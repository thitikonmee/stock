import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { auth } from '@stockos/core';

/** Auth configuration for tests: fresh keys, cheap password hashing, production timings. */
export function testAuthConfig(overrides: Partial<auth.AuthConfig> = {}): auth.AuthConfig {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    ...auth.DEFAULT_AUTH_TIMINGS,
    jwt: new auth.JwtService(
      { currentKid: 'test-1', privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() },
      { issuer: 'https://api.stockos.test', audience: 'stockos-api' },
    ),
    hasher: new auth.PasswordHasher({ memoryCost: 1024, timeCost: 1, parallelism: 1 }),
    secretBox: new auth.SecretBox(randomBytes(32)),
    oauthProviders: {},
    ...overrides,
  };
}
