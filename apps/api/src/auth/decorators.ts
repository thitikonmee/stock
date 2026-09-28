import { createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { UnauthenticatedError } from '@stockos/shared';
import type { iam } from '@stockos/core';

export const ACCESS_POLICY = 'stockos:access-policy';

/**
 * Every route must declare exactly one access policy; the global AuthGuard rejects routes without
 * one (fail closed), and a test checks all registered routes.
 */
export type AccessPolicy =
  { kind: 'public' } | { kind: 'authenticated' } | { kind: 'permission'; permission: iam.PermissionCode };

/** No authentication (signup, login, health, webhooks). */
export const Public = () => SetMetadata(ACCESS_POLICY, { kind: 'public' } satisfies AccessPolicy);

/** Any signed-in member; the service decides what they may see. */
export const Authenticated = () =>
  SetMetadata(ACCESS_POLICY, { kind: 'authenticated' } satisfies AccessPolicy);

/**
 * Caller must hold the permission at some scope. This is an early filter only — services still
 * check the precise resource scope (branch/warehouse) with `assertCan`.
 */
export const RequirePermission = (permission: iam.PermissionCode) =>
  SetMetadata(ACCESS_POLICY, { kind: 'permission', permission } satisfies AccessPolicy);

const PRINCIPAL = Symbol('principal');

export function attachPrincipal(request: FastifyRequest, principal: iam.Principal): void {
  (request as unknown as Record<symbol, unknown>)[PRINCIPAL] = principal;
}

export function principalOf(request: FastifyRequest): iam.Principal | undefined {
  return (request as unknown as Record<symbol, iam.Principal | undefined>)[PRINCIPAL];
}

/** Inject the authenticated principal into a handler parameter. */
export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): iam.Principal => {
    const principal = principalOf(ctx.switchToHttp().getRequest<FastifyRequest>());
    if (!principal) throw new UnauthenticatedError();
    return principal;
  },
);
