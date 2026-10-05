import ExcelJS from 'exceljs';
import { sql } from 'kysely';
import type { Tx } from '@stockos/database';
import { ValidationError, formatCost, formatQuantity, toCost, toQuantity, uuidv7 } from '@stockos/shared';
import { recordAudit } from '../../audit/public-api';
import { assertCan, type Principal } from '../../iam/public-api';
import { applyMovingAverage } from '../infrastructure/cost-repository';
import { InventoryEngine } from './inventory-engine';

export interface ReceiveLine {
  warehouseId: string;
  variantId: string;
  quantity: string;
  unitCost?: string;
}
export interface ReceiveInput {
  lines: readonly ReceiveLine[];
  idempotencyKey: string;
  note?: string;
}
export interface ReceiveResult {
  movementId: string;
}

export interface OpeningStockImportResult {
  totalRows: number;
  applied: number;
  errors: { row: number; message: string }[];
}

const HEADERS = ['warehouseCode', 'sku', 'quantity', 'unitCost'] as const;

/**
 * Receiving stock (ad-hoc receive, opening balances) and the moving weighted average cost that
 * rides along with it. `InventoryEngine` stays cost-agnostic (docs/04-inventory.md) — this service
 * calls it for the balance/ledger side, then folds unit cost into `variant_costs` itself.
 */
export class ReceivingService {
  private readonly engine = new InventoryEngine();

  /** Ad-hoc "just add stock" (goods receipt without a PO, or opening balance). */
  async receive(tx: Tx, principal: Principal, input: ReceiveInput): Promise<ReceiveResult> {
    assertCan(principal, 'inventory.receive');
    if (input.lines.length === 0) throw new ValidationError('At least one line is required');
    const result = await this.engine.apply(tx, {
      tenantId: principal.tenantId,
      operation: 'RECEIVE_DIRECT',
      idempotencyKey: input.idempotencyKey,
      reference: { type: 'STOCK_RECEIVE', id: uuidv7() },
      userId: principal.membershipId,
      ...(input.note ? { note: input.note } : {}),
      lines: input.lines.map((l) => ({
        warehouseId: l.warehouseId,
        variantId: l.variantId,
        quantity: l.quantity,
        ...(l.unitCost ? { unitCost: l.unitCost } : {}),
      })),
    });
    if (!result.replayed) {
      for (const line of input.lines) {
        if (line.unitCost)
          await applyMovingAverage(tx, principal.tenantId, line.variantId, line.quantity, line.unitCost);
      }
    }
    await recordAudit(tx, {
      tenantId: principal.tenantId,
      action: 'inventory.receive',
      resourceType: 'inventory_movement',
      resourceId: result.movementId,
      after: { lines: input.lines.length },
    });
    return { movementId: result.movementId };
  }

  /** Bulk opening-stock import (.xlsx): one OPENING movement per row, synchronous like Phase 2's import. */
  async importOpeningStock(
    tx: Tx,
    principal: Principal,
    fileBuffer: Buffer,
  ): Promise<OpeningStockImportResult> {
    assertCan(principal, 'inventory.receive');
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(fileBuffer as unknown as Parameters<typeof wb.xlsx.load>[0]);
    } catch {
      throw new ValidationError('File is not a valid .xlsx workbook');
    }
    const sheet = wb.worksheets[0];
    if (!sheet) throw new ValidationError('Workbook has no sheet');
    const headerRow = sheet.getRow(1).values as unknown[];
    const colIndex = new Map<string, number>();
    for (let i = 1; i < headerRow.length; i++) {
      const h = String(headerRow[i] ?? '').trim();
      if (h) colIndex.set(h, i);
    }
    for (const required of HEADERS) {
      if (!colIndex.has(required)) throw new ValidationError(`Missing required column: ${required}`);
    }

    const errors: { row: number; message: string }[] = [];
    let applied = 0;
    const totalRows = sheet.rowCount - 1;
    const warehouseCache = new Map<string, string>();

    for (let r = 2; r <= sheet.rowCount; r++) {
      const row = sheet.getRow(r);
      const get = (key: (typeof HEADERS)[number]) => {
        const idx = colIndex.get(key);
        if (!idx) return '';
        const cell = row.getCell(idx).value;
        return cell == null ? '' : String(cell).trim();
      };
      const warehouseCode = get('warehouseCode');
      const sku = get('sku');
      if (!warehouseCode && !sku) continue; // blank row
      try {
        if (!warehouseCode || !sku) throw new ValidationError('warehouseCode and sku are required');
        let warehouseId = warehouseCache.get(warehouseCode);
        if (!warehouseId) {
          const { rows } = await sql<{
            id: string;
          }>`select id from warehouses where code = ${warehouseCode}`.execute(tx);
          if (!rows[0]) throw new ValidationError(`Unknown warehouse code: ${warehouseCode}`);
          warehouseId = rows[0].id;
          warehouseCache.set(warehouseCode, warehouseId);
        }
        const { rows: vRows } = await sql<{ id: string }>`
          select id from product_variants where sku = ${sku} and deleted_at is null`.execute(tx);
        if (!vRows[0]) throw new ValidationError(`Unknown SKU: ${sku}`);
        const quantity = formatQuantity(toQuantity(get('quantity')));
        const unitCostRaw = get('unitCost');

        await this.engine.apply(tx, {
          tenantId: principal.tenantId,
          operation: 'OPENING',
          idempotencyKey: `opening-import:${warehouseId}:${vRows[0].id}`,
          reference: { type: 'OPENING_IMPORT', id: uuidv7() },
          userId: principal.membershipId,
          lines: [
            {
              warehouseId,
              variantId: vRows[0].id,
              quantity,
              ...(unitCostRaw ? { unitCost: formatCost(toCost(unitCostRaw)) } : {}),
            },
          ],
        });
        if (unitCostRaw) await applyMovingAverage(tx, principal.tenantId, vRows[0].id, quantity, unitCostRaw);
        applied++;
      } catch (err) {
        errors.push({ row: r, message: err instanceof Error ? err.message : 'Unknown error' });
      }
    }

    await recordAudit(tx, {
      tenantId: principal.tenantId,
      action: 'inventory.opening_stock.import',
      resourceType: 'inventory_movement',
      after: { totalRows, applied, errorCount: errors.length },
    });
    return { totalRows, applied, errors };
  }

  async buildTemplate(): Promise<Uint8Array> {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('OpeningStock');
    sheet.addRow([...HEADERS]);
    sheet.addRow(['MAIN', 'SKU-001', '10', '150']);
    return wb.xlsx.writeBuffer() as unknown as Promise<Uint8Array>;
  }
}
