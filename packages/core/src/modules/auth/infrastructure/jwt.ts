import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { UnauthenticatedError } from '@stockos/shared';

/**
 * Minimal ES256 JWT (RFC 7519) with key ids for rotation. Deliberately strict: only `ES256`
 * is accepted (no `none`, no HS* confusion), and iss/aud/exp are always checked.
 */
export interface JwtKeys {
  /** kid used for signing new tokens. */
  currentKid: string;
  privateKeyPem: string;
  /** Public keys still accepted for verification (includes the current one automatically). */
  previousPublicKeysPem?: Readonly<Record<string, string>>;
}

export interface JwtOptions {
  issuer: string;
  audience: string;
  /** Allowed clock skew in seconds. */
  clockToleranceSec?: number;
}

export type JwtClaims = Record<string, unknown> & { exp: number; iat: number };

const b64url = (input: Buffer | string) => Buffer.from(input).toString('base64url');

export class JwtService {
  private readonly privateKey: KeyObject;
  private readonly publicKeys: Map<string, KeyObject>;

  constructor(
    private readonly keys: JwtKeys,
    private readonly options: JwtOptions,
  ) {
    this.privateKey = createPrivateKey(keys.privateKeyPem);
    if (
      this.privateKey.asymmetricKeyType !== 'ec' ||
      this.privateKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
    ) {
      throw new Error('JWT signing key must be an EC P-256 private key');
    }
    this.publicKeys = new Map([[keys.currentKid, createPublicKey(this.privateKey)]]);
    for (const [kid, pem] of Object.entries(keys.previousPublicKeysPem ?? {})) {
      this.publicKeys.set(kid, createPublicKey(pem));
    }
  }

  sign(claims: Record<string, unknown>, ttlSec: number, now = Math.floor(Date.now() / 1000)): string {
    const header = b64url(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: this.keys.currentKid }));
    const payload = b64url(
      JSON.stringify({
        ...claims,
        iss: this.options.issuer,
        aud: this.options.audience,
        iat: now,
        exp: now + ttlSec,
      }),
    );
    const signature = sign('sha256', Buffer.from(`${header}.${payload}`), {
      key: this.privateKey,
      dsaEncoding: 'ieee-p1363',
    });
    return `${header}.${payload}.${b64url(signature)}`;
  }

  verify(token: string, now = Math.floor(Date.now() / 1000)): JwtClaims {
    const invalid = () => new UnauthenticatedError('UNAUTHENTICATED', 'Invalid token');
    const parts = token.split('.');
    if (parts.length !== 3) throw invalid();
    const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

    let header: { alg?: unknown; kid?: unknown };
    let claims: Record<string, unknown>;
    try {
      header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8')) as typeof header;
      claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as Record<string, unknown>;
    } catch {
      throw invalid();
    }
    if (header.alg !== 'ES256' || typeof header.kid !== 'string') throw invalid();
    const key = this.publicKeys.get(header.kid);
    if (!key) throw invalid();

    const ok = verify(
      'sha256',
      Buffer.from(`${headerB64}.${payloadB64}`),
      { key, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signatureB64, 'base64url'),
    );
    if (!ok) throw invalid();

    const tolerance = this.options.clockToleranceSec ?? 30;
    if (claims['iss'] !== this.options.issuer || claims['aud'] !== this.options.audience) throw invalid();
    if (typeof claims['exp'] !== 'number' || typeof claims['iat'] !== 'number') throw invalid();
    if (claims['exp'] + tolerance < now) throw new UnauthenticatedError('TOKEN_EXPIRED', 'Token expired');
    if (claims['iat'] - tolerance > now) throw invalid();
    return claims as JwtClaims;
  }
}
