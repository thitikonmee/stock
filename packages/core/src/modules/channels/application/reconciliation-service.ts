import { sql } from 'kysely';
import type { Tx } from '@stockos/database';
import { Dec, NotFoundError, uuidv7 } from '@stockos/shared';
import { assertCan, systemPrincipal, type Principal } from '../../iam/public-api';
import type { InventoryQueryService } from '../../inventory/public-api';
import { computeSellable } from '../domain/stock-policy';
import type { ReconciliationItemRow, ReconciliationRunRow } from '../domain/types';
import type { AdapterRegistry } from './adapter-registry';
import type { TokenManager } from './token-manager';
import type { StockPolicyService } from './stock-policy-service';
import { loadChannelAccount } from './account-repository';

/**
 * Compares what we last pushed/computed as sellable against what the channel actually shows
 * (docs/06 §21, reconciliation_runs/reconciliation_items — already in the baseline schema).
 * A mismatch here is either "we haven't pushed our latest number yet" (benign, self-heals on the
 * next stock push) or a real drift worth a human's attention — this phase reports both and leaves
 * the classification/resolution decision to the admin console, not an automatic fix.
 */
export class ReconciliationService {
  constructor(
    private readonly registry: AdapterRegistry,
    private readonly tokens: TokenManager,
    private readonly inventoryQuery: InventoryQueryService,
    private readonly policies: StockPolicyService,
  ) {}

  async run(tx: Tx, principal: Principal, channelAccountId: string): Promise<ReconciliationRunRow> {
    assertCan(principal, 'channel.sync');
    const account = await loadChannelAccount(tx, channelAccountId);
    if (!account) throw new NotFoundError('Channel account not found');
    const runId = uuidv7();
    await sql`insert into reconciliation_runs (tenant_id, id, type, channel_account_id, status)
              values (${principal.tenantId}, ${runId}, 'CHANNEL_STOCK', ${channelAccountId}, 'RUNNING')`.execute(
      tx,
    );

    const { rows: mapped } = await sql<{
      id: string;
      external_item_id: string;
      external_variant_id: string;
      variant_id: string;
    }>`select id, external_item_id, external_variant_id, variant_id from channel_product_variants
        where channel_account_id = ${channelAccountId} and variant_id is not null
          and mapping_status in ('AUTO_MAPPED','CONFIRMED')`.execute(tx);

    let checked = 0;
    let mismatches = 0;
    if (mapped.length > 0 && account.defaultWarehouseId) {
      const adapter = this.registry.get(account.channelCode);
      const accountRef = {
        tenantId: principal.tenantId,
        channelAccountId,
        externalShopId: account.externalShopId,
      };
      const accessToken = await this.tokens.getValidAccessToken(tx, accountRef, account.channelCode);
      const actual = adapter.getInventory
        ? await adapter.getInventory(
            accountRef,
            accessToken,
            mapped.map((m) => ({
              externalItemId: m.external_item_id,
              externalVariantId: m.external_variant_id,
            })),
          )
        : [];
      const actualByKey = new Map(
        actual.map((a) => [`${a.externalItemId}\u0000${a.externalVariantId}`, a.quantity]),
      );
      const reader = systemPrincipal(principal.tenantId, ['inventory.read']);

      for (const row of mapped) {
        checked++;
        const balance = await this.inventoryQuery.listBalances(tx, reader, {
          variantId: row.variant_id,
          warehouseId: account.defaultWarehouseId,
        });
        const policy = await this.policies.resolveEffective(tx, channelAccountId, row.variant_id);
        const expected = computeSellable(balance.data[0]?.available ?? '0', policy);
        const actualQty = actualByKey.get(`${row.external_item_id}\u0000${row.external_variant_id}`) ?? null;
        const diff = actualQty === null ? null : new Dec(actualQty).minus(expected).toFixed(3);
        if (diff !== null && !new Dec(diff).isZero()) mismatches++;
        await sql`insert into reconciliation_items (tenant_id, id, run_id, variant_id, channel_product_variant_id,
                                                     expected_qty, actual_qty, diff, classification, resolution)
                  values (${principal.tenantId}, ${uuidv7()}, ${runId}, ${row.variant_id}, ${row.id},
                          ${expected}, ${actualQty}, ${diff},
                          ${diff === null ? 'NO_DATA' : new Dec(diff).isZero() ? 'MATCH' : 'TRUE_MISMATCH'},
                          ${diff !== null && !new Dec(diff).isZero() ? 'OPEN' : 'AUTO_RESOLVED'})`.execute(
          tx,
        );
      }
    }

    await sql`update reconciliation_runs set status = 'COMPLETED', checked_count = ${checked},
                mismatch_count = ${mismatches}, finished_at = now() where id = ${runId}`.execute(tx);
    return (await this.getRun(tx, principal, runId))!;
  }

  async getRun(tx: Tx, principal: Principal, runId: string): Promise<ReconciliationRunRow | null> {
    assertCan(principal, 'channel.read');
    const { rows } = await sql<{
      id: string;
      channel_account_id: string | null;
      status: ReconciliationRunRow['status'];
      checked_count: number;
      mismatch_count: number;
      started_at: Date;
      finished_at: Date | null;
    }>`select id, channel_account_id, status, checked_count, mismatch_count, started_at, finished_at
        from reconciliation_runs where id = ${runId}`.execute(tx);
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      type: 'CHANNEL_STOCK',
      channelAccountId: row.channel_account_id,
      status: row.status,
      checkedCount: row.checked_count,
      mismatchCount: row.mismatch_count,
      startedAt: row.started_at.toISOString(),
      finishedAt: row.finished_at?.toISOString() ?? null,
    };
  }

  async listRuns(tx: Tx, principal: Principal, channelAccountId?: string): Promise<ReconciliationRunRow[]> {
    assertCan(principal, 'channel.read');
    if (channelAccountId && !(await loadChannelAccount(tx, channelAccountId))) {
      throw new NotFoundError('Channel account not found');
    }
    const { rows } = await sql<{ id: string }>`
      select id from reconciliation_runs
       where ${channelAccountId ?? null}::uuid is null or channel_account_id = ${channelAccountId ?? null}
       order by started_at desc limit 50`.execute(tx);
    const runs = await Promise.all(rows.map((r) => this.getRun(tx, principal, r.id)));
    return runs.filter((r): r is ReconciliationRunRow => r !== null);
  }

  async listItems(tx: Tx, principal: Principal, runId: string): Promise<ReconciliationItemRow[]> {
    assertCan(principal, 'channel.read');
    if (!(await this.getRun(tx, principal, runId))) throw new NotFoundError('Reconciliation run not found');
    const { rows } = await sql<{
      id: string;
      variant_id: string | null;
      channel_product_variant_id: string | null;
      expected_qty: string | null;
      actual_qty: string | null;
      diff: string | null;
      classification: string | null;
      resolution: ReconciliationItemRow['resolution'];
    }>`select id, variant_id, channel_product_variant_id, expected_qty, actual_qty, diff, classification, resolution
        from reconciliation_items where run_id = ${runId} order by id`.execute(tx);
    return rows.map((r) => ({
      id: r.id,
      variantId: r.variant_id,
      channelProductVariantId: r.channel_product_variant_id,
      expectedQty: r.expected_qty,
      actualQty: r.actual_qty,
      diff: r.diff,
      classification: r.classification,
      resolution: r.resolution,
    }));
  }
}
