// Generate LOCAL development secrets: JWT signing key and the master key for SecretBox.
// Usage: pnpm gen:keys   (never use these for staging/prod — those come from Secrets Manager/KMS)
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..', '..', '..');
const dir = resolve(root, '.secrets');
const keyFile = resolve(dir, 'jwt-private.pem');

mkdirSync(dir, { recursive: true, mode: 0o700 });
if (existsSync(keyFile)) {
  console.log(`${keyFile} already exists — delete it first to rotate`);
} else {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  console.log(`wrote ${keyFile}`);
}
console.log('\nAdd to .env:');
console.log(`LOCAL_MASTER_KEY_BASE64=${randomBytes(32).toString('base64')}`);
