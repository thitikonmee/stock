import { sql } from 'kysely';
import type { Tx } from '@stockos/database';
import { assertCan, type Principal } from '../../iam/public-api';

export interface BalanceRow {
  warehouseId: string;
  variantId: string;
  sku: string;
  variantName: string;
  onHand: string;
  reserved: string;
  committed: string;
  damaged: string;
  incoming: string;
  available: string;
  lowStockThreshold: string | null;
  version: string;
}

export interface BalanceQuery {
  variantId?: string;
  warehouseId?: string;
  lowStock?: boolean;
  cursor?: string;
  limit?: number;
}
export interface BalancePage {
  data: BalanceRow[];
  page: { nextCursor: string | null };
}

export interface LedgerLine {
  id: string;
  createdAt: string;
  occurredAt: string;
  transactionType: string;
  bucket: string;
  quantity: string;
  beforeQuantity: string;
  afterQuantity: string;
  unitCost: string | null;
  referenceType: string;
  referenceId: string;
  reasonCode: string | null;
  note: string | null;
}
export interface TransactionQuery {
  variantId?: string;
  warehouseId?: string;
  type?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
}
export interface TransactionPage {
  data: LedgerLine[];
  page: { nextCursor: string | null };
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Read-only queries over balances and the ledger (stock overview, stock card, low-stock list). */
export class InventoryQueryService {
  async listBalances(tx: Tx, principal: Principal, query: BalanceQuery): Promise<BalancePage> {
    assertCan(principal, 'inventory.read');
    const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const cursor = decodeCursor(query.cursor);

    const { rows } = await sql<BalanceRow & { updated_at: Date }>`
      select b.warehouse_id as "warehouseId", b.variant_id as "variantId", v.sku, v.name as "variantName",
             b.on_hand as "onHand", b.reserved, b.committed, b.damaged, b.incoming, b.available,
             v.low_stock_threshold as "lowStockThreshold", b.version::text as version, b.updated_at
        from inventory_balances b
        join product_variants v on v.tenant_id = b.tenant_id and v.id = b.variant_id
       where v.deleted_at is null
         and (${query.variantId ?? null}::uuid is null or b.variant_id = ${query.variantId ?? null})
         and (${query.warehouseId ?? null}::uuid is null or b.warehouse_id = ${query.warehouseId ?? null})
         and (${query.lowStock ?? null}::boolean is not true
              or (v.low_stock_threshold is not null and b.available <= v.low_stock_threshold))
         and (
           ${cursor?.updatedAt ?? null}::timestamptz is null
           or (b.updated_at, b.variant_id) < (${cursor?.updatedAt ?? null}::timestamptz, ${cursor?.variantId ?? null}::uuid)
         )
       order by b.updated_at desc, b.variant_id desc
       limit ${limit + 1}`.execute(tx);

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      data: page.map(({ updated_at: _updatedAt, ...r }) => r),
      page: {
        nextCursor:
          hasMore && last
            ? Buffer.from(`${last.updated_at.toISOString()}|${last.variantId}`, 'utf8').toString('base64url')
            : null,
      },
    };
  }

  /** Stock card: the ledger lines for one SKU (optionally at one warehouse), newest first. */
  async listTransactions(tx: Tx, principal: Principal, query: TransactionQuery): Promise<TransactionPage> {
    assertCan(principal, 'inventory.read');
    const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const cursor = decodeTxCursor(query.cursor);

    const { rows } = await sql<{
      id: string;
      created_at: Date;
      occurred_at: Date;
      transaction_type: string;
      bucket: string;
      quantity: string;
      before_quantity: string;
      after_quantity: string;
      unit_cost: string | null;
      reference_type: string;
      reference_id: string;
      reason_code: string | null;
      note: string | null;
    }>`
      select id, created_at, occurred_at, transaction_type, bucket, quantity, before_quantity,
             after_quantity, unit_cost, reference_type, reference_id, reason_code, note
        from inventory_transactions
       where (${query.variantId ?? null}::uuid is null or variant_id = ${query.variantId ?? null})
         and (${query.warehouseId ?? null}::uuid is null or warehouse_id = ${query.warehouseId ?? null})
         and (${query.type ?? null}::text is null or transaction_type = ${query.type ?? null})
         and (${query.from ?? null}::timestamptz is null or occurred_at >= ${query.from ?? null}::timestamptz)
         and (${query.to ?? null}::timestamptz is null or occurred_at <= ${query.to ?? null}::timestamptz)
         and (
           ${cursor?.createdAt ?? null}::timestamptz is null
           or (created_at, id) < (${cursor?.createdAt ?? null}::timestamptz, ${cursor?.id ?? null}::uuid)
         )
       order by created_at desc, id desc
       limit ${limit + 1}`.execute(tx);

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      data: page.map((r) => ({
        id: r.id,
        createdAt: r.created_at.toISOString(),
        occurredAt: r.occurred_at.toISOString(),
        transactionType: r.transaction_type,
        bucket: r.bucket,
        quantity: r.quantity,
        beforeQuantity: r.before_quantity,
        afterQuantity: r.after_quantity,
        unitCost: r.unit_cost,
        referenceType: r.reference_type,
        referenceId: r.reference_id,
        reasonCode: r.reason_code,
        note: r.note,
      })),
      page: {
        nextCursor:
          hasMore && last
            ? Buffer.from(`${last.created_at.toISOString()}|${last.id}`, 'utf8').toString('base64url')
            : null,
      },
    };
  }
}

function decodeCursor(cursor: string | undefined): { updatedAt: string; variantId: string } | undefined {
  if (!cursor) return undefined;
  const [updatedAt, variantId] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  return updatedAt && variantId ? { updatedAt, variantId } : undefined;
}

function decodeTxCursor(cursor: string | undefined): { createdAt: string; id: string } | undefined {
  if (!cursor) return undefined;
  const [createdAt, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  return createdAt && id ? { createdAt, id } : undefined;
}
