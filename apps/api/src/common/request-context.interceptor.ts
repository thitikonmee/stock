import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Observable } from 'rxjs';
import { runWithContext } from '@stockos/shared';
import { principalOf } from '../auth/decorators';

const TRACEPARENT_RE = /^[\da-f]{2}-([\da-f]{32})-[\da-f]{16}-[\da-f]{2}$/;

/**
 * Runs each handler inside an AsyncLocalStorage context so logs, audit rows and outbox headers
 * pick up request id, trace id, tenant, actor, IP and user agent without passing them around.
 * Guards run before interceptors, so the principal (if any) is already resolved here.
 */
@Injectable()
export class RequestContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const traceparent = request.headers['traceparent'];
    const traceId = typeof traceparent === 'string' ? TRACEPARENT_RE.exec(traceparent)?.[1] : undefined;
    const userAgent = request.headers['user-agent'];
    const principal = principalOf(request);

    return new Observable((subscriber) =>
      runWithContext(
        {
          requestId: request.id,
          ...(traceId ? { traceId } : {}),
          ...(principal
            ? {
                tenantId: principal.tenantId,
                actor: { type: 'USER' as const, id: principal.userId, membershipId: principal.membershipId },
              }
            : {}),
          ip: request.ip,
          ...(typeof userAgent === 'string' ? { userAgent } : {}),
        },
        () => next.handle().subscribe(subscriber),
      ),
    );
  }
}
