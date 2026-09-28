import { sql } from 'kysely';
import { PgErrorCode, pgErrorCode, tenantTx, type Db, type Tx } from '@stockos/database';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthenticatedError,
  ValidationError,
  hashEquals,
  isUuid,
  newOpaqueToken,
  sha256,
  uuidv7,
} from '@stockos/shared';
import { recordAudit } from '../../audit/public-api';
import { PlanService } from '../../billing/public-api';
import { NotificationService } from '../../notifications/public-api';
import {
  assertCan,
  listAssignments,
  replaceAssignments,
  type Principal,
  type RoleAssignment,
  type RoleService,
} from '../../iam/public-api';
import type { PasswordHasher } from '../infrastructure/password';
import { normalizeEmail, type AuthService } from './auth-service';
import type { TokenPair } from './sessions';

export interface Member {
  membershipId: string;
  userId: string;
  email: string | null;
  displayName: string;
  status: string;
  isOwner: boolean;
  mfaEnabled: boolean;
  roles: (RoleAssignment & { roleCode: string })[];
}

export interface InvitationCreated {
  invitationId: string;
  email: string;
  /** Deliver to the invitee (e-mail in production). Shown once; only its hash is stored. */
  token: string;
  expiresAt: Date;
  /** For the invitation e-mail. */
  companyName: string;
  inviterName: string;
}

export interface OpenInvitation {
  id: string;
  email: string;
  roles: RoleAssignment[];
  invitedBy: string | null;
  expiresAt: Date;
  createdAt: Date;
}

const INVITATION_TTL_MS = 72 * 3600 * 1000;

/** Members of a tenant and the invitation flow. */
export class UserService {
  private readonly plans = new PlanService();
  private readonly notifications = new NotificationService();

  constructor(
    private readonly db: Db,
    private readonly roles: RoleService,
    private readonly auth: AuthService,
    private readonly hasher: PasswordHasher,
  ) {}

  async listMembers(tx: Tx, principal: Principal): Promise<Member[]> {
    assertCan(principal, 'user.read');
    const { rows } = await sql<{
      id: string;
      user_id: string;
      email: string | null;
      display_name: string;
      status: string;
      is_owner: boolean;
      mfa_enabled: boolean;
    }>`
      select m.id, m.user_id, u.email::text as email, u.display_name, m.status, m.is_owner, u.mfa_enabled
        from tenant_memberships m join users u on u.id = m.user_id
       where m.status <> 'REMOVED'
       order by m.is_owner desc, u.display_name`.execute(tx);
    const members: Member[] = [];
    for (const r of rows) {
      members.push({
        membershipId: r.id,
        userId: r.user_id,
        email: r.email,
        displayName: r.display_name,
        status: r.status,
        isOwner: r.is_owner,
        mfaEnabled: r.mfa_enabled,
        roles: await listAssignments(tx, r.id),
      });
    }
    return members;
  }

  async getMember(tx: Tx, principal: Principal, membershipId: string): Promise<Member> {
    const member = (await this.listMembers(tx, principal)).find((m) => m.membershipId === membershipId);
    if (!member) throw new NotFoundError('Member not found');
    return member;
  }

  async invite(
    tx: Tx,
    principal: Principal,
    input: { email: string; roles: RoleAssignment[] },
  ): Promise<InvitationCreated> {
    assertCan(principal, 'user.manage');
    const email = normalizeEmail(input.email);
    if (input.roles.length === 0) throw new ValidationError('Give the new member at least one role');
    await this.roles.validateAssignments(tx, principal, input.roles);
    await this.plans.assertWithinLimit(tx, principal.tenantId, 'users');

    const { rows: existing } = await sql`
      select 1 from tenant_memberships m join users u on u.id = m.user_id
       where u.email = ${email} and m.status in ('ACTIVE', 'SUSPENDED')`.execute(tx);
    if (existing.length) throw new ConflictError('This person is already a member');

    const id = uuidv7();
    const secret = newOpaqueToken();
    const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
    try {
      await sql`insert into invitations (tenant_id, id, email, role_assignments, token_hash, invited_by, expires_at)
                values (${principal.tenantId}, ${id}, ${email}, ${JSON.stringify(input.roles)}::jsonb, ${sha256(secret)},
                        ${principal.membershipId}, ${expiresAt})`.execute(tx);
    } catch (err) {
      if (pgErrorCode(err) === PgErrorCode.UniqueViolation)
        throw new ConflictError('An invitation for this e-mail is already open');
      throw err;
    }
    await recordAudit(tx, {
      tenantId: principal.tenantId,
      action: 'user.invite',
      resourceType: 'invitation',
      resourceId: id,
      after: { email, roles: input.roles },
    });
    const { rows: names } = await sql<{ company: string; inviter: string }>`
      select t.name as company, u.display_name as inviter
        from tenants t cross join users u
       where t.id = ${principal.tenantId} and u.id = ${principal.userId}`.execute(tx);
    return {
      invitationId: id,
      email,
      token: `${principal.tenantId}.${id}.${secret}`,
      expiresAt,
      companyName: names[0]?.company ?? '',
      inviterName: names[0]?.inviter ?? '',
    };
  }

  async listInvitations(tx: Tx, principal: Principal): Promise<OpenInvitation[]> {
    assertCan(principal, 'user.read');
    const { rows } = await sql<{
      id: string;
      email: string;
      role_assignments: RoleAssignment[];
      invited_by: string | null;
      expires_at: Date;
      created_at: Date;
    }>`select i.id, i.email::text as email, i.role_assignments, u.display_name as invited_by, i.expires_at, i.created_at
         from invitations i
         left join tenant_memberships m on m.id = i.invited_by
         left join users u on u.id = m.user_id
        where i.accepted_at is null and i.revoked_at is null
        order by i.created_at desc`.execute(tx);
    return rows.map((r) => ({
      id: r.id,
      email: r.email,
      roles: r.role_assignments,
      invitedBy: r.invited_by,
      expiresAt: r.expires_at,
      createdAt: r.created_at,
    }));
  }

  async revokeInvitation(tx: Tx, principal: Principal, id: string): Promise<void> {
    assertCan(principal, 'user.manage');
    if (!isUuid(id)) throw new NotFoundError('Invitation not found');
    const { rows } = await sql`update invitations set revoked_at = now()
                                where id = ${id} and accepted_at is null and revoked_at is null returning id`.execute(
      tx,
    );
    if (rows.length === 0) throw new NotFoundError('Invitation not found');
    await recordAudit(tx, {
      tenantId: principal.tenantId,
      action: 'user.invitation.revoke',
      resourceType: 'invitation',
      resourceId: id,
    });
  }

  /**
   * Suspend or reactivate a member. Suspension revokes their sessions at once; their API keys stop
   * working too (keys act on behalf of their creator).
   */
  async setMemberStatus(tx: Tx, principal: Principal, membershipId: string, status: 'ACTIVE' | 'SUSPENDED') {
    assertCan(principal, 'user.manage');
    if (!isUuid(membershipId)) throw new NotFoundError('Member not found');
    if (membershipId === principal.membershipId) {
      throw new ForbiddenError('You cannot change your own status', {}, 'PRIVILEGE_ESCALATION');
    }
    const { rows } = await sql<{ is_owner: boolean; status: string }>`
      select is_owner, status from tenant_memberships where id = ${membershipId} and status in ('ACTIVE', 'SUSPENDED')`.execute(
      tx,
    );
    const member = rows[0];
    if (!member) throw new NotFoundError('Member not found');
    if (member.is_owner)
      throw new ForbiddenError('The owner cannot be suspended', {}, 'PRIVILEGE_ESCALATION');
    await sql`update tenant_memberships set status = ${status}, updated_at = now() where id = ${membershipId}`.execute(
      tx,
    );
    if (status === 'SUSPENDED') {
      await sql`update user_sessions set revoked_at = now() where membership_id = ${membershipId} and revoked_at is null`.execute(
        tx,
      );
    }
    await recordAudit(tx, {
      tenantId: principal.tenantId,
      action: status === 'SUSPENDED' ? 'membership.suspend' : 'membership.reactivate',
      resourceType: 'membership',
      resourceId: membershipId,
      before: { status: member.status },
      after: { status },
    });
    return this.getMember(tx, principal, membershipId);
  }

  /**
   * Public endpoint. The token names its tenant, so the lookup runs under that tenant's RLS.
   * An existing user (member elsewhere) must prove their password; a new user sets one.
   */
  async acceptInvitation(input: {
    token: string;
    password: string;
    displayName?: string;
  }): Promise<TokenPair> {
    const [tenantId, invitationId, secret] = input.token.split('.');
    if (!isUuid(tenantId) || !isUuid(invitationId) || !secret) throw invalidInvitation();

    return tenantTx(this.db, tenantId, async (tx) => {
      const { rows } = await sql<{
        email: string;
        role_assignments: RoleAssignment[];
        token_hash: Buffer;
        expires_at: Date;
        accepted_at: Date | null;
        revoked_at: Date | null;
        inviter_user_id: string | null;
      }>`select email::text as email, role_assignments, token_hash, expires_at, accepted_at, revoked_at,
                (select m.user_id from tenant_memberships m where m.id = invitations.invited_by) as inviter_user_id
           from invitations where id = ${invitationId} for update`.execute(tx);
      const inv = rows[0];
      if (
        !inv ||
        !hashEquals(inv.token_hash, sha256(secret)) ||
        inv.accepted_at ||
        inv.revoked_at ||
        inv.expires_at < new Date()
      ) {
        throw invalidInvitation();
      }

      const userId = await this.findOrCreateUser(tx, inv.email, input);
      const { rows: memberRows } = await sql<{ id: string }>`
        insert into tenant_memberships (tenant_id, id, user_id, status)
        values (${tenantId}, ${uuidv7()}, ${userId}, 'ACTIVE')
        on conflict (tenant_id, user_id) do update set status = 'ACTIVE', updated_at = now()
          where tenant_memberships.status in ('INVITED', 'REMOVED')
        returning id`.execute(tx);
      const membershipId = memberRows[0]?.id;
      if (!membershipId) throw new ConflictError('You are already a member of this company');

      await replaceAssignments(tx, tenantId, membershipId, inv.role_assignments, null);
      await sql`update invitations set accepted_at = now(), accepted_membership_id = ${membershipId} where id = ${invitationId}`.execute(
        tx,
      );
      await recordAudit(tx, {
        tenantId,
        action: 'user.invitation.accepted',
        resourceType: 'membership',
        resourceId: membershipId,
        actor: { type: 'USER', id: userId },
        after: { email: inv.email, roles: inv.role_assignments },
      });
      if (inv.inviter_user_id) {
        await this.notifications.notify(tx, {
          tenantId,
          userIds: [inv.inviter_user_id],
          eventType: 'MEMBER_JOINED',
          severity: 'INFO',
          title: `${inv.email} accepted your invitation`,
          data: { membershipId },
        });
      }
      return this.auth.startSession(userId, tenantId, membershipId, ['pwd'], tx);
    });
  }

  private async findOrCreateUser(
    tx: Tx,
    email: string,
    input: { password: string; displayName?: string },
  ): Promise<string> {
    const { rows } = await sql<{ id: string; password_hash: string | null }>`
      select id, password_hash from users where email = ${email} for update`.execute(tx);
    const existing = rows[0];
    if (existing) {
      if (!(await this.hasher.verify(existing.password_hash, input.password))) {
        throw new UnauthenticatedError(
          'INVALID_CREDENTIALS',
          'Sign in with your existing password to accept',
        );
      }
      return existing.id;
    }
    if (!input.displayName?.trim()) throw new ValidationError('displayName is required for new accounts');
    const id = uuidv7();
    const passwordHash = await this.hasher.hash(input.password);
    await sql`insert into users (id, email, password_hash, display_name, email_verified_at)
              values (${id}, ${email}, ${passwordHash}, ${input.displayName.trim()}, now())`.execute(tx);
    return id;
  }
}

function invalidInvitation() {
  return new UnauthenticatedError('UNAUTHENTICATED', 'This invitation link is invalid or has expired');
}
