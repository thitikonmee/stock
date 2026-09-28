import type { z } from 'zod';
import { ValidationError } from '@stockos/shared';

/** Parse untrusted input with a zod schema; unknown keys are rejected (no mass assignment). */
export function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input ?? {});
  if (!result.success) {
    throw new ValidationError('Invalid request', {
      errors: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return result.data;
}

/** `If-Match: "v3"` → 3. Required for updates guarded by optimistic locking. */
export function parseIfMatch(header: string | string[] | undefined): number {
  const value = Array.isArray(header) ? header[0] : header;
  const match = value ? /^(?:W\/)?"v(\d+)"$/.exec(value.trim()) : null;
  if (!match) throw new ValidationError('If-Match header with the resource ETag is required');
  return Number(match[1]);
}
