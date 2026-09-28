import { sql } from 'kysely';
import { PgErrorCode, pgErrorCode, type Tx } from '@stockos/database';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  formatMoney,
  isUuid,
  toMoney,
  uuidv7,
} from '@stockos/shared';
import { recordAudit } from '../../audit/public-api';
import { assertCan, type Principal } from '../../iam/public-api';

export interface PriceList {
  id: string;
  code: string;
  name: string;
  channelCode: string | null;
  priceIncludesTax: boolean;
  priority: number;
  isDefault: boolean;
}
export interface PriceListInput {
  code: string;
  name: string;
  channelCode?: string | null;
  priceIncludesTax?: boolean;
  priority?: number;
  isDefault?: boolean;
}

export interface Price {
  id: string;
  priceListId: string;
  variantId: string;
  minQty: string;
  price: string;
}

const CODE_RE = /^[A-Z0-9][A-Z0-9_-]{0,19}$/;
const RETAIL_CODE = 'RETAIL';

/**
 * Price lists + prices (Phase 2 "basic": a flat price per variant per list; scheduling/tiers stay
 * on the plan for a later pricing phase). Every tenant gets a default RETAIL list at signup.
 */
export class PriceService {
  async ensureDefaultList(tx: Tx, tenantId: string): Promise<void> {
    await sql`insert into price_lists (tenant_id, id, code, name, price_includes_tax, priority, is_default)
              values (${tenantId}, ${uuidv7()}, ${RETAIL_CODE}, 'Retail', true, 100, true)
              on conflict (tenant_id, code) do nothing`.execute(tx);
  }

  async listLists(tx: Tx, principal: Principal): Promise<PriceList[]> {
    assertCan(principal, 'price.read');
    const { rows } =
      await sql<PriceListRow>`select ${listCols} from price_lists order by priority, code`.execute(tx);
    return rows.map(toPriceList);
  }

  async createList(tx: Tx, principal: Principal, input: PriceListInput): Promise<PriceList> {
    assertCan(principal, 'price.manage');
    if (!CODE_RE.test(input.code)) throw new ValidationError('Code must be 1-20 chars: A-Z, 0-9, _ or -');
    const id = uuidv7();
    try {
      await sql`insert into price_lists (tenant_id, id, code, name, channel_code, price_includes_tax, priority, is_default)
                values (${principal.tenantId}, ${id}, ${input.code}, ${requireName(input.name)},
                        ${input.channelCode ?? null}, ${input.priceIncludesTax ?? true}, ${input.priority ?? 100},
                        ${input.isDefault ?? false})`.execute(tx);
    } catch (err) {
      if (pgErrorCode(err) === PgErrorCode.UniqueViolation)
        throw new ConflictError(`Price list ${input.code} already exists`);
      throw err;
    }
    await recordAudit(tx, {
      tenantId: principal.tenantId,
      action: 'price_list.create',
      resourceType: 'price_list',
      resourceId: id,
      after: { code: input.code },
    });
    const { rows } = await sql<PriceListRow>`select ${listCols} from price_lists where id = ${id}`.execute(
      tx,
    );
    return toPriceList(rows[0]!);
  }

  async listPrices(tx: Tx, principal: Principal, priceListId: string): Promise<Price[]> {
    assertCan(principal, 'price.read');
    const { rows: listRows } = await sql`select 1 from price_lists where id = ${priceListId}`.execute(tx);
    if (listRows.length === 0) throw new NotFoundError('Price list not found');
    const { rows } = await sql<PriceRow>`
      select ${priceCols} from prices where price_list_id = ${priceListId} order by variant_id, min_qty`.execute(
      tx,
    );
    return rows.map(toPrice);
  }

  /** Upsert the flat price for a variant on a list (min_qty = 1, always valid). */
  async setPrice(
    tx: Tx,
    principal: Principal,
    priceListId: string,
    input: { variantId: string; price: string },
  ): Promise<Price> {
    assertCan(principal, 'price.manage');
    if (!isUuid(input.variantId)) throw new ValidationError('Unknown variant');
    const { rows: listRows } = await sql`select 1 from price_lists where id = ${priceListId}`.execute(tx);
    if (listRows.length === 0) throw new NotFoundError('Price list not found');
    const { rows: variantRows } =
      await sql`select 1 from product_variants where id = ${input.variantId} and deleted_at is null`.execute(
        tx,
      );
    if (variantRows.length === 0)
      throw new ValidationError('Unknown variant', { variantId: input.variantId });
    const price = formatMoney(toMoney(input.price));

    await sql`delete from prices where price_list_id = ${priceListId} and variant_id = ${input.variantId} and min_qty = 1`.execute(
      tx,
    );
    const id = uuidv7();
    await sql`insert into prices (tenant_id, id, price_list_id, variant_id, min_qty, price, created_by)
              values (${principal.tenantId}, ${id}, ${priceListId}, ${input.variantId}, 1, ${price}, ${principal.membershipId})`.execute(
      tx,
    );
    await recordAudit(tx, {
      tenantId: principal.tenantId,
      action: 'price.set',
      resourceType: 'price_list',
      resourceId: priceListId,
      after: { variantId: input.variantId, price },
    });
    const { rows } = await sql<PriceRow>`select ${priceCols} from prices where id = ${id}`.execute(tx);
    return toPrice(rows[0]!);
  }
}

interface PriceListRow {
  id: string;
  code: string;
  name: string;
  channel_code: string | null;
  price_includes_tax: boolean;
  priority: number;
  is_default: boolean;
}
const listCols = sql`id, code, name, channel_code, price_includes_tax, priority, is_default`;
const toPriceList = (r: PriceListRow): PriceList => ({
  id: r.id,
  code: r.code,
  name: r.name,
  channelCode: r.channel_code,
  priceIncludesTax: r.price_includes_tax,
  priority: r.priority,
  isDefault: r.is_default,
});

interface PriceRow {
  id: string;
  price_list_id: string;
  variant_id: string;
  min_qty: string;
  price: string;
}
const priceCols = sql`id, price_list_id, variant_id, min_qty, price`;
const toPrice = (r: PriceRow): Price => ({
  id: r.id,
  priceListId: r.price_list_id,
  variantId: r.variant_id,
  minQty: r.min_qty,
  price: r.price,
});

function requireName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 120) throw new ValidationError('Name must be 1-120 characters');
  return trimmed;
}
