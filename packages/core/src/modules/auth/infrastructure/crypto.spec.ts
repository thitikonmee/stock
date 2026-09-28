import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { UnauthenticatedError } from '@stockos/shared';
import { JwtService } from './jwt';
import { PasswordHasher } from './password';
import { SecretBox } from './secret-box';
import { base32Encode, otpauthUri, totpAt, verifyTotp } from './totp';

const pem = () =>
  generateKeyPairSync('ec', { namedCurve: 'P-256' })
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString();
const opts = { issuer: 'https://api.stockos.test', audience: 'stockos-api' };

describe('JwtService', () => {
  const jwt = new JwtService({ currentKid: 'k1', privateKeyPem: pem() }, opts);

  it('round-trips claims', () => {
    const claims = jwt.verify(jwt.sign({ sub: 'u1', tid: 't1' }, 60));
    expect(claims).toMatchObject({ sub: 'u1', tid: 't1', iss: opts.issuer, aud: opts.audience });
  });

  it('rejects expired, tampered, foreign and alg-confused tokens', () => {
    const now = 1_800_000_000;
    const token = jwt.sign({ sub: 'u1' }, 60, now);
    expect(() => jwt.verify(token, now + 120)).toThrow(expect.objectContaining({ code: 'TOKEN_EXPIRED' }));

    const [h, p, s] = token.split('.') as [string, string, string];
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), sub: 'admin' }),
    ).toString('base64url');
    expect(() => jwt.verify(`${h}.${forged}.${s}`, now)).toThrow(UnauthenticatedError);

    const none = Buffer.from(JSON.stringify({ alg: 'none', kid: 'k1' })).toString('base64url');
    expect(() => jwt.verify(`${none}.${p}.`, now)).toThrow(UnauthenticatedError);

    const other = new JwtService({ currentKid: 'k1', privateKeyPem: pem() }, opts);
    expect(() => jwt.verify(other.sign({ sub: 'u1' }, 60, now), now)).toThrow(UnauthenticatedError);

    const wrongAud = new JwtService({ currentKid: 'k1', privateKeyPem: pem() }, { ...opts, audience: 'x' });
    expect(() => wrongAud.verify(token, now)).toThrow(UnauthenticatedError);
  });

  it('keeps accepting tokens signed with a rotated-out key', () => {
    const oldPem = pem();
    const old = new JwtService({ currentKid: 'k1', privateKeyPem: oldPem }, opts);
    const token = old.sign({ sub: 'u1' }, 60);
    const oldPublicPem = createPublicKey(oldPem).export({ type: 'spki', format: 'pem' }).toString();
    const rotated = new JwtService(
      { currentKid: 'k2', privateKeyPem: pem(), previousPublicKeysPem: { k1: oldPublicPem } },
      opts,
    );
    expect(rotated.verify(token)).toMatchObject({ sub: 'u1' });
  });
});

describe('TOTP (RFC 6238)', () => {
  const rfcSecret = Buffer.from('12345678901234567890');

  it('matches the RFC test vectors (SHA1, 8 digits)', () => {
    expect(totpAt(rfcSecret, Math.floor(59 / 30), 8)).toBe('94287082');
    expect(totpAt(rfcSecret, Math.floor(1111111109 / 30), 8)).toBe('07081804');
    expect(totpAt(rfcSecret, Math.floor(2000000000 / 30), 8)).toBe('69279037');
  });

  it('accepts the current code with ±1 step drift and rejects others', () => {
    const now = 1_800_000_000_000;
    const step = Math.floor(now / 30_000);
    expect(verifyTotp(rfcSecret, totpAt(rfcSecret, step), now)).toBe(step);
    expect(verifyTotp(rfcSecret, totpAt(rfcSecret, step - 1), now)).toBe(step - 1);
    expect(verifyTotp(rfcSecret, totpAt(rfcSecret, step - 3), now)).toBeNull();
    expect(verifyTotp(rfcSecret, 'abcdef', now)).toBeNull();
  });

  it('encodes base32 and otpauth URIs', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(otpauthUri(rfcSecret, 'a@b.co', 'StockOS')).toMatch(
      /^otpauth:\/\/totp\/StockOS%3Aa%40b\.co\?secret=GEZDGNBV/,
    );
  });
});

describe('SecretBox', () => {
  const box = new SecretBox(Buffer.alloc(32, 7));

  it('encrypts and binds to its owner', () => {
    const sealed = box.seal(Buffer.from('seed'), 'user:1');
    expect(box.open(sealed, 'user:1').toString()).toBe('seed');
    expect(() => box.open(sealed, 'user:2')).toThrow();
  });
});

describe('PasswordHasher', () => {
  const hasher = new PasswordHasher({ memoryCost: 1024, timeCost: 1, parallelism: 1 });

  it('hashes with argon2id and verifies', async () => {
    const h = await hasher.hash('correct horse battery');
    expect(h.startsWith('$argon2id$')).toBe(true);
    expect(await hasher.verify(h, 'correct horse battery')).toBe(true);
    expect(await hasher.verify(h, 'wrong horse battery')).toBe(false);
    expect(await hasher.verify(null, 'anything at all')).toBe(false);
  });

  it('rejects weak passwords', async () => {
    await expect(hasher.hash('short')).rejects.toThrow();
    await expect(hasher.hash('aaaaaaaaaaaa')).rejects.toThrow();
  });
});
