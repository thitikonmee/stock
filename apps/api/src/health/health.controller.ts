import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { READINESS_CHECK, type ReadinessCheck } from '../tokens';

@Controller('health')
export class HealthController {
  constructor(@Inject(READINESS_CHECK) private readonly readinessCheck: ReadinessCheck) {}

  /** Liveness: the process is up. Never touches dependencies. */
  @Get()
  live() {
    return { status: 'ok' };
  }

  /** Readiness: dependencies reachable. The load balancer stops routing here when this fails. */
  @Get('ready')
  async ready() {
    try {
      await this.readinessCheck();
    } catch {
      throw new ServiceUnavailableException('dependency unavailable');
    }
    return { status: 'ready' };
  }
}
