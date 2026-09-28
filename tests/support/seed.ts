import { sql } from 'kysely';
import { inventory } from '@stockos/core';
import { tenantTx, type Db } from '@stockos/database';
import { uuidv7 } from '@stockos/shared';

export interface SeededTenant {
  tenantId: string;
  warehouseId: string;
  unitId: string;
  productId: string;
}

/**
 * Create a tenant with one warehouse and one product family, using the RLS-enforced app role
 * (tenants are inserted after setting app.tenant_id to the new id, as the signup flow will).
 */
export async function seedTenant(
  db: Db,
  options: { allowNegativeStock?: boolean } = {},
): Promise<SeededTenant> {
  const tenantId = uuidv7();
  const warehouseId = uuidv7();
  const unitId = uuidv7();
  const productId = uuidv7();

  await tenantTx(db, tenantId, async (tx) => {
    await sql`insert into tenants (id, slug, name) values (${tenantId}, ${`t-${tenantId}`}, 'Test shop')`.execute(
      tx,
    );
    await sql`insert into units (tenant_id, id, code, name) values (${tenantId}, ${unitId}, 'PCS', 'ชิ้น')`.execute(
      tx,
    );
    await sql`insert into warehouses (tenant_id, id, code, name, allow_negative_stock)
              values (${tenantId}, ${warehouseId}, 'WH1', 'Main', ${options.allowNegativeStock ?? false})`.execute(
      tx,
    );
    await sql`insert into products (tenant_id, id, code, name, base_unit_id)
              values (${tenantId}, ${productId}, 'NIKE-AM', 'Nike Air Max', ${unitId})`.execute(tx);
  });
  return { tenantId, warehouseId, unitId, productId };
}

export async function seedWarehouse(db: Db, tenantId: string, code: string, allowNegativeStock = false) {
  const id = uuidv7();
  await tenantTx(db, tenantId, async (tx) => {
    await sql`insert into warehouses (tenant_id, id, code, name, allow_negative_stock)
              values (${tenantId}, ${id}, ${code}, ${code}, ${allowNegativeStock})`.execute(tx);
  });
  return id;
}

/** Create variants and give each an opening balance in the tenant's warehouse. */
export async function seedVariants(
  db: Db,
  t: SeededTenant,
  count: number,
  openingQty: string | null,
  warehouseId: string = t.warehouseId,
): Promise<string[]> {
  const engine = new inventory.InventoryEngine();
  const ids = Array.from({ length: count }, () => uuidv7());
  await tenantTx(db, t.tenantId, async (tx) => {
    for (const [i, id] of ids.entries()) {
      await sql`insert into product_variants (tenant_id, id, product_id, sku, name)
                values (${t.tenantId}, ${id}, ${t.productId}, ${`SKU-${id.slice(-8)}-${i}`}, ${`Variant ${i}`})`.execute(
        tx,
      );
    }
    if (openingQty !== null) {
      await engine.apply(tx, {
        tenantId: t.tenantId,
        operation: 'OPENING',
        idempotencyKey: `seed:opening:${warehouseId}:${ids[0]}`,
        reference: { type: 'OPENING', id: uuidv7() },
        lines: ids.map((variantId) => ({ warehouseId, variantId, quantity: openingQty })),
      });
    }
  });
  return ids;
}
