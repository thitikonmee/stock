#!/usr/bin/env node
// Local full stack without Docker: embedded PostgreSQL 16 + API + web.
//   pnpm dev:stack        → API http://localhost:3000, web http://localhost:3100
// Data persists in .pg-dev/ (delete it to start over). Dev secrets live in .secrets/ (gitignored).
// E-mails are printed to the API log (no SMTP needed). Not for production.
import { spawn, execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'package.json'));
const { default: EmbeddedPostgres } = require('embedded-postgres');

const PG_PORT = Number(process.env.DEV_PG_PORT ?? 54320);
const secrets = join(root, '.secrets');
mkdirSync(secrets, { recursive: true, mode: 0o700 });

const keyFile = join(secrets, 'jwt-private.pem');
if (!existsSync(keyFile)) {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
}
const masterKeyFile = join(secrets, 'dev-master.key');
if (!existsSync(masterKeyFile))
  writeFileSync(masterKeyFile, randomBytes(32).toString('base64'), { mode: 0o600 });

const dataDir = join(root, '.pg-dev');
const fresh = !existsSync(join(dataDir, 'PG_VERSION'));
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'stockos_admin',
  password: 'stockos_admin',
  port: PG_PORT,
  persistent: true,
  onLog: () => {},
});
if (fresh) await pg.initialise();
await pg.start();
if (fresh) await pg.createDatabase('stockos');

const env = {
  ...process.env,
  NODE_ENV: 'development',
  APP_ENV: 'local',
  LOG_LEVEL: process.env.LOG_LEVEL ?? 'info',
  DATABASE_URL_ADMIN: `postgres://stockos_admin:stockos_admin@localhost:${PG_PORT}/stockos`,
  DATABASE_URL: `postgres://stockos_app:stockos_app@localhost:${PG_PORT}/stockos`,
  DATABASE_URL_PLATFORM: `postgres://stockos_platform:stockos_platform@localhost:${PG_PORT}/stockos`,
  JWT_PRIVATE_KEY_PATH: keyFile,
  LOCAL_MASTER_KEY_BASE64: readFileSync(masterKeyFile, 'utf8').trim(),
  PASSWORD_ARGON2_MEMORY_KB: '19456',
  PUBLIC_WEB_BASE_URL: 'http://localhost:3100',
  API_URL: 'http://localhost:3000',
  NEXT_TELEMETRY_DISABLED: '1',
};
delete env.SMTP_HOST; // print e-mails instead of sending

// Use pnpm if installed; otherwise put a corepack shim (version pinned in package.json) on PATH,
// because package scripts call `pnpm` themselves.
const pnpm = (() => {
  try {
    execFileSync('pnpm', ['--version'], { stdio: 'ignore', env });
  } catch {
    const shimDir = mkdtempSync(join(tmpdir(), 'stockos-pnpm-'));
    execFileSync('corepack', ['enable', '--install-directory', shimDir, 'pnpm'], { stdio: 'ignore' });
    env.PATH = `${shimDir}${delimiter}${env.PATH ?? ''}`;
    env.COREPACK_ENABLE_DOWNLOAD_PROMPT = '0';
  }
  return ['pnpm'];
})();
const run = (args) =>
  execFileSync(pnpm[0], [...pnpm.slice(1), ...args], { cwd: root, env, stdio: 'inherit' });
run(['db:migrate']);
run(['db:local-roles']);
run(['--filter', '@stockos/api...', 'build']);

const children = [
  spawn('node', ['apps/api/dist/main.js'], { cwd: root, env: { ...env, PORT: '3000' }, stdio: 'inherit' }),
  spawn(pnpm[0], [...pnpm.slice(1), '--filter', '@stockos/web', 'dev'], { cwd: root, env, stdio: 'inherit' }),
];

const stop = async () => {
  for (const child of children) child.kill('SIGTERM');
  await pg.stop();
  process.exit(0);
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
for (const child of children) child.on('exit', (code) => code && code !== 0 && void stop());
