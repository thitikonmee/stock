import { sql } from 'kysely';
import { PgErrorCode, pgErrorCode, type Tx } from '@stockos/database';
import {
  BusinessRuleError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  PreconditionFailedError,
  ValidationError,
  isUuid,
  uuidv7,
} from '@stockos/shared';
import { recordAudit } from '../../audit/public-api';
import { isPermissionCode, type PermissionCode } from '../domain/permissions';
import { assertCan, tenantWidePermissions, type Principal } from '../domain/policy';
import { isSystemRoleCode } from '../domain/system-roles';
import {
  insertRolePermissions,
  listAssignments,
  listRoles,
  replaceAssignments,
  scopeExists,
  type RoleAssignment,
  type RoleRow,
} from '../infrastructure/iam-repository';

export interface CreateRoleInput {
  code: string;
  name: string;
  description?: string;
  permissions: readonly string[];
}

export interface UpdateRoleInput {
  name?: string;
  description?: string;
  permissions?: readonly string[];
  /** Optimistic lock: must match the role's current version. */
  expectedVersion: number;
}

const ROLE_CODE_RE = /^[A-Z][A-Z0-9_]{1,39}$/;

/**
 * Custom roles and role assignment. Every mutation enforces the delegation ceiling:
 * you can only hand out permissions you hold tenant-wide yourself (no privilege escalation).
 */
export class RoleService {
  async list(tx: Tx, principal: Principal): Promise<RoleRow[]> {
    assertCan(principal, 'user.read');
    return listRoles(tx);
  }

  async create(tx: Tx, principal: Principal, input: CreateRoleInput): Promise<RoleRow> {
    assertCan(principal, 'role.manage');
    if (!ROLE_CODE_RE.test(input.code))
      throw new ValidationError('Role code must be UPPER_SNAKE_CASE (2-40 chars)');
    if (isSystemRoleCode(input.code)) throw new ConflictError(`Role code ${input.code} is reserved`);
    const permissions = this.checkDelegable(principal, input.permissions);

    const id = uuidv7();
    try {
      await sql`insert into roles (tenant_id, id, code, name, description, is_system)
                values (${principal.tenantId}, ${id}, ${input.code}, ${input.name}, ${input.description ?? null}, false)`.execute(
        tx,
      );
    } catch (err) {
      if (pgErrorCode(err) === PgErrorCode.UniqueViolation)
        throw new ConflictError(`Role ${input.code} already exists`);
      throw err;
    }
    await insertRolePermissions(tx, principal.tenantId, id, permissions);
    await recordAudit(tx, {
      tenantId: principal.tenantId,
      action: 'role.create',
      resourceType: 'role',
      resourceId: id,
      after: { code: input.code, name: input.name, permissions },
    });
    return (await listRoles(tx, id))[0]!;
  }

  async update(tx: Tx, principal: Principal, roleId: string, input: UpdateRoleInput): Promise<RoleRow> {
    assertCan(principal, 'role.manage');
    const role = await this.getOrThrow(tx, roleId);
    if (role.isSystem)
      throw new BusinessRuleError(
        'SYSTEM_ROLE_IMMUTABLE',
        'System roles cannot be changed; clone them instead',
      );
    const permissions = input.permissions ? this.checkDelegable(principal, input.permissions) : undefined;
    // Editing a role changes everyone holding it: the editor must also hold what is being removed.
    if (permissions)
      this.checkDelegable(
        principal,
        role.permissions.filter((p) => !permissions.includes(p)),
      );

    const { rows } = await sql<{ version: number }>`
      update roles set name = coalesce(${input.name ?? null}, name),
                       description = coalesce(${input.description ?? null}, description),
                       version = version + 1, updated_at = now()
       where id = ${roleId} and version = ${input.expectedVersion}
      returning version`.execute(tx);
    if (rows.length === 0)
      throw new PreconditionFailedError('Role was changed by someone else', { currentVersion: role.version });
    if (permissions) {
      await sql`delete from role_permissions where role_id = ${roleId}`.execute(tx);
      await insertRolePermissions(tx, principal.tenantId, roleId, permissions);
    }
    await recordAudit(tx, {
      tenantId: principal.tenantId,
      action: 'role.update',
      resourceType: 'role',
      resourceId: roleId,
      before: { name: role.name, permissions: role.permissions },
      after: { name: input.name ?? role.name, permissions: permissions ?? role.permissions },
    });
    return (await listRoles(tx, roleId))[0]!;
  }

  /** Replace all role assignments of a member. */
  async assign(tx: Tx, principal: Principal, membershipId: string, assignments: readonly RoleAssignment[]) {
    assertCan(principal, 'user.manage');
    if (!isUuid(membershipId)) throw new NotFoundError('Member not found');
    if (membershipId === principal.membershipId)
      throw new ForbiddenError('You cannot change your own roles', {}, 'PRIVILEGE_ESCALATION');

    const { rows: members } = await sql<{ is_owner: boolean }>`
      select is_owner from tenant_memberships where id = ${membershipId} and status <> 'REMOVED'`.execute(tx);
    const member = members[0];
    if (!member) throw new NotFoundError('Member not found');
    if (member.is_owner)
      throw new ForbiddenError(
        'The owner’s roles can only change through ownership transfer',
        {},
        'PRIVILEGE_ESCALATION',
      );

    await this.validateAssignments(tx, principal, assignments);
    const before = await listAssignments(tx, membershipId);
    await replaceAssignments(tx, principal.tenantId, membershipId, assignments, principal.membershipId);
    await recordAudit(tx, {
      tenantId: principal.tenantId,
      action: 'membership.roles.replace',
      resourceType: 'membership',
      resourceId: membershipId,
      before: { assignments: before },
      after: { assignments },
    });
    return listAssignments(tx, membershipId);
  }

  /** Shared with invitations: roles must exist, never be OWNER, stay within the inviter's ceiling. */
  async validateAssignments(
    tx: Tx,
    principal: Principal,
    assignments: readonly RoleAssignment[],
  ): Promise<void> {
    if (assignments.length > 20) throw new ValidationError('Too many role assignments');
    const roles = new Map((await listRoles(tx)).map((r) => [r.id, r]));
    for (const a of assignments) {
      const role = isUuid(a.roleId) ? roles.get(a.roleId) : undefined;
      if (!role) throw new ValidationError('Unknown role', { roleId: a.roleId });
      if (role.code === 'OWNER')
        throw new ForbiddenError('The OWNER role cannot be assigned', {}, 'PRIVILEGE_ESCALATION');
      this.checkDelegable(principal, role.permissions);
      if ((a.scopeType === 'TENANT') !== (a.scopeId === null))
        throw new ValidationError('scopeId is required for BRANCH/WAREHOUSE scope only');
      if (
        a.scopeType !== 'TENANT' &&
        (!isUuid(a.scopeId) || !(await scopeExists(tx, a.scopeType, a.scopeId)))
      ) {
        throw new ValidationError(`Unknown ${a.scopeType.toLowerCase()}`, { scopeId: a.scopeId });
      }
    }
  }

  private checkDelegable(principal: Principal, requested: readonly string[]): PermissionCode[] {
    const unknown = requested.filter((p) => !isPermissionCode(p));
    if (unknown.length) throw new ValidationError('Unknown permissions', { permissions: unknown });
    const ceiling = tenantWidePermissions(principal);
    const beyond = requested.filter((p) => !ceiling.has(p as PermissionCode));
    if (beyond.length) {
      throw new ForbiddenError(
        'You cannot grant permissions you do not hold',
        { permissions: beyond },
        'PRIVILEGE_ESCALATION',
      );
    }
    return [...new Set(requested as PermissionCode[])].sort();
  }

  private async getOrThrow(tx: Tx, roleId: string): Promise<RoleRow> {
    const role = isUuid(roleId) ? (await listRoles(tx, roleId))[0] : undefined;
    if (!role) throw new NotFoundError('Role not found');
    return role;
  }
}
