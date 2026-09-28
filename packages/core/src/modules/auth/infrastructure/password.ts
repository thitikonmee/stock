import { hash, verify } from '@node-rs/argon2';
import { ValidationError } from '@stockos/shared';

export interface PasswordHashingParams {
  /** KiB. Production 65536 (64 MB); tests use a small value. */
  memoryCost: number;
  timeCost: number;
  parallelism: number;
}

export const PRODUCTION_PASSWORD_PARAMS: PasswordHashingParams = {
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
};

const MIN_LENGTH = 10;
const MAX_LENGTH = 256;

export class PasswordHasher {
  /** Hash used to spend the same time when the account does not exist (no user enumeration). */
  private dummyHash: Promise<string> | undefined;

  constructor(private readonly params: PasswordHashingParams = PRODUCTION_PASSWORD_PARAMS) {}

  async hash(password: string): Promise<string> {
    assertAcceptablePassword(password);
    return hash(password, { ...this.params, algorithm: 2 /* Argon2id */ });
  }

  async verify(passwordHash: string | null | undefined, password: string): Promise<boolean> {
    if (password.length > MAX_LENGTH) return false;
    if (!passwordHash) {
      this.dummyHash ??= hash('dummy-password-for-timing', { ...this.params, algorithm: 2 });
      await verify(await this.dummyHash, password).catch(() => false);
      return false;
    }
    return verify(passwordHash, password).catch(() => false);
  }
}

export function assertAcceptablePassword(password: string): void {
  if (password.length < MIN_LENGTH || password.length > MAX_LENGTH) {
    throw new ValidationError(`Password must be ${MIN_LENGTH}-${MAX_LENGTH} characters`);
  }
  if (new Set(password).size < 4) throw new ValidationError('Password is too simple');
}
