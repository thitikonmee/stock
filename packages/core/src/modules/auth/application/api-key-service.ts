import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { PgErrorCode, pgErrorCode, platformTx, tenantTx, type Db, type Tx } from '@stockos/database';
import {
  ForbiddenError,
  hashEquals,
  isUuid,
  newOpaqueToken,
  NotFoundError,
  sha256,
  UnauthenticatedError,
  uuidv7,
  ValidationError,
} from '@stockos/shared';
import { recordAudit } from '../../audit/public-api';
import {
  assertCan,
  isDangerous,
  isPermissionCode,
  loadMembershipAccess,
  tenantWidePermissions,
  type PermissionCode,
  type Principal,
} from '../../iam/public-api';
import { assertUsableMembership } from './auth-service';

// Own prefix so secret scanners (and GitHub secret scanning) can recognise leaked StockOS keys —
// not 'sk_live_', which is Stripe's format and would be reported to the wrong owner.
export const API_KEY_PREFIX = 'sos_live_';
const PREFIX_HEX_LENGTH = 12;
const LAST_USED_WRITE_INTERVAL_SEC = 60;

export interface ApiKey {
  id: string;
  name: string;
  /** Public identifier shown in the UI, e.g. `sos_live_` + 12 hex chars. */
  prefix: string;
  permissions: PermissionCode[];
  ipAllowlist: string[];
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

export interface CreateApiKeyInput {
  name: string;
  permissions: readonly string[];
  expiresInDays?: number;
  ipAllowlist?: readonly string[];
}

/**
 * API keys for integrations. A key acts on behalf of the member who created it and is limited to
 * (key permissions ∩ creator's current permissions). Keys never carry dangerous permissions and
 * cannot manage users, roles or other keys. Only the SHA-256 of the secret is stored.
 */
export class ApiKeyService {
  constructor(private readonly db: Db) {}

  async create(tx: Tx, principal: Principal, input: CreateApiKeyInput): Promise<ApiKey & { secret: string }> {
    assertCan(principal, 'api_key.manage');
    if (principal.kind !== 'USER') throw new ForbiddenError('API keys cannot create API keys');
    const permissions = [...new Set(input.permissions)];
    if (permissions.length === 0) throw new ValidationError('Choose at least one permission');
    const unknown = permissions.filter((p) => !isPermissionCode(p));
    if (unknown.length) throw new ValidationError('Unknown permissions', { permissions: unknown });
    const dangerous = (permissions as PermissionCode[]).filter(isDangerous);
    if (dangerous.length)
      throw new ValidationError('These permissions cannot be given to API keys', { permissions: dangerous });
    const ceiling = tenantWidePermissions(principal);
    const beyond = permissions.filter((p) => !ceiling.has(p as PermissionCode));
    if (beyond.length) {
      throw new ForbiddenError(
        'You cannot grant permissions you do not hold',
        { permissions: beyond },
        'PRIVILEGE_ESCALATION',
      );
    }
    if (input.expiresInDays !== undefined && (input.expiresInDays < 1 || input.expiresInDays > 730)) {
      throw new ValidationError('expiresInDays must be 1-730');
    }

    const id = uuidv7();
    const prefix = randomBytes(PREFIX_HEX_LENGTH / 2).toString('hex');
    const secret = newOpaqueToken();
    const expiresAt = input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000) : null;
    try {
      await sql`insert into api_keys (tenant_id, id, name, prefix, key_hash, permissions, ip_allowlist, expires_at, created_by)
                values (${principal.tenantId}, ${id}, ${input.name}, ${prefix}, ${sha256(secret)}, ${permissions}::text[],
                        ${input.ipAllowlist?.length ? [...input.ipAllowlist] : null}::cidr[], ${expiresAt}, ${principal.membershipId})`.execute(
        tx,
      );
    } catch (err) {
      if (pgErrorCode(err) === PgErrorCode.InvalidTextRepresentation)
        throw new ValidationError('ipAllowlist entries must be IPs or CIDR ranges');
      throw err;
    }
    await recordAudit(tx, {
      tenantId: principal.tenantId,
      action: 'api_key.create',
      resourceType: 'api_key',
      resourceId: id,
      after: { name: input.name, prefix, permissions, ipAllowlist: input.ipAllowlist ?? [], expiresAt },
    });
    const created = (await this.list(tx, principal)).find((k) => k.id === id)!;
    return { ...created, secret: `${API_KEY_PREFIX}${prefix}_${secret}` };
  }

  async list(tx: Tx, principal: Principal): Promise<ApiKey[]> {
    assertCan(principal, 'api_key.manage');
    const { rows } = await sql<{
      id: string;
      name: string;
      prefix: string;
      permissions: string[];
      ip_allowlist: string[] | null;
      expires_at: Date | null;
      last_used_at: Date | null;
      revoked_at: Date | null;
      created_at: Date;
    }>`select id, name, prefix, permissions, array(select host(c) || '/' || masklen(c) from unnest(ip_allowlist) c) as ip_allowlist,
              expires_at, last_used_at, revoked_at, created_at
         from api_keys order by created_at desc`.execute(tx);
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      prefix: `${API_KEY_PREFIX}${r.prefix}`,
      permissions: r.permissions.filter(isPermissionCode),
      ipAllowlist: r.ip_allowlist ?? [],
      expiresAt: r.expires_at,
      lastUsedAt: r.last_used_at,
      revokedAt: r.revoked_at,
      createdAt: r.created_at,
    }));
  }

  async revoke(tx: Tx, principal: Principal, id: string): Promise<void> {
    assertCan(principal, 'api_key.manage');
    if (!isUuid(id)) throw new NotFoundError('API key not found');
    const { rows } = await sql<{ id: string }>`
      update api_keys set revoked_at = coalesce(revoked_at, now()) where id = ${id} returning id`.execute(tx);
    if (rows.length === 0) throw new NotFoundError('API key not found');
    await recordAudit(tx, {
      tenantId: principal.tenantId,
      action: 'api_key.revoke',
      resourceType: 'api_key',
      resourceId: id,
    });
  }

  /** Resolve `sos_live_<prefix>_<secret>` into a Principal. */
  async authenticate(token: string, ip: string | undefined): Promise<Principal> {
    const body = token.startsWith(API_KEY_PREFIX) ? token.slice(API_KEY_PREFIX.length) : '';
    const prefix = body.slice(0, PREFIX_HEX_LENGTH);
    const secret = body.slice(PREFIX_HEX_LENGTH + 1);
    if (!/^[0-9a-f]{12}$/.test(prefix) || body[PREFIX_HEX_LENGTH] !== '_' || !secret)
      throw new UnauthenticatedError();

    const { rows } = await platformTx(this.db, (tx) =>
      sql<{
        tenant_id: string;
        id: string;
        key_hash: Buffer;
        permissions: string[];
        expires_at: Date | null;
        revoked_at: Date | null;
        created_by: string;
        ip_ok: boolean | null;
        rate_limit_per_min: number;
      }>`select tenant_id, id, key_hash, permissions, expires_at, revoked_at, created_by, rate_limit_per_min,
                (ip_allowlist is null or cardinality(ip_allowlist) = 0 or ${ip ?? null}::inet <<= any(ip_allowlist)) as ip_ok
           from auth_api_key(${prefix})`.execute(tx),
    );
    const key = rows[0];
    if (
      !key ||
      !hashEquals(key.key_hash, sha256(secret)) ||
      key.revoked_at ||
      (key.expires_at && key.expires_at < new Date())
    ) {
      throw new UnauthenticatedError();
    }
    if (!key.ip_ok) throw new ForbiddenError('This API key cannot be used from this IP address');

    return tenantTx(this.db, key.tenant_id, async (tx) => {
      const access = await loadMembershipAccess(tx, key.created_by);
      if (!access) throw new UnauthenticatedError();
      assertUsableMembership(access, access.userId);
      await sql`update api_keys set last_used_at = now()
                 where id = ${key.id}
                   and (last_used_at is null or last_used_at < now() - make_interval(secs => ${LAST_USED_WRITE_INTERVAL_SEC}))`.execute(
        tx,
      );
      const allowed = new Set(key.permissions);
      return {
        kind: 'API_KEY',
        userId: access.userId,
        tenantId: key.tenant_id,
        membershipId: key.created_by,
        sessionId: null,
        apiKeyId: key.id,
        isOwner: false,
        grants: access.grants.filter((g) => allowed.has(g.permission) && !isDangerous(g.permission)),
        amr: [],
        authTime: 0,
        mfaEnabled: false,
        mfaEnforced: false,
        rateLimitPerMin: key.rate_limit_per_min,
      };
    });
  }
}
