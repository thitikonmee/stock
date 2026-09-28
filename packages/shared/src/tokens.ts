import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** 256-bit random token for refresh tokens / invitations. Only the SHA-256 is ever stored. */
export function newOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

export function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

export function hashEquals(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
