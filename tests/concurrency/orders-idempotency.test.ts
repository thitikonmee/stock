import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@stockos/shared';
import { call, createTestApi, signup, type Api, type SignedUpTenant } from '../support/api';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

const CONCURRENCY = 20;
let db: TestDatabase;
let api: Api;

beforeAll(async () => {
  db = await createTestDatabase({ appPoolSize: CONCURRENCY });
  api = await createTestApi(db);
});
afterAll(async () => {
  await api.close();
  await db.drop();
});

describe('POST /orders idempotency under concurrency', () => {
  it('the same Idempotency-Key fired 20x at once creates exactly one order and reserves stock once', async () => {
    const t: SignedUpTenant = await signup(api, 'OrdersConcurrency');
    const [warehouse] = (await call(api, 'GET', '/api/v1/warehouses', { token: t.accessToken })).body;

    const unit = (
      await call(api, 'POST', '/api/v1/units', { token: t.accessToken, body: { code: 'U1', name: 'U' } })
    ).body;
    const product = (
      await call(api, 'POST', '/api/v1/products', {
        token: t.accessToken,
        body: {
          code: 'OCONC-1',
          name: 'Order Concurrency Widget',
          baseUnitId: unit.id,
          variants: [{ sku: 'OCONC-1-A', sellingPrice: '107.00' }],
        },
      })
    ).body;
    const variantId = product.variants[0].id as string;
    await call(api, 'POST', '/api/v1/inventory/receive', {
      token: t.accessToken,
      headers: { 'idempotency-key': `recv:${variantId}` },
      body: { lines: [{ warehouseId: warehouse.id, variantId, quantity: '10' }] },
    });

    const idempotencyKey = uuidv7();
    const body = { channelCode: 'API', warehouseId: warehouse.id, lines: [{ variantId, quantity: '2' }] };

    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () =>
        call(api, 'POST', '/api/v1/orders', {
          token: t.accessToken,
          headers: { 'idempotency-key': idempotencyKey },
          body,
        }),
      ),
    );

    expect(
      results.every((r) => r.status === 201),
      JSON.stringify(results.map((r) => ({ status: r.status, code: r.body?.code }))),
    ).toBe(true);
    const orderIds = new Set(results.map((r) => r.body.id));
    expect(orderIds.size).toBe(1);

    const balance = (
      await call(
        api,
        'GET',
        `/api/v1/inventory/balances?variantId=${variantId}&warehouseId=${warehouse.id}`,
        {
          token: t.accessToken,
        },
      )
    ).body.data[0];
    expect(balance.reserved).toBe('2.000'); // not reserved 20x
  });
});
