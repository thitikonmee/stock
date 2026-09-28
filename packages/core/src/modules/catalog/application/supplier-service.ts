import { sql } from 'kysely';
import { PgErrorCode, pgErrorCode, type Tx } from '@stockos/database';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  formatCost,
  isUuid,
  toCost,
  uuidv7,
} from '@stockos/shared';
import { recordAudit } from '../../audit/public-api';
import { assertCan, type Principal } from '../../iam/public-api';

export interface Supplier {
  id: string;
  code: string;
  name: string;
  taxId: string | null;
  paymentTermsDays: number;
  defaultLeadTimeDays: number;
  currency: string;
  isActive: boolean;
}
export interface SupplierInput {
  code: string;
  name: string;
  taxId?: string | null;
  paymentTermsDays?: number;
  defaultLeadTimeDays?: number;
  currency?: string;
  isActive?: boolean;
}

export interface SupplierProduct {
  supplierId: string;
  variantId: string;
  supplierSku: string | null;
  lastCost: string | null;
  minOrderQty: string | null;
  leadTimeDays: number | null;
  isPreferred: boolean;
}

const CODE_RE = /^[A-Z0-9][A-Z0-9_-]{0,19}$/;

/** Suppliers and their per-SKU price/lead time links (Phase 2 "basic" purchasing prep). */
export class SupplierService {
  async list(tx: Tx, principal: Principal): Promise<Supplier[]> {
    assertCan(principal, 'supplier.read');
    const { rows } = await sql<SupplierRow>`select ${cols} from suppliers order by name`.execute(tx);
    return rows.map(toSupplier);
  }

  async get(tx: Tx, principal: Principal, id: string): Promise<Supplier> {
    assertCan(principal, 'supplier.read');
    return this.getOrThrow(tx, id);
  }

  async create(tx: Tx, principal: Principal, input: SupplierInput): Promise<Supplier> {
    assertCan(principal, 'supplier.manage');
    if (!CODE_RE.test(input.code)) throw new ValidationError('Code must be 1-20 chars: A-Z, 0-9, _ or -');
    const name = requireName(input.name);
    const id = uuidv7();
    try {
      await sql`insert into suppliers (tenant_id, id, code, name, tax_id, payment_terms_days,
                                        default_lead_time_days, currency, is_active)
                values (${principal.tenantId}, ${id}, ${input.code}, ${name}, ${input.taxId ?? null},
                        ${input.paymentTermsDays ?? 30}, ${input.defaultLeadTimeDays ?? 7},
                        ${input.currency ?? 'THB'}, ${input.isActive ?? true})`.execute(tx);
    } catch (err) {
      if (pgErrorCode(err) === PgErrorCode.UniqueViolation)
        throw new ConflictError(`Supplier code ${input.code} already exists`);
      throw err;
    }
    await recordAudit(tx, {
      tenantId: principal.tenantId,
      action: 'supplier.create',
      resourceType: 'supplier',
      resourceId: id,
      after: { code: input.code, name },
    });
    return this.getOrThrow(tx, id);
  }

  async update(tx: Tx, principal: Principal, id: string, input: Partial<SupplierInput>): Promise<Supplier> {
    assertCan(principal, 'supplier.manage');
    const before = await this.getOrThrow(tx, id);
    const name = input.name !== undefined ? requireName(input.name) : undefined;
    await sql`update suppliers set
                name = coalesce(${name ?? null}, name),
                tax_id = case when ${input.taxId !== undefined} then ${input.taxId ?? null} else tax_id end,
                payment_terms_days = coalesce(${input.paymentTermsDays ?? null}, payment_terms_days),
                default_lead_time_days = coalesce(${input.defaultLeadTimeDays ?? null}, default_lead_time_days),
                is_active = coalesce(${input.isActive ?? null}, is_active),
                updated_at = now()
              where id = ${id}`.execute(tx);
    const after = await this.getOrThrow(tx, id);
    await recordAudit(tx, {
      tenantId: principal.tenantId,
      action: 'supplier.update',
      resourceType: 'supplier',
      resourceId: id,
      before: { ...before },
      after: { ...after },
    });
    return after;
  }

  async linkProduct(
    tx: Tx,
    principal: Principal,
    supplierId: string,
    input: {
      variantId: string;
      supplierSku?: string | null;
      lastCost?: string | null;
      minOrderQty?: string | null;
      leadTimeDays?: number | null;
      isPreferred?: boolean;
    },
  ): Promise<SupplierProduct> {
    assertCan(principal, 'supplier.manage');
    await this.getOrThrow(tx, supplierId);
    if (!isUuid(input.variantId)) throw new ValidationError('Unknown variant');
    const { rows: variantRows } =
      await sql`select 1 from product_variants where id = ${input.variantId} and deleted_at is null`.execute(
        tx,
      );
    if (variantRows.length === 0)
      throw new ValidationError('Unknown variant', { variantId: input.variantId });
    const lastCost = input.lastCost != null ? formatCost(toCost(input.lastCost)) : null;

    await sql`insert into supplier_products (tenant_id, supplier_id, variant_id, supplier_sku, last_cost,
                                             min_order_qty, lead_time_days, is_preferred)
              values (${principal.tenantId}, ${supplierId}, ${input.variantId}, ${input.supplierSku ?? null},
                      ${lastCost}, ${input.minOrderQty ?? null}, ${input.leadTimeDays ?? null},
                      ${input.isPreferred ?? false})
              on conflict (tenant_id, supplier_id, variant_id) do update set
                supplier_sku = excluded.supplier_sku, last_cost = excluded.last_cost,
                min_order_qty = excluded.min_order_qty, lead_time_days = excluded.lead_time_days,
                is_preferred = excluded.is_preferred`.execute(tx);
    await recordAudit(tx, {
      tenantId: principal.tenantId,
      action: 'supplier.product.link',
      resourceType: 'supplier',
      resourceId: supplierId,
      after: { variantId: input.variantId, supplierSku: input.supplierSku ?? null },
    });
    const { rows } = await sql<SupplierProductRow>`
      select ${spCols} from supplier_products where supplier_id = ${supplierId} and variant_id = ${input.variantId}`.execute(
      tx,
    );
    return toSupplierProduct(rows[0]!);
  }

  async listProducts(tx: Tx, principal: Principal, supplierId: string): Promise<SupplierProduct[]> {
    assertCan(principal, 'supplier.read');
    await this.getOrThrow(tx, supplierId);
    const { rows } = await sql<SupplierProductRow>`
      select ${spCols} from supplier_products where supplier_id = ${supplierId} order by variant_id`.execute(
      tx,
    );
    return rows.map(toSupplierProduct);
  }

  private async getOrThrow(tx: Tx, id: string): Promise<Supplier> {
    const row = isUuid(id)
      ? (await sql<SupplierRow>`select ${cols} from suppliers where id = ${id}`.execute(tx)).rows[0]
      : undefined;
    if (!row) throw new NotFoundError('Supplier not found');
    return toSupplier(row);
  }
}

interface SupplierRow {
  id: string;
  code: string;
  name: string;
  tax_id: string | null;
  payment_terms_days: number;
  default_lead_time_days: number;
  currency: string;
  is_active: boolean;
}
const cols = sql`id, code, name, tax_id, payment_terms_days, default_lead_time_days, currency, is_active`;
const toSupplier = (r: SupplierRow): Supplier => ({
  id: r.id,
  code: r.code,
  name: r.name,
  taxId: r.tax_id,
  paymentTermsDays: r.payment_terms_days,
  defaultLeadTimeDays: r.default_lead_time_days,
  currency: r.currency,
  isActive: r.is_active,
});

interface SupplierProductRow {
  supplier_id: string;
  variant_id: string;
  supplier_sku: string | null;
  last_cost: string | null;
  min_order_qty: string | null;
  lead_time_days: number | null;
  is_preferred: boolean;
}
const spCols = sql`supplier_id, variant_id, supplier_sku, last_cost, min_order_qty, lead_time_days, is_preferred`;
const toSupplierProduct = (r: SupplierProductRow): SupplierProduct => ({
  supplierId: r.supplier_id,
  variantId: r.variant_id,
  supplierSku: r.supplier_sku,
  lastCost: r.last_cost,
  minOrderQty: r.min_order_qty,
  leadTimeDays: r.lead_time_days,
  isPreferred: r.is_preferred,
});

function requireName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 200) throw new ValidationError('Name must be 1-200 characters');
  return trimmed;
}
