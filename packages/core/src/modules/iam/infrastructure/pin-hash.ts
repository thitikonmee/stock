import { hash, verify } from '@node-rs/argon2';
import { ValidationError } from '@stockos/shared';

/** 4-6 digits, like every Thai POS terminal's cashier PIN (docs/05-pos.md §15). */
export const PIN_RE = /^\d{4,6}$/;

// Same memory-hard algorithm as account passwords (packages/core/src/modules/auth/infrastructure/password.ts);
// low-entropy digits need it even more, since a leaked hash is otherwise cheap to brute-force.
const PIN_PARAMS = { memoryCost: 65536, timeCost: 3, parallelism: 1, algorithm: 2 as const };

export function assertAcceptablePin(pin: string): void {
  if (!PIN_RE.test(pin)) throw new ValidationError('PIN must be 4-6 digits');
}

export async function hashPin(pin: string): Promise<string> {
  assertAcceptablePin(pin);
  return hash(pin, PIN_PARAMS);
}

export async function verifyPin(pinHash: string | null | undefined, pin: string): Promise<boolean> {
  if (!pinHash || !PIN_RE.test(pin)) return false;
  return verify(pinHash, pin).catch(() => false);
}
