import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@stockos/shared';
import { call, createTestApi, signup, type Api, type SignedUpTenant } from '../support/api';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

let db: TestDatabase;
let api: Api;
let t: SignedUpTenant;
let warehouseId: string;

beforeAll(async () => {
  db = await createTestDatabase();
  api = await createTestApi(db);
  t = await signup(api, 'Orders');
  const [w] = (await call(api, 'GET', '/api/v1/warehouses', { token: t.accessToken })).body;
  warehouseId = w.id;
});
afterAll(async () => {
  await api.close();
  await db.drop();
});

async function createVariant(sku: string, sellingPrice = '107.00', qty = '10') {
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
    body: { lines: [{ warehouseId, variantId, quantity: qty }] },
  });
  return variantId;
}

async function balanceOf(variantId: string) {
  return (
    await call(api, 'GET', `/api/v1/inventory/balances?variantId=${variantId}&warehouseId=${warehouseId}`, {
      token: t.accessToken,
    })
  ).body.data[0];
}

async function createOrder(variantId: string, opts: { quantity?: string; paid?: boolean } = {}) {
  const res = await call(api, 'POST', '/api/v1/orders', {
    token: t.accessToken,
    headers: { 'idempotency-key': uuidv7() },
    body: {
      channelCode: 'API',
      warehouseId,
      paid: opts.paid ?? false,
      lines: [{ variantId, quantity: opts.quantity ?? '2' }],
    },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

describe('order lifecycle', () => {
  it('unpaid order reserves stock, pay+confirm commits it, cancel releases it', async () => {
    const variantId = await createVariant(`ORD-${Date.now()}`);
    const order = await createOrder(variantId, { quantity: '3' });
    expect(order.status).toBe('PENDING');

    const balanceAfterOrder = await balanceOf(variantId);
    expect(balanceAfterOrder.reserved).toBe('3.000');
    expect(balanceAfterOrder.available).toBe('7.000');

    const paid = await call(api, 'POST', `/api/v1/orders/${order.id}/pay`, { token: t.accessToken });
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    expect(paid.body.status).toBe('PAID');

    const confirmed = await call(api, 'POST', `/api/v1/orders/${order.id}/confirm`, { token: t.accessToken });
    expect(confirmed.body.status).toBe('CONFIRMED');
    const balanceAfterConfirm = await balanceOf(variantId);
    expect(balanceAfterConfirm.committed).toBe('3.000');
    expect(balanceAfterConfirm.reserved).toBe('0.000');

    const cancelled = await call(api, 'POST', `/api/v1/orders/${order.id}/cancel`, {
      token: t.accessToken,
      body: { reason: 'customer changed mind' },
    });
    expect(cancelled.body.status).toBe('CANCELLED');
    const balanceAfterCancel = await balanceOf(variantId);
    expect(balanceAfterCancel.committed).toBe('0.000');
    expect(balanceAfterCancel.available).toBe('10.000');
  });

  it('rejects an illegal transition instead of doing nothing', async () => {
    const variantId = await createVariant(`ORD-${Date.now()}`);
    const order = await createOrder(variantId, { paid: true });
    const res = await call(api, 'POST', `/api/v1/orders/${order.id}/pay`, { token: t.accessToken });
    expect(res).toMatchObject({ status: 409, body: { code: 'INVALID_STATE_TRANSITION' } });
  });

  it('holds and releases', async () => {
    const variantId = await createVariant(`ORD-${Date.now()}`);
    const order = await createOrder(variantId, { paid: true });
    const held = await call(api, 'POST', `/api/v1/orders/${order.id}/hold`, {
      token: t.accessToken,
      body: { reason: 'unmapped SKU' },
    });
    expect(held.body).toMatchObject({ status: 'ON_HOLD', holdReason: 'unmapped SKU' });
    const released = await call(api, 'POST', `/api/v1/orders/${order.id}/release-hold`, {
      token: t.accessToken,
    });
    expect(released.body).toMatchObject({ status: 'CONFIRMED', holdReason: null });
  });

  it('refuses to reserve more than is in stock', async () => {
    const variantId = await createVariant(`ORD-${Date.now()}`, '107.00', '1');
    const res = await call(api, 'POST', '/api/v1/orders', {
      token: t.accessToken,
      headers: { 'idempotency-key': uuidv7() },
      body: { channelCode: 'API', warehouseId, lines: [{ variantId, quantity: '5' }] },
    });
    expect(res).toMatchObject({ status: 409, body: { code: 'STOCK_INSUFFICIENT' } });
  });

  it('the same Idempotency-Key returns the original order untouched', async () => {
    const variantId = await createVariant(`ORD-${Date.now()}`);
    const key = uuidv7();
    const body = { channelCode: 'API', warehouseId, lines: [{ variantId, quantity: '1' }] };
    const first = await call(api, 'POST', '/api/v1/orders', {
      token: t.accessToken,
      headers: { 'idempotency-key': key },
      body,
    });
    const second = await call(api, 'POST', '/api/v1/orders', {
      token: t.accessToken,
      headers: { 'idempotency-key': key },
      body,
    });
    expect(second.body.id).toBe(first.body.id);
    const balance = await balanceOf(variantId);
    expect(balance.reserved).toBe('1.000'); // not reserved twice
  });
});

describe('fulfillment', () => {
  it('ships partially, then fully, moving order status only once fully shipped', async () => {
    const variantId = await createVariant(`FUL-${Date.now()}`);
    const order = await createOrder(variantId, { quantity: '4', paid: true });
    await call(api, 'POST', `/api/v1/orders/${order.id}/confirm`, { token: t.accessToken });

    const f1 = (
      await call(api, 'POST', `/api/v1/orders/${order.id}/fulfillments`, {
        token: t.accessToken,
        headers: { 'idempotency-key': uuidv7() },
        body: { lines: [{ orderItemId: order.lines[0].id, quantity: '1' }] },
      })
    ).body;
    const ship1 = await call(api, 'POST', `/api/v1/fulfillments/${f1.id}/ship`, {
      token: t.accessToken,
      body: { carrier: 'Kerry', trackingNo: 'KX1' },
    });
    expect(ship1.body.status).toBe('SHIPPED');

    let current = (await call(api, 'GET', `/api/v1/orders/${order.id}`, { token: t.accessToken })).body;
    expect(current.status).toBe('PROCESSING'); // still not fully shipped
    expect(current.fulfillmentStatus).toBe('PARTIALLY_FULFILLED');

    const balanceMidway = await balanceOf(variantId);
    expect(balanceMidway.onHand).toBe('9.000'); // 10 - 1 shipped

    const f2 = (
      await call(api, 'POST', `/api/v1/orders/${order.id}/fulfillments`, {
        token: t.accessToken,
        headers: { 'idempotency-key': uuidv7() },
        body: { lines: [{ orderItemId: order.lines[0].id, quantity: '3' }] },
      })
    ).body;
    await call(api, 'POST', `/api/v1/fulfillments/${f2.id}/ship`, { token: t.accessToken, body: {} });

    current = (await call(api, 'GET', `/api/v1/orders/${order.id}`, { token: t.accessToken })).body;
    expect(current.status).toBe('SHIPPED');
    expect(current.fulfillmentStatus).toBe('FULFILLED');
    const balanceFinal = await balanceOf(variantId);
    expect(balanceFinal.onHand).toBe('6.000'); // 10 - 4 shipped total
  });

  it('refuses to over-fulfil a line', async () => {
    const variantId = await createVariant(`FUL-${Date.now()}`);
    const order = await createOrder(variantId, { quantity: '2', paid: true });
    await call(api, 'POST', `/api/v1/orders/${order.id}/confirm`, { token: t.accessToken });
    const res = await call(api, 'POST', `/api/v1/orders/${order.id}/fulfillments`, {
      token: t.accessToken,
      headers: { 'idempotency-key': uuidv7() },
      body: { lines: [{ orderItemId: order.lines[0].id, quantity: '5' }] },
    });
    expect(res).toMatchObject({ status: 422, body: { code: 'OVER_FULFILL' } });
  });
});

describe('return + refund', () => {
  it('restocks on SELLABLE receive and refunds the money', async () => {
    const variantId = await createVariant(`RET-${Date.now()}`);
    const order = await createOrder(variantId, { quantity: '2', paid: true });
    await call(api, 'POST', `/api/v1/orders/${order.id}/confirm`, { token: t.accessToken });
    const f = (
      await call(api, 'POST', `/api/v1/orders/${order.id}/fulfillments`, {
        token: t.accessToken,
        headers: { 'idempotency-key': uuidv7() },
        body: { lines: [{ orderItemId: order.lines[0].id, quantity: '2' }] },
      })
    ).body;
    await call(api, 'POST', `/api/v1/fulfillments/${f.id}/ship`, { token: t.accessToken, body: {} });
    const balanceAfterShip = await balanceOf(variantId);
    expect(balanceAfterShip.onHand).toBe('8.000');

    const ret = (
      await call(api, 'POST', `/api/v1/orders/${order.id}/returns`, {
        token: t.accessToken,
        headers: { 'idempotency-key': uuidv7() },
        body: { lines: [{ orderItemId: order.lines[0].id, quantity: '1' }], reason: 'wrong size' },
      })
    ).body;
    const received = await call(api, 'POST', `/api/v1/returns/${ret.id}/receive`, {
      token: t.accessToken,
      body: { lines: [{ orderItemId: order.lines[0].id, condition: 'SELLABLE' }] },
    });
    expect(received.body.status).toBe('COMPLETED');
    const balanceAfterReturn = await balanceOf(variantId);
    expect(balanceAfterReturn.onHand).toBe('9.000'); // 1 unit restocked

    const orderAfterReturn = (await call(api, 'GET', `/api/v1/orders/${order.id}`, { token: t.accessToken }))
      .body;
    expect(orderAfterReturn.status).toBe('RETURNED');

    const refund = await call(api, 'POST', `/api/v1/orders/${order.id}/refunds`, {
      token: t.accessToken,
      headers: { 'idempotency-key': uuidv7() },
      body: {
        lines: [{ orderItemId: order.lines[0].id, quantity: '1' }],
        reason: 'wrong size',
        returnId: ret.id,
      },
    });
    expect(refund.status, JSON.stringify(refund.body)).toBe(201);
    expect(refund.body.amount).toBe('107.00'); // half of the 214.00 line

    const orderAfterRefund = (await call(api, 'GET', `/api/v1/orders/${order.id}`, { token: t.accessToken }))
      .body;
    expect(orderAfterRefund.status).toBe('REFUNDED');
  });

  it('rejects a receive quantity beyond what was returned and a refund beyond what was sold', async () => {
    const variantId = await createVariant(`RET-${Date.now()}`);
    const order = await createOrder(variantId, { quantity: '1', paid: true });
    await call(api, 'POST', `/api/v1/orders/${order.id}/confirm`, { token: t.accessToken });
    const overReturn = await call(api, 'POST', `/api/v1/orders/${order.id}/returns`, {
      token: t.accessToken,
      headers: { 'idempotency-key': uuidv7() },
      body: { lines: [{ orderItemId: order.lines[0].id, quantity: '1' }] }, // nothing fulfilled yet
    });
    expect(overReturn).toMatchObject({ status: 422, body: { code: 'OVER_RETURN' } });

    const overRefund = await call(api, 'POST', `/api/v1/orders/${order.id}/refunds`, {
      token: t.accessToken,
      headers: { 'idempotency-key': uuidv7() },
      body: { lines: [{ orderItemId: order.lines[0].id, quantity: '99' }], reason: 'test' },
    });
    expect(overRefund).toMatchObject({ status: 422, body: { code: 'REFUND_EXCEEDS_SOLD' } });
  });
});
