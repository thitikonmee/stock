import { sql } from 'kysely';
import type { Tx } from '@stockos/database';
import { uuidv7 } from '@stockos/shared';
import { assertCan, type Principal } from '../../iam/public-api';
import { DEFAULT_STOCK_POLICY, type StockPolicy } from '../domain/stock-policy';
import type { StockPolicyRow, UpsertStockPolicyInput } from '../domain/types';

/** CRUD over `channel_stock_policies` (docs/06 §Shopee stock: "safety stock + buffer"). */
export class StockPolicyService {
  /** Most specific row wins: (account, variant) > (account, any variant) > (any account, variant)
   *  > tenant default > the hardcoded no-op default. Shared by `StockSyncService` (what to push)
   *  and `ReconciliationService` (what we'd expect the channel to show) so the two agree. */
  async resolveEffective(tx: Tx, channelAccountId: string, variantId: string): Promise<StockPolicy> {
    const { rows } = await sql<{
      strategy: StockPolicy['strategy'];
      safety_stock: string;
      buffer_percent: string;
      max_push_qty: string | null;
      push_zero_below: string;
    }>`select strategy, safety_stock, buffer_percent, max_push_qty, push_zero_below from channel_stock_policies
        where tenant_id = current_tenant_id()
          and (channel_account_id = ${channelAccountId} or channel_account_id is null)
          and (variant_id = ${variantId} or variant_id is null)
        order by channel_account_id nulls last, variant_id nulls last
        limit 1`.execute(tx);
    const row = rows[0];
    if (!row) return DEFAULT_STOCK_POLICY;
    return {
      strategy: row.strategy,
      safetyStock: row.safety_stock,
      bufferPercent: row.buffer_percent,
      maxPushQty: row.max_push_qty,
      pushZeroBelow: row.push_zero_below,
    };
  }
  async list(tx: Tx, principal: Principal, channelAccountId?: string): Promise<StockPolicyRow[]> {
    assertCan(principal, 'channel.read');
    const { rows } = await sql<Row>`
      select id, channel_account_id, variant_id, strategy, safety_stock, buffer_percent, max_push_qty, push_zero_below
        from channel_stock_policies
       where ${channelAccountId ?? null}::uuid is null or channel_account_id = ${channelAccountId ?? null}
          or channel_account_id is null
       order by channel_account_id nulls first, variant_id nulls first`.execute(tx);
    return rows.map(toRow);
  }

  async upsert(tx: Tx, principal: Principal, input: UpsertStockPolicyInput): Promise<StockPolicyRow> {
    assertCan(principal, 'channel.manage');
    const { rows } = await sql<{ id: string }>`
      insert into channel_stock_policies (tenant_id, id, channel_account_id, variant_id, strategy, safety_stock,
                                          buffer_percent, max_push_qty, push_zero_below)
      values (${principal.tenantId}, ${uuidv7()}, ${input.channelAccountId ?? null}, ${input.variantId ?? null},
              ${input.strategy ?? 'GLOBAL_POOL'}, ${input.safetyStock ?? '0'}, ${input.bufferPercent ?? '0'},
              ${input.maxPushQty ?? null}, ${input.pushZeroBelow ?? '0'})
      on conflict (tenant_id, coalesce(channel_account_id, '00000000-0000-0000-0000-000000000000'),
                    coalesce(variant_id, '00000000-0000-0000-0000-000000000000'))
        do update set strategy = excluded.strategy, safety_stock = excluded.safety_stock, buffer_percent = excluded.buffer_percent,
                      max_push_qty = excluded.max_push_qty, push_zero_below = excluded.push_zero_below
      returning id`.execute(tx);
    const { rows: full } = await sql<Row>`
      select id, channel_account_id, variant_id, strategy, safety_stock, buffer_percent, max_push_qty, push_zero_below
        from channel_stock_policies where id = ${rows[0]!.id}`.execute(tx);
    return toRow(full[0]!);
  }
}

interface Row {
  id: string;
  channel_account_id: string | null;
  variant_id: string | null;
  strategy: StockPolicyRow['strategy'];
  safety_stock: string;
  buffer_percent: string;
  max_push_qty: string | null;
  push_zero_below: string;
}
function toRow(r: Row): StockPolicyRow {
  return {
    id: r.id,
    channelAccountId: r.channel_account_id,
    variantId: r.variant_id,
    strategy: r.strategy,
    safetyStock: r.safety_stock,
    bufferPercent: r.buffer_percent,
    maxPushQty: r.max_push_qty,
    pushZeroBelow: r.push_zero_below,
  };
}
