import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inventory } from '@stockos/core';
import { tenantTx, type TxOptions } from '@stockos/database';
import { uuidv7 } from '@stockos/shared';
import {
  expectLedgerChainsAreContinuous,
  expectLedgerMatchesBalances,
  expectNoNegativeBuckets,
  expectNotOvercommitted,
} from '../support/invariants';
import { seedTenant, seedVariants, type SeededTenant } from '../support/seed';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

const CONCURRENCY = 100;
const engine = new inventory.InventoryEngine();
let db: TestDatabase;

beforeAll(async () => {
  // Pool as large as the burst so requests really hit Postgres at the same time.
  db = await createTestDatabase({ appPoolSize: CONCURRENCY });
});
afterAll(async () => db.drop());

type Outcome = 'ok' | 'insufficient';

async function attempt(
  t: SeededTenant,
  cmd: Omit<inventory.MovementCommand, 'tenantId'>,
  txOptions: TxOptions = {},
): Promise<Outcome> {
  try {
    await tenantTx(db.app, t.tenantId, (tx) => engine.apply(tx, { ...cmd, tenantId: t.tenantId }), txOptions);
    return 'ok';
  } catch (err) {
    if (err instanceof inventory.InsufficientStockError) return 'insufficient';
    throw err;
  }
}

async function balanceOf(t: SeededTenant, variantId: string) {
  const [b] = await tenantTx(db.app, t.tenantId, (tx) =>
    inventory.readBalances(tx, t.tenantId, [{ warehouseId: t.warehouseId, variantId }]),
  );
  return b!;
}

async function assertInvariants(t: SeededTenant, { allowOvercommit = false } = {}) {
  await expectLedgerMatchesBalances(db.app, t.tenantId);
  await expectLedgerChainsAreContinuous(db.app, t.tenantId);
  await expectNoNegativeBuckets(db.app, t.tenantId);
  if (!allowOvercommit) await expectNotOvercommitted(db.app, t.tenantId);
}

describe('overselling under concurrency', () => {
  it('stock = 1, 100 concurrent reservations → exactly one succeeds', async () => {
    const t = await seedTenant(db.app);
    const [v] = await seedVariants(db.app, t, 1, '1');

    const outcomes = await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) =>
        attempt(t, {
          operation: 'RESERVE',
          idempotencyKey: `order:${i}:reserve`,
          reference: { type: 'ORDER', id: uuidv7() },
          lines: [{ warehouseId: t.warehouseId, variantId: v!, quantity: '1' }],
        }),
      ),
    );

    expect(outcomes.filter((o) => o === 'ok')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'insufficient')).toHaveLength(CONCURRENCY - 1);
    expect(await balanceOf(t, v!)).toMatchObject({ onHand: '1.000', reserved: '1.000', available: '0.000' });
    await assertInvariants(t);
  });

  it('POS + Shopee + Lazada + TikTok selling the same SKU at once never exceed stock', async () => {
    const t = await seedTenant(db.app);
    const [v] = await seedVariants(db.app, t, 1, '10');
    const channels = ['POS', 'SHOPEE', 'LAZADA', 'TIKTOK'] as const;

    const outcomes = await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) => {
        const channelCode = channels[i % channels.length]!;
        // POS sells immediately; marketplace orders arrive paid and are committed until shipped.
        return attempt(t, {
          operation: channelCode === 'POS' ? 'SELL_DIRECT' : 'COMMIT_DIRECT',
          idempotencyKey: `${channelCode}:${i}`,
          reference: { type: channelCode === 'POS' ? 'POS_SALE' : 'ORDER', id: uuidv7() },
          channelCode,
          lines: [{ warehouseId: t.warehouseId, variantId: v!, quantity: '1' }],
        });
      }),
    );

    expect(outcomes.filter((o) => o === 'ok')).toHaveLength(10);
    // Every unit was either sold at the POS (on_hand down) or committed to a marketplace order.
    const b = await balanceOf(t, v!);
    expect(b).toMatchObject({ reserved: '0.000', available: '0.000' });
    expect(b.onHand).toBe(b.committed);
    await assertInvariants(t);
  });

  it('the same idempotency key sent 50 times concurrently applies once', async () => {
    const t = await seedTenant(db.app);
    const [v] = await seedVariants(db.app, t, 1, '10');
    const reference = { type: 'ORDER', id: uuidv7() };

    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        tenantTx(db.app, t.tenantId, (tx) =>
          engine.apply(tx, {
            tenantId: t.tenantId,
            operation: 'RESERVE',
            idempotencyKey: 'shopee:order:SN123:reserve',
            reference,
            lines: [{ warehouseId: t.warehouseId, variantId: v!, quantity: '3' }],
          }),
        ),
      ),
    );

    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(new Set(results.map((r) => r.movementId)).size).toBe(1);
    expect((await balanceOf(t, v!)).reserved).toBe('3.000');
    await assertInvariants(t);
  });

  it('multi-line orders in random line order do not deadlock', async () => {
    const t = await seedTenant(db.app);
    const variants = await seedVariants(db.app, t, 10, '1000');
    let requested = 0;

    const outcomes = await Promise.all(
      Array.from({ length: 200 }, (_, i) => {
        const picked = shuffle([...variants]).slice(0, 1 + (i % 5));
        requested += picked.length;
        // No retries: a deadlock must surface as a failure instead of being papered over.
        return attempt(
          t,
          {
            operation: 'RESERVE',
            idempotencyKey: `multi:${i}`,
            reference: { type: 'ORDER', id: uuidv7() },
            lines: shuffle(
              picked.map((variantId) => ({ warehouseId: t.warehouseId, variantId, quantity: '1' })),
            ),
          },
          { maxRetries: 0 },
        );
      }),
    );

    expect(outcomes.every((o) => o === 'ok')).toBe(true);
    const balances = await Promise.all(variants.map((v) => balanceOf(t, v)));
    expect(balances.reduce((sum, b) => sum + Number(b.reserved), 0)).toBe(requested);
    await assertInvariants(t);
  });

  it('a random mix of operations keeps ledger and balances consistent', async () => {
    const t = await seedTenant(db.app);
    const variants = await seedVariants(db.app, t, 3, '20');
    const ops: inventory.Operation[] = [
      'RESERVE',
      'RELEASE',
      'COMMIT',
      'COMMIT_DIRECT',
      'UNCOMMIT',
      'SHIP',
      'SELL_DIRECT',
      'LOSS',
      'FOUND',
      'MARK_DAMAGED',
      'RETURN_SELLABLE',
      'EXPECT_INCOMING',
      'RECEIVE_PURCHASE',
    ];

    for (let wave = 0; wave < 5; wave++) {
      await Promise.all(
        Array.from({ length: CONCURRENCY }, (_, i) =>
          attempt(t, {
            operation: ops[(i * 7 + wave) % ops.length]!,
            idempotencyKey: `mix:${wave}:${i}`,
            reference: { type: 'TEST', id: uuidv7() },
            lines: [
              {
                warehouseId: t.warehouseId,
                variantId: variants[i % variants.length]!,
                quantity: String(1 + (i % 3)),
              },
            ],
          }),
        ),
      );
    }
    // LOSS and MARK_DAMAGED record physical facts and may leave rows OVERCOMMITTED (available < 0).
    await assertInvariants(t, { allowOvercommit: true });
  });
});

function shuffle<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items;
}
