import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import type { auth } from '@stockos/core';
import { ForbiddenError, UnauthenticatedError } from '@stockos/shared';
import { ACCESS_POLICY, attachPrincipal, type AccessPolicy } from './decorators';

/**
 * Global guard. Fails closed: a route without a declared access policy is rejected, so a
 * forgotten decorator can never expose an endpoint.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authService: auth.AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const policy = this.reflector.getAllAndOverride<AccessPolicy | undefined>(ACCESS_POLICY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!policy) throw new ForbiddenError('This endpoint has no access policy');
    if (policy.kind === 'public') return true;

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const header = request.headers.authorization;
    const match = typeof header === 'string' ? /^Bearer ([A-Za-z0-9._~+/=-]+)$/.exec(header) : null;
    if (!match) throw new UnauthenticatedError();

    const principal = await this.authService.authenticate(match[1]!);
    attachPrincipal(request, principal);

    if (policy.kind === 'permission' && !principal.grants.some((g) => g.permission === policy.permission)) {
      throw new ForbiddenError(`Missing permission ${policy.permission}`, { permission: policy.permission });
    }
    return true;
  }
}
