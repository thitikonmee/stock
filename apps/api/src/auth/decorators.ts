import { applyDecorators, createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { UnauthenticatedError } from '@stockos/shared';
import type { iam, tenancy } from '@stockos/core';

export const ACCESS_POLICY = 'stockos:access-policy';
export const ALLOW_WITHOUT_MFA = 'stockos:allow-without-mfa';
export const RATE_LIMIT = 'stockos:rate-limit';

/**
 * Every route must declare exactly one access policy; the global AuthGuard rejects routes without
 * one (fail closed), and a test checks all registered routes.
 */
export type AccessPolicy =
  | { kind: 'public' }
  | { kind: 'authenticated' }
  | { kind: 'permission'; permission: iam.PermissionCode }
  | { kind: 'device' };

/** No authentication (signup, login, health, webhooks). */
export const Public = () => SetMetadata(ACCESS_POLICY, { kind: 'public' } satisfies AccessPolicy);

/** Any signed-in member or API key; the service decides what they may see. */
export const Authenticated = () =>
  SetMetadata(ACCESS_POLICY, { kind: 'authenticated' } satisfies AccessPolicy);

/**
 * Caller must hold the permission at some scope. This is an early filter only — services still
 * check the precise resource scope (branch/warehouse) with `assertCan`.
 */
export const RequirePermission = (permission: iam.PermissionCode) =>
  SetMetadata(ACCESS_POLICY, { kind: 'permission', permission } satisfies AccessPolicy);

/** A registered POS device (`Authorization: Device <token>`), not a person. */
export const DeviceAuth = () => SetMetadata(ACCESS_POLICY, { kind: 'device' } satisfies AccessPolicy);

/**
 * Still reachable when the tenant requires 2FA and the caller has not enrolled yet —
 * only what is needed to enrol (me, mfa setup/confirm, logout).
 */
export const AllowWithoutMfa = () => SetMetadata(ALLOW_WITHOUT_MFA, true);

export type RateLimitName =
  'signup' | 'login' | 'mfa' | 'refresh' | 'invitation-accept' | 'device-register' | 'oauth';

/** Per-client-IP fixed-window limit for abuse-prone endpoints (limits configured in AppDeps). */
export const RateLimit = (name: RateLimitName) => applyDecorators(SetMetadata(RATE_LIMIT, name));

const PRINCIPAL = Symbol('principal');
const DEVICE = Symbol('device');

export function attachPrincipal(request: FastifyRequest, principal: iam.Principal): void {
  (request as unknown as Record<symbol, unknown>)[PRINCIPAL] = principal;
}

export function principalOf(request: FastifyRequest): iam.Principal | undefined {
  return (request as unknown as Record<symbol, iam.Principal | undefined>)[PRINCIPAL];
}

export function attachDevice(request: FastifyRequest, device: tenancy.DevicePrincipal): void {
  (request as unknown as Record<symbol, unknown>)[DEVICE] = device;
}

export function deviceOf(request: FastifyRequest): tenancy.DevicePrincipal | undefined {
  return (request as unknown as Record<symbol, tenancy.DevicePrincipal | undefined>)[DEVICE];
}

/** Inject the authenticated principal into a handler parameter. */
export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): iam.Principal => {
    const principal = principalOf(ctx.switchToHttp().getRequest<FastifyRequest>());
    if (!principal) throw new UnauthenticatedError();
    return principal;
  },
);

/** Inject the authenticated POS device into a handler parameter. */
export const CurrentDevice = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): tenancy.DevicePrincipal => {
    const device = deviceOf(ctx.switchToHttp().getRequest<FastifyRequest>());
    if (!device) throw new UnauthenticatedError();
    return device;
  },
);
