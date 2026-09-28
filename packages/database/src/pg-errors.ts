/** Postgres SQLSTATE codes the application reacts to. */
export const PgErrorCode = {
  UniqueViolation: '23505',
  ForeignKeyViolation: '23503',
  CheckViolation: '23514',
  InvalidTextRepresentation: '22P02',
  SerializationFailure: '40001',
  DeadlockDetected: '40P01',
  LockNotAvailable: '55P03',
  QueryCanceled: '57014',
  InsufficientPrivilege: '42501',
} as const;

const RETRYABLE: ReadonlySet<string> = new Set([
  PgErrorCode.SerializationFailure,
  PgErrorCode.DeadlockDetected,
  PgErrorCode.LockNotAvailable,
]);

export function pgErrorCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string') {
    return err.code;
  }
  return undefined;
}

/** Transient concurrency failures: safe to retry the whole transaction. */
export function isRetryableTxError(err: unknown): boolean {
  const code = pgErrorCode(err);
  return code !== undefined && RETRYABLE.has(code);
}
