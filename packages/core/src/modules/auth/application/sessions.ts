import { sql } from 'kysely';
import type { Tx } from '@stockos/database';
import { uuidv7 } from '@stockos/shared';
import type { JwtService } from '../infrastructure/jwt';
import { newOpaqueToken, sha256 } from '../infrastructure/opaque-token';

export interface TokenPair {
  tokenType: 'Bearer';
  accessToken: string;
  refreshToken: string;
  /** Access token lifetime in seconds. */
  expiresIn: number;
}

export interface SessionSubject {
  userId: string;
  tenantId: string;
  membershipId: string;
  amr: readonly string[];
  authTime: Date;
}

export interface SessionTtls {
  accessTokenTtlSec: number;
  refreshTokenTtlSec: number;
  refreshAbsoluteTtlSec: number;
}

/**
 * Start (or continue, when `familyId` is given) a refresh-token family and mint a token pair.
 * The refresh token is opaque; only its SHA-256 is stored.
 */
export async function issueSession(
  tx: Tx,
  jwt: JwtService,
  ttls: SessionTtls,
  subject: SessionSubject,
  family?: { familyId: string; familyExpiresAt: Date },
): Promise<TokenPair> {
  const now = Date.now();
  const sessionId = uuidv7();
  const familyId = family?.familyId ?? uuidv7();
  const familyExpiresAt = family?.familyExpiresAt ?? new Date(now + ttls.refreshAbsoluteTtlSec * 1000);
  const expiresAt = new Date(Math.min(now + ttls.refreshTokenTtlSec * 1000, familyExpiresAt.getTime()));
  const refreshToken = newOpaqueToken();

  await sql`
    insert into user_sessions (id, user_id, tenant_id, membership_id, family_id, refresh_token_hash,
                               amr, auth_time, expires_at, family_expires_at)
    values (${sessionId}, ${subject.userId}, ${subject.tenantId}, ${subject.membershipId}, ${familyId},
            ${sha256(refreshToken)}, ${[...subject.amr]}::text[], ${subject.authTime}, ${expiresAt}, ${familyExpiresAt})`.execute(
    tx,
  );

  const accessToken = jwt.sign(
    {
      typ: 'access',
      sub: subject.userId,
      tid: subject.tenantId,
      mid: subject.membershipId,
      sid: sessionId,
      amr: subject.amr,
      auth_time: Math.floor(subject.authTime.getTime() / 1000),
    },
    ttls.accessTokenTtlSec,
  );
  return { tokenType: 'Bearer', accessToken, refreshToken, expiresIn: ttls.accessTokenTtlSec };
}

export async function revokeFamily(tx: Tx, familyId: string): Promise<void> {
  await sql`update user_sessions set revoked_at = now() where family_id = ${familyId} and revoked_at is null`.execute(
    tx,
  );
}
