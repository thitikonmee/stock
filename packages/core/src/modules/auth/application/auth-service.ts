import { sql } from 'kysely';
import { PgErrorCode, pgErrorCode, platformTx, tenantTx, type Db, type Tx } from '@stockos/database';
import {
  BusinessRuleError,
  ConflictError,
  ForbiddenError,
  isUuid,
  sha256,
  UnauthenticatedError,
  uuidv7,
  ValidationError,
} from '@stockos/shared';
import { recordAudit } from '../../audit/public-api';
import { PlanService } from '../../billing/public-api';
import { PriceService } from '../../catalog/public-api';
import {
  createSystemRoles,
  loadMembershipAccess,
  replaceAssignments,
  type MembershipAccess,
  type Principal,
} from '../../iam/public-api';
import type { JwtService } from '../infrastructure/jwt';
import type { OAuthProvider, OAuthProviderCode } from '../oauth/provider';
import type { PasswordHasher } from '../infrastructure/password';
import type { SecretBox } from '../infrastructure/secret-box';
import { base32Encode, generateTotpSecret, otpauthUri, verifyTotp } from '../infrastructure/totp';
import { issueSession, revokeFamily, type SessionTtls, type TokenPair } from './sessions';

export interface AuthConfig extends SessionTtls {
  jwt: JwtService;
  /** Registered login identity providers; a code with no entry means that "Continue with ..."
   *  button simply isn't offered — same optional-registration convention as `channels.AdapterRegistry`. */
  oauthProviders: Partial<Record<OAuthProviderCode, OAuthProvider>>;
  hasher: PasswordHasher;
  secretBox: SecretBox;
  mfaChallengeTtlSec: number;
  /** Dangerous actions need a 2FA proof at most this old (users who have 2FA). */
  stepUpMaxAgeSec: number;
  maxFailedAttempts: number;
  lockoutMinutes: number;
  /** A refresh token presented again within this window is treated as a client race, not theft. */
  refreshReuseGraceSec: number;
  totpIssuer: string;
}

export const DEFAULT_AUTH_TIMINGS = {
  accessTokenTtlSec: 15 * 60,
  refreshTokenTtlSec: 30 * 24 * 3600,
  refreshAbsoluteTtlSec: 90 * 24 * 3600,
  mfaChallengeTtlSec: 5 * 60,
  stepUpMaxAgeSec: 15 * 60,
  maxFailedAttempts: 5,
  lockoutMinutes: 15,
  refreshReuseGraceSec: 10,
  totpIssuer: 'StockOS',
} as const;

export interface SignupInput {
  companyName: string;
  slug: string;
  ownerName: string;
  email: string;
  password: string;
}

export type LoginResult = ({ mfaRequired: false } & TokenPair) | { mfaRequired: true; mfaToken: string };
export type OAuthSignInResult = LoginResult | { needsSignup: true; suggestedName: string; email: string };

/** Tenant statuses that may use the product. PAST_DUE keeps working during the grace period. */
const USABLE_TENANT_STATUSES = new Set(['TRIAL', 'ACTIVE', 'PAST_DUE']);
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;

const OAUTH_CONNECT_STATE_AAD = 'oauth-connect-state';
const OAUTH_TICKET_AAD = 'oauth-login-ticket';
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const OAUTH_TICKET_TTL_MS = 10 * 60 * 1000;

interface OAuthTicketPayload {
  provider: OAuthProviderCode;
  providerId: string;
  email: string;
  name: string;
  exp: number;
}

interface UserRow {
  id: string;
  password_hash: string | null;
  status: string;
  locked_until: Date | null;
  mfa_enabled: boolean;
  mfa_totp_secret_enc: Buffer | null;
  mfa_last_step: string | null;
  email: string | null;
}

export class AuthService {
  constructor(
    private readonly db: Db,
    private readonly config: AuthConfig,
  ) {}

  // ---------------------------------------------------------------- signup

  /** Create a company, its owner, system roles, a head-office branch and main warehouse. */
  async signup(input: SignupInput): Promise<{ tenantId: string; userId: string } & TokenPair> {
    const slug = input.slug.trim().toLowerCase();
    if (!SLUG_RE.test(slug)) throw new ValidationError('slug must be 3-40 chars: a-z, 0-9 and -');
    const email = normalizeEmail(input.email);
    const passwordHash = await this.config.hasher.hash(input.password);
    const tenantId = uuidv7();
    const userId = uuidv7();
    const membershipId = uuidv7();

    try {
      return await tenantTx(this.db, tenantId, async (tx) => {
        await sql`insert into tenants (id, slug, name, status) values (${tenantId}, ${slug}, ${input.companyName}, 'TRIAL')`.execute(
          tx,
        );
        await sql`insert into users (id, email, password_hash, display_name) values (${userId}, ${email}, ${passwordHash}, ${input.ownerName})`.execute(
          tx,
        );
        await sql`insert into tenant_memberships (tenant_id, id, user_id, status, is_owner)
                  values (${tenantId}, ${membershipId}, ${userId}, 'ACTIVE', true)`.execute(tx);
        await new PlanService().startTrial(tx, tenantId);
        const roles = await createSystemRoles(tx, tenantId);
        await replaceAssignments(
          tx,
          tenantId,
          membershipId,
          [{ roleId: roles.get('OWNER')!, scopeType: 'TENANT', scopeId: null }],
          null,
        );

        const branchId = uuidv7();
        await sql`insert into branches (tenant_id, id, code, name, tax_branch_no) values (${tenantId}, ${branchId}, 'HQ', 'สำนักงานใหญ่', '00000')`.execute(
          tx,
        );
        await sql`insert into warehouses (tenant_id, id, branch_id, code, name, type)
                  values (${tenantId}, ${uuidv7()}, ${branchId}, 'MAIN', 'คลังหลัก', 'CENTRAL')`.execute(tx);
        await new PriceService().ensureDefaultList(tx, tenantId);

        await recordAudit(tx, {
          tenantId,
          action: 'tenant.signup',
          resourceType: 'tenant',
          resourceId: tenantId,
          actor: { type: 'USER', id: userId },
          after: { slug, companyName: input.companyName, ownerEmail: email },
        });
        const tokens = await issueSession(tx, this.config.jwt, this.config, {
          userId,
          tenantId,
          membershipId,
          amr: ['pwd'],
          authTime: new Date(),
        });
        return { tenantId, userId, ...tokens };
      });
    } catch (err) {
      if (pgErrorCode(err) === PgErrorCode.UniqueViolation) {
        const constraint = (err as { constraint?: string }).constraint;
        if (constraint === 'users_email_key') throw new ConflictError('E-mail is already registered');
        if (constraint === 'tenants_slug_key') throw new ConflictError('This shop URL is taken');
      }
      throw err; // any other violation is a bug, not a user conflict
    }
  }

  // ---------------------------------------------------------------- login

  async login(input: { identifier: string; password: string; tenantSlug?: string }): Promise<LoginResult> {
    const user = await this.findUser(input.identifier);
    const passwordOk = await this.config.hasher.verify(user?.password_hash, input.password);

    if (!user) throw invalidCredentials();
    if (user.locked_until && user.locked_until > new Date()) {
      throw new UnauthenticatedError('ACCOUNT_LOCKED', 'Too many failed attempts, try again later');
    }
    if (!passwordOk) {
      await this.recordFailure(user.id);
      throw invalidCredentials();
    }
    if (user.status !== 'ACTIVE') throw invalidCredentials();
    await this.resetFailures(user.id);

    const membership = await this.pickMembership(user.id, input.tenantSlug);
    if (user.mfa_enabled) {
      const mfaToken = this.config.jwt.sign(
        { typ: 'mfa', sub: user.id, tid: membership.tenant_id, mid: membership.membership_id },
        this.config.mfaChallengeTtlSec,
      );
      return { mfaRequired: true, mfaToken };
    }
    return {
      mfaRequired: false,
      ...(await this.startSession(user.id, membership.tenant_id, membership.membership_id, ['pwd'])),
    };
  }

  async verifyMfa(input: { mfaToken: string; code: string }): Promise<TokenPair> {
    const claims = this.config.jwt.verify(input.mfaToken);
    if (claims['typ'] !== 'mfa') throw new UnauthenticatedError();
    const userId = String(claims['sub']);
    const user = await this.loadUser(userId);
    if (!user?.mfa_enabled || !user.mfa_totp_secret_enc) throw new UnauthenticatedError();
    if (user.locked_until && user.locked_until > new Date())
      throw new UnauthenticatedError('ACCOUNT_LOCKED', 'Too many failed attempts, try again later');

    const step = verifyTotp(
      this.config.secretBox.open(user.mfa_totp_secret_enc, `totp:${user.id}`),
      input.code,
    );
    if (step === null || !(await this.claimTotpStep(user.id, step))) {
      await this.recordFailure(user.id);
      throw new UnauthenticatedError('INVALID_MFA_CODE', 'Invalid verification code');
    }
    await this.resetFailures(user.id);
    return this.startSession(userId, String(claims['tid']), String(claims['mid']), ['pwd', 'otp']);
  }

  // ---------------------------------------------------------------- OAuth login / self-service signup

  private getOAuthProvider(code: OAuthProviderCode): OAuthProvider {
    const provider = this.config.oauthProviders[code];
    if (!provider) throw new ValidationError(`${code} sign-in is not enabled`);
    return provider;
  }

  /** Step 1: where to send the browser. `state` only carries a nonce + expiry — unlike the ticket
   *  issued after callback, there is no identity to protect yet, so it just proves "this callback
   *  request followed a `start` call we issued" within a short window (CSRF/replay guard). */
  oauthAuthorizeUrl(code: OAuthProviderCode, redirectUri: string): string {
    const provider = this.getOAuthProvider(code);
    const state = this.config.secretBox
      .seal(
        Buffer.from(JSON.stringify({ nonce: uuidv7(), exp: Date.now() + OAUTH_STATE_TTL_MS })),
        OAUTH_CONNECT_STATE_AAD,
      )
      .toString('base64url');
    return provider.buildAuthorizeUrl(redirectUri, state);
  }

  /**
   * Step 2: the provider's own redirect lands here (via the `@Public()` controller callback).
   * Verifies `state` (proves this callback followed a `start` call we actually issued, within the
   * window, rather than e.g. a stale bookmarked/replayed callback URL), exchanges `code` for a
   * profile, and — this is the one place an unverified provider email gets rejected, before
   * anything downstream ever trusts it — seals a short-lived ticket the web app round-trips
   * through `oauthResolve`/`oauthSignup`. Never returns tokens or touches the database: no account
   * decision happens until the ticket comes back.
   */
  async oauthCallback(
    code: OAuthProviderCode,
    authCode: string,
    state: string,
    redirectUri: string,
  ): Promise<string> {
    const provider = this.getOAuthProvider(code);
    let statePayload: { exp: number };
    try {
      statePayload = JSON.parse(
        this.config.secretBox.open(Buffer.from(state, 'base64url'), OAUTH_CONNECT_STATE_AAD).toString('utf8'),
      ) as { exp: number };
    } catch {
      throw new UnauthenticatedError('OAUTH_FAILED', 'Sign-in request is invalid, please try again');
    }
    if (statePayload.exp < Date.now()) {
      throw new UnauthenticatedError('OAUTH_FAILED', 'Sign-in request expired, please try again');
    }
    const profile = await provider.exchangeCode(authCode, redirectUri);
    if (!profile.emailVerified) {
      throw new UnauthenticatedError('OAUTH_FAILED', `${code} did not confirm this e-mail address`);
    }
    const payload: OAuthTicketPayload = {
      provider: code,
      providerId: profile.providerId,
      email: normalizeEmail(profile.email),
      name: profile.name,
      exp: Date.now() + OAUTH_TICKET_TTL_MS,
    };
    return this.config.secretBox
      .seal(Buffer.from(JSON.stringify(payload)), OAUTH_TICKET_AAD)
      .toString('base64url');
  }

  /**
   * Step 3: the web app calls this right after the callback redirect (ticket not yet tied to any
   * account), and again after the user picks a tenant or an MFA code — same multi-step shape as
   * `login()`. No existing user for the ticket's verified email -> `needsSignup` (an expected
   * branch, not an error) instead of auto-creating a tenant with a guessed name.
   */
  async oauthResolve(ticket: string, tenantSlug?: string): Promise<OAuthSignInResult> {
    const payload = this.openOAuthTicket(ticket);
    const user = await this.findUser(payload.email);
    if (!user) return { needsSignup: true, suggestedName: payload.name, email: payload.email };

    await this.linkOAuthIdentity(user.id, payload);
    const membership = await this.pickMembership(user.id, tenantSlug);
    if (user.mfa_enabled) {
      const mfaToken = this.config.jwt.sign(
        { typ: 'mfa', sub: user.id, tid: membership.tenant_id, mid: membership.membership_id },
        this.config.mfaChallengeTtlSec,
      );
      return { mfaRequired: true, mfaToken };
    }
    return {
      mfaRequired: false,
      ...(await this.startSession(user.id, membership.tenant_id, membership.membership_id, [
        payload.provider.toLowerCase(),
      ])),
    };
  }

  /**
   * Step 3b (only when `oauthResolve` returned `needsSignup`): re-opens the *same* ticket — the
   * company name is the only thing trusted from the client here, every identity field is re-derived
   * from the sealed ticket, never from anything the browser could have tampered with in between.
   * Mirrors `signup()`'s tenant/user/membership/trial/roles/branch/warehouse/price-list bootstrap,
   * minus the password hash, plus the `user_identities` link row.
   */
  async oauthSignup(
    ticket: string,
    companyName: string,
  ): Promise<{ tenantId: string; userId: string } & TokenPair> {
    const payload = this.openOAuthTicket(ticket);
    const name = companyName.trim();
    if (name.length < 2 || name.length > 120) {
      throw new ValidationError('companyName must be 2-120 characters');
    }
    if (await this.findUser(payload.email)) {
      throw new ConflictError('An account already exists for this e-mail — sign in instead');
    }

    const tenantId = uuidv7();
    const userId = uuidv7();
    const membershipId = uuidv7();
    const slug = await this.pickAvailableSlug(name);

    try {
      return await tenantTx(this.db, tenantId, async (tx) => {
        await sql`insert into tenants (id, slug, name, status) values (${tenantId}, ${slug}, ${name}, 'TRIAL')`.execute(
          tx,
        );
        await sql`insert into users (id, email, display_name, email_verified_at)
                  values (${userId}, ${payload.email}, ${payload.name || name}, now())`.execute(tx);
        await sql`insert into user_identities (id, user_id, provider, provider_user_id, email)
                  values (${uuidv7()}, ${userId}, ${payload.provider}, ${payload.providerId}, ${payload.email})`.execute(
          tx,
        );
        await sql`insert into tenant_memberships (tenant_id, id, user_id, status, is_owner)
                  values (${tenantId}, ${membershipId}, ${userId}, 'ACTIVE', true)`.execute(tx);
        await new PlanService().startTrial(tx, tenantId);
        const roles = await createSystemRoles(tx, tenantId);
        await replaceAssignments(
          tx,
          tenantId,
          membershipId,
          [{ roleId: roles.get('OWNER')!, scopeType: 'TENANT', scopeId: null }],
          null,
        );

        const branchId = uuidv7();
        await sql`insert into branches (tenant_id, id, code, name, tax_branch_no) values (${tenantId}, ${branchId}, 'HQ', 'สำนักงานใหญ่', '00000')`.execute(
          tx,
        );
        await sql`insert into warehouses (tenant_id, id, branch_id, code, name, type)
                  values (${tenantId}, ${uuidv7()}, ${branchId}, 'MAIN', 'คลังหลัก', 'CENTRAL')`.execute(tx);
        await new PriceService().ensureDefaultList(tx, tenantId);

        await recordAudit(tx, {
          tenantId,
          action: 'tenant.signup',
          resourceType: 'tenant',
          resourceId: tenantId,
          actor: { type: 'USER', id: userId },
          after: { slug, companyName: name, ownerEmail: payload.email, provider: payload.provider },
        });
        const tokens = await issueSession(tx, this.config.jwt, this.config, {
          userId,
          tenantId,
          membershipId,
          amr: [payload.provider.toLowerCase()],
          authTime: new Date(),
        });
        return { tenantId, userId, ...tokens };
      });
    } catch (err) {
      if (pgErrorCode(err) === PgErrorCode.UniqueViolation) {
        const constraint = (err as { constraint?: string }).constraint;
        if (constraint === 'users_email_key') {
          throw new ConflictError('An account already exists for this e-mail — sign in instead');
        }
        if (constraint === 'tenants_slug_key') {
          // The retry loop in pickAvailableSlug already tries hard to dodge this; losing a race
          // to another signup picking the exact same suffix in the same instant is rare enough
          // that asking the user to just try again is reasonable rather than retrying forever here.
          throw new ConflictError('That shop URL was just taken — please try again');
        }
      }
      throw err;
    }
  }

  private openOAuthTicket(ticket: string): OAuthTicketPayload {
    let payload: OAuthTicketPayload;
    try {
      payload = JSON.parse(
        this.config.secretBox.open(Buffer.from(ticket, 'base64url'), OAUTH_TICKET_AAD).toString('utf8'),
      ) as OAuthTicketPayload;
    } catch {
      throw new UnauthenticatedError('OAUTH_FAILED', 'Sign-in link is invalid, please try again');
    }
    if (payload.exp < Date.now()) {
      throw new UnauthenticatedError('OAUTH_FAILED', 'Sign-in link expired, please try again');
    }
    return payload;
  }

  private async linkOAuthIdentity(userId: string, payload: OAuthTicketPayload): Promise<void> {
    await platformTx(this.db, (tx) =>
      sql`insert into user_identities (id, user_id, provider, provider_user_id, email)
          values (${uuidv7()}, ${userId}, ${payload.provider}, ${payload.providerId}, ${payload.email})
          on conflict (provider, provider_user_id) do update set email = excluded.email`.execute(tx),
    );
    await platformTx(this.db, (tx) =>
      sql`update users set email_verified_at = coalesce(email_verified_at, now()) where id = ${userId}`.execute(
        tx,
      ),
    );
  }

  private async pickAvailableSlug(companyName: string): Promise<string> {
    const base = slugify(companyName);
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = attempt === 0 ? base : `${base}-${uuidv7().slice(-4)}`;
      const { rows } = await platformTx(this.db, (tx) =>
        sql<{
          exists: boolean;
        }>`select exists(select 1 from tenants where slug = ${candidate}) as exists`.execute(tx),
      );
      if (!rows[0]!.exists) return candidate;
    }
    throw new ConflictError('Could not find an available shop URL, please try a different name');
  }

  // ---------------------------------------------------------------- refresh / logout

  /**
   * Refresh-token rotation. Presenting an already-rotated token outside the grace window means the
   * token was copied: the whole family (every device of that login) is revoked.
   */
  async refresh(refreshToken: string): Promise<TokenPair> {
    // One transaction: rotation and the new token commit together, or neither does.
    const outcome = await platformTx(this.db, async (tx) => {
      const { rows } = await sql<{
        id: string;
        user_id: string;
        tenant_id: string;
        membership_id: string;
        family_id: string;
        amr: string[];
        auth_time: Date;
        expires_at: Date;
        family_expires_at: Date;
        rotated_at: Date | null;
        revoked_at: Date | null;
      }>`select id, user_id, tenant_id, membership_id, family_id, amr, auth_time, expires_at, family_expires_at, rotated_at, revoked_at
           from user_sessions where refresh_token_hash = ${sha256(refreshToken)} for update`.execute(tx);
      const s = rows[0];
      if (!s || s.revoked_at || s.expires_at < new Date()) return { error: new UnauthenticatedError() };
      if (s.rotated_at) {
        const ageSec = (Date.now() - s.rotated_at.getTime()) / 1000;
        if (ageSec > this.config.refreshReuseGraceSec) {
          await revokeFamily(tx, s.family_id);
          return { error: new UnauthenticatedError('TOKEN_REUSED', 'Session revoked, please sign in again') };
        }
        return { error: new UnauthenticatedError('TOKEN_REUSED', 'Token already used') };
      }
      await sql`update user_sessions set rotated_at = now() where id = ${s.id}`.execute(tx);

      // Now that the tenant is known, scope the rest of the transaction to it (RLS applies).
      await sql`select set_config('app.tenant_id', ${s.tenant_id}, true)`.execute(tx);
      const access = await loadMembershipAccess(tx, s.membership_id);
      const user = await this.loadUser(s.user_id, tx);
      if (
        !access ||
        access.membershipStatus !== 'ACTIVE' ||
        !USABLE_TENANT_STATUSES.has(access.tenantStatus) ||
        user?.status !== 'ACTIVE'
      ) {
        await revokeFamily(tx, s.family_id);
        return { error: new UnauthenticatedError() };
      }
      const tokens = await issueSession(
        tx,
        this.config.jwt,
        this.config,
        {
          userId: s.user_id,
          tenantId: s.tenant_id,
          membershipId: s.membership_id,
          amr: s.amr,
          authTime: s.auth_time,
        },
        { familyId: s.family_id, familyExpiresAt: s.family_expires_at },
      );
      return { tokens };
    });
    // Errors are returned (not thrown) so the revocations above still commit.
    if ('error' in outcome) throw outcome.error;
    return outcome.tokens;
  }

  async logout(principal: Principal): Promise<void> {
    if (!principal.sessionId) return; // API keys have no session; revoke the key instead
    await tenantTx(this.db, principal.tenantId, async (tx) => {
      const { rows } = await sql<{
        family_id: string;
      }>`select family_id from user_sessions where id = ${principal.sessionId}`.execute(tx);
      if (rows[0]) await revokeFamily(tx, rows[0].family_id);
      await recordAudit(tx, {
        tenantId: principal.tenantId,
        action: 'auth.logout',
        resourceType: 'session',
        resourceId: principal.sessionId,
      });
    });
  }

  // ---------------------------------------------------------------- per-request authentication

  /** Resolve a bearer access token into a Principal. Checks revocation and membership on every call. */
  async authenticate(accessToken: string): Promise<Principal> {
    const claims = this.config.jwt.verify(accessToken);
    const [tid, mid, sid, sub] = [claims['tid'], claims['mid'], claims['sid'], claims['sub']];
    if (claims['typ'] !== 'access' || !isUuid(tid) || !isUuid(mid) || !isUuid(sid) || !isUuid(sub)) {
      throw new UnauthenticatedError();
    }
    return tenantTx(this.db, tid, async (tx) => {
      const { rows } = await sql<{ ok: number }>`
        select 1 as ok from user_sessions s join users u on u.id = s.user_id
         where s.id = ${sid} and s.revoked_at is null and u.status = 'ACTIVE'`.execute(tx);
      if (rows.length === 0) throw new UnauthenticatedError();
      const access = await loadMembershipAccess(tx, mid);
      assertUsableMembership(access, sub);
      return {
        kind: 'USER',
        userId: sub,
        tenantId: tid,
        membershipId: mid,
        sessionId: sid,
        apiKeyId: null,
        isOwner: access.isOwner,
        grants: access.grants,
        amr: Array.isArray(claims['amr']) ? claims['amr'].map(String) : [],
        authTime: typeof claims['auth_time'] === 'number' ? claims['auth_time'] : 0,
        mfaEnabled: access.mfaEnabled,
        mfaEnforced: access.mfaEnforced,
      };
    });
  }

  /**
   * Step-up: prove 2FA again to unlock dangerous actions. Issues a new token pair in the same
   * session family with a fresh auth_time and `otp` in amr.
   */
  async stepUp(principal: Principal, code: string): Promise<TokenPair> {
    if (principal.kind !== 'USER' || !principal.sessionId) throw new UnauthenticatedError();
    const user = await this.loadUser(principal.userId);
    if (!user?.mfa_enabled || !user.mfa_totp_secret_enc) {
      throw new BusinessRuleError('MFA_NOT_ENABLED', 'Turn on two-factor authentication first');
    }
    const step = verifyTotp(this.config.secretBox.open(user.mfa_totp_secret_enc, `totp:${user.id}`), code);
    if (step === null || !(await this.claimTotpStep(user.id, step))) {
      await this.recordFailure(user.id);
      throw new UnauthenticatedError('INVALID_MFA_CODE', 'Invalid verification code');
    }
    return tenantTx(this.db, principal.tenantId, async (tx) => {
      const { rows } = await sql<{ family_id: string; family_expires_at: Date }>`
        select family_id, family_expires_at from user_sessions
         where id = ${principal.sessionId} and revoked_at is null`.execute(tx);
      const session = rows[0];
      if (!session) throw new UnauthenticatedError();
      await recordAudit(tx, {
        tenantId: principal.tenantId,
        action: 'auth.step_up',
        resourceType: 'user',
        resourceId: user.id,
      });
      return issueSession(
        tx,
        this.config.jwt,
        this.config,
        {
          userId: user.id,
          tenantId: principal.tenantId,
          membershipId: principal.membershipId,
          amr: ['pwd', 'otp'],
          authTime: new Date(),
        },
        { familyId: session.family_id, familyExpiresAt: session.family_expires_at },
      );
    });
  }

  // ---------------------------------------------------------------- MFA enrolment

  async startMfaEnrolment(principal: Principal): Promise<{ secret: string; otpauthUri: string }> {
    const user = await this.loadUser(principal.userId);
    if (!user) throw new UnauthenticatedError();
    if (user.mfa_enabled)
      throw new BusinessRuleError('MFA_ALREADY_ENABLED', 'Two-factor authentication is already on');
    const secret = generateTotpSecret();
    const sealed = this.config.secretBox.seal(secret, `totp:${user.id}`);
    await platformTx(this.db, (tx) =>
      sql`update users set mfa_totp_secret_enc = ${sealed}, mfa_last_step = null where id = ${user.id}`.execute(
        tx,
      ),
    );
    return {
      secret: base32Encode(secret),
      otpauthUri: otpauthUri(secret, user.email ?? user.id, this.config.totpIssuer),
    };
  }

  async confirmMfaEnrolment(principal: Principal, code: string): Promise<void> {
    const user = await this.loadUser(principal.userId);
    if (!user?.mfa_totp_secret_enc || user.mfa_enabled)
      throw new BusinessRuleError('MFA_NOT_PENDING', 'Start enrolment first');
    const step = verifyTotp(this.config.secretBox.open(user.mfa_totp_secret_enc, `totp:${user.id}`), code);
    if (step === null || !(await this.claimTotpStep(user.id, step))) {
      throw new UnauthenticatedError('INVALID_MFA_CODE', 'Invalid verification code');
    }
    await tenantTx(this.db, principal.tenantId, async (tx) => {
      await sql`update users set mfa_enabled = true where id = ${user.id}`.execute(tx);
      await recordAudit(tx, {
        tenantId: principal.tenantId,
        action: 'auth.mfa.enabled',
        resourceType: 'user',
        resourceId: user.id,
      });
    });
  }

  // ---------------------------------------------------------------- helpers

  /** Used by invitation acceptance to sign the new member in. */
  async startSession(
    userId: string,
    tenantId: string,
    membershipId: string,
    amr: string[],
    tx?: Tx,
  ): Promise<TokenPair> {
    const run = (t: Tx) =>
      issueSession(t, this.config.jwt, this.config, {
        userId,
        tenantId,
        membershipId,
        amr,
        authTime: new Date(),
      });
    if (tx) return run(tx);
    return tenantTx(this.db, tenantId, async (t) => {
      const tokens = await run(t);
      await recordAudit(t, {
        tenantId,
        action: 'auth.login.succeeded',
        resourceType: 'user',
        resourceId: userId,
        actor: { type: 'USER', id: userId },
        after: { amr },
      });
      return tokens;
    });
  }

  private async pickMembership(userId: string, tenantSlug?: string) {
    const { rows } = await platformTx(this.db, (tx) =>
      sql<{
        tenant_id: string;
        tenant_slug: string;
        tenant_name: string;
        tenant_status: string;
        membership_id: string;
        membership_status: string;
      }>`
        select * from auth_user_memberships(${userId})`.execute(tx),
    );
    const usable = rows.filter(
      (r) => r.membership_status === 'ACTIVE' && USABLE_TENANT_STATUSES.has(r.tenant_status),
    );
    const chosen = tenantSlug
      ? usable.find((r) => r.tenant_slug === tenantSlug.toLowerCase())
      : usable.length === 1
        ? usable[0]
        : undefined;
    if (chosen) return chosen;
    if (tenantSlug || usable.length === 0) throw invalidCredentials();
    throw new BusinessRuleError('TENANT_SELECTION_REQUIRED', 'Choose which company to sign in to', {
      tenants: usable.map((r) => ({ slug: r.tenant_slug, name: r.tenant_name })),
    });
  }

  private async findUser(identifier: string): Promise<UserRow | undefined> {
    const id = identifier.trim();
    if (!id || id.length > 320) return undefined;
    const { rows } = await platformTx(this.db, (tx) =>
      id.includes('@')
        ? sql<UserRow>`select ${userCols} from users where email = ${normalizeEmail(id)}`.execute(tx)
        : sql<UserRow>`select ${userCols} from users where phone = ${id}`.execute(tx),
    );
    return rows[0];
  }

  private async loadUser(userId: string, tx?: Tx): Promise<UserRow | undefined> {
    const query = (t: Tx) => sql<UserRow>`select ${userCols} from users where id = ${userId}`.execute(t);
    const { rows } = tx ? await query(tx) : await platformTx(this.db, query);
    return rows[0];
  }

  /** Atomically accept a TOTP step only if it is newer than the last one used (no replays). */
  private async claimTotpStep(userId: string, step: number): Promise<boolean> {
    const { rows } = await platformTx(this.db, (tx) =>
      sql`update users set mfa_last_step = ${step}
           where id = ${userId} and (mfa_last_step is null or mfa_last_step < ${step}) returning id`.execute(
        tx,
      ),
    );
    return rows.length === 1;
  }

  private async recordFailure(userId: string) {
    await platformTx(this.db, (tx) =>
      // An expired lockout starts a fresh count; otherwise the next mistake would re-lock at once.
      sql`with next as (
            select id, case when locked_until < now() then 1 else failed_login_count + 1 end as n
              from users where id = ${userId} for update)
          update users u set failed_login_count = next.n,
                 locked_until = case when next.n >= ${this.config.maxFailedAttempts}
                                     then now() + make_interval(mins => ${this.config.lockoutMinutes})
                                     when u.locked_until < now() then null else u.locked_until end
            from next where u.id = next.id`.execute(tx),
    );
  }

  private async resetFailures(userId: string) {
    await platformTx(this.db, (tx) =>
      sql`update users set failed_login_count = 0, locked_until = null, last_login_at = now() where id = ${userId}`.execute(
        tx,
      ),
    );
  }
}

const userCols = sql`id, email::text as email, password_hash, status, locked_until, mfa_enabled, mfa_totp_secret_enc, mfa_last_step`;

function invalidCredentials() {
  return new UnauthenticatedError('INVALID_CREDENTIALS', 'Invalid e-mail/phone or password');
}

export function normalizeEmail(email: string): string {
  const value = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) || value.length > 254)
    throw new ValidationError('Invalid e-mail address');
  return value;
}

/** Best-effort URL-safe slug from a company name, for `oauthSignup` (password signup asks the user
 *  to pick their own slug directly — this derives one instead, since OAuth signup only collects a
 *  display name). A non-Latin name (e.g. Thai) strips to nothing here, which is fine: `tenants.slug`
 *  is just an internal identifier, not shown to the shop's own customers, and `pickAvailableSlug`'s
 *  random-suffix fallback already keeps it unique either way. */
function slugify(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-+|-+$)/g, '')
    .slice(0, 34);
  return base.length >= 3 ? base : `shop-${uuidv7().slice(-6)}`;
}

/** Membership may act: exists, belongs to the credential's user, active, in a usable tenant. */
export function assertUsableMembership(
  access: MembershipAccess | null,
  userId: string,
): asserts access is MembershipAccess {
  if (
    !access ||
    access.userId !== userId ||
    access.membershipStatus !== 'ACTIVE' ||
    access.userStatus !== 'ACTIVE'
  ) {
    throw new UnauthenticatedError();
  }
  if (!USABLE_TENANT_STATUSES.has(access.tenantStatus)) {
    throw new ForbiddenError(
      'This company account is not active',
      { status: access.tenantStatus },
      'TENANT_INACTIVE',
    );
  }
}
