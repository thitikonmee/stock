import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@stockos/shared';
import {
  addMember,
  call,
  createTestApi,
  registerDevice,
  setUpCashier,
  signup,
  type Api,
  type SignedUpTenant,
} from '../support/api';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

const CONCURRENCY = 20;
let db: TestDatabase;
let api: Api;

beforeAll(async () => {
  // Pool as large as the burst so requests really hit Postgres at the same time (docs/12-testing.md Test 3).
  db = await createTestDatabase({ appPoolSize: CONCURRENCY });
  api = await createTestApi(db);
});
afterAll(async () => {
  await api.close();
  await db.drop();
});

describe('POST /pos/sales idempotency under concurrency', () => {
  it('the same client_txn_id fired 20x at once creates exactly one order and sells stock once', async () => {
    const t: SignedUpTenant = await signup(api, 'PosConcurrency');
    const [branch] = (await call(api, 'GET', '/api/v1/branches', { token: t.accessToken })).body;
    const [warehouse] = (await call(api, 'GET', '/api/v1/warehouses', { token: t.accessToken })).body;
    const device = await registerDevice(api, t, { branchId: branch.id, warehouseId: warehouse.id });

    const unit = (
      await call(api, 'POST', '/api/v1/units', { token: t.accessToken, body: { code: 'U1', name: 'U' } })
    ).body;
    const product = (
      await call(api, 'POST', '/api/v1/products', {
        token: t.accessToken,
        body: {
          code: 'CONC-1',
          name: 'Concurrency Widget',
          baseUnitId: unit.id,
          variants: [{ sku: 'CONC-1-A', sellingPrice: '107.00' }],
        },
      })
    ).body;
    const variantId = product.variants[0].id as string;
    await call(api, 'POST', '/api/v1/inventory/receive', {
      token: t.accessToken,
      headers: { 'idempotency-key': `recv:${variantId}` },
      body: { lines: [{ warehouseId: device.warehouseId, variantId, quantity: '10' }] },
    });

    const cashier = await addMember(api, t, [{ roleCode: 'CASHIER' }]);
    await setUpCashier(api, t, cashier.membershipId, cashier.accessToken);
    const shift = (
      await call(api, 'POST', '/api/v1/pos/shifts', {
        token: cashier.accessToken,
        body: { posDeviceId: device.id, openingCash: '0.00' },
      })
    ).body;

    const clientTxnId = uuidv7();
    const body = {
      posDeviceId: device.id,
      shiftId: shift.id,
      clientTxnId,
      lines: [{ variantId, quantity: '1' }],
      payments: [{ method: 'CASH', amount: '107.00', tenderedAmount: '107.00' }],
    };

    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () =>
        call(api, 'POST', '/api/v1/pos/sales', { token: cashier.accessToken, body }),
      ),
    );

    expect(
      results.every((r) => r.status === 201),
      JSON.stringify(results.map((r) => ({ status: r.status, code: r.body?.code, detail: r.body?.detail }))),
    ).toBe(true);
    const orderIds = new Set(results.map((r) => r.body.orderId));
    expect(orderIds.size).toBe(1); // one winner; every other request replayed its result

    const balance = (
      await call(
        api,
        'GET',
        `/api/v1/inventory/balances?variantId=${variantId}&warehouseId=${device.warehouseId}`,
        {
          token: t.accessToken,
        },
      )
    ).body.data[0];
    expect(balance.onHand).toBe('9.000'); // 10 received - 1 sold, not 20x sold

    const sales = (
      await call(api, 'GET', `/api/v1/pos/sales?posDeviceId=${device.id}`, { token: t.accessToken })
    ).body;
    expect(sales).toHaveLength(1);
  });
});

describe('POST /pos/sales/:id/refunds idempotency under concurrency', () => {
  it('the same Idempotency-Key fired 20x at once refunds exactly once', async () => {
    const t: SignedUpTenant = await signup(api, 'PosRefundConcurrency');
    const [branch] = (await call(api, 'GET', '/api/v1/branches', { token: t.accessToken })).body;
    const [warehouse] = (await call(api, 'GET', '/api/v1/warehouses', { token: t.accessToken })).body;
    const device = await registerDevice(api, t, { branchId: branch.id, warehouseId: warehouse.id });

    const unit = (
      await call(api, 'POST', '/api/v1/units', { token: t.accessToken, body: { code: 'U1', name: 'U' } })
    ).body;
    const product = (
      await call(api, 'POST', '/api/v1/products', {
        token: t.accessToken,
        body: {
          code: 'CONC-2',
          name: 'Concurrency Widget 2',
          baseUnitId: unit.id,
          variants: [{ sku: 'CONC-2-A', sellingPrice: '107.00' }],
        },
      })
    ).body;
    const variantId = product.variants[0].id as string;
    await call(api, 'POST', '/api/v1/inventory/receive', {
      token: t.accessToken,
      headers: { 'idempotency-key': `recv:${variantId}` },
      body: { lines: [{ warehouseId: device.warehouseId, variantId, quantity: '10' }] },
    });

    const shift = (
      await call(api, 'POST', '/api/v1/pos/shifts', {
        token: t.accessToken,
        body: { posDeviceId: device.id, openingCash: '0.00' },
      })
    ).body;
    const sale = (
      await call(api, 'POST', '/api/v1/pos/sales', {
        token: t.accessToken,
        body: {
          posDeviceId: device.id,
          shiftId: shift.id,
          clientTxnId: uuidv7(),
          lines: [{ variantId, quantity: '1' }],
          payments: [{ method: 'CASH', amount: '107.00', tenderedAmount: '107.00' }],
        },
      })
    ).body;

    const idempotencyKey = `test:conc:refund:${sale.orderId}`;
    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () =>
        call(api, 'POST', `/api/v1/pos/sales/${sale.orderId}/refunds`, {
          token: t.accessToken,
          headers: { 'idempotency-key': idempotencyKey },
          body: {
            shiftId: shift.id,
            lines: [{ orderItemId: sale.lines[0].orderItemId, quantity: '1' }],
            reason: 'test',
          },
        }),
      ),
    );

    expect(
      results.every((r) => r.status === 201),
      JSON.stringify(results.map((r) => ({ status: r.status, code: r.body?.code }))),
    ).toBe(true);
    const refundIds = new Set(results.map((r) => r.body.id));
    expect(refundIds.size).toBe(1);

    const order = (await call(api, 'GET', `/api/v1/pos/sales/${sale.orderId}`, { token: t.accessToken }))
      .body;
    // Fully refunded exactly once. If the advisory lock let two racers both apply their update,
    // payments.refunded_amount would exceed payments.amount and the second one would have 422'd
    // instead of 201 above — this just confirms the visible order state landed correctly too.
    expect(order.status).toBe('REFUNDED');

    const balance = (
      await call(
        api,
        'GET',
        `/api/v1/inventory/balances?variantId=${variantId}&warehouseId=${device.warehouseId}`,
        {
          token: t.accessToken,
        },
      )
    ).body.data[0];
    expect(balance.onHand).toBe('9.000'); // 10 received - 1 sold + 0 restocked (no restockCondition here)
  });
});
