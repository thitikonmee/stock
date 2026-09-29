import { sql } from 'kysely';
import type { Tx } from '@stockos/database';
import { NotFoundError, uuidv7 } from '@stockos/shared';
import { recordAudit } from '../../audit/public-api';
import { assertCan, type Principal } from '../../iam/public-api';
import {
  computeExpectedBalance,
  rebuildBalance,
  type BucketDiff,
} from '../infrastructure/rebuild-repository';

export interface ReconciliationItem {
  id: string;
  variantId: string;
  expectedQty: string | null;
  actualQty: string | null;
  diff: string | null;
  classification: string | null;
  resolution: string | null;
}
export interface ReconciliationRun {
  id: string;
  type: 'LEDGER_BALANCE';
  status: 'RUNNING' | 'COMPLETED' | 'FAILED';
  checkedCount: number;
  mismatchCount: number;
  startedAt: string;
  finishedAt: string | null;
  items: ReconciliationItem[];
}

const MAX_CHECKED = 5000;

/**
 * Ledger↔balance reconciliation: `inventory_transactions` is the source of truth, so any row whose
 * stored bucket totals disagree with the ledger's own sum is a real mismatch (data corruption,
 * a bug, or a manual DB edit) — never something a normal engine operation can cause on its own.
 */
export class ReconciliationService {
  async run(
    tx: Tx,
    principal: Principal,
    query: { warehouseId?: string; variantId?: string } = {},
  ): Promise<ReconciliationRun> {
    assertCan(principal, 'inventory.read');
    const runId = uuidv7();
    await sql`insert into reconciliation_runs (tenant_id, id, type, status) values (${principal.tenantId}, ${runId}, 'LEDGER_BALANCE', 'RUNNING')`.execute(
      tx,
    );

    const { rows: balances } = await sql<{ warehouse_id: string; variant_id: string }>`
      select warehouse_id, variant_id from inventory_balances
       where (${query.warehouseId ?? null}::uuid is null or warehouse_id = ${query.warehouseId ?? null})
         and (${query.variantId ?? null}::uuid is null or variant_id = ${query.variantId ?? null})
       order by warehouse_id, variant_id
       limit ${MAX_CHECKED}`.execute(tx);

    const items: ReconciliationItem[] = [];
    for (const b of balances) {
      const expected = await computeExpectedBalance(tx, principal.tenantId, b.warehouse_id, b.variant_id);
      const { rows: currentRows } = await sql<{
        on_hand: string;
        reserved: string;
        committed: string;
        damaged: string;
        incoming: string;
      }>`select on_hand, reserved, committed, damaged, incoming from inventory_balances
          where tenant_id = ${principal.tenantId} and warehouse_id = ${b.warehouse_id} and variant_id = ${b.variant_id}`.execute(
        tx,
      );
      const current = currentRows[0]!;
      const currentByBucket: Record<string, string> = {
        ON_HAND: current.on_hand,
        RESERVED: current.reserved,
        COMMITTED: current.committed,
        DAMAGED: current.damaged,
        INCOMING: current.incoming,
      };
      const mismatched = (Object.keys(expected) as (keyof typeof expected)[]).filter(
        (bucket) => expected[bucket] !== currentByBucket[bucket],
      );
      if (mismatched.length === 0) continue;

      const itemId = uuidv7();
      const expectedTotal = mismatched.map((k) => expected[k]).join(',');
      const actualTotal = mismatched.map((k) => currentByBucket[k]).join(',');
      await sql`insert into reconciliation_items (tenant_id, id, run_id, variant_id, expected_qty, actual_qty,
                                                   diff, classification, resolution)
                values (${principal.tenantId}, ${itemId}, ${runId}, ${b.variant_id}, null, null, null,
                        ${'TRUE_MISMATCH:' + mismatched.join('|')}, 'OPEN')`.execute(tx);
      items.push({
        id: itemId,
        variantId: b.variant_id,
        expectedQty: expectedTotal,
        actualQty: actualTotal,
        diff: null,
        classification: 'TRUE_MISMATCH:' + mismatched.join('|'),
        resolution: 'OPEN',
      });
    }

    await sql`update reconciliation_runs set status = 'COMPLETED', checked_count = ${balances.length},
                     mismatch_count = ${items.length}, finished_at = now() where id = ${runId}`.execute(tx);
    await recordAudit(tx, {
      tenantId: principal.tenantId,
      action: 'inventory.reconciliation.run',
      resourceType: 'reconciliation_run',
      resourceId: runId,
      after: { checked: balances.length, mismatches: items.length },
    });
    return {
      id: runId,
      type: 'LEDGER_BALANCE',
      status: 'COMPLETED',
      checkedCount: balances.length,
      mismatchCount: items.length,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      items,
    };
  }

  async get(tx: Tx, principal: Principal, id: string): Promise<ReconciliationRun> {
    assertCan(principal, 'inventory.read');
    const { rows } = await sql<{
      id: string;
      status: 'RUNNING' | 'COMPLETED' | 'FAILED';
      checked_count: number;
      mismatch_count: number;
      started_at: Date;
      finished_at: Date | null;
    }>`select id, status, checked_count, mismatch_count, started_at, finished_at
        from reconciliation_runs where id = ${id}`.execute(tx);
    const run = rows[0];
    if (!run) throw new NotFoundError('Reconciliation run not found');
    const { rows: items } = await sql<{
      id: string;
      variant_id: string;
      classification: string | null;
      resolution: string | null;
    }>`select id, variant_id, classification, resolution from reconciliation_items where run_id = ${id}`.execute(
      tx,
    );
    return {
      id: run.id,
      type: 'LEDGER_BALANCE',
      status: run.status,
      checkedCount: run.checked_count,
      mismatchCount: run.mismatch_count,
      startedAt: run.started_at.toISOString(),
      finishedAt: run.finished_at?.toISOString() ?? null,
      items: items.map((i) => ({
        id: i.id,
        variantId: i.variant_id,
        expectedQty: null,
        actualQty: null,
        diff: null,
        classification: i.classification,
        resolution: i.resolution,
      })),
    };
  }

  /** Recompute balances straight from the ledger for every mismatch found by a run, and mark them resolved. */
  async rebuildFromRun(
    tx: Tx,
    principal: Principal,
    runId: string,
  ): Promise<{ corrected: number; diffs: BucketDiff[][] }> {
    assertCan(principal, 'inventory.adjust.approve'); // rewriting authoritative balances is a sensitive op
    const { rows } = await sql<{ id: string; variant_id: string }>`
      select ri.id, ri.variant_id from reconciliation_items ri
       where ri.run_id = ${runId} and ri.resolution = 'OPEN'`.execute(tx);
    if (rows.length === 0) throw new NotFoundError('No open mismatches for this run');

    const { rows: warehouseRows } = await sql<{ warehouse_id: string; variant_id: string }>`
      select distinct b.warehouse_id, b.variant_id from inventory_balances b
       where b.variant_id = any(${rows.map((r) => r.variant_id)}::uuid[])`.execute(tx);

    const diffs: BucketDiff[][] = [];
    let corrected = 0;
    for (const b of warehouseRows) {
      const outcome = await rebuildBalance(tx, principal.tenantId, b.warehouse_id, b.variant_id);
      if (outcome.corrected) {
        corrected++;
        diffs.push(outcome.mismatches);
      }
    }
    await sql`update reconciliation_items set resolution = 'AUTO_RESOLVED', resolved_by = ${principal.membershipId},
                     resolved_at = now() where run_id = ${runId} and resolution = 'OPEN'`.execute(tx);
    await recordAudit(tx, {
      tenantId: principal.tenantId,
      action: 'inventory.reconciliation.rebuild',
      resourceType: 'reconciliation_run',
      resourceId: runId,
      after: { corrected, diffs },
    });
    return { corrected, diffs };
  }
}
