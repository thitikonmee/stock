import { sql } from 'kysely';
import { PgErrorCode, pgErrorCode, type Tx } from '@stockos/database';
import {
  BusinessRuleError,
  ConflictError,
  Dec,
  NotFoundError,
  PreconditionFailedError,
  ValidationError,
  formatCost,
  formatMoney,
  formatQuantity,
  isUuid,
  toCost,
  toMoney,
  toQuantity,
  uuidv7,
} from '@stockos/shared';
import { recordAudit } from '../../audit/public-api';
import { PlanService } from '../../billing/public-api';
import { assertCan, type Principal } from '../../iam/public-api';
import { assertValidBarcode, type BarcodeSymbology } from '../domain/barcode';
import { nextInternalBarcode } from './barcode-service';

export type ProductType = 'STANDARD' | 'BUNDLE' | 'SERVICE' | 'NON_STOCK';
export type ProductStatus = 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
export type VariantStatus = 'ACTIVE' | 'INACTIVE' | 'ARCHIVED';
export type TaxClass = 'VAT7' | 'VAT0' | 'EXEMPT';

export interface ProductOption {
  name: string;
  values: string[];
}

export interface Variant {
  id: string;
  productId: string;
  sku: string;
  name: string;
  optionValues: Record<string, string>;
  costPrice: string;
  sellingPrice: string;
  weightGrams: number | null;
  reorderPoint: string | null;
  reorderQty: string | null;
  lowStockThreshold: string | null;
  status: VariantStatus;
  version: number;
  barcodes: string[];
}

export interface Product {
  id: string;
  code: string;
  name: string;
  description: string | null;
  brandId: string | null;
  categoryId: string | null;
  baseUnitId: string;
  type: ProductType;
  options: ProductOption[];
  taxClass: TaxClass;
  trackInventory: boolean;
  status: ProductStatus;
  version: number;
  variants: Variant[];
}

export interface VariantInput {
  sku: string;
  name?: string;
  optionValues?: Record<string, string>;
  costPrice?: string;
  sellingPrice?: string;
  weightGrams?: number | null;
  reorderPoint?: string | null;
  reorderQty?: string | null;
  lowStockThreshold?: string | null;
  barcodes?: string[];
}

export interface ProductCreateInput {
  code: string;
  name: string;
  description?: string | null;
  brandId?: string | null;
  categoryId?: string | null;
  baseUnitId: string;
  type?: ProductType;
  options?: ProductOption[];
  taxClass?: TaxClass;
  trackInventory?: boolean;
  variants: VariantInput[];
}

export interface ProductUpdateInput {
  name?: string;
  description?: string | null;
  brandId?: string | null;
  categoryId?: string | null;
  status?: ProductStatus;
  /** Optimistic lock: must match the product's current version. */
  expectedVersion: number;
}

export interface VariantUpdateInput {
  name?: string;
  costPrice?: string;
  sellingPrice?: string;
  weightGrams?: number | null;
  reorderPoint?: string | null;
  reorderQty?: string | null;
  lowStockThreshold?: string | null;
  status?: VariantStatus;
  /** Optimistic lock: must match the variant's current version. */
  expectedVersion: number;
}

export interface UnitConversion {
  unitId: string;
  unitCode: string;
  factorToBase: string;
  isPurchaseUnit: boolean;
  isSalesUnit: boolean;
}

/** Just enough to price and tax a line at the register — POS reads this instead of the full Product tree. */
export interface VariantSaleInfo {
  id: string;
  productId: string;
  sku: string;
  name: string;
  sellingPrice: string;
  taxClass: TaxClass;
  status: VariantStatus;
}

export interface ProductListQuery {
  q?: string;
  categoryId?: string;
  brandId?: string;
  status?: ProductStatus;
  cursor?: string;
  limit?: number;
}
export interface ProductListPage {
  data: Product[];
  page: { nextCursor: string | null };
}

const CODE_RE = /^[A-Z0-9][A-Z0-9._-]{0,39}$/;
const SKU_RE = /^[A-Z0-9][A-Z0-9._-]{0,39}$/;
const MAX_VARIANTS_PER_PRODUCT = 200;
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 30;

/**
 * Products, variants (SKU level) and their barcodes/bundle components. Every write is scoped by
 * `product.*` permissions and counted against the tenant's `skus` plan limit (docs/14 §35).
 */
export class ProductService {
  private readonly plans = new PlanService();

  async list(tx: Tx, principal: Principal, query: ProductListQuery): Promise<ProductListPage> {
    assertCan(principal, 'product.read');
    const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const q = query.q?.trim() || undefined;

    if (q) {
      // Search mode: ranked by trigram *word* similarity (best-matching substring, not whole-string
      // similarity — a short query against a long product name needs `<%`/word_similarity, not `%`)
      // across product name / variant sku / variant name. No keyset pagination here — similarity
      // order is not monotonic in (created_at, id).
      const { rows } = await sql<{ id: string; score: number }>`
        select p.id,
               greatest(
                 word_similarity(${q}, p.name),
                 coalesce((select max(word_similarity(${q}, v.name)) from product_variants v
                            where v.product_id = p.id and v.deleted_at is null), 0),
                 case when p.code ilike ${q + '%'} then 1 else 0 end,
                 case when exists (select 1 from product_variants v
                                     where v.product_id = p.id and v.deleted_at is null and v.sku ilike ${q + '%'})
                      then 1 else 0 end
               ) as score
          from products p
         where p.deleted_at is null
           and (${query.categoryId ?? null}::uuid is null or p.category_id = ${query.categoryId ?? null})
           and (${query.brandId ?? null}::uuid is null or p.brand_id = ${query.brandId ?? null})
           and (${query.status ?? null}::text is null or p.status = ${query.status ?? null})
           and (
             ${q} <% p.name or p.code ilike ${q + '%'}
             or exists (select 1 from product_variants v
                         where v.product_id = p.id and v.deleted_at is null
                           and (v.sku ilike ${q + '%'} or ${q} <% v.name))
           )
         order by score desc, p.name asc
         limit ${limit}`.execute(tx);
      const products = await this.hydrate(
        tx,
        rows.map((r) => r.id),
      );
      const byId = new Map(products.map((p) => [p.id, p]));
      return {
        data: rows.map((r) => byId.get(r.id)).filter((p): p is Product => !!p),
        page: { nextCursor: null },
      };
    }

    const cursor = decodeCursor(query.cursor);
    const { rows } = await sql<{ id: string; created_at: Date }>`
      select p.id, p.created_at
        from products p
       where p.deleted_at is null
         and (${query.categoryId ?? null}::uuid is null or p.category_id = ${query.categoryId ?? null})
         and (${query.brandId ?? null}::uuid is null or p.brand_id = ${query.brandId ?? null})
         and (${query.status ?? null}::text is null or p.status = ${query.status ?? null})
         and (
           ${cursor?.createdAt ?? null}::timestamptz is null
           or (p.created_at, p.id) < (${cursor?.createdAt ?? null}::timestamptz, ${cursor?.id ?? null}::uuid)
         )
       order by p.created_at desc, p.id desc
       limit ${limit + 1}`.execute(tx);
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const products = await this.hydrate(
      tx,
      page.map((r) => r.id),
    );
    const byId = new Map(products.map((p) => [p.id, p]));
    const data = page.map((r) => byId.get(r.id)).filter((p): p is Product => !!p);
    const last = page.at(-1);
    return {
      data,
      page: { nextCursor: hasMore && last ? encodeCursor(last.created_at, last.id) : null },
    };
  }

  async get(tx: Tx, principal: Principal, id: string): Promise<Product> {
    assertCan(principal, 'product.read');
    return this.getOrThrow(tx, id);
  }

  async create(tx: Tx, principal: Principal, input: ProductCreateInput): Promise<Product> {
    assertCan(principal, 'product.create');
    if (!CODE_RE.test(input.code))
      throw new ValidationError('Product code must be 1-40 chars: A-Z 0-9 . _ -');
    const name = requireName(input.name);
    if (!isUuid(input.baseUnitId)) throw new ValidationError('Unknown base unit');
    if (input.variants.length === 0) throw new ValidationError('At least one variant is required');
    if (input.variants.length > MAX_VARIANTS_PER_PRODUCT)
      throw new ValidationError(`At most ${MAX_VARIANTS_PER_PRODUCT} variants per product`);
    await this.assertRefs(tx, {
      brandId: input.brandId,
      categoryId: input.categoryId,
      unitId: input.baseUnitId,
    });
    await this.plans.assertWithinLimit(tx, principal.tenantId, 'skus', input.variants.length);

    const productId = uuidv7();
    try {
      await sql`insert into products (tenant_id, id, code, name, description, brand_id, category_id,
                                       base_unit_id, type, options, tax_class, track_inventory, status, created_by)
                values (${principal.tenantId}, ${productId}, ${input.code}, ${name}, ${input.description ?? null},
                        ${input.brandId ?? null}, ${input.categoryId ?? null}, ${input.baseUnitId},
                        ${input.type ?? 'STANDARD'}, ${JSON.stringify(input.options ?? [])}::jsonb,
                        ${input.taxClass ?? 'VAT7'}, ${input.trackInventory ?? true}, 'ACTIVE', ${principal.membershipId})`.execute(
        tx,
      );
      for (const v of input.variants) await this.insertVariant(tx, principal, productId, name, v);
    } catch (err) {
      throw mapUniqueError(err);
    }
    await recordAudit(tx, {
      tenantId: principal.tenantId,
      action: 'product.create',
      resourceType: 'product',
      resourceId: productId,
      after: { code: input.code, name, variants: input.variants.map((v) => v.sku) },
    });
    return this.getOrThrow(tx, productId);
  }

  async update(tx: Tx, principal: Principal, id: string, input: ProductUpdateInput): Promise<Product> {
    assertCan(principal, 'product.update');
    const before = await this.getOrThrow(tx, id);
    if (input.brandId !== undefined || input.categoryId !== undefined) {
      await this.assertRefs(tx, {
        brandId: input.brandId ?? undefined,
        categoryId: input.categoryId ?? undefined,
      });
    }
    const name = input.name !== undefined ? requireName(input.name) : undefined;
    const { rows } = await sql<{ version: number }>`
      update products set name = coalesce(${name ?? null}, name),
                          description = case when ${input.description !== undefined} then ${input.description ?? null} else description end,
                          brand_id = case when ${input.brandId !== undefined} then ${input.brandId ?? null} else brand_id end,
                          category_id = case when ${input.categoryId !== undefined} then ${input.categoryId ?? null} else category_id end,
                          status = coalesce(${input.status ?? null}, status),
                          version = version + 1, updated_at = now()
       where id = ${id} and version = ${input.expectedVersion}
      returning version`.execute(tx);
    if (rows.length === 0)
      throw new PreconditionFailedError('Product was changed by someone else', {
        currentVersion: before.version,
      });
    const after = await this.getOrThrow(tx, id);
    await recordAudit(tx, {
      tenantId: principal.tenantId,
      action: 'product.update',
      resourceType: 'product',
      resourceId: id,
      before: { name: before.name, status: before.status },
      after: { name: after.name, status: after.status },
    });
    return after;
  }

  /** Soft delete: refused while any variant still holds physical stock. */
  async remove(tx: Tx, principal: Principal, id: string): Promise<void> {
    assertCan(principal, 'product.delete');
    const product = await this.getOrThrow(tx, id);
    if (product.variants.length) {
      const variantIds = product.variants.map((v) => v.id);
      const { rows } = await sql<{ n: string }>`
        select coalesce(sum(on_hand + incoming), 0) as n from inventory_balances
         where variant_id = any(${variantIds}::uuid[])`.execute(tx);
      if (new Dec(rows[0]?.n ?? 0).greaterThan(0)) {
        throw new BusinessRuleError('PRODUCT_HAS_STOCK', 'Cannot delete a product that still has stock');
      }
    }
    await sql`update products set deleted_at = now() where id = ${id}`.execute(tx);
    await sql`update product_variants set deleted_at = now() where product_id = ${id}`.execute(tx);
    await recordAudit(tx, {
      tenantId: principal.tenantId,
      action: 'product.delete',
      resourceType: 'product',
      resourceId: id,
      before: { code: product.code, name: product.name },
    });
  }

  async addVariant(tx: Tx, principal: Principal, productId: string, input: VariantInput): Promise<Variant> {
    assertCan(principal, 'product.update');
    const product = await this.getOrThrow(tx, productId);
    if (product.variants.length >= MAX_VARIANTS_PER_PRODUCT)
      throw new ValidationError(`At most ${MAX_VARIANTS_PER_PRODUCT} variants per product`);
    await this.plans.assertWithinLimit(tx, principal.tenantId, 'skus', 1);
    let variantId: string;
    try {
      variantId = await this.insertVariant(tx, principal, productId, product.name, input);
    } catch (err) {
      throw mapUniqueError(err);
    }
    await recordAudit(tx, {
      tenantId: principal.tenantId,
      action: 'variant.create',
      resourceType: 'product_variant',
      resourceId: variantId,
      after: { sku: input.sku, productId },
    });
    return this.getVariantOrThrow(tx, variantId);
  }

  async updateVariant(tx: Tx, principal: Principal, id: string, input: VariantUpdateInput): Promise<Variant> {
    assertCan(principal, 'product.update');
    const before = await this.getVariantOrThrow(tx, id);
    const costPrice = input.costPrice !== undefined ? formatCost(toCost(input.costPrice)) : undefined;
    const sellingPrice =
      input.sellingPrice !== undefined ? formatMoney(toMoney(input.sellingPrice)) : undefined;
    const reorderPoint = normalizeOptionalQty(input.reorderPoint);
    const reorderQty = normalizeOptionalQty(input.reorderQty);
    const lowStockThreshold = normalizeOptionalQty(input.lowStockThreshold);
    const name = input.name !== undefined ? requireName(input.name) : undefined;

    const { rows } = await sql<{ version: number }>`
      update product_variants set
        name = coalesce(${name ?? null}, name),
        cost_price = coalesce(${costPrice ?? null}, cost_price),
        selling_price = coalesce(${sellingPrice ?? null}, selling_price),
        weight_grams = case when ${input.weightGrams !== undefined} then ${input.weightGrams ?? null} else weight_grams end,
        reorder_point = case when ${input.reorderPoint !== undefined} then ${reorderPoint} else reorder_point end,
        reorder_qty = case when ${input.reorderQty !== undefined} then ${reorderQty} else reorder_qty end,
        low_stock_threshold = case when ${input.lowStockThreshold !== undefined} then ${lowStockThreshold} else low_stock_threshold end,
        status = coalesce(${input.status ?? null}, status),
        version = version + 1, updated_at = now()
       where id = ${id} and version = ${input.expectedVersion}
      returning version`.execute(tx);
    if (rows.length === 0)
      throw new PreconditionFailedError('Variant was changed by someone else', {
        currentVersion: before.version,
      });
    const after = await this.getVariantOrThrow(tx, id);
    await recordAudit(tx, {
      tenantId: principal.tenantId,
      action: 'variant.update',
      resourceType: 'product_variant',
      resourceId: id,
      before: { sellingPrice: before.sellingPrice, status: before.status },
      after: { sellingPrice: after.sellingPrice, status: after.status },
    });
    return after;
  }

  async getVariant(tx: Tx, principal: Principal, id: string): Promise<Variant> {
    assertCan(principal, 'product.read');
    return this.getVariantOrThrow(tx, id);
  }

  async lookup(tx: Tx, principal: Principal, params: { barcode?: string; sku?: string }): Promise<Variant> {
    assertCan(principal, 'product.read');
    if (params.barcode) {
      const { rows } = await sql<{ variant_id: string }>`
        select variant_id from variant_barcodes where barcode = ${params.barcode}`.execute(tx);
      const variantId = rows[0]?.variant_id;
      if (!variantId) throw new NotFoundError('No variant for this barcode');
      return this.getVariantOrThrow(tx, variantId);
    }
    if (params.sku) {
      const { rows } = await sql<{ id: string }>`
        select id from product_variants where sku = ${params.sku} and deleted_at is null`.execute(tx);
      const id = rows[0]?.id;
      if (!id) throw new NotFoundError('No variant for this SKU');
      return this.getVariantOrThrow(tx, id);
    }
    throw new ValidationError('Provide barcode or sku');
  }

  /** Price + tax lookup for the POS register (docs/05-pos.md scan → cart). */
  async saleInfo(
    tx: Tx,
    principal: Principal,
    params: { variantId?: string; barcode?: string; sku?: string },
  ): Promise<VariantSaleInfo> {
    assertCan(principal, 'product.read');
    let variantId = params.variantId;
    if (!variantId && params.barcode) {
      const { rows } = await sql<{ variant_id: string }>`
        select variant_id from variant_barcodes where barcode = ${params.barcode}`.execute(tx);
      variantId = rows[0]?.variant_id;
      if (!variantId) throw new NotFoundError('No variant for this barcode');
    } else if (!variantId && params.sku) {
      const { rows } = await sql<{ id: string }>`
        select id from product_variants where sku = ${params.sku} and deleted_at is null`.execute(tx);
      variantId = rows[0]?.id;
      if (!variantId) throw new NotFoundError('No variant for this SKU');
    }
    if (!variantId || !isUuid(variantId)) throw new ValidationError('Provide variantId, barcode or sku');

    const { rows } = await sql<{
      id: string;
      product_id: string;
      sku: string;
      name: string;
      selling_price: string;
      tax_class: TaxClass;
      status: VariantStatus;
    }>`
      select v.id, v.product_id, v.sku, v.name, v.selling_price, p.tax_class, v.status
        from product_variants v
        join products p on p.id = v.product_id
       where v.id = ${variantId} and v.deleted_at is null and p.deleted_at is null`.execute(tx);
    const row = rows[0];
    if (!row) throw new NotFoundError('Variant not found');
    return {
      id: row.id,
      productId: row.product_id,
      sku: row.sku,
      name: row.name,
      sellingPrice: row.selling_price,
      taxClass: row.tax_class,
      status: row.status,
    };
  }

  // --- Barcodes ----------------------------------------------------------------
  async addBarcode(
    tx: Tx,
    principal: Principal,
    variantId: string,
    input: { barcode: string; symbology: BarcodeSymbology; unitId?: string | null; isPrimary?: boolean },
  ): Promise<Variant> {
    assertCan(principal, 'product.update');
    await this.getVariantOrThrow(tx, variantId);
    assertValidBarcode(input.symbology, input.barcode);
    await this.insertBarcode(tx, principal.tenantId, variantId, input);
    await recordAudit(tx, {
      tenantId: principal.tenantId,
      action: 'barcode.add',
      resourceType: 'product_variant',
      resourceId: variantId,
      after: { barcode: input.barcode, symbology: input.symbology },
    });
    return this.getVariantOrThrow(tx, variantId);
  }

  /** Generate a fresh, valid internal EAN-13 (prefix 20-29) or an internal Code 128 and attach it. */
  async generateBarcode(
    tx: Tx,
    principal: Principal,
    input: { variantId: string; symbology: 'EAN13' | 'CODE128'; prefix?: string; isPrimary?: boolean },
  ): Promise<{ variant: Variant; barcode: string }> {
    assertCan(principal, 'product.update');
    await this.getVariantOrThrow(tx, input.variantId);
    const barcode = await nextInternalBarcode(tx, principal.tenantId, input.symbology, input.prefix);
    await this.insertBarcode(tx, principal.tenantId, input.variantId, {
      barcode,
      symbology: input.symbology,
      isPrimary: input.isPrimary,
    });
    await recordAudit(tx, {
      tenantId: principal.tenantId,
      action: 'barcode.generate',
      resourceType: 'product_variant',
      resourceId: input.variantId,
      after: { barcode, symbology: input.symbology },
    });
    return { variant: await this.getVariantOrThrow(tx, input.variantId), barcode };
  }

  // --- Unit conversion (1 BOX = 12 PCS) ------------------------------------------
  async listUnitConversions(tx: Tx, principal: Principal, productId: string): Promise<UnitConversion[]> {
    assertCan(principal, 'product.read');
    await this.getOrThrow(tx, productId);
    const { rows } = await sql<{
      unit_id: string;
      code: string;
      factor_to_base: string;
      is_purchase_unit: boolean;
      is_sales_unit: boolean;
    }>`
      select pu.unit_id, u.code, pu.factor_to_base, pu.is_purchase_unit, pu.is_sales_unit
        from product_units pu join units u on u.id = pu.unit_id
       where pu.product_id = ${productId} order by u.code`.execute(tx);
    return rows.map((r) => ({
      unitId: r.unit_id,
      unitCode: r.code,
      factorToBase: r.factor_to_base,
      isPurchaseUnit: r.is_purchase_unit,
      isSalesUnit: r.is_sales_unit,
    }));
  }

  async setUnitConversion(
    tx: Tx,
    principal: Principal,
    productId: string,
    input: { unitId: string; factorToBase: string; isPurchaseUnit?: boolean; isSalesUnit?: boolean },
  ): Promise<UnitConversion[]> {
    assertCan(principal, 'product.update');
    const product = await this.getOrThrow(tx, productId);
    if (!isUuid(input.unitId)) throw new ValidationError('Unknown unit');
    if (input.unitId === product.baseUnitId)
      throw new ValidationError('The base unit does not need a conversion row');
    const { rows: unitRows } = await sql`select 1 from units where id = ${input.unitId}`.execute(tx);
    if (unitRows.length === 0) throw new ValidationError('Unknown unit', { unitId: input.unitId });
    // product_units.factor_to_base is NUMERIC(14,6) — finer than the usual QUANTITY_SCALE (3), so
    // this is validated/formatted locally rather than with toQuantity/formatQuantity.
    let factor: Dec;
    try {
      factor = new Dec(input.factorToBase);
    } catch {
      throw new ValidationError('Invalid factorToBase');
    }
    if (!factor.isFinite() || factor.decimalPlaces() > 6 || factor.lessThanOrEqualTo(0)) {
      throw new ValidationError('factorToBase must be a positive number with at most 6 decimal places');
    }
    const factorStr = factor.toFixed(6);

    await sql`insert into product_units (tenant_id, product_id, unit_id, factor_to_base, is_purchase_unit, is_sales_unit)
              values (${principal.tenantId}, ${productId}, ${input.unitId}, ${factorStr},
                      ${input.isPurchaseUnit ?? false}, ${input.isSalesUnit ?? true})
              on conflict (tenant_id, product_id, unit_id) do update set
                factor_to_base = excluded.factor_to_base, is_purchase_unit = excluded.is_purchase_unit,
                is_sales_unit = excluded.is_sales_unit`.execute(tx);
    await recordAudit(tx, {
      tenantId: principal.tenantId,
      action: 'product.unit_conversion.set',
      resourceType: 'product',
      resourceId: productId,
      after: { unitId: input.unitId, factorToBase: factorStr },
    });
    return this.listUnitConversions(tx, principal, productId);
  }

  // --- Bundles -------------------------------------------------------------------
  async getBundleComponents(
    tx: Tx,
    principal: Principal,
    bundleVariantId: string,
  ): Promise<{ variantId: string; sku: string; name: string; quantity: string }[]> {
    assertCan(principal, 'product.read');
    await this.getVariantOrThrow(tx, bundleVariantId);
    const { rows } = await sql<{ variant_id: string; sku: string; name: string; quantity: string }>`
      select v.id as variant_id, v.sku, v.name, bc.quantity
        from bundle_components bc join product_variants v on v.id = bc.component_variant_id
       where bc.bundle_variant_id = ${bundleVariantId}
       order by v.sku`.execute(tx);
    return rows.map((r) => ({ variantId: r.variant_id, sku: r.sku, name: r.name, quantity: r.quantity }));
  }

  async setBundleComponents(
    tx: Tx,
    principal: Principal,
    bundleVariantId: string,
    components: { variantId: string; quantity: string }[],
  ): Promise<Variant> {
    assertCan(principal, 'product.update');
    const bundle = await this.getVariantOrThrow(tx, bundleVariantId);
    const { rows } = await sql<{
      type: ProductType;
    }>`select type from products where id = ${bundle.productId}`.execute(tx);
    if (rows[0]?.type !== 'BUNDLE') throw new BusinessRuleError('NOT_A_BUNDLE', 'Product is not type BUNDLE');
    if (components.length === 0) throw new ValidationError('A bundle needs at least one component');
    if (components.some((c) => c.variantId === bundleVariantId))
      throw new ValidationError('A bundle cannot contain itself');
    for (const c of components) await this.getVariantOrThrow(tx, c.variantId);

    await sql`delete from bundle_components where bundle_variant_id = ${bundleVariantId}`.execute(tx);
    for (const c of components) {
      const qty = formatQuantity(toQuantity(c.quantity));
      await sql`insert into bundle_components (tenant_id, bundle_variant_id, component_variant_id, quantity)
                values (${principal.tenantId}, ${bundleVariantId}, ${c.variantId}, ${qty})`.execute(tx);
    }
    await recordAudit(tx, {
      tenantId: principal.tenantId,
      action: 'bundle.components.replace',
      resourceType: 'product_variant',
      resourceId: bundleVariantId,
      after: { components },
    });
    return this.getVariantOrThrow(tx, bundleVariantId);
  }

  // --- internal ------------------------------------------------------------------
  private async insertVariant(
    tx: Tx,
    principal: Principal,
    productId: string,
    productName: string,
    input: VariantInput,
  ): Promise<string> {
    if (!SKU_RE.test(input.sku)) throw new ValidationError('SKU must be 1-40 chars: A-Z 0-9 . _ -');
    const name = input.name ? requireName(input.name) : `${productName}${suffixOf(input.optionValues)}`;
    const costPrice = input.costPrice !== undefined ? formatCost(toCost(input.costPrice)) : '0.0000';
    const sellingPrice = input.sellingPrice !== undefined ? formatMoney(toMoney(input.sellingPrice)) : '0.00';
    const variantId = uuidv7();
    await sql`insert into product_variants (tenant_id, id, product_id, sku, name, option_values,
                                             cost_price, selling_price, weight_grams,
                                             reorder_point, reorder_qty, low_stock_threshold, status)
              values (${principal.tenantId}, ${variantId}, ${productId}, ${input.sku}, ${name},
                      ${JSON.stringify(input.optionValues ?? {})}::jsonb, ${costPrice}, ${sellingPrice},
                      ${input.weightGrams ?? null}, ${normalizeOptionalQty(input.reorderPoint)},
                      ${normalizeOptionalQty(input.reorderQty)}, ${normalizeOptionalQty(input.lowStockThreshold)},
                      'ACTIVE')`.execute(tx);
    for (const [i, barcode] of (input.barcodes ?? []).entries()) {
      const symbology: BarcodeSymbology = /^\d{13}$/.test(barcode) ? 'EAN13' : 'CODE128';
      assertValidBarcode(symbology, barcode);
      await this.insertBarcode(tx, principal.tenantId, variantId, { barcode, symbology, isPrimary: i === 0 });
    }
    return variantId;
  }

  private async insertBarcode(
    tx: Tx,
    tenantId: string,
    variantId: string,
    input: { barcode: string; symbology: BarcodeSymbology; unitId?: string | null; isPrimary?: boolean },
  ): Promise<void> {
    try {
      if (input.isPrimary) {
        await sql`update variant_barcodes set is_primary = false where variant_id = ${variantId}`.execute(tx);
      }
      await sql`insert into variant_barcodes (tenant_id, barcode, variant_id, symbology, unit_id, is_primary)
                values (${tenantId}, ${input.barcode}, ${variantId}, ${input.symbology}, ${input.unitId ?? null},
                        ${input.isPrimary ?? false})`.execute(tx);
    } catch (err) {
      if (pgErrorCode(err) === PgErrorCode.UniqueViolation)
        throw new ConflictError(`Barcode ${input.barcode} is already assigned to another SKU`);
      throw err;
    }
  }

  private async assertRefs(
    tx: Tx,
    refs: { brandId?: string | null; categoryId?: string | null; unitId?: string },
  ): Promise<void> {
    if (refs.brandId) {
      const { rows } = await sql`select 1 from brands where id = ${refs.brandId}`.execute(tx);
      if (rows.length === 0) throw new ValidationError('Unknown brand', { brandId: refs.brandId });
    }
    if (refs.categoryId) {
      const { rows } = await sql`select 1 from categories where id = ${refs.categoryId}`.execute(tx);
      if (rows.length === 0) throw new ValidationError('Unknown category', { categoryId: refs.categoryId });
    }
    if (refs.unitId) {
      const { rows } = await sql`select 1 from units where id = ${refs.unitId}`.execute(tx);
      if (rows.length === 0) throw new ValidationError('Unknown unit', { unitId: refs.unitId });
    }
  }

  private async hydrate(tx: Tx, productIds: string[]): Promise<Product[]> {
    if (productIds.length === 0) return [];
    const { rows: products } = await sql<ProductRow>`
      select ${productCols} from products where id = any(${productIds}::uuid[]) and deleted_at is null`.execute(
      tx,
    );
    const { rows: variants } = await sql<VariantRow>`
      select ${variantCols} from product_variants
       where product_id = any(${productIds}::uuid[]) and deleted_at is null
       order by sku`.execute(tx);
    const { rows: barcodes } = await sql<{ variant_id: string; barcode: string }>`
      select variant_id, barcode from variant_barcodes
       where variant_id = any(${variants.map((v) => v.id)}::uuid[])
       order by is_primary desc, barcode`.execute(tx);
    const barcodesByVariant = groupBy(barcodes, (b) => b.variant_id);
    const variantsByProduct = groupBy(variants, (v) => v.product_id);
    return products.map((p) =>
      toProduct(
        p,
        (variantsByProduct.get(p.id) ?? []).map((v) =>
          toVariant(
            v,
            (barcodesByVariant.get(v.id) ?? []).map((b) => b.barcode),
          ),
        ),
      ),
    );
  }

  private async getOrThrow(tx: Tx, id: string): Promise<Product> {
    if (!isUuid(id)) throw new NotFoundError('Product not found');
    const [product] = await this.hydrate(tx, [id]);
    if (!product) throw new NotFoundError('Product not found');
    return product;
  }

  private async getVariantOrThrow(tx: Tx, id: string): Promise<Variant> {
    if (!isUuid(id)) throw new NotFoundError('Variant not found');
    const { rows } =
      await sql<VariantRow>`select ${variantCols} from product_variants where id = ${id} and deleted_at is null`.execute(
        tx,
      );
    const row = rows[0];
    if (!row) throw new NotFoundError('Variant not found');
    const { rows: barcodes } = await sql<{ barcode: string }>`
      select barcode from variant_barcodes where variant_id = ${id} order by is_primary desc, barcode`.execute(
      tx,
    );
    return toVariant(
      row,
      barcodes.map((b) => b.barcode),
    );
  }
}

interface ProductRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  brand_id: string | null;
  category_id: string | null;
  base_unit_id: string;
  type: ProductType;
  options: ProductOption[];
  tax_class: TaxClass;
  track_inventory: boolean;
  status: ProductStatus;
  version: number;
}
const productCols = sql`id, code, name, description, brand_id, category_id, base_unit_id, type, options,
                         tax_class, track_inventory, status, version`;

interface VariantRow {
  id: string;
  product_id: string;
  sku: string;
  name: string;
  option_values: Record<string, string>;
  cost_price: string;
  selling_price: string;
  weight_grams: number | null;
  reorder_point: string | null;
  reorder_qty: string | null;
  low_stock_threshold: string | null;
  status: VariantStatus;
  version: number;
}
const variantCols = sql`id, product_id, sku, name, option_values, cost_price, selling_price, weight_grams,
                         reorder_point, reorder_qty, low_stock_threshold, status, version`;

function toProduct(r: ProductRow, variants: Variant[]): Product {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    description: r.description,
    brandId: r.brand_id,
    categoryId: r.category_id,
    baseUnitId: r.base_unit_id,
    type: r.type,
    options: r.options ?? [],
    taxClass: r.tax_class,
    trackInventory: r.track_inventory,
    status: r.status,
    version: r.version,
    variants,
  };
}

function toVariant(r: VariantRow, barcodes: string[]): Variant {
  return {
    id: r.id,
    productId: r.product_id,
    sku: r.sku,
    name: r.name,
    optionValues: r.option_values ?? {},
    costPrice: r.cost_price,
    sellingPrice: r.selling_price,
    weightGrams: r.weight_grams,
    reorderPoint: r.reorder_point,
    reorderQty: r.reorder_qty,
    lowStockThreshold: r.low_stock_threshold,
    status: r.status,
    version: r.version,
    barcodes,
  };
}

function requireName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 255) throw new ValidationError('Name must be 1-255 characters');
  return trimmed;
}

function suffixOf(optionValues: Record<string, string> | undefined): string {
  if (!optionValues || Object.keys(optionValues).length === 0) return '';
  return ' - ' + Object.values(optionValues).join(' / ');
}

function normalizeOptionalQty(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  return formatQuantity(toQuantity(value, { allowZero: true }));
}

function mapUniqueError(err: unknown): unknown {
  if (pgErrorCode(err) === PgErrorCode.UniqueViolation) {
    const detail = (err as { detail?: string }).detail ?? '';
    if (detail.includes('sku')) return new ConflictError('A SKU in this request already exists');
    if (detail.includes('code')) return new ConflictError('Product code already exists');
    return new ConflictError('Duplicate value');
  }
  return err;
}

/** Opaque, unguessable-order cursor: base64("<created_at ISO>|<id>"). */
function decodeCursor(cursor: string | undefined): { createdAt: string; id: string } | undefined {
  if (!cursor) return undefined;
  try {
    const [createdAt, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    if (!createdAt || !id || !isUuid(id)) throw new Error('bad cursor');
    return { createdAt, id };
  } catch {
    throw new ValidationError('Invalid cursor');
  }
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}

function groupBy<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const arr = map.get(k);
    if (arr) arr.push(item);
    else map.set(k, [item]);
  }
  return map;
}
