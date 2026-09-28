import pino, { type Logger } from 'pino';
import { currentContext } from './context';

export type { Logger };

/** Paths that must never reach log storage (tokens, credentials, PII). */
export const REDACT_PATHS = [
  'password',
  '*.password',
  'token',
  '*.token',
  'accessToken',
  '*.accessToken',
  'refreshToken',
  '*.refreshToken',
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  '*.phone',
  '*.email',
  '*.address',
];

export function createLogger(service: string, level: string = process.env['LOG_LEVEL'] ?? 'info'): Logger {
  return pino({
    level,
    base: { service, env: process.env['APP_ENV'] ?? 'local' },
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    timestamp: pino.stdTimeFunctions.isoTime,
    mixin() {
      const ctx = currentContext();
      return ctx ? { request_id: ctx.requestId, trace_id: ctx.traceId, tenant_id: ctx.tenantId } : {};
    },
  });
}
