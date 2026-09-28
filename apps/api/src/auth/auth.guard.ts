import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { auth, iam, type tenancy } from '@stockos/core';
import type { PgRateLimiter } from '@stockos/database';
import { ForbiddenError, RateLimitedError, UnauthenticatedError } from '@stockos/shared';
import {
  ACCESS_POLICY,
  ALLOW_WITHOUT_MFA,
  attachDevice,
  attachPrincipal,
  type AccessPolicy,
} from './decorators';

const TOKEN_RE = /^(Bearer|Device) ([A-Za-z0-9._~+/=-]+)$/;

/**
 * Global guard. Fails closed: a route without a declared access policy is rejected, so a
 * forgotten decorator can never expose an endpoint. Also enforces the tenant's 2FA policy:
 * - members holding dangerous permissions must enrol 2FA once the grace period ends;
 * - members with 2FA must have proved it within `stepUpMaxAgeSec` for dangerous permissions.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authService: auth.AuthService,
    private readonly apiKeys: auth.ApiKeyService,
    private readonly devices: tenancy.DeviceService,
    private readonly stepUpMaxAgeSec: number,
    private readonly limiter: PgRateLimiter,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    const policy = this.reflector.getAllAndOverride<AccessPolicy | undefined>(ACCESS_POLICY, targets);
    if (!policy) throw new ForbiddenError('This endpoint has no access policy');
    if (policy.kind === 'public') return true;

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const header = request.headers.authorization;
    const match = typeof header === 'string' ? TOKEN_RE.exec(header) : null;
    if (!match) throw new UnauthenticatedError();
    const [, scheme, token] = match as unknown as [string, 'Bearer' | 'Device', string];

    if (policy.kind === 'device') {
      if (scheme !== 'Device') throw new UnauthenticatedError();
      attachDevice(request, await this.devices.authenticate(token));
      return true;
    }
    if (scheme !== 'Bearer') throw new UnauthenticatedError();

    const principal = token.startsWith(auth.API_KEY_PREFIX)
      ? await this.apiKeys.authenticate(token, request.ip)
      : await this.authService.authenticate(token);
    attachPrincipal(request, principal);

    if (principal.kind === 'API_KEY' && principal.apiKeyId && principal.rateLimitPerMin) {
      const hit = await this.limiter.hit(`api-key:${principal.apiKeyId}`, {
        limit: principal.rateLimitPerMin,
        windowSec: 60,
      });
      if (!hit.allowed) throw new RateLimitedError(hit.retryAfterSec);
    }

    if (principal.kind === 'USER') {
      const allowWithoutMfa = this.reflector.getAllAndOverride<boolean | undefined>(
        ALLOW_WITHOUT_MFA,
        targets,
      );
      const holdsDangerous = principal.grants.some((g) => iam.isDangerous(g.permission));
      if (holdsDangerous && principal.mfaEnforced && !principal.mfaEnabled && !allowWithoutMfa) {
        throw new ForbiddenError(
          'Your company requires two-factor authentication for your role. Set it up to continue.',
          {},
          'MFA_ENROLLMENT_REQUIRED',
        );
      }
    }

    if (policy.kind === 'permission') {
      if (!principal.grants.some((g) => g.permission === policy.permission)) {
        throw new ForbiddenError(`Missing permission ${policy.permission}`, {
          permission: policy.permission,
        });
      }
      if (principal.kind === 'USER' && principal.mfaEnabled && iam.isDangerous(policy.permission)) {
        const ageSec = Math.floor(Date.now() / 1000) - principal.authTime;
        if (!principal.amr.includes('otp') || ageSec > this.stepUpMaxAgeSec) {
          throw new ForbiddenError(
            'Confirm with your 2FA code to continue',
            { maxAgeSec: this.stepUpMaxAgeSec },
            'STEP_UP_REQUIRED',
          );
        }
      }
    }
    return true;
  }
}
