import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Observable } from 'rxjs';
import { runWithContext } from '@stockos/shared';

const TRACEPARENT_RE = /^[\da-f]{2}-([\da-f]{32})-[\da-f]{16}-[\da-f]{2}$/;

/**
 * Runs each handler inside an AsyncLocalStorage context so logs, audit rows and outbox headers
 * pick up request_id / trace_id without passing them through every call.
 * Tenant and actor are added by the auth guard (Phase 1).
 */
@Injectable()
export class RequestContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const traceparent = request.headers['traceparent'];
    const traceId = typeof traceparent === 'string' ? TRACEPARENT_RE.exec(traceparent)?.[1] : undefined;

    return new Observable((subscriber) =>
      runWithContext({ requestId: request.id, ...(traceId ? { traceId } : {}) }, () =>
        next.handle().subscribe(subscriber),
      ),
    );
  }
}
