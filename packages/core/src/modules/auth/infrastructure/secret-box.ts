import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 1;

/**
 * AES-256-GCM for small secrets at rest (TOTP seeds; channel tokens later).
 * Format: [version:1][iv:12][tag:16][ciphertext]. `aad` binds the ciphertext to its owner
 * (e.g. the user id) so a value copied to another row fails to decrypt.
 * Production: the master key comes from KMS (envelope encryption); local: from env.
 */
export class SecretBox {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error('SecretBox key must be 32 bytes');
  }

  seal(plaintext: Buffer, aad: string): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(aad));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), ciphertext]);
  }

  open(sealed: Buffer, aad: string): Buffer {
    if (sealed[0] !== VERSION || sealed.length < 29) throw new Error('Unsupported sealed secret');
    const decipher = createDecipheriv('aes-256-gcm', this.key, sealed.subarray(1, 13));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(sealed.subarray(13, 29));
    return Buffer.concat([decipher.update(sealed.subarray(29)), decipher.final()]);
  }
}
