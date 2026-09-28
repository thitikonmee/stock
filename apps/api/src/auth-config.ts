import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { Env } from '@stockos/config';
import { auth } from '@stockos/core';

/** Build the auth configuration from validated env. Paths are relative to the repo root. */
export function authConfigFromEnv(env: Env, repoRoot: string): auth.AuthConfig {
  const read = (p: string) => readFileSync(isAbsolute(p) ? p : resolve(repoRoot, p), 'utf8');
  const previous = env.JWT_PREVIOUS_PUBLIC_KEYS_PATH
    ? (JSON.parse(read(env.JWT_PREVIOUS_PUBLIC_KEYS_PATH)) as Record<string, string>)
    : {};

  return {
    ...auth.DEFAULT_AUTH_TIMINGS,
    accessTokenTtlSec: env.ACCESS_TOKEN_TTL_SEC,
    refreshTokenTtlSec: env.REFRESH_TOKEN_TTL_DAYS * 24 * 3600,
    refreshAbsoluteTtlSec: env.REFRESH_TOKEN_ABSOLUTE_DAYS * 24 * 3600,
    jwt: new auth.JwtService(
      {
        currentKid: env.JWT_KID,
        privateKeyPem: read(env.JWT_PRIVATE_KEY_PATH),
        previousPublicKeysPem: previous,
      },
      { issuer: env.JWT_ISSUER, audience: env.JWT_AUDIENCE },
    ),
    hasher: new auth.PasswordHasher({
      ...auth.PRODUCTION_PASSWORD_PARAMS,
      memoryCost: env.PASSWORD_ARGON2_MEMORY_KB,
    }),
    secretBox: new auth.SecretBox(Buffer.from(env.LOCAL_MASTER_KEY_BASE64, 'base64')),
  };
}
