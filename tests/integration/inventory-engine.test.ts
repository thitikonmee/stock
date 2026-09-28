import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inventory } from '@stockos/core';
import { platformTx, tenantTx } from '@stockos/database';
import { IdempotencyKeyReusedError, ValidationError, uuidv7 } from '@stockos/shared';
import { expectLedgerChainsAreContinuous, expectLedgerMatchesBalances } from '../support/invariants';
import { seedTenant, seedVariants, seedWarehouse, type SeededTenant } from '../support/seed';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

const engine = new inventory.InventoryEngine();
let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => db.drop());

function move(
  t: SeededTenant,
  operation: inventory.Operation,
  lines: { variantId: string; quantity: string; warehouseId?: string }[],
  extra: Partial<inventory.MovementCommand> = {},
) {
  return tenantTx(db.app, t.tenantId, (tx) =>
    engine.apply(tx, {
      tenantId: t.tenantId,
      operation,
      idempotencyKey: extra.idempotencyKey ?? `test:${uuidv7()}`,
      reference: extra.reference ?? { type: 'ORDER', id: uuidv7() },
      lines: lines.map((l) => ({
        warehouseId: l.warehouseId ?? t.warehouseId,
        variantId: l.variantId,
        quantity: l.quantity,
      })),
      ...extra,
    }),
  );
}

async function balance(t: SeededTenant, variantId: string, warehouseId = t.warehouseId) {
  const [b] = await tenantTx(db.app, t.tenantId, (tx) =>
    inventory.readBalances(tx, t.tenantId, [{ warehouseId, variantId }]),
  );
  return b;
}

describe('InventoryEngine', () => {
  it('runs the marketplace lifecycle: reserve → commit → ship', async () => {
    const t = await seedTenant(db.app);
    const [v] = await seedVariants(db.app, t, 1, '100');

    await move(t, 'RESERVE', [{ variantId: v!, quantity: '10' }]);
    expect(await balance(t, v!)).toMatchObject({
      onHand: '100.000',
      reserved: '10.000',
      available: '90.000',
    });

    await move(t, 'COMMIT', [{ variantId: v!, quantity: '10' }]);
    expect(await balance(t, v!)).toMatchObject({
      reserved: '0.000',
      committed: '10.000',
      available: '90.000',
    });

    await move(t, 'SHIP', [{ variantId: v!, quantity: '10' }]);
    expect(await balance(t, v!)).toMatchObject({ onHand: '90.000', committed: '0.000', available: '90.000' });

    await expectLedgerMatchesBalances(db.app, t.tenantId);
    await expectLedgerChainsAreContinuous(db.app, t.tenantId);
  });

  it('records who/why/where on every ledger row with before and after quantities', async () => {
    const t = await seedTenant(db.app);
    const [v] = await seedVariants(db.app, t, 1, '5');
    const orderId = uuidv7();
    const userId = uuidv7();
    await move(t, 'SELL_DIRECT', [{ variantId: v!, quantity: '2' }], {
      reference: { type: 'POS_SALE', id: orderId },
      channelCode: 'POS',
      userId,
    });

    const rows = await tenantTx(db.app, t.tenantId, async (tx) => {
      const r = await sql<Record<string, unknown>>`
        select transaction_type, bucket, quantity, before_quantity, after_quantity, reference_type,
               reference_id, channel_code, user_id
          from inventory_transactions where reference_id = ${orderId}`.execute(tx);
      return r.rows;
    });
    expect(rows).toEqual([
      {
        transaction_type: 'SALE',
        bucket: 'ON_HAND',
        quantity: '-2.000',
        before_quantity: '5.000',
        after_quantity: '3.000',
        reference_type: 'POS_SALE',
        reference_id: orderId,
        channel_code: 'POS',
        user_id: userId,
      },
    ]);
  });

  it('rejects a sale that exceeds available stock and changes nothing', async () => {
    const t = await seedTenant(db.app);
    const [v] = await seedVariants(db.app, t, 1, '3');
    await move(t, 'RESERVE', [{ variantId: v!, quantity: '2' }]);

    const err = await move(t, 'SELL_DIRECT', [{ variantId: v!, quantity: '2' }]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(inventory.InsufficientStockError);
    expect((err as inventory.InsufficientStockError).meta).toMatchObject({
      requested: '2.000',
      available: '1.000',
    });
    expect(await balance(t, v!)).toMatchObject({ onHand: '3.000', reserved: '2.000', available: '1.000' });
  });

  it('is all-or-nothing across lines', async () => {
    const t = await seedTenant(db.app);
    const [a, b] = await seedVariants(db.app, t, 2, '1');
    const err = await move(t, 'RESERVE', [
      { variantId: a!, quantity: '1' },
      { variantId: b!, quantity: '2' },
    ]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(inventory.InsufficientStockError);
    expect((await balance(t, a!))?.reserved).toBe('0.000');
    await expectLedgerMatchesBalances(db.app, t.tenantId);
  });

  it('replays an idempotency key without touching stock again', async () => {
    const t = await seedTenant(db.app);
    const [v] = await seedVariants(db.app, t, 1, '10');
    const key = `order:${uuidv7()}:reserve`;
    const reference = { type: 'ORDER', id: uuidv7() };

    const first = await move(t, 'RESERVE', [{ variantId: v!, quantity: '4' }], {
      idempotencyKey: key,
      reference,
    });
    const second = await move(t, 'RESERVE', [{ variantId: v!, quantity: '4' }], {
      idempotencyKey: key,
      reference,
    });

    expect(first.replayed).toBe(false);
    expect(second).toMatchObject({ replayed: true, movementId: first.movementId });
    expect((await balance(t, v!))?.reserved).toBe('4.000');
  });

  it('refuses to reuse an idempotency key for a different movement', async () => {
    const t = await seedTenant(db.app);
    const [v] = await seedVariants(db.app, t, 1, '10');
    const key = `order:${uuidv7()}:reserve`;
    await move(t, 'RESERVE', [{ variantId: v!, quantity: '1' }], { idempotencyKey: key });
    await expect(
      move(t, 'RESERVE', [{ variantId: v!, quantity: '1' }], { idempotencyKey: key }),
    ).rejects.toBeInstanceOf(IdempotencyKeyReusedError);
  });

  it('respects minRemaining (stock held back for other channels)', async () => {
    const t = await seedTenant(db.app);
    const [v] = await seedVariants(db.app, t, 1, '10');
    await expect(
      move(t, 'RESERVE', [{ variantId: v!, quantity: '3' }], { minRemaining: '8' }),
    ).rejects.toBeInstanceOf(inventory.InsufficientStockError);
    await move(t, 'RESERVE', [{ variantId: v!, quantity: '2' }], { minRemaining: '8' });
  });

  it('records a loss even when it leaves reserved stock overcommitted, then blocks new reservations', async () => {
    const t = await seedTenant(db.app);
    const [v] = await seedVariants(db.app, t, 1, '5');
    await move(t, 'RESERVE', [{ variantId: v!, quantity: '4' }]);

    // 3 units found missing: a physical fact, recorded even though 4 are promised to orders.
    await move(t, 'LOSS', [{ variantId: v!, quantity: '3' }]);
    expect(await balance(t, v!)).toMatchObject({ onHand: '2.000', reserved: '4.000', available: '-2.000' });

    await expect(move(t, 'RESERVE', [{ variantId: v!, quantity: '1' }])).rejects.toBeInstanceOf(
      inventory.InsufficientStockError,
    );
    // Cannot lose more than is physically on hand.
    await expect(move(t, 'LOSS', [{ variantId: v!, quantity: '3' }])).rejects.toBeInstanceOf(
      inventory.InsufficientStockError,
    );
    await expectLedgerMatchesBalances(db.app, t.tenantId);
  });

  it('allows negative stock only when both the command and the warehouse permit it', async () => {
    const t = await seedTenant(db.app);
    const store = await seedWarehouse(db.app, t.tenantId, 'STORE1', true);
    const [v] = await seedVariants(db.app, t, 1, '1', store);

    // Online sale: guard applies even in a negative-allowed warehouse.
    await expect(
      move(t, 'SELL_DIRECT', [{ variantId: v!, quantity: '2', warehouseId: store }]),
    ).rejects.toBeInstanceOf(inventory.InsufficientStockError);

    // Offline POS sync: goods already left the store, so the sale is recorded.
    await move(t, 'SELL_DIRECT', [{ variantId: v!, quantity: '2', warehouseId: store }], {
      allowNegative: true,
    });
    expect((await balance(t, v!, store))?.onHand).toBe('-1.000');

    // Same flag in a warehouse that forbids negative stock is still rejected.
    const [w] = await seedVariants(db.app, t, 1, '1');
    await expect(
      move(t, 'SELL_DIRECT', [{ variantId: w!, quantity: '2' }], { allowNegative: true }),
    ).rejects.toBeInstanceOf(inventory.InsufficientStockError);
    await expectLedgerMatchesBalances(db.app, t.tenantId);
  });

  it('handles signed count variances with a guard on the negative side', async () => {
    const t = await seedTenant(db.app);
    const [v] = await seedVariants(db.app, t, 1, '5');
    await move(t, 'COUNT_VARIANCE', [{ variantId: v!, quantity: '-2' }]);
    await move(t, 'COUNT_VARIANCE', [{ variantId: v!, quantity: '1' }]);
    expect((await balance(t, v!))?.onHand).toBe('4.000');
    await expect(move(t, 'COUNT_VARIANCE', [{ variantId: v!, quantity: '-5' }])).rejects.toBeInstanceOf(
      inventory.InsufficientStockError,
    );
  });

  it('creates balance rows on first inbound movement and rejects unknown ids', async () => {
    const t = await seedTenant(db.app);
    const [v] = await seedVariants(db.app, t, 1, null);
    await move(t, 'RECEIVE_DIRECT', [{ variantId: v!, quantity: '7' }]);
    expect((await balance(t, v!))?.onHand).toBe('7.000');

    await expect(move(t, 'RECEIVE_DIRECT', [{ variantId: uuidv7(), quantity: '1' }])).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(
      move(t, 'RECEIVE_DIRECT', [{ variantId: v!, quantity: '1', warehouseId: uuidv7() }]),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('cannot touch another tenant’s stock', async () => {
    const a = await seedTenant(db.app);
    const b = await seedTenant(db.app);
    const [v] = await seedVariants(db.app, a, 1, '5');
    // Tenant B passes A's warehouse and variant ids: invisible under RLS → treated as unknown / no stock.
    await expect(
      move(b, 'RECEIVE_DIRECT', [{ variantId: v!, quantity: '1', warehouseId: a.warehouseId }]),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      move(b, 'RESERVE', [{ variantId: v!, quantity: '1', warehouseId: a.warehouseId }]),
    ).rejects.toBeInstanceOf(inventory.InsufficientStockError);
    expect((await balance(a, v!))?.onHand).toBe('5.000');
  });

  it('writes a StockChanged outbox event in the same transaction', async () => {
    const t = await seedTenant(db.app);
    const [v] = await seedVariants(db.app, t, 1, '5');
    const result = await move(t, 'RESERVE', [{ variantId: v!, quantity: '1' }]);

    const events = await platformTx(db.platform, async (tx) => {
      const { rows } = await sql<{
        event_type: string;
        payload: { items: { variantId: string; available: string }[] };
      }>`
        select event_type, payload from outbox_events where aggregate_id = ${result.movementId}`.execute(tx);
      return rows;
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event_type: 'StockChanged',
      payload: { items: [{ variantId: v, available: '4.000' }] },
    });
  });

  it('rolls back everything when the surrounding transaction fails', async () => {
    const t = await seedTenant(db.app);
    const [v] = await seedVariants(db.app, t, 1, '5');
    const key = `order:${uuidv7()}:reserve`;
    const reference = { type: 'ORDER', id: uuidv7() };
    const cmd = {
      tenantId: t.tenantId,
      operation: 'RESERVE' as const,
      idempotencyKey: key,
      reference,
      lines: [{ warehouseId: t.warehouseId, variantId: v!, quantity: '1' }],
    };

    await expect(
      tenantTx(db.app, t.tenantId, async (tx) => {
        await engine.apply(tx, cmd);
        throw new Error('order insert failed');
      }),
    ).rejects.toThrow('order insert failed');
    expect((await balance(t, v!))?.reserved).toBe('0.000');

    const retry = await tenantTx(db.app, t.tenantId, (tx) => engine.apply(tx, cmd));
    expect(retry.replayed).toBe(false);
    expect((await balance(t, v!))?.reserved).toBe('1.000');
    await expectLedgerMatchesBalances(db.app, t.tenantId);
  });
});
