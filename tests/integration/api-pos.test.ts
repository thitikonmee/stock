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
  type RegisteredDevice,
  type SignedUpTenant,
} from '../support/api';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

let db: TestDatabase;
let api: Api;
let t: SignedUpTenant;
let device: RegisteredDevice;

beforeAll(async () => {
  db = await createTestDatabase();
  api = await createTestApi(db);
  t = await signup(api, 'Pos');
  const [branch] = (await call(api, 'GET', '/api/v1/branches', { token: t.accessToken })).body;
  const [warehouse] = (await call(api, 'GET', '/api/v1/warehouses', { token: t.accessToken })).body;
  device = await registerDevice(api, t, { branchId: branch.id, warehouseId: warehouse.id });
});
afterAll(async () => {
  await api.close();
  await db.drop();
});

async function createPricedVariant(sku: string, warehouseId: string, sellingPrice = '107.00') {
  const unit = (
    await call(api, 'POST', '/api/v1/units', {
      token: t.accessToken,
      body: { code: `U${Date.now()}`, name: 'U' },
    })
  ).body;
  const product = (
    await call(api, 'POST', '/api/v1/products', {
      token: t.accessToken,
      body: {
        code: `P-${sku}`,
        name: `Product ${sku}`,
        baseUnitId: unit.id,
        variants: [{ sku, sellingPrice }],
      },
    })
  ).body;
  const variantId = product.variants[0].id as string;
  await call(api, 'POST', '/api/v1/inventory/receive', {
    token: t.accessToken,
    headers: { 'idempotency-key': `recv:${variantId}` },
    body: { lines: [{ warehouseId, variantId, quantity: '10' }] },
  });
  return variantId;
}

/** Each open shift claims its device exclusively, so tests that need one register their own device. */
async function freshDevice(): Promise<RegisteredDevice> {
  return registerDevice(api, t, { branchId: device.branchId, warehouseId: device.warehouseId });
}

async function openShift(token: string, posDeviceId: string, openingCash = '0.00') {
  const res = await call(api, 'POST', '/api/v1/pos/shifts', {
    token,
    body: { posDeviceId, openingCash },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

describe('cashier PIN login', () => {
  it('logs in with employee code + PIN and gets a session scoped by role', async () => {
    const cashier = await addMember(api, t, [{ roleCode: 'CASHIER' }]);
    const { employeeCode, pin } = await setUpCashier(api, t, cashier.membershipId, cashier.accessToken);

    const login = await call(api, 'POST', '/api/v1/pos/sessions', {
      headers: { authorization: `Device ${device.deviceToken}` },
      body: { employeeCode, pin },
    });
    expect(login.status, JSON.stringify(login.body)).toBe(200);
    expect(login.body.accessToken).toBeTypeOf('string');

    const me = await call(api, 'GET', '/api/v1/me', { token: login.body.accessToken });
    const perms = me.body.grants.map((g: { permission: string }) => g.permission);
    expect(perms).toContain('pos.sell');
    expect(perms).not.toContain('pos.refund');
  });

  it('rejects a wrong PIN and locks after too many attempts', async () => {
    const cashier = await addMember(api, t, [{ roleCode: 'CASHIER' }]);
    const { employeeCode } = await setUpCashier(api, t, cashier.membershipId, cashier.accessToken, {
      pin: '9999',
    });

    const wrong = () =>
      call(api, 'POST', '/api/v1/pos/sessions', {
        headers: { authorization: `Device ${device.deviceToken}` },
        body: { employeeCode, pin: '0000' },
      });
    for (let i = 0; i < 5; i++) {
      expect((await wrong()).body.code).toBe('INVALID_CREDENTIALS');
    }
    expect((await wrong()).body.code).toBe('ACCOUNT_LOCKED');
  });

  it('rejects a PIN presented without a device token', async () => {
    const res = await call(api, 'POST', '/api/v1/pos/sessions', { body: { employeeCode: 'X', pin: '1234' } });
    expect(res.status).toBe(401);
  });
});

describe('shift lifecycle', () => {
  it('opens once per device, tracks cash movements and closes with a Z-report', async () => {
    const dev = await freshDevice();
    const shiftId = await openShift(t.accessToken, dev.id, '500.00');

    const again = await call(api, 'POST', '/api/v1/pos/shifts', {
      token: t.accessToken,
      body: { posDeviceId: dev.id, openingCash: '0.00' },
    });
    expect(again).toMatchObject({ status: 422, body: { code: 'SHIFT_ALREADY_OPEN' } });

    await call(api, 'POST', `/api/v1/pos/shifts/${shiftId}/cash-movements`, {
      token: t.accessToken,
      body: { type: 'PAY_IN', amount: '50.00', reason: 'float top-up' },
    });

    const closed = await call(api, 'POST', `/api/v1/pos/shifts/${shiftId}/close`, {
      token: t.accessToken,
      body: { countedCash: '550.00' },
    });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body).toMatchObject({ status: 'CLOSED', expectedCash: '550.00', cashVariance: '0.00' });
  });

  it('nets a cash refund against expected cash — the drawer actually paid it out', async () => {
    const dev = await freshDevice();
    const variantId = await createPricedVariant(`SHIFT-CASH-${Date.now()}`, dev.warehouseId);
    const shiftId = await openShift(t.accessToken, dev.id, '0.00');
    const sale = (
      await call(api, 'POST', '/api/v1/pos/sales', {
        token: t.accessToken,
        body: {
          posDeviceId: dev.id,
          shiftId,
          clientTxnId: uuidv7(),
          lines: [{ variantId, quantity: '1' }],
          payments: [{ method: 'CASH', amount: '107.00', tenderedAmount: '107.00' }],
        },
      })
    ).body;

    await call(api, 'POST', `/api/v1/pos/sales/${sale.orderId}/refunds`, {
      token: t.accessToken,
      headers: { 'idempotency-key': `test:shift-cash-refund:${sale.orderId}` },
      body: {
        shiftId,
        lines: [{ orderItemId: sale.lines[0].orderItemId, quantity: '1' }],
        reason: 'test',
      },
    });

    const closed = await call(api, 'POST', `/api/v1/pos/shifts/${shiftId}/close`, {
      token: t.accessToken,
      body: { countedCash: '0.00' },
    });
    // Sale put 107.00 in the drawer, the refund paid 107.00 back out — net zero, not +107.00.
    expect(closed.body).toMatchObject({ expectedCash: '0.00', cashVariance: '0.00' });
  });
});

describe('sale', () => {
  it('computes VAT/rounding, deducts stock, and replays the same result for a retried clientTxnId', async () => {
    const dev = await freshDevice();
    const variantId = await createPricedVariant(`SALE-${Date.now()}`, dev.warehouseId);
    const shiftId = await openShift(t.accessToken, dev.id);
    const clientTxnId = uuidv7();
    const body = {
      posDeviceId: dev.id,
      shiftId,
      clientTxnId,
      lines: [{ variantId, quantity: '2' }],
      payments: [{ method: 'CASH', amount: '214.00', tenderedAmount: '300.00' }],
    };

    const first = await call(api, 'POST', '/api/v1/pos/sales', { token: t.accessToken, body });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body).toMatchObject({ grandTotal: '214.00', taxTotal: '14.00', changeAmount: '86.00' });

    const balance = (
      await call(
        api,
        'GET',
        `/api/v1/inventory/balances?variantId=${variantId}&warehouseId=${dev.warehouseId}`,
        {
          token: t.accessToken,
        },
      )
    ).body.data[0];
    expect(balance.onHand).toBe('8.000'); // 10 received - 2 sold

    const replay = await call(api, 'POST', '/api/v1/pos/sales', { token: t.accessToken, body });
    expect(replay.status).toBe(201);
    expect(replay.body.orderId).toBe(first.body.orderId);

    const balanceAfterReplay = (
      await call(
        api,
        'GET',
        `/api/v1/inventory/balances?variantId=${variantId}&warehouseId=${dev.warehouseId}`,
        {
          token: t.accessToken,
        },
      )
    ).body.data[0];
    expect(balanceAfterReplay.onHand).toBe('8.000'); // unchanged — the retry did not sell it twice
  });

  it('refuses to sell more than is in stock', async () => {
    const dev = await freshDevice();
    const variantId = await createPricedVariant(`OVER-${Date.now()}`, dev.warehouseId);
    const shiftId = await openShift(t.accessToken, dev.id);
    const res = await call(api, 'POST', '/api/v1/pos/sales', {
      token: t.accessToken,
      body: {
        posDeviceId: dev.id,
        shiftId,
        clientTxnId: uuidv7(),
        lines: [{ variantId, quantity: '999' }],
        payments: [{ method: 'CASH', amount: '106893.00', tenderedAmount: '106893.00' }],
      },
    });
    expect(res).toMatchObject({ status: 409, body: { code: 'STOCK_INSUFFICIENT' } });
  });

  it('needs a manager override once a discount exceeds the cashier limit', async () => {
    const dev = await freshDevice();
    const variantId = await createPricedVariant(`DISC-${Date.now()}`, dev.warehouseId);
    const cashier = await addMember(api, t, [{ roleCode: 'CASHIER' }]);
    await setUpCashier(api, t, cashier.membershipId, cashier.accessToken);
    const manager = await addMember(api, t, [{ roleCode: 'MANAGER' }]);
    const { employeeCode: managerCode, pin: managerPin } = await setUpCashier(
      api,
      t,
      manager.membershipId,
      manager.accessToken,
    );
    const shiftId = await openShift(cashier.accessToken, dev.id);

    const blocked = await call(api, 'POST', '/api/v1/pos/sales', {
      token: cashier.accessToken,
      body: {
        posDeviceId: dev.id,
        shiftId,
        clientTxnId: uuidv7(),
        lines: [{ variantId, quantity: '1', discountAmount: '50.00' }], // ~47% of 107.00, way over the 10% default
        payments: [{ method: 'CASH', amount: '57.00', tenderedAmount: '57.00' }],
      },
    });
    expect(blocked).toMatchObject({ status: 422, body: { code: 'DISCOUNT_LIMIT_EXCEEDED' } });

    const approved = await call(api, 'POST', '/api/v1/pos/sales', {
      token: cashier.accessToken,
      body: {
        posDeviceId: dev.id,
        shiftId,
        clientTxnId: uuidv7(),
        lines: [{ variantId, quantity: '1', discountAmount: '50.00' }],
        payments: [{ method: 'CASH', amount: '57.00', tenderedAmount: '57.00' }],
        discountOverride: { employeeCode: managerCode, pin: managerPin },
      },
    });
    expect(approved.status, JSON.stringify(approved.body)).toBe(201);
  });
});

describe('refund', () => {
  it('needs pos.refund (or a manager override), restocks, and is idempotent', async () => {
    const dev = await freshDevice();
    const variantId = await createPricedVariant(`REF-${Date.now()}`, dev.warehouseId);
    const shiftId = await openShift(t.accessToken, dev.id);
    const sale = (
      await call(api, 'POST', '/api/v1/pos/sales', {
        token: t.accessToken,
        body: {
          posDeviceId: dev.id,
          shiftId,
          clientTxnId: uuidv7(),
          lines: [{ variantId, quantity: '2' }],
          payments: [{ method: 'CASH', amount: '214.00', tenderedAmount: '214.00' }],
        },
      })
    ).body;
    const orderItemId = sale.lines[0].orderItemId as string;

    const cashier = await addMember(api, t, [{ roleCode: 'CASHIER' }]);
    await setUpCashier(api, t, cashier.membershipId, cashier.accessToken);

    const refuseNoPermission = await call(api, 'POST', `/api/v1/pos/sales/${sale.orderId}/refunds`, {
      token: cashier.accessToken,
      headers: { 'idempotency-key': `test:refund:${sale.orderId}:1` },
      body: { shiftId, lines: [{ orderItemId, quantity: '1' }], reason: 'customer changed mind' },
    });
    expect(refuseNoPermission).toMatchObject({ status: 422, body: { code: 'MANAGER_APPROVAL_REQUIRED' } });

    const manager = await addMember(api, t, [{ roleCode: 'MANAGER' }]);
    const { employeeCode: managerCode, pin: managerPin } = await setUpCashier(
      api,
      t,
      manager.membershipId,
      manager.accessToken,
    );
    const refundKey = `test:refund:${sale.orderId}:2`;
    const refunded = await call(api, 'POST', `/api/v1/pos/sales/${sale.orderId}/refunds`, {
      token: cashier.accessToken,
      headers: { 'idempotency-key': refundKey },
      body: {
        shiftId,
        lines: [{ orderItemId, quantity: '1', restockCondition: 'SELLABLE' }],
        reason: 'customer changed mind',
        managerOverride: { employeeCode: managerCode, pin: managerPin },
      },
    });
    expect(refunded.status, JSON.stringify(refunded.body)).toBe(201);
    expect(refunded.body.amount).toBe('107.00'); // half of the 214.00 line (1 of 2 units)

    const balance = (
      await call(
        api,
        'GET',
        `/api/v1/inventory/balances?variantId=${variantId}&warehouseId=${dev.warehouseId}`,
        {
          token: t.accessToken,
        },
      )
    ).body.data[0];
    expect(balance.onHand).toBe('9.000'); // 10 received - 2 sold + 1 restocked

    // Same idempotency key again — returns the original refund, does not restock a second time.
    const replay = await call(api, 'POST', `/api/v1/pos/sales/${sale.orderId}/refunds`, {
      token: cashier.accessToken,
      headers: { 'idempotency-key': refundKey },
      body: {
        shiftId,
        lines: [{ orderItemId, quantity: '1', restockCondition: 'SELLABLE' }],
        reason: 'customer changed mind',
        managerOverride: { employeeCode: managerCode, pin: managerPin },
      },
    });
    expect(replay.body.id).toBe(refunded.body.id);

    const overRefund = await call(api, 'POST', `/api/v1/pos/sales/${sale.orderId}/refunds`, {
      token: cashier.accessToken,
      headers: { 'idempotency-key': `test:refund:${sale.orderId}:3` },
      body: {
        shiftId,
        lines: [{ orderItemId, quantity: '5' }],
        reason: 'too many',
        managerOverride: { employeeCode: managerCode, pin: managerPin },
      },
    });
    expect(overRefund).toMatchObject({ status: 422, body: { code: 'REFUND_EXCEEDS_SOLD' } });
  });
});
