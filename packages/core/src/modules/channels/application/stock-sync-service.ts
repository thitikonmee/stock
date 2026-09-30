import { sql } from 'kysely';
import type { Tx } from '@stockos/database';
import { NotFoundError, uuidv7 } from '@stockos/shared';
import { assertCan, systemPrincipal, type Principal } from '../../iam/public-api';
import type { InventoryQueryService } from '../../inventory/public-api';
import { computeSellable } from '../domain/stock-policy';
import type { StockUpdate } from '../domain/channel-adapter';
import type { AdapterRegistry } from './adapter-registry';
import type { TokenManager } from './token-manager';
import type { StockPolicyService } from './stock-policy-service';
import { loadChannelAccount } from './account-repository';

export interface StockSyncResult {
  pushed: number;
  failed: number;
  skipped: number;
}

/**
 * `available → sellable → push` (docs/06 §20 StockSyncService, §Shopee stock policy). One push per
 * call, no debounce/coalesce queue in this phase (no Redis here — see stockos-dev-workflow memory)
 * — callers (the webhook handler after SHIP, the manual "sync now" button) just call this directly,
 * which is safe because Shopee's `update_stock` takes an absolute value: re-sending it is idempotent.
 */
export class StockSyncService {
  constructor(
    private readonly registry: AdapterRegistry,
    private readonly tokens: TokenManager,
    private readonly inventoryQuery: InventoryQueryService,
    private readonly policies: StockPolicyService,
  ) {}

  async pushAccount(tx: Tx, principal: Principal, channelAccountId: string): Promise<StockSyncResult> {
    assertCan(principal, 'channel.sync');
    const account = await loadChannelAccount(tx, channelAccountId);
    if (!account) throw new NotFoundError('Channel account not found');
    if (!account.defaultWarehouseId) return { pushed: 0, failed: 0, skipped: 0 };

    const adapter = this.registry.get(account.channelCode);
    const accountRef = {
      tenantId: principal.tenantId,
      channelAccountId,
      externalShopId: account.externalShopId,
    };
    const accessToken = await this.tokens.getValidAccessToken(tx, accountRef, account.channelCode);

    const { rows: mapped } = await sql<{
      external_item_id: string;
      external_variant_id: string;
      variant_id: string;
      quantity_multiplier: string;
    }>`select external_item_id, external_variant_id, variant_id, quantity_multiplier
        from channel_product_variants
       where channel_account_id = ${channelAccountId} and sync_stock and variant_id is not null
         and mapping_status in ('AUTO_MAPPED','CONFIRMED')`.execute(tx);
    if (mapped.length === 0) return { pushed: 0, failed: 0, skipped: 0 };

    const reader = systemPrincipal(principal.tenantId, ['inventory.read']);
    const updates: StockUpdate[] = [];
    const skipped = 0;
    for (const row of mapped) {
      const policy = await this.policies.resolveEffective(tx, channelAccountId, row.variant_id);
      const balance = await this.inventoryQuery.listBalances(tx, reader, {
        variantId: row.variant_id,
        warehouseId: account.defaultWarehouseId,
      });
      const available = balance.data[0]?.available ?? '0';
      const sellable = computeSellable(available, policy);
      const pushQty = (Number(sellable) / Number(row.quantity_multiplier || '1')).toFixed(0);
      updates.push({
        externalItemId: row.external_item_id,
        externalVariantId: row.external_variant_id,
        quantity: pushQty,
      });
    }
    if (updates.length === 0) return { pushed: 0, failed: 0, skipped };

    const pushedQtyByKey = new Map(
      updates.map((u) => [`${u.externalItemId}\u0000${u.externalVariantId}`, u.quantity]),
    );
    const results = await adapter.updateInventory(accountRef, accessToken, updates);
    let pushed = 0;
    let failed = 0;
    for (const r of results) {
      if (r.ok) {
        pushed++;
        const qty = pushedQtyByKey.get(`${r.externalItemId}\u0000${r.externalVariantId}`) ?? '0';
        await sql`update channel_product_variants set last_pushed_qty = ${qty}, last_pushed_at = now()
                  where channel_account_id = ${channelAccountId} and external_item_id = ${r.externalItemId}
                    and external_variant_id = ${r.externalVariantId}`.execute(tx);
      } else {
        failed++;
      }
    }
    await sql`insert into sync_jobs (tenant_id, id, channel_account_id, job_type, status, attempts, input, output,
                                     scheduled_at, started_at, finished_at)
              values (${principal.tenantId}, ${uuidv7()}, ${channelAccountId}, 'STOCK_PUSH',
                      ${failed === 0 ? 'SUCCEEDED' : 'FAILED'}, 1, ${JSON.stringify({ count: updates.length })}::jsonb,
                      ${JSON.stringify({ pushed, failed })}::jsonb, now(), now(), now())`.execute(tx);
    return { pushed, failed, skipped };
  }
}
