import type { IncomingMessage } from 'node:http';
import { Module, type DynamicModule } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { sql } from 'kysely';
import type { Db } from '@stockos/database';
import { uuidv7, type Logger } from '@stockos/shared';
import { ProblemDetailsFilter } from './common/problem.filter';
import { RequestContextInterceptor } from './common/request-context.interceptor';
import { HealthController } from './health/health.controller';
import { DB, LOGGER, READINESS_CHECK, type ReadinessCheck } from './tokens';

export interface AppDeps {
  db: Db;
  logger: Logger;
  corsOrigins?: string[];
  /** Defaults to `select 1` against `db`. */
  readinessCheck?: ReadinessCheck;
}

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,128}$/;

@Module({})
class AppModule {
  static register(deps: AppDeps): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController],
      providers: [
        { provide: DB, useValue: deps.db },
        { provide: LOGGER, useValue: deps.logger },
        {
          provide: READINESS_CHECK,
          useValue: deps.readinessCheck ?? (async () => void (await sql`select 1`.execute(deps.db))),
        },
      ],
    };
  }
}

/** Build the HTTP app (used by main.ts and by tests via `app.inject`). */
export async function createApp(deps: AppDeps): Promise<NestFastifyApplication> {
  const adapter = new FastifyAdapter({
    bodyLimit: 1_048_576,
    requestIdHeader: false,
    // Accept a caller's X-Request-Id only if it is well-formed (prevents log injection).
    genReqId: (req: IncomingMessage) => {
      const header = req.headers['x-request-id'];
      return typeof header === 'string' && REQUEST_ID_RE.test(header) ? header : uuidv7();
    },
  });

  const app = await NestFactory.create<NestFastifyApplication>(AppModule.register(deps), adapter, {
    logger: ['error', 'warn'],
  });

  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRequest', async (request, reply) => {
      void reply.header('x-request-id', request.id);
    });

  app.setGlobalPrefix('api/v1', { exclude: ['health', 'health/ready'] });
  app.useGlobalFilters(new ProblemDetailsFilter(deps.logger));
  app.useGlobalInterceptors(new RequestContextInterceptor());
  if (deps.corsOrigins?.length) app.enableCors({ origin: deps.corsOrigins, credentials: true });

  await app.init();
  return app;
}
