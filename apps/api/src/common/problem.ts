import { HttpException } from '@nestjs/common';
import { isDomainError } from '@stockos/shared';

/** RFC 9457 problem details, plus StockOS extensions (`code`, `requestId`, `meta`). */
export interface Problem {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
  requestId: string;
  meta?: Readonly<Record<string, unknown>>;
}

const ERROR_DOCS = 'https://docs.stockos.co/errors/';

const STATUS_CODES: Record<number, { code: string; title: string }> = {
  400: { code: 'VALIDATION_FAILED', title: 'Bad request' },
  401: { code: 'UNAUTHENTICATED', title: 'Unauthenticated' },
  403: { code: 'FORBIDDEN', title: 'Forbidden' },
  404: { code: 'NOT_FOUND', title: 'Not found' },
  405: { code: 'METHOD_NOT_ALLOWED', title: 'Method not allowed' },
  409: { code: 'CONFLICT', title: 'Conflict' },
  412: { code: 'PRECONDITION_FAILED', title: 'Precondition failed' },
  413: { code: 'PAYLOAD_TOO_LARGE', title: 'Payload too large' },
  415: { code: 'UNSUPPORTED_MEDIA_TYPE', title: 'Unsupported media type' },
  422: { code: 'UNPROCESSABLE', title: 'Unprocessable request' },
  429: { code: 'RATE_LIMITED', title: 'Too many requests' },
  503: { code: 'DEPENDENCY_UNAVAILABLE', title: 'Service unavailable' },
};

export function toProblem(exception: unknown, requestId: string): Problem {
  if (isDomainError(exception)) {
    return {
      type: ERROR_DOCS + exception.code.toLowerCase().replace(/_/g, '-'),
      title: STATUS_CODES[exception.httpStatus]?.title ?? 'Error',
      status: exception.httpStatus,
      code: exception.code,
      detail: exception.message,
      requestId,
      ...(Object.keys(exception.meta).length ? { meta: exception.meta } : {}),
    };
  }

  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const known = STATUS_CODES[status] ?? {
      code: status >= 500 ? 'INTERNAL_ERROR' : 'HTTP_ERROR',
      title: 'Error',
    };
    return {
      type: ERROR_DOCS + known.code.toLowerCase().replace(/_/g, '-'),
      title: known.title,
      status,
      code: known.code,
      // Framework messages for 5xx may leak internals; only 4xx details are passed through.
      ...(status < 500 ? { detail: exception.message } : {}),
      requestId,
    };
  }

  const status = statusFromFramework(exception);
  if (status !== undefined && status < 500)
    return toProblem(new HttpException(messageOf(exception), status), requestId);

  return {
    type: ERROR_DOCS + 'internal-error',
    title: 'Internal server error',
    status: 500,
    code: 'INTERNAL_ERROR',
    requestId,
  };
}

/** Fastify errors (e.g. body too large, invalid JSON) carry `statusCode`. */
function statusFromFramework(exception: unknown): number | undefined {
  if (typeof exception === 'object' && exception !== null && 'statusCode' in exception) {
    const code = exception.statusCode;
    if (typeof code === 'number' && code >= 400 && code < 600) return code;
  }
  return undefined;
}

function messageOf(exception: unknown): string {
  return exception instanceof Error ? exception.message : 'Request failed';
}
