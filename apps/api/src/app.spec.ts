import 'reflect-metadata';
import { generateKeyPairSync } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '@stockos/database';
import { createLogger } from '@stockos/shared';
import { createApp } from './app';
import { toProblem } from './common/problem';
import { auth, inventory } from '@stockos/core';

describe('api app', () => {
  const healthy = { value: true };
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await createApp({
      db: {} as Db, // these tests only hit routes that never reach the database
      logger: createLogger('test', 'silent'),
      auth: {
        ...auth.DEFAULT_AUTH_TIMINGS,
        jwt: new auth.JwtService(
          {
            currentKid: 'k',
            privateKeyPem: generateKeyPairSync('ec', { namedCurve: 'P-256' })
              .privateKey.export({ type: 'pkcs8', format: 'pem' })
              .toString(),
          },
          { issuer: 'https://api.stockos.test', audience: 'stockos-api' },
        ),
        hasher: new auth.PasswordHasher({ memoryCost: 1024, timeCost: 1, parallelism: 1 }),
        secretBox: new auth.SecretBox(Buffer.alloc(32)),
        oauthProviders: {},
      },
      readinessCheck: async () => {
        if (!healthy.value) throw new Error('connection refused');
      },
    });
  });
  afterAll(async () => app.close());

  it('answers liveness and echoes a valid X-Request-Id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'req-12345678' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    expect(res.headers['x-request-id']).toBe('req-12345678');
  });

  it('replaces a malformed X-Request-Id with a generated one', async () => {
    const res = await app.inject({ method: 'GET', url: '/health', headers: { 'x-request-id': 'bad id\n' } });
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('reports readiness from the database', async () => {
    healthy.value = true;
    expect((await app.inject({ method: 'GET', url: '/health/ready' })).statusCode).toBe(200);

    healthy.value = false;
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toMatchObject({ status: 503, code: 'DEPENDENCY_UNAVAILABLE' });
    healthy.value = true;
  });

  it('returns problem+json for unknown routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
      requestId: res.headers['x-request-id'],
    });
  });
});

describe('toProblem', () => {
  it('maps domain errors with their stable code and metadata', () => {
    const err = new inventory.InsufficientStockError({
      warehouseId: 'w',
      variantId: 'v',
      operation: 'RESERVE',
      requested: '2.000',
      available: '1.000',
    });
    expect(toProblem(err, 'r1')).toMatchObject({
      type: 'https://docs.stockos.co/errors/stock-insufficient',
      status: 409,
      code: 'STOCK_INSUFFICIENT',
      requestId: 'r1',
      meta: { available: '1.000' },
    });
  });

  it('hides details of unexpected errors', () => {
    const problem = toProblem(new Error('password=hunter2 in SQL'), 'r2');
    expect(problem).toEqual({
      type: 'https://docs.stockos.co/errors/internal-error',
      title: 'Internal server error',
      status: 500,
      code: 'INTERNAL_ERROR',
      requestId: 'r2',
    });
  });
});
