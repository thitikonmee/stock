import { sql } from 'kysely';
import type { Tx } from '@stockos/database';
import {
  BusinessRuleError,
  Dec,
  NotFoundError,
  ValidationError,
  formatQuantity,
  isUuid,
  toQuantity,
} from '@stockos/shared';
import { recordAudit } from '../../audit/public-api';
import { assertCan, type Principal } from '../../iam/public-api';
import type { QuotaPosition } from '../domain/stock-policy';
import { loadChannelAccount } from './account-repository';

export interface ChannelAllocation {
  channelAccountId: string;
  warehouseId: string;
  variantId: string;
  sku: string;
  variantName: string;
  allocatedQty: string;
  consumedQty: string;
  remainingQty: string;
  /** Warehouse stock not reserved by anyone and not allocated to any channel (what POS can sell). */
  unallocatedQty: string;
}

export interface AllocationLineInput {
  variantId: string;
  /** Defaults to the account's default warehouse. */
  warehouseId?: string;
  allocatedQty: string;
}

/**
 * CHANNEL_ALLOCATION quotas (docs/04-inventory.md §8). An allocation reserves part of a warehouse's
 * available stock for one marketplace account: InventoryEngine's AVAILABLE guard keeps everyone else
 * (POS, manual orders, other channels) out of the remaining quota, the account's own orders consume
 * it (ReservationService), and its stock push is capped at it under the CHANNEL_ALLOCATION strategy.
 *
 * Setting quotas locks the (warehouse, variant) balance row first — same lock order as the engine
 * (balances → allocations) — so concurrent edits can't jointly allocate more than is available.
 */
export class AllocationService {
  async list(tx: Tx, principal: Principal, channelAccountId: string): Promise<ChannelAllocation[]> {
    assertCan(principal, 'channel.read');
    await this.requireAccount(tx, channelAccountId);
    const { rows } = await sql<AllocationRow>`
      select ${allocationCols} from channel_allocations a
        join product_variants v on v.id = a.variant_id
        join inventory_balances b on b.warehouse_id = a.warehouse_id and b.variant_id = a.variant_id
       where a.channel_account_id = ${channelAccountId}
       order by v.sku`.execute(tx);
    return rows.map(toAllocation);
  }

  async set(
    tx: Tx,
    principal: Principal,
    channelAccountId: string,
    lines: readonly AllocationLineInput[],
  ): Promise<ChannelAllocation[]> {
    assertCan(principal, 'channel.manage');
    const account = await this.requireAccount(tx, channelAccountId);
    if (lines.length === 0 || lines.length > 500) throw new ValidationError('Send 1..500 lines');

    for (const line of lines) {
      const warehouseId = line.warehouseId ?? account.defaultWarehouseId;
      if (!warehouseId)
        throw new ValidationError('Set a default warehouse for this shop, or pass warehouseId');
      if (!isUuid(warehouseId) || !isUuid(line.variantId))
        throw new ValidationError('Unknown warehouse or variant');
      const allocated = toQuantity(line.allocatedQty, { allowZero: true });

      const { rows: bal } = await sql<{ free: string }>`
        select on_hand - reserved - committed as free from inventory_balances
         where warehouse_id = ${warehouseId} and variant_id = ${line.variantId}
         for update`.execute(tx);
      if (!bal[0]) {
        throw new ValidationError('This SKU has no stock record at that warehouse yet', {
          variantId: line.variantId,
          warehouseId,
        });
      }
      const { rows: mine } = await sql<{ consumed_qty: string }>`
        select consumed_qty from channel_allocations
         where channel_account_id = ${channelAccountId} and warehouse_id = ${warehouseId}
           and variant_id = ${line.variantId}`.execute(tx);
      const consumed = new Dec(mine[0]?.consumed_qty ?? 0);
      if (allocated.lessThan(consumed)) {
        throw new BusinessRuleError(
          'ALLOCATION_BELOW_CONSUMED',
          'Cannot allocate less than this shop already sold',
          {
            variantId: line.variantId,
            consumed: formatQuantity(consumed),
          },
        );
      }
      const { rows: others } = await sql<{ remaining: string }>`
        select coalesce(sum(allocated_qty - consumed_qty), 0) as remaining from channel_allocations
         where warehouse_id = ${warehouseId} and variant_id = ${line.variantId}
           and channel_account_id <> ${channelAccountId}`.execute(tx);
      const totalRemaining = new Dec(others[0]!.remaining).plus(allocated.minus(consumed));
      if (totalRemaining.greaterThan(bal[0].free)) {
        throw new BusinessRuleError(
          'OVER_ALLOCATED',
          'Quotas would exceed the stock that is free to allocate',
          {
            variantId: line.variantId,
            free: formatQuantity(new Dec(bal[0].free)),
            allocatedElsewhere: formatQuantity(new Dec(others[0]!.remaining)),
          },
        );
      }
      await sql`
        insert into channel_allocations (tenant_id, channel_account_id, warehouse_id, variant_id, allocated_qty)
        values (${principal.tenantId}, ${channelAccountId}, ${warehouseId}, ${line.variantId}, ${formatQuantity(allocated)})
        on conflict (tenant_id, channel_account_id, warehouse_id, variant_id)
          do update set allocated_qty = excluded.allocated_qty, version = channel_allocations.version + 1,
                        updated_at = now()`.execute(tx);
    }
    await recordAudit(tx, {
      tenantId: principal.tenantId,
      action: 'channel.allocation.set',
      resourceType: 'channel_account',
      resourceId: channelAccountId,
      after: { lines: lines.map((l) => ({ variantId: l.variantId, allocatedQty: l.allocatedQty })) },
    });
    return this.list(tx, principal, channelAccountId);
  }

  private async requireAccount(tx: Tx, id: string) {
    if (!isUuid(id)) throw new NotFoundError('Channel account not found');
    const account = await loadChannelAccount(tx, id);
    if (!account) throw new NotFoundError('Channel account not found');
    return account;
  }
}

interface AllocationRow {
  channel_account_id: string;
  warehouse_id: string;
  variant_id: string;
  sku: string;
  variant_name: string;
  allocated_qty: string;
  consumed_qty: string;
  unallocated: string;
}
const allocationCols = sql`a.channel_account_id, a.warehouse_id, a.variant_id, v.sku, v.name as variant_name,
  a.allocated_qty, a.consumed_qty,
  b.on_hand - b.reserved - b.committed
    - (select coalesce(sum(x.allocated_qty - x.consumed_qty), 0) from channel_allocations x
        where x.warehouse_id = a.warehouse_id and x.variant_id = a.variant_id) as unallocated`;

function toAllocation(r: AllocationRow): ChannelAllocation {
  return {
    channelAccountId: r.channel_account_id,
    warehouseId: r.warehouse_id,
    variantId: r.variant_id,
    sku: r.sku,
    variantName: r.variant_name,
    allocatedQty: r.allocated_qty,
    consumedQty: r.consumed_qty,
    remainingQty: formatQuantity(new Dec(r.allocated_qty).minus(r.consumed_qty)),
    unallocatedQty: formatQuantity(new Dec(r.unallocated)),
  };
}

/** Quota position of one account for stock push / reconciliation (internal: no permission check). */
export async function readQuotaPosition(
  tx: Tx,
  channelAccountId: string,
  warehouseId: string,
  variantId: string,
): Promise<QuotaPosition> {
  const { rows } = await sql<{ own: string | null; others: string }>`
    select sum(allocated_qty - consumed_qty) filter (where channel_account_id = ${channelAccountId}) as own,
           coalesce(sum(allocated_qty - consumed_qty) filter (where channel_account_id <> ${channelAccountId}), 0) as others
      from channel_allocations where warehouse_id = ${warehouseId} and variant_id = ${variantId}`.execute(tx);
  return { ownRemaining: rows[0]?.own ?? null, othersRemaining: rows[0]?.others ?? '0' };
}
