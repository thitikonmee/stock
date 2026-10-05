import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import type { PgRateLimiter, RateLimitRule } from '@stockos/database';
import { RateLimitedError } from '@stockos/shared';
import { RATE_LIMIT, type RateLimitName } from './decorators';

export type RateLimits = Record<RateLimitName, RateLimitRule>;

export const DEFAULT_RATE_LIMITS: RateLimits = {
  signup: { limit: 10, windowSec: 3600 },
  login: { limit: 30, windowSec: 900 },
  mfa: { limit: 30, windowSec: 900 },
  refresh: { limit: 300, windowSec: 900 },
  'invitation-accept': { limit: 20, windowSec: 900 },
  'device-register': { limit: 10, windowSec: 900 },
  oauth: { limit: 20, windowSec: 900 },
};

/**
 * Per-IP limits on abuse-prone public endpoints (credential stuffing, code guessing).
 * Complements per-account lockout, which cannot stop one IP trying many accounts.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly limiter: PgRateLimiter,
    private readonly limits: RateLimits,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const name = this.reflector.getAllAndOverride<RateLimitName | undefined>(RATE_LIMIT, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!name) return true;
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const result = await this.limiter.hit(`${name}:ip:${request.ip}`, this.limits[name]);
    if (!result.allowed) throw new RateLimitedError(result.retryAfterSec);
    return true;
  }
}
