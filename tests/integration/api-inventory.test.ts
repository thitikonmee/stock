import ExcelJS from 'exceljs';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { platformTx } from '@stockos/database';
import { addMember, call, createTestApi, signup, type Api, type SignedUpTenant } from '../support/api';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

let db: TestDatabase;
let api: Api;
let t: SignedUpTenant;
let warehouseId: string;
let warehouse2Id: string;

beforeAll(async () => {
  db = await createTestDatabase();
  api = await createTestApi(db);
  t = await signup(api, 'Inventory');
  const [w1] = (await call(api, 'GET', '/api/v1/warehouses', { token: t.accessToken })).body;
  warehouseId = w1.id;
  const created = await call(api, 'POST', '/api/v1/warehouses', {
    token: t.accessToken,
    body: { code: 'W2', name: 'Warehouse 2' },
  });
  warehouse2Id = created.body.id;
});
afterAll(async () => {
  await api.close();
  await db.drop();
});

async function createVariant(sku: string) {
  const unit = (
    await call(api, 'POST', '/api/v1/units', {
      token: t.accessToken,
      body: { code: `U${Date.now()}`, name: 'U' },
    })
  ).body;
  const product = (
    await call(api, 'POST', '/api/v1/products', {
      token: t.accessToken,
      body: { code: `P-${sku}`, name: `Product ${sku}`, baseUnitId: unit.id, variants: [{ sku }] },
    })
  ).body;
  return product.variants[0].id as string;
}

async function balanceOf(variantId: string, warehouse = warehouseId) {
  return (
    await call(api, 'GET', `/api/v1/inventory/balances?variantId=${variantId}&warehouseId=${warehouse}`, {
      token: t.accessToken,
    })
  ).body.data[0];
}

describe('reserve / commit / release', () => {
  it('reserves, commits and releases stock, keeping the ledger in step', async () => {
    const variantId = await createVariant(`RES-${Date.now()}`);
    await call(api, 'POST', '/api/v1/inventory/receive', {
      token: t.accessToken,
      headers: { 'idempotency-key': `recv:${variantId}` },
      body: { lines: [{ warehouseId, variantId, quantity: '10' }] },
    });
    expect(await balanceOf(variantId)).toMatchObject({ onHand: '10.000', available: '10.000' });

    const reserve = await call(api, 'POST', '/api/v1/inventory/reserve', {
      token: t.accessToken,
      headers: { 'idempotency-key': `reserve:${variantId}:1` },
      body: {
        referenceType: 'ORDER_ITEM',
        referenceId: '00000000-0000-7000-8000-000000000001',
        items: [{ warehouseId, variantId, quantity: '4' }],
      },
    });
    expect(reserve.status).toBe(201);
    const reservationId = reserve.body[0].id;
    expect(await balanceOf(variantId)).toMatchObject({ reserved: '4.000', available: '6.000' });

    // Replaying the same Idempotency-Key does not reserve again.
    await call(api, 'POST', '/api/v1/inventory/reserve', {
      token: t.accessToken,
      headers: { 'idempotency-key': `reserve:${variantId}:1` },
      body: {
        referenceType: 'ORDER_ITEM',
        referenceId: '00000000-0000-7000-8000-000000000001',
        items: [{ warehouseId, variantId, quantity: '4' }],
      },
    });
    expect(await balanceOf(variantId)).toMatchObject({ reserved: '4.000' });

    const commit = await call(api, 'POST', `/api/v1/inventory/reservations/${reservationId}/commit`, {
      token: t.accessToken,
    });
    expect(commit.body).toMatchObject({ status: 'COMMITTED' });
    expect(await balanceOf(variantId)).toMatchObject({
      reserved: '0.000',
      committed: '4.000',
      available: '6.000',
    });

    const release = await call(api, 'POST', `/api/v1/inventory/reservations/${reservationId}/release`, {
      token: t.accessToken,
    });
    expect(release).toMatchObject({ status: 422, body: { code: 'RESERVATION_NOT_RELEASABLE' } }); // already COMMITTED
  });

  it('never reserves more than is available (single line, sequential)', async () => {
    const variantId = await createVariant(`OVER-${Date.now()}`);
    await call(api, 'POST', '/api/v1/inventory/receive', {
      token: t.accessToken,
      headers: { 'idempotency-key': `recv:${variantId}` },
      body: { lines: [{ warehouseId, variantId, quantity: '2' }] },
    });
    const first = await call(api, 'POST', '/api/v1/inventory/reserve', {
      token: t.accessToken,
      headers: { 'idempotency-key': `reserve:${variantId}:a` },
      body: {
        referenceType: 'ORDER_ITEM',
        referenceId: '00000000-0000-7000-8000-000000000002',
        items: [{ warehouseId, variantId, quantity: '2' }],
      },
    });
    expect(first.status).toBe(201);
    const second = await call(api, 'POST', '/api/v1/inventory/reserve', {
      token: t.accessToken,
      headers: { 'idempotency-key': `reserve:${variantId}:b` },
      body: {
        referenceType: 'ORDER_ITEM',
        referenceId: '00000000-0000-7000-8000-000000000003',
        items: [{ warehouseId, variantId, quantity: '1' }],
      },
    });
    expect(second.status).toBe(409);
  });

  it('sweeps reservations past their expiry', async () => {
    const variantId = await createVariant(`EXP-${Date.now()}`);
    await call(api, 'POST', '/api/v1/inventory/receive', {
      token: t.accessToken,
      headers: { 'idempotency-key': `recv:${variantId}` },
      body: { lines: [{ warehouseId, variantId, quantity: '3' }] },
    });
    await call(api, 'POST', '/api/v1/inventory/reserve', {
      token: t.accessToken,
      headers: { 'idempotency-key': `reserve:${variantId}:ttl` },
      body: {
        referenceType: 'ORDER_ITEM',
        referenceId: '00000000-0000-7000-8000-000000000004',
        items: [{ warehouseId, variantId, quantity: '3' }],
        ttlSeconds: 1,
      },
    });
    expect(await balanceOf(variantId)).toMatchObject({ reserved: '3.000' });

    // Fast-forward past the TTL directly in the DB (no real 1s sleep in a test).
    await platformTx(db.platform, (tx) =>
      sql`update inventory_reservations set expires_at = now() - interval '1 second'
          where tenant_id = ${t.tenantId} and variant_id = ${variantId}`.execute(tx),
    );
    const swept = await call(api, 'POST', '/api/v1/inventory/reservations/sweep', { token: t.accessToken });
    expect(swept.body.released).toBeGreaterThanOrEqual(1);
    expect(await balanceOf(variantId)).toMatchObject({ reserved: '0.000', available: '3.000' });
  });
});

describe('manual adjustments', () => {
  it('requires approval from someone other than the requester, then posts to the ledger', async () => {
    const variantId = await createVariant(`ADJ-${Date.now()}`);
    const created = await call(api, 'POST', '/api/v1/inventory/adjustments', {
      token: t.accessToken,
      body: {
        warehouseId,
        reasonCode: 'FOUND',
        note: 'สินค้าที่เจอเพิ่ม',
        items: [{ variantId, quantityDelta: '5' }],
      },
    });
    expect(created).toMatchObject({ status: 201, body: { status: 'PENDING_APPROVAL' } });

    // The requester (owner) cannot approve their own adjustment.
    const selfApprove = await call(api, 'POST', `/api/v1/inventory/adjustments/${created.body.id}/approve`, {
      token: t.accessToken,
    });
    expect(selfApprove).toMatchObject({ status: 403, body: { code: 'PRIVILEGE_ESCALATION' } });

    const approver = await addMember(api, t, [{ roleCode: 'ADMIN' }]);
    const approved = await call(api, 'POST', `/api/v1/inventory/adjustments/${created.body.id}/approve`, {
      token: approver.accessToken,
    });
    expect(approved.body).toMatchObject({ status: 'POSTED' });
    expect(await balanceOf(variantId)).toMatchObject({ onHand: '5.000', available: '5.000' });

    const txns = await call(
      api,
      'GET',
      `/api/v1/inventory/transactions?variantId=${variantId}&warehouseId=${warehouseId}`,
      { token: t.accessToken },
    );
    expect(txns.body.data[0]).toMatchObject({ transactionType: 'ADJUSTMENT', quantity: '5.000' });
  });

  it('rejects an adjustment without posting anything', async () => {
    const variantId = await createVariant(`REJ-${Date.now()}`);
    const created = await call(api, 'POST', '/api/v1/inventory/adjustments', {
      token: t.accessToken,
      body: { warehouseId, reasonCode: 'OTHER', items: [{ variantId, quantityDelta: '5' }] },
    });
    const approver = await addMember(api, t, [{ roleCode: 'ADMIN' }]);
    const rejected = await call(api, 'POST', `/api/v1/inventory/adjustments/${created.body.id}/reject`, {
      token: approver.accessToken,
      body: { note: 'ข้อมูลไม่ถูกต้อง' },
    });
    expect(rejected.body).toMatchObject({ status: 'REJECTED' });
    expect((await balanceOf(variantId)) ?? { onHand: '0.000' }).toMatchObject({ onHand: '0.000' });
  });
});

describe('receiving and moving average cost', () => {
  it('computes the weighted average cost across two receipts', async () => {
    const variantId = await createVariant(`COST-${Date.now()}`);
    await call(api, 'POST', '/api/v1/inventory/receive', {
      token: t.accessToken,
      headers: { 'idempotency-key': `cost:${variantId}:1` },
      body: { lines: [{ warehouseId, variantId, quantity: '10', unitCost: '100' }] },
    });
    await call(api, 'POST', '/api/v1/inventory/receive', {
      token: t.accessToken,
      headers: { 'idempotency-key': `cost:${variantId}:2` },
      body: { lines: [{ warehouseId, variantId, quantity: '10', unitCost: '120' }] },
    });
    // (10*100 + 10*120) / 20 = 110
    const cost = await platformTx(db.platform, (tx) =>
      sql<{
        avg_cost: string;
      }>`select avg_cost from variant_costs where tenant_id = ${t.tenantId} and variant_id = ${variantId}`.execute(
        tx,
      ),
    );
    expect(cost.rows[0]?.avg_cost).toBe('110.0000');
  });
});

describe('opening stock import', () => {
  it('imports opening balances from an xlsx template and reports per-row errors', async () => {
    const variantId = await createVariant(`OPEN-${Date.now()}`);
    const { rows } = await platformTx(db.platform, (tx) =>
      sql<{ sku: string }>`select sku from product_variants where id = ${variantId}`.execute(tx),
    );
    const sku = rows[0]!.sku;

    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('OpeningStock');
    sheet.addRow(['warehouseCode', 'sku', 'quantity', 'unitCost']);
    sheet.addRow(['MAIN', sku, '25', '80']);
    sheet.addRow(['MAIN', 'NOT-A-REAL-SKU', '5', '']);
    const buffer = Buffer.from((await wb.xlsx.writeBuffer()) as unknown as ArrayBuffer);

    const res = await call(api, 'POST', '/api/v1/inventory/opening-stock/import', {
      token: t.accessToken,
      headers: { 'content-type': 'application/octet-stream' },
      body: buffer as unknown as Record<string, unknown>,
    });
    expect(res.body).toMatchObject({ totalRows: 2, applied: 1, errors: [{ row: 3 }] });
    expect(await balanceOf(variantId)).toMatchObject({ onHand: '25.000' });
  });
});

describe('low stock', () => {
  it('lists a SKU once its available quantity drops to or below its threshold', async () => {
    const variantId = await createVariant(`LOW-${Date.now()}`);
    await call(api, 'PATCH', `/api/v1/variants/${variantId}`, {
      token: t.accessToken,
      headers: { 'if-match': '"v1"' },
      body: { lowStockThreshold: '5' },
    });
    await call(api, 'POST', '/api/v1/inventory/receive', {
      token: t.accessToken,
      headers: { 'idempotency-key': `low:${variantId}` },
      body: { lines: [{ warehouseId, variantId, quantity: '3' }] },
    });
    const low = await call(api, 'GET', '/api/v1/inventory/balances?lowStock=true', { token: t.accessToken });
    expect(low.body.data.some((b: { variantId: string }) => b.variantId === variantId)).toBe(true);
  });
});

describe('reconciliation', () => {
  it('detects an injected mismatch and rebuild restores it from the ledger', async () => {
    const variantId = await createVariant(`RECON-${Date.now()}`);
    await call(api, 'POST', '/api/v1/inventory/receive', {
      token: t.accessToken,
      headers: { 'idempotency-key': `recon:${variantId}` },
      body: { lines: [{ warehouseId, variantId, quantity: '10' }] },
    });

    // Simulate corruption: a direct DB edit that bypasses InventoryEngine entirely.
    await platformTx(db.platform, (tx) =>
      sql`update inventory_balances set on_hand = 999 where tenant_id = ${t.tenantId} and warehouse_id = ${warehouseId} and variant_id = ${variantId}`.execute(
        tx,
      ),
    );
    expect(await balanceOf(variantId)).toMatchObject({ onHand: '999.000' });

    const run = await call(api, 'POST', '/api/v1/inventory/reconciliation-runs', {
      token: t.accessToken,
      body: { variantId },
    });
    expect(run.body).toMatchObject({ status: 'COMPLETED', mismatchCount: 1 });

    const rebuild = await call(api, 'POST', `/api/v1/inventory/reconciliation-runs/${run.body.id}/rebuild`, {
      token: t.accessToken,
    });
    expect(rebuild.body.corrected).toBeGreaterThanOrEqual(1);
    expect(await balanceOf(variantId)).toMatchObject({ onHand: '10.000' });

    // Running again over the same scope now finds nothing.
    const rerun = await call(api, 'POST', '/api/v1/inventory/reconciliation-runs', {
      token: t.accessToken,
      body: { variantId },
    });
    expect(rerun.body).toMatchObject({ mismatchCount: 0 });
  });
});

describe('multi-warehouse balances', () => {
  it('keeps balances independent per warehouse', async () => {
    const variantId = await createVariant(`MW-${Date.now()}`);
    await call(api, 'POST', '/api/v1/inventory/receive', {
      token: t.accessToken,
      headers: { 'idempotency-key': `mw:${variantId}:1` },
      body: { lines: [{ warehouseId, variantId, quantity: '4' }] },
    });
    await call(api, 'POST', '/api/v1/inventory/receive', {
      token: t.accessToken,
      headers: { 'idempotency-key': `mw:${variantId}:2` },
      body: { lines: [{ warehouseId: warehouse2Id, variantId, quantity: '7' }] },
    });
    expect(await balanceOf(variantId, warehouseId)).toMatchObject({ onHand: '4.000' });
    expect(await balanceOf(variantId, warehouse2Id)).toMatchObject({ onHand: '7.000' });
  });
});
