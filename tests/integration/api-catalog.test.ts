import ExcelJS from 'exceljs';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inventory } from '@stockos/core';
import { platformTx, tenantTx } from '@stockos/database';
import { call, callBinary, createTestApi, signup, type Api, type SignedUpTenant } from '../support/api';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

let db: TestDatabase;
let api: Api;
let t: SignedUpTenant;
let unitId: string;
let warehouseId: string;

beforeAll(async () => {
  db = await createTestDatabase();
  api = await createTestApi(db);
  t = await signup(api, 'Catalog');
  const unit = (
    await call(api, 'POST', '/api/v1/units', { token: t.accessToken, body: { code: 'PCS', name: 'ชิ้น' } })
  ).body;
  unitId = unit.id;
  const [warehouse] = (await call(api, 'GET', '/api/v1/warehouses', { token: t.accessToken })).body;
  warehouseId = warehouse.id;
});
afterAll(async () => {
  await api.close();
  await db.drop();
});

async function createProduct(overrides: Partial<Record<string, unknown>> = {}, variants?: unknown[]) {
  const res = await call(api, 'POST', '/api/v1/products', {
    token: t.accessToken,
    body: {
      code: `P-${Math.random().toString(36).slice(2, 10)}`,
      name: 'Nike Air Max',
      baseUnitId: unitId,
      variants: variants ?? [{ sku: `SKU-${Math.random().toString(36).slice(2, 10)}` }],
      ...overrides,
    },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

describe('Phase 2 DoD: create a product with a variant matrix, barcode and printed label', () => {
  it('creates Nike Air Max with 5 variants, generates barcodes and prints a label sheet', async () => {
    const brand = (
      await call(api, 'POST', '/api/v1/brands', { token: t.accessToken, body: { name: 'Nike' } })
    ).body;
    const category = (
      await call(api, 'POST', '/api/v1/categories', { token: t.accessToken, body: { name: 'Running Shoes' } })
    ).body;

    const sizes = ['40', '41', '42', '43', '44'];
    const product = await createProduct(
      { code: 'NIKE-AIRMAX', brandId: brand.id, categoryId: category.id },
      sizes.map((size) => ({
        sku: `NIKE-AIRMAX-BLK-${size}`,
        name: `Nike Air Max - Black / ${size}`,
        optionValues: { Color: 'Black', Size: size },
        costPrice: '1200',
        sellingPrice: '2490.00',
      })),
    );
    expect(product.variants).toHaveLength(5);
    expect(product.brandId).toBe(brand.id);
    expect(product.categoryId).toBe(category.id);

    const variant = product.variants[0];
    const generated = await call(api, 'POST', '/api/v1/barcodes/generate', {
      token: t.accessToken,
      body: { variantId: variant.id, symbology: 'EAN13' },
    });
    expect(generated.status).toBe(201);
    expect(generated.body.barcode).toMatch(/^2\d{12}$/); // internal prefix 20-29
    expect(generated.body.variant.barcodes).toContain(generated.body.barcode);

    // A second SKU gets its own, different barcode.
    const generated2 = await call(api, 'POST', '/api/v1/barcodes/generate', {
      token: t.accessToken,
      body: { variantId: product.variants[1].id, symbology: 'EAN13' },
    });
    expect(generated2.body.barcode).not.toBe(generated.body.barcode);

    const labels = await callBinary(api, 'POST', '/api/v1/barcodes/labels', {
      token: t.accessToken,
      body: {
        items: [
          { variantId: variant.id, quantity: 2 },
          { variantId: product.variants[1].id, quantity: 1 },
        ],
      },
    });
    expect(labels.status).toBe(200);
    expect(labels.headers['content-type']).toBe('application/pdf');
    expect(labels.body.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(labels.body.length).toBeGreaterThan(1000);
  });
});

describe('optimistic locking', () => {
  it('rejects a product update without If-Match and a stale If-Match', async () => {
    const product = await createProduct();
    const get1 = await call(api, 'GET', `/api/v1/products/${product.id}`, { token: t.accessToken });
    expect(get1.headers['etag']).toBe('"v1"');

    const noIfMatch = await call(api, 'PATCH', `/api/v1/products/${product.id}`, {
      token: t.accessToken,
      body: { name: 'X' },
    });
    expect(noIfMatch.status).toBe(400);

    const ok = await call(api, 'PATCH', `/api/v1/products/${product.id}`, {
      token: t.accessToken,
      headers: { 'if-match': '"v1"' },
      body: { name: 'Nike Air Max 2' },
    });
    expect(ok).toMatchObject({ status: 200, body: { name: 'Nike Air Max 2', version: 2 } });
    expect(ok.headers['etag']).toBe('"v2"');

    const stale = await call(api, 'PATCH', `/api/v1/products/${product.id}`, {
      token: t.accessToken,
      headers: { 'if-match': '"v1"' },
      body: { name: 'Stale' },
    });
    expect(stale).toMatchObject({ status: 412, body: { code: 'PRECONDITION_FAILED' } });
  });

  it('rejects a stale variant update', async () => {
    const product = await createProduct();
    const variant = product.variants[0];
    const ok = await call(api, 'PATCH', `/api/v1/variants/${variant.id}`, {
      token: t.accessToken,
      headers: { 'if-match': `"v${variant.version}"` },
      body: { sellingPrice: '199.00' },
    });
    expect(ok).toMatchObject({ status: 200, body: { sellingPrice: '199.00', version: 2 } });
    const stale = await call(api, 'PATCH', `/api/v1/variants/${variant.id}`, {
      token: t.accessToken,
      headers: { 'if-match': `"v${variant.version}"` },
      body: { sellingPrice: '1.00' },
    });
    expect(stale.status).toBe(412);
  });
});

describe('uniqueness', () => {
  it('rejects a duplicate SKU across products', async () => {
    const sku = `DUP-${Math.random().toString(36).slice(2, 8)}`;
    await createProduct({}, [{ sku }]);
    const res = await call(api, 'POST', '/api/v1/products', {
      token: t.accessToken,
      body: {
        code: `P-${Math.random().toString(36).slice(2, 8)}`,
        name: 'Other',
        baseUnitId: unitId,
        variants: [{ sku }],
      },
    });
    expect(res).toMatchObject({ status: 409, body: { code: 'DUPLICATE' } });
  });

  it('rejects a barcode already assigned to another SKU', async () => {
    const product = await createProduct({}, [{ sku: `A-${Date.now()}` }, { sku: `B-${Date.now()}` }]);
    const [v1, v2] = product.variants;
    const barcode = '4006381333931'; // valid EAN-13
    const first = await call(api, 'POST', `/api/v1/variants/${v1.id}/barcodes`, {
      token: t.accessToken,
      body: { barcode, symbology: 'EAN13' },
    });
    expect(first.status).toBe(201);
    const second = await call(api, 'POST', `/api/v1/variants/${v2.id}/barcodes`, {
      token: t.accessToken,
      body: { barcode, symbology: 'EAN13' },
    });
    expect(second).toMatchObject({ status: 409, body: { code: 'DUPLICATE' } });
  });

  it('rejects an invalid EAN-13 check digit', async () => {
    const product = await createProduct();
    const res = await call(api, 'POST', `/api/v1/variants/${product.variants[0].id}/barcodes`, {
      token: t.accessToken,
      body: { barcode: '4006381333930', symbology: 'EAN13' }, // wrong check digit
    });
    expect(res.status).toBe(400);
  });
});

describe('categories', () => {
  it('builds a materialized-path tree and keeps descendants in sync on rename', async () => {
    const parent = (
      await call(api, 'POST', '/api/v1/categories', { token: t.accessToken, body: { name: 'Shoes' } })
    ).body;
    expect(parent.path).toBe('/shoes/');
    const child = (
      await call(api, 'POST', '/api/v1/categories', {
        token: t.accessToken,
        body: { name: 'Running', parentId: parent.id },
      })
    ).body;
    expect(child.path).toBe('/shoes/running/');

    const renamed = await call(api, 'PATCH', `/api/v1/categories/${parent.id}`, {
      token: t.accessToken,
      body: { name: 'Footwear' },
    });
    expect(renamed.body.path).toBe('/footwear/');
    const childAfter = await call(api, 'GET', `/api/v1/categories/${child.id}`, { token: t.accessToken });
    expect(childAfter.body.path).toBe('/footwear/running/');
  });
});

describe('bundles', () => {
  it('computes a bundle from its components and rejects components on a non-bundle', async () => {
    const componentA = await createProduct();
    const componentB = await createProduct();
    const bundle = await createProduct({ type: 'BUNDLE' }, [{ sku: `BNDL-${Date.now()}` }]);
    const bundleVariantId = bundle.variants[0].id;

    const set = await call(api, 'POST', `/api/v1/variants/${bundleVariantId}/bundle-components`, {
      token: t.accessToken,
      body: {
        components: [
          { variantId: componentA.variants[0].id, quantity: '2' },
          { variantId: componentB.variants[0].id, quantity: '1' },
        ],
      },
    });
    expect(set.status).toBe(201);

    const got = await call(api, 'GET', `/api/v1/variants/${bundleVariantId}/bundle-components`, {
      token: t.accessToken,
    });
    expect(got.body).toHaveLength(2);
    expect(got.body.map((c: { quantity: string }) => c.quantity).sort()).toEqual(['1.000', '2.000']);

    const nonBundle = await createProduct();
    const rejected = await call(
      api,
      'POST',
      `/api/v1/variants/${nonBundle.variants[0].id}/bundle-components`,
      {
        token: t.accessToken,
        body: { components: [{ variantId: componentA.variants[0].id, quantity: '1' }] },
      },
    );
    expect(rejected).toMatchObject({ status: 422, body: { code: 'NOT_A_BUNDLE' } });
  });
});

describe('unit conversion', () => {
  it('records 1 BOX = 12 PCS for a product', async () => {
    const box = (
      await call(api, 'POST', '/api/v1/units', {
        token: t.accessToken,
        body: { code: `BOX${Date.now()}`, name: 'ลัง' },
      })
    ).body;
    const product = await createProduct();
    const set = await call(api, 'POST', `/api/v1/products/${product.id}/units`, {
      token: t.accessToken,
      body: { unitId: box.id, factorToBase: '12', isPurchaseUnit: true, isSalesUnit: false },
    });
    expect(set.status).toBe(201);
    expect(set.body).toContainEqual(
      expect.objectContaining({ unitId: box.id, factorToBase: '12.000000', isPurchaseUnit: true }),
    );
  });
});

describe('deleting a product', () => {
  it('is blocked while the SKU still has stock, allowed once it does not', async () => {
    const withStock = await createProduct();
    await tenantTx(db.app, t.tenantId, (tx) =>
      new inventory.InventoryEngine().apply(tx, {
        tenantId: t.tenantId,
        operation: 'OPENING',
        idempotencyKey: `test:opening:${withStock.variants[0].id}`,
        reference: { type: 'OPENING', id: withStock.id },
        lines: [{ warehouseId, variantId: withStock.variants[0].id, quantity: '5' }],
      }),
    );
    const blocked = await call(api, 'DELETE', `/api/v1/products/${withStock.id}`, { token: t.accessToken });
    // 422 (not 409): this codebase's convention for "blocked by a business rule" (see DeviceService's
    // DEVICE_LOST/DEVICE_NOT_REGISTERED) rather than a version/uniqueness conflict.
    expect(blocked).toMatchObject({ status: 422, body: { code: 'PRODUCT_HAS_STOCK' } });

    const withoutStock = await createProduct();
    const deleted = await call(api, 'DELETE', `/api/v1/products/${withoutStock.id}`, {
      token: t.accessToken,
    });
    expect(deleted.status).toBe(204);
    expect(
      (await call(api, 'GET', `/api/v1/products/${withoutStock.id}`, { token: t.accessToken })).status,
    ).toBe(404);
  });
});

describe('suppliers', () => {
  it('links a supplier to a SKU with cost and lead time', async () => {
    const supplier = (
      await call(api, 'POST', '/api/v1/suppliers', {
        token: t.accessToken,
        body: { code: `SUP${Date.now()}`, name: 'ห้างหุ้นส่วน ABC' },
      })
    ).body;
    const product = await createProduct();
    const linked = await call(api, 'POST', `/api/v1/suppliers/${supplier.id}/products`, {
      token: t.accessToken,
      body: { variantId: product.variants[0].id, supplierSku: 'ABC-1', lastCost: '899.5', leadTimeDays: 5 },
    });
    expect(linked).toMatchObject({ status: 201, body: { supplierSku: 'ABC-1', lastCost: '899.5000' } });
    const list = await call(api, 'GET', `/api/v1/suppliers/${supplier.id}/products`, {
      token: t.accessToken,
    });
    expect(list.body).toHaveLength(1);
  });
});

describe('product images', () => {
  it('uploads, serves and deletes an image', async () => {
    const product = await createProduct();
    const uploaded = await call(api, 'POST', `/api/v1/products/${product.id}/images`, {
      token: t.accessToken,
      body: { contentType: 'image/png', dataBase64: Buffer.from('fake-png-bytes').toString('base64') },
    });
    expect(uploaded).toMatchObject({ status: 201, body: { contentType: 'image/png' } });

    const fetched = await callBinary(api, 'GET', `/api/v1/images/${uploaded.body.id}`, {
      token: t.accessToken,
    });
    expect(fetched.status).toBe(200);
    expect(fetched.headers['content-type']).toBe('image/png');
    expect(fetched.body.toString()).toBe('fake-png-bytes');

    const deleted = await call(api, 'DELETE', `/api/v1/images/${uploaded.body.id}`, { token: t.accessToken });
    expect(deleted.status).toBe(204);
    expect(
      (await call(api, 'GET', `/api/v1/images/${uploaded.body.id}`, { token: t.accessToken })).status,
    ).toBe(404);
  });

  it('rejects an oversized or wrong-type upload', async () => {
    const product = await createProduct();
    const tooBig = await call(api, 'POST', `/api/v1/products/${product.id}/images`, {
      token: t.accessToken,
      body: { contentType: 'image/png', dataBase64: Buffer.alloc(6 * 1024 * 1024, 1).toString('base64') },
    });
    expect(tooBig.status).toBe(400);
    const wrongType = await call(api, 'POST', `/api/v1/products/${product.id}/images`, {
      token: t.accessToken,
      body: { contentType: 'application/pdf', dataBase64: 'AAAA' },
    });
    expect(wrongType.status).toBe(400);
  });
});

describe('trigram search', () => {
  it('finds products by partial and misspelled name', async () => {
    await createProduct({ code: `SEARCH-A-${Date.now()}`, name: 'Adidas Ultraboost 22' });
    await createProduct({ code: `SEARCH-B-${Date.now()}`, name: 'Converse Chuck Taylor' });

    const partial = await call(api, 'GET', '/api/v1/products?q=Ultraboost', { token: t.accessToken });
    expect(partial.body.data.some((p: { name: string }) => p.name === 'Adidas Ultraboost 22')).toBe(true);

    const misspelled = await call(api, 'GET', '/api/v1/products?q=Ultrabost', { token: t.accessToken });
    expect(misspelled.body.data.some((p: { name: string }) => p.name === 'Adidas Ultraboost 22')).toBe(true);
  });

  it('paginates the full list with a keyset cursor', async () => {
    for (let i = 0; i < 3; i++) await createProduct({ code: `PAGE-${Date.now()}-${i}` });
    const page1 = await call(api, 'GET', '/api/v1/products?limit=2', { token: t.accessToken });
    expect(page1.body.data).toHaveLength(2);
    expect(page1.body.page.nextCursor).toBeTruthy();
    const page2 = await call(
      api,
      'GET',
      `/api/v1/products?limit=2&cursor=${encodeURIComponent(page1.body.page.nextCursor)}`,
      { token: t.accessToken },
    );
    expect(page2.body.data).toHaveLength(2);
    const ids1 = new Set(page1.body.data.map((p: { id: string }) => p.id));
    for (const p of page2.body.data as { id: string }[]) expect(ids1.has(p.id)).toBe(false);
  });
});

describe('bulk import / export', () => {
  it('imports a catalog spreadsheet and reports a job, then exports it back out', async () => {
    const rows = 300;
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('Products');
    sheet.addRow([
      'productCode',
      'productName',
      'brandName',
      'baseUnitCode',
      'sku',
      'costPrice',
      'sellingPrice',
    ]);
    const tag = Date.now();
    for (let i = 0; i < rows; i++) {
      sheet.addRow([
        `IMP-${tag}-${i}`,
        `Imported Product ${i}`,
        '',
        'PCS',
        `IMP-${tag}-${i}-SKU`,
        '100',
        '199',
      ]);
    }
    const buffer = Buffer.from((await wb.xlsx.writeBuffer()) as unknown as ArrayBuffer);

    const started = Date.now();
    const imported = await call(api, 'POST', '/api/v1/products/import', {
      token: t.accessToken,
      headers: { 'content-type': 'application/octet-stream' },
      body: buffer as unknown as Record<string, unknown>,
    });
    const elapsedMs = Date.now() - started;
    expect(imported, JSON.stringify(imported.body)).toMatchObject({
      status: 201,
      body: {
        status: 'COMPLETED',
        totalRows: rows,
        createdProducts: rows,
        createdVariants: rows,
        errors: [],
      },
    });
    expect(elapsedMs).toBeLessThan(60_000);

    const job = await call(api, 'GET', `/api/v1/jobs/${imported.body.id}`, { token: t.accessToken });
    expect(job.body).toMatchObject({ status: 'COMPLETED', createdProducts: rows });

    const exported = await callBinary(api, 'GET', '/api/v1/products/export', { token: t.accessToken });
    expect(exported.status).toBe(200);
    expect(exported.headers['content-type']).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    const outWb = new ExcelJS.Workbook();
    await outWb.xlsx.load(exported.body as unknown as Parameters<typeof outWb.xlsx.load>[0]);
    const outSheet = outWb.worksheets[0]!;
    expect(outSheet.rowCount - 1).toBeGreaterThanOrEqual(rows);
  });

  it('imports a template that round-trips through the real endpoint', async () => {
    const template = await callBinary(api, 'GET', '/api/v1/products/import/template', {
      token: t.accessToken,
    });
    expect(template.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(template.body as unknown as Parameters<typeof wb.xlsx.load>[0]);
    expect(wb.worksheets[0]!.getRow(1).getCell(1).value).toBe('productCode');
  });

  it('reports row errors without failing the whole job', async () => {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('Products');
    sheet.addRow(['productCode', 'productName', 'baseUnitCode', 'sku']);
    sheet.addRow(['BAD-1', 'Bad Row', 'NOT-A-UNIT', `BAD-${Date.now()}`]); // unknown unit
    sheet.addRow(['OK-1', 'Good Row', 'PCS', `OK-${Date.now()}`]);
    const buffer = Buffer.from((await wb.xlsx.writeBuffer()) as unknown as ArrayBuffer);

    const res = await call(api, 'POST', '/api/v1/products/import', {
      token: t.accessToken,
      headers: { 'content-type': 'application/octet-stream' },
      body: buffer as unknown as Record<string, unknown>,
    });
    expect(res.body).toMatchObject({ status: 'COMPLETED', createdProducts: 1, errors: [{ row: 2 }] });
  });
});

describe('plan limits', () => {
  it('blocks creating a SKU once the tenant is over its plan limit', async () => {
    await platformTx(db.platform, (tx) =>
      sql`insert into plans (id, name, limits) values ('TEST_LOW_SKU', 'Test Low SKU', '{"skus":1}'::jsonb)
          on conflict (id) do update set limits = excluded.limits`.execute(tx),
    );
    const low = await signup(api, 'LowPlan');
    await platformTx(db.platform, (tx) =>
      sql`update tenant_subscriptions set plan_id = 'TEST_LOW_SKU' where tenant_id = ${low.tenantId}`.execute(
        tx,
      ),
    );
    const lowUnit = (
      await call(api, 'POST', '/api/v1/units', { token: low.accessToken, body: { code: 'PCS', name: 'PCS' } })
    ).body;
    const first = await call(api, 'POST', '/api/v1/products', {
      token: low.accessToken,
      body: { code: 'FIRST', name: 'First', baseUnitId: lowUnit.id, variants: [{ sku: 'FIRST-1' }] },
    });
    expect(first.status).toBe(201);
    const second = await call(api, 'POST', '/api/v1/products', {
      token: low.accessToken,
      body: { code: 'SECOND', name: 'Second', baseUnitId: lowUnit.id, variants: [{ sku: 'SECOND-1' }] },
    });
    expect(second).toMatchObject({ status: 403, body: { code: 'PLAN_LIMIT_EXCEEDED' } });
  });
});
