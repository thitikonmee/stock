/**
 * Base class for expected business errors. Each subclass has a stable `code` that clients can
 * rely on, and an HTTP status used by the API's problem+json filter.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;
  abstract readonly httpStatus: number;

  constructor(
    message: string,
    readonly meta: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends DomainError {
  readonly code = 'VALIDATION_FAILED';
  readonly httpStatus = 400;
}

export class NotFoundError extends DomainError {
  readonly code = 'NOT_FOUND';
  readonly httpStatus = 404;
}

export class InvalidStateTransitionError extends DomainError {
  readonly code = 'INVALID_STATE_TRANSITION';
  readonly httpStatus = 409;
}

export class IdempotencyKeyReusedError extends DomainError {
  readonly code = 'IDEMPOTENCY_KEY_REUSED';
  readonly httpStatus = 422;
}

export type UnauthenticatedCode =
  | 'UNAUTHENTICATED'
  | 'INVALID_CREDENTIALS'
  | 'ACCOUNT_LOCKED'
  | 'TOKEN_EXPIRED'
  | 'TOKEN_REUSED'
  | 'INVALID_MFA_CODE';

/** 401 — who you are could not be established. Messages never reveal which part was wrong. */
export class UnauthenticatedError extends DomainError {
  readonly httpStatus = 401;

  constructor(
    readonly code: UnauthenticatedCode = 'UNAUTHENTICATED',
    message = 'Authentication required',
    meta: Readonly<Record<string, unknown>> = {},
  ) {
    super(message, meta);
  }
}

export type ForbiddenCode =
  | 'FORBIDDEN'
  | 'PRIVILEGE_ESCALATION'
  | 'STEP_UP_REQUIRED'
  | 'MFA_ENROLLMENT_REQUIRED'
  | 'TENANT_INACTIVE'
  | 'PLAN_LIMIT_EXCEEDED';

/** 429 — too many attempts; `retryAfterSec` becomes the Retry-After header. */
export class RateLimitedError extends DomainError {
  readonly code = 'RATE_LIMITED';
  readonly httpStatus = 429;

  constructor(readonly retryAfterSec: number) {
    super('Too many requests, try again later', { retryAfterSec });
  }
}

/** 403 — authenticated, but not allowed. */
export class ForbiddenError extends DomainError {
  readonly httpStatus = 403;

  constructor(
    message = 'Forbidden',
    meta: Readonly<Record<string, unknown>> = {},
    readonly code: ForbiddenCode = 'FORBIDDEN',
  ) {
    super(message, meta);
  }
}

/** 409 — a unique business key is already taken (SKU, branch code, e-mail ...). */
export class ConflictError extends DomainError {
  readonly code = 'DUPLICATE';
  readonly httpStatus = 409;
}

/** 412 — optimistic lock failed: the resource changed since the client read it. */
export class PreconditionFailedError extends DomainError {
  readonly code = 'PRECONDITION_FAILED';
  readonly httpStatus = 412;
}

/** 422 with a machine-readable reason, for business rules that are not plain input validation. */
export class BusinessRuleError extends DomainError {
  readonly httpStatus = 422;

  constructor(
    readonly code: string,
    message: string,
    meta: Readonly<Record<string, unknown>> = {},
  ) {
    super(message, meta);
  }
}

export function isDomainError(err: unknown): err is DomainError {
  return err instanceof DomainError;
}
