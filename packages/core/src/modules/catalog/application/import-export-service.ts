import { Readable } from 'node:stream';
import ExcelJS from 'exceljs';
import { sql } from 'kysely';
import type { Tx } from '@stockos/database';
import { NotFoundError, ValidationError, isUuid, uuidv7 } from '@stockos/shared';
import { assertCan, type Principal } from '../../iam/public-api';
import type { ProductService } from './product-service';

export interface ImportPreviewRow {
  row: number;
  status: 'success' | 'error';
  note: string;
  sku: string;
  productName: string;
  aliasName: string;
  description: string;
  properties: string;
}

export interface ImportJob {
  id: string | null;
  status: 'PROCESSING' | 'COMPLETED' | 'FAILED';
  totalRows: number;
  createdProducts: number;
  createdVariants: number;
  updatedVariants: number;
  errors: { row: number; message: string }[];
  /** Per-row detail, for the import-preview UI. Empty when loaded back via `getJob` (not persisted). */
  rows: ImportPreviewRow[];
}

/** Thrown by `importXlsx` when called with `dryRun: true`, to unwind the transaction (it must never
 *  commit) while still carrying the computed preview back to the caller. Not a real error — the
 *  controller catches this specifically and returns `.result` as a normal 200 response. */
export class DryRunAbort extends Error {
  constructor(readonly result: ImportJob) {
    super('dry-run-abort');
  }
}

const HEADERS = [
  'productCode',
  'productName',
  'description',
  'brandName',
  'baseUnitCode',
  'sku',
  'variantName',
  'optionValues',
  'costPrice',
  'sellingPrice',
  'barcode',
] as const;
type RowValues = Record<(typeof HEADERS)[number], string>;

const MAX_ROWS = 20_000;

/**
 * Bulk product/variant import & export via Excel. Import is processed synchronously inside the
 * request (see docs/15 Phase 2) and recorded in `import_jobs` so the response shape matches a
 * future async worker without a client-visible change.
 */
export class ImportExportService {
  constructor(private readonly products: ProductService) {}

  /** A ready-to-fill template: one header row + example row. */
  async buildTemplate(): Promise<Uint8Array> {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('Products');
    sheet.addRow([...HEADERS]);
    sheet.addRow([
      'SHOE-001',
      'Nike Air Max',
      'รองเท้าวิ่งน้ำหนักเบา พื้นรองรับแรงกระแทก',
      'Nike',
      'PCS',
      'SHOE-001-BLK-41',
      'Nike Air Max - Black / 41',
      'Color=Black;Size=41',
      '1200',
      '2490',
      '',
    ]);
    return wb.xlsx.writeBuffer() as unknown as Promise<Uint8Array>;
  }

  async importXlsx(
    tx: Tx,
    principal: Principal,
    fileBuffer: Buffer,
    fileName?: string,
    options: { dryRun?: boolean; maxRows?: number } = {},
  ): Promise<ImportJob> {
    assertCan(principal, 'product.create');
    const wb = new ExcelJS.Workbook();
    const isCsv = (fileName ?? '').trim().toLowerCase().endsWith('.csv');
    try {
      if (isCsv) {
        // `map` disabled: fast-csv's default coerces numeric-looking cells to JS numbers (e.g. a
        // SKU of "007" -> 7), silently corrupting business codes. Every field here is text.
        await wb.csv.read(Readable.from(fileBuffer), {
          map: (value: unknown) => (value === '' ? null : value),
        });
      } else {
        // exceljs's own .d.ts module-locally shadows `Buffer` with a bogus `extends ArrayBuffer`
        // interface, incompatible with the real (Uint8Array-backed) Node Buffer. `Parameters<>`
        // recovers that exact (unexported) shadow type so the cast through `unknown` lands correctly.
        await wb.xlsx.load(fileBuffer as unknown as Parameters<typeof wb.xlsx.load>[0]);
      }
    } catch {
      throw new ValidationError('File is not a valid .xlsx or .csv file');
    }
    const sheet = wb.worksheets[0];
    if (!sheet) throw new ValidationError('Workbook has no sheet');

    const headerRow = sheet.getRow(1).values as unknown[];
    const colIndex = new Map<string, number>();
    for (let i = 1; i < headerRow.length; i++) {
      const h = String(headerRow[i] ?? '').trim();
      if (h) colIndex.set(h, i);
    }
    for (const required of ['productCode', 'baseUnitCode', 'sku'] as const) {
      if (!colIndex.has(required)) throw new ValidationError(`Missing required column: ${required}`);
    }

    const totalRows = sheet.rowCount - 1;
    const maxRows = options.maxRows ?? MAX_ROWS;
    if (totalRows > maxRows) throw new ValidationError(`At most ${maxRows} rows per import`);

    const jobId = uuidv7();
    const errors: { row: number; message: string }[] = [];
    const previewRows: ImportPreviewRow[] = [];
    let createdProducts = 0;
    let createdVariants = 0;
    let updatedVariants = 0;
    const productIdByCode = new Map<string, string>();

    for (let r = 2; r <= sheet.rowCount; r++) {
      const row = sheet.getRow(r);
      if (row.values == null || (row.values as unknown[]).length === 0) continue;
      const values = readRow(row, colIndex);
      if (!values.productCode && !values.sku) continue; // blank row
      const preview = {
        row: r,
        sku: values.sku,
        productName: values.productName,
        aliasName: values.variantName,
        description: values.description,
        properties: values.optionValues.replace(/;/g, ', '),
      };
      try {
        const result = await this.importRow(tx, principal, productIdByCode, values);
        if (result === 'product+variant') {
          createdProducts++;
          createdVariants++;
        } else if (result === 'variant') createdVariants++;
        else updatedVariants++;
        const note =
          result === 'product+variant'
            ? 'จะสร้างสินค้าใหม่'
            : result === 'variant'
              ? 'จะเพิ่ม SKU ใหม่ในสินค้าเดิม'
              : 'จะอัปเดต SKU ที่มีอยู่แล้ว';
        previewRows.push({ ...preview, status: 'success', note });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        errors.push({ row: r, message });
        previewRows.push({ ...preview, status: 'error', note: message });
      }
    }

    const status = errors.length === totalRows && totalRows > 0 ? 'FAILED' : 'COMPLETED';
    if (options.dryRun) {
      throw new DryRunAbort({
        id: null,
        status,
        totalRows,
        createdProducts,
        createdVariants,
        updatedVariants,
        errors,
        rows: previewRows,
      });
    }
    await sql`insert into import_jobs (tenant_id, id, type, status, file_name, total_rows, created_products,
                                       created_variants, updated_variants, errors, created_by, completed_at)
              values (${principal.tenantId}, ${jobId}, 'PRODUCT_IMPORT', ${status}, ${fileName ?? null},
                      ${totalRows}, ${createdProducts}, ${createdVariants}, ${updatedVariants},
                      ${JSON.stringify(errors)}::jsonb, ${principal.membershipId}, now())`.execute(tx);
    return {
      id: jobId,
      status,
      totalRows,
      createdProducts,
      createdVariants,
      updatedVariants,
      errors,
      rows: previewRows,
    };
  }

  async getJob(tx: Tx, principal: Principal, id: string): Promise<ImportJob> {
    assertCan(principal, 'product.read');
    if (!isUuid(id)) throw new NotFoundError('Unknown job');
    const { rows } = await sql<{
      id: string;
      status: ImportJob['status'];
      total_rows: number;
      created_products: number;
      created_variants: number;
      updated_variants: number;
      errors: { row: number; message: string }[];
    }>`select id, status, total_rows, created_products, created_variants, updated_variants, errors
        from import_jobs where id = ${id}`.execute(tx);
    const row = rows[0];
    if (!row) throw new NotFoundError('Unknown job');
    return {
      id: row.id,
      status: row.status,
      totalRows: row.total_rows,
      createdProducts: row.created_products,
      createdVariants: row.created_variants,
      updatedVariants: row.updated_variants,
      errors: row.errors,
      rows: [], // per-row detail is not persisted; only `importXlsx`'s own live response has it
    };
  }

  async exportXlsx(tx: Tx, principal: Principal): Promise<Uint8Array> {
    assertCan(principal, 'product.read');
    const { rows } = await sql<{
      product_code: string;
      product_name: string;
      description: string | null;
      brand_name: string | null;
      base_unit_code: string;
      sku: string;
      variant_name: string;
      option_values: Record<string, string>;
      cost_price: string;
      selling_price: string;
      status: string;
      barcode: string | null;
    }>`
      select p.code as product_code, p.name as product_name, p.description, b.name as brand_name,
             u.code as base_unit_code, v.sku, v.name as variant_name, v.option_values, v.cost_price,
             v.selling_price, v.status,
             (select barcode from variant_barcodes where variant_id = v.id order by is_primary desc limit 1) as barcode
        from product_variants v
        join products p on p.id = v.product_id
        left join brands b on b.id = p.brand_id
        join units u on u.id = p.base_unit_id
       where v.deleted_at is null and p.deleted_at is null
       order by p.code, v.sku`.execute(tx);

    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('Products');
    sheet.addRow([...HEADERS, 'status']);
    for (const r of rows) {
      sheet.addRow([
        r.product_code,
        r.product_name,
        r.description ?? '',
        r.brand_name ?? '',
        r.base_unit_code,
        r.sku,
        r.variant_name,
        Object.entries(r.option_values ?? {})
          .map(([k, v]) => `${k}=${v}`)
          .join(';'),
        r.cost_price,
        r.selling_price,
        r.barcode ?? '',
        r.status,
      ]);
    }
    return wb.xlsx.writeBuffer() as unknown as Promise<Uint8Array>;
  }

  private async importRow(
    tx: Tx,
    principal: Principal,
    productIdByCode: Map<string, string>,
    row: RowValues,
  ): Promise<'product+variant' | 'variant' | 'updated'> {
    if (!row.sku) throw new ValidationError('sku is required');
    const { rows: existingVariant } = await sql<{ id: string; version: number; product_id: string }>`
      select id, version, product_id from product_variants where sku = ${row.sku} and deleted_at is null`.execute(
      tx,
    );
    const optionValues = parseOptionValues(row.optionValues);

    if (existingVariant[0]) {
      const v = existingVariant[0];
      await this.products.updateVariant(tx, principal, v.id, {
        expectedVersion: v.version,
        ...(row.variantName ? { name: row.variantName } : {}),
        ...(row.costPrice ? { costPrice: row.costPrice } : {}),
        ...(row.sellingPrice ? { sellingPrice: row.sellingPrice } : {}),
      });
      if (row.barcode) await this.attachBarcodeIfNew(tx, principal, v.id, row.barcode);
      return 'updated';
    }

    if (!row.productCode) throw new ValidationError('productCode is required for a new SKU');
    let productId = productIdByCode.get(row.productCode);
    if (!productId) {
      const { rows: existingProduct } = await sql<{ id: string }>`
        select id from products where code = ${row.productCode} and deleted_at is null`.execute(tx);
      if (existingProduct[0]) {
        productId = existingProduct[0].id;
      } else {
        if (!row.productName) throw new ValidationError('productName is required for a new product');
        if (!row.baseUnitCode) throw new ValidationError('baseUnitCode is required for a new product');
        const unitId = await this.resolveUnit(tx, row.baseUnitCode);
        const brandId = row.brandName ? await this.resolveBrand(tx, principal, row.brandName) : undefined;
        const created = await this.products.create(tx, principal, {
          code: row.productCode,
          name: row.productName,
          baseUnitId: unitId,
          ...(row.description ? { description: row.description } : {}),
          ...(brandId ? { brandId } : {}),
          variants: [
            {
              sku: row.sku,
              ...(row.variantName ? { name: row.variantName } : {}),
              ...(Object.keys(optionValues).length ? { optionValues } : {}),
              ...(row.costPrice ? { costPrice: row.costPrice } : {}),
              ...(row.sellingPrice ? { sellingPrice: row.sellingPrice } : {}),
              ...(row.barcode ? { barcodes: [row.barcode] } : {}),
            },
          ],
        });
        productIdByCode.set(row.productCode, created.id);
        return 'product+variant';
      }
      productIdByCode.set(row.productCode, productId);
    }
    await this.products.addVariant(tx, principal, productId, {
      sku: row.sku,
      ...(row.variantName ? { name: row.variantName } : {}),
      ...(Object.keys(optionValues).length ? { optionValues } : {}),
      ...(row.costPrice ? { costPrice: row.costPrice } : {}),
      ...(row.sellingPrice ? { sellingPrice: row.sellingPrice } : {}),
      ...(row.barcode ? { barcodes: [row.barcode] } : {}),
    });
    return 'variant';
  }

  private async attachBarcodeIfNew(
    tx: Tx,
    principal: Principal,
    variantId: string,
    barcode: string,
  ): Promise<void> {
    const { rows } = await sql`select 1 from variant_barcodes where barcode = ${barcode}`.execute(tx);
    if (rows.length > 0) return;
    const symbology = /^\d{13}$/.test(barcode) ? 'EAN13' : 'CODE128';
    await this.products.addBarcode(tx, principal, variantId, { barcode, symbology });
  }

  private async resolveUnit(tx: Tx, code: string): Promise<string> {
    const { rows } = await sql<{ id: string }>`select id from units where code = ${code}`.execute(tx);
    if (!rows[0]) throw new ValidationError(`Unknown unit code: ${code}`);
    return rows[0].id;
  }

  private async resolveBrand(tx: Tx, principal: Principal, name: string): Promise<string> {
    const { rows } = await sql<{ id: string }>`select id from brands where name = ${name}`.execute(tx);
    if (rows[0]) return rows[0].id;
    const id = uuidv7();
    await sql`insert into brands (tenant_id, id, name) values (${principal.tenantId}, ${id}, ${name})
              on conflict (tenant_id, name) do nothing`.execute(tx);
    const { rows: after } = await sql<{ id: string }>`select id from brands where name = ${name}`.execute(tx);
    return after[0]!.id;
  }
}

function readRow(row: ExcelJS.Row, colIndex: Map<string, number>): RowValues {
  const get = (key: (typeof HEADERS)[number]): string => {
    const idx = colIndex.get(key);
    if (!idx) return '';
    const cell = row.getCell(idx).value;
    if (cell == null) return '';
    if (typeof cell === 'object' && 'text' in cell) return String((cell as { text: unknown }).text ?? '');
    if (typeof cell === 'object' && 'result' in cell)
      return String((cell as { result: unknown }).result ?? '');
    return String(cell).trim();
  };
  return Object.fromEntries(HEADERS.map((h) => [h, get(h)])) as RowValues;
}

function parseOptionValues(raw: string): Record<string, string> {
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const pair of raw.split(';')) {
    const [k, v] = pair.split('=');
    if (k?.trim() && v?.trim()) out[k.trim()] = v.trim();
  }
  return out;
}
