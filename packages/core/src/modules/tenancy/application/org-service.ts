import { sql } from 'kysely';
import { PgErrorCode, pgErrorCode, type Tx } from '@stockos/database';
import { ConflictError, NotFoundError, ValidationError, isUuid, uuidv7 } from '@stockos/shared';
import { recordAudit } from '../../audit/public-api';
import { PlanService } from '../../billing/public-api';
import { assertCan, type Principal } from '../../iam/public-api';
import { syncNegativeStockPolicy } from '../../inventory/public-api';

export interface Branch {
  id: string;
  code: string;
  name: string;
  taxBranchNo: string;
  phone: string | null;
  isActive: boolean;
}

export type WarehouseType =
  'STORE' | 'CENTRAL' | 'ONLINE' | 'MARKETPLACE_FULFILLMENT' | 'TRANSIT' | 'VIRTUAL';

export interface Warehouse {
  id: string;
  branchId: string | null;
  code: string;
  name: string;
  type: WarehouseType;
  allowNegativeStock: boolean;
  isActive: boolean;
}

export interface BranchInput {
  code: string;
  name: string;
  taxBranchNo?: string;
  phone?: string | null;
}

export interface WarehouseInput {
  code: string;
  name: string;
  branchId?: string | null;
  type?: WarehouseType;
  allowNegativeStock?: boolean;
}

const CODE_RE = /^[A-Z0-9][A-Z0-9_-]{0,19}$/;

/**
 * Branches and warehouses. Reads are open to every member (org structure is not secret inside a
 * tenant); writes need branch.manage / warehouse.manage at tenant scope.
 */
export class OrgService {
  private readonly plans = new PlanService();

  async listBranches(tx: Tx): Promise<Branch[]> {
    const { rows } = await sql<BranchRow>`select ${branchCols} from branches order by code`.execute(tx);
    return rows.map(toBranch);
  }

  async getBranch(tx: Tx, id: string): Promise<Branch> {
    const row = isUuid(id)
      ? (await sql<BranchRow>`select ${branchCols} from branches where id = ${id}`.execute(tx)).rows[0]
      : undefined;
    if (!row) throw new NotFoundError('Branch not found');
    return toBranch(row);
  }

  async createBranch(tx: Tx, principal: Principal, input: BranchInput): Promise<Branch> {
    assertCan(principal, 'branch.manage');
    checkCode(input.code);
    await this.plans.assertWithinLimit(tx, principal.tenantId, 'branches');
    const taxBranchNo = input.taxBranchNo ?? '00000';
    if (!/^\d{5}$/.test(taxBranchNo))
      throw new ValidationError('taxBranchNo must be 5 digits (00000 = head office)');
    const id = uuidv7();
    await unique(`Branch code ${input.code} already exists`, () =>
      sql`insert into branches (tenant_id, id, code, name, tax_branch_no, phone)
          values (${principal.tenantId}, ${id}, ${input.code}, ${input.name}, ${taxBranchNo}, ${input.phone ?? null})`.execute(
        tx,
      ),
    );
    await recordAudit(tx, {
      tenantId: principal.tenantId,
      action: 'branch.create',
      resourceType: 'branch',
      resourceId: id,
      after: { ...input },
    });
    return this.getBranch(tx, id);
  }

  async updateBranch(
    tx: Tx,
    principal: Principal,
    id: string,
    input: Partial<BranchInput> & { isActive?: boolean },
  ): Promise<Branch> {
    assertCan(principal, 'branch.manage');
    const before = await this.getBranch(tx, id);
    if (input.code !== undefined) checkCode(input.code);
    await unique(`Branch code ${input.code ?? ''} already exists`, () =>
      sql`update branches set code = coalesce(${input.code ?? null}, code), name = coalesce(${input.name ?? null}, name),
                 phone = coalesce(${input.phone ?? null}, phone), is_active = coalesce(${input.isActive ?? null}, is_active)
           where id = ${id}`.execute(tx),
    );
    const after = await this.getBranch(tx, id);
    await recordAudit(tx, {
      tenantId: principal.tenantId,
      action: 'branch.update',
      resourceType: 'branch',
      resourceId: id,
      before: { ...before },
      after: { ...after },
    });
    return after;
  }

  async listWarehouses(tx: Tx): Promise<Warehouse[]> {
    const { rows } = await sql<WarehouseRow>`select ${warehouseCols} from warehouses order by code`.execute(
      tx,
    );
    return rows.map(toWarehouse);
  }

  async getWarehouse(tx: Tx, id: string): Promise<Warehouse> {
    const row = isUuid(id)
      ? (await sql<WarehouseRow>`select ${warehouseCols} from warehouses where id = ${id}`.execute(tx))
          .rows[0]
      : undefined;
    if (!row) throw new NotFoundError('Warehouse not found');
    return toWarehouse(row);
  }

  async createWarehouse(tx: Tx, principal: Principal, input: WarehouseInput): Promise<Warehouse> {
    assertCan(principal, 'warehouse.manage');
    checkCode(input.code);
    if (input.branchId)
      await this.getBranch(tx, input.branchId).catch(() => {
        throw new ValidationError('Unknown branch', { branchId: input.branchId });
      });
    const id = uuidv7();
    await unique(`Warehouse code ${input.code} already exists`, () =>
      sql`insert into warehouses (tenant_id, id, branch_id, code, name, type, allow_negative_stock)
          values (${principal.tenantId}, ${id}, ${input.branchId ?? null}, ${input.code}, ${input.name},
                  ${input.type ?? 'STORE'}, ${input.allowNegativeStock ?? false})`.execute(tx),
    );
    await recordAudit(tx, {
      tenantId: principal.tenantId,
      action: 'warehouse.create',
      resourceType: 'warehouse',
      resourceId: id,
      after: { ...input },
    });
    return this.getWarehouse(tx, id);
  }

  async updateWarehouse(
    tx: Tx,
    principal: Principal,
    id: string,
    input: Partial<Omit<WarehouseInput, 'branchId'>> & { isActive?: boolean },
  ): Promise<Warehouse> {
    assertCan(principal, 'warehouse.manage');
    const before = await this.getWarehouse(tx, id);
    if (input.code !== undefined) checkCode(input.code);
    await unique(`Warehouse code ${input.code ?? ''} already exists`, () =>
      sql`update warehouses set code = coalesce(${input.code ?? null}, code), name = coalesce(${input.name ?? null}, name),
                 type = coalesce(${input.type ?? null}, type),
                 allow_negative_stock = coalesce(${input.allowNegativeStock ?? null}, allow_negative_stock),
                 is_active = coalesce(${input.isActive ?? null}, is_active)
           where id = ${id}`.execute(tx),
    );
    // Balances copy the warehouse's negative-stock policy (InventoryEngine guard); keep them in sync.
    if (input.allowNegativeStock !== undefined && input.allowNegativeStock !== before.allowNegativeStock) {
      await syncNegativeStockPolicy(tx, id, input.allowNegativeStock);
    }
    const after = await this.getWarehouse(tx, id);
    await recordAudit(tx, {
      tenantId: principal.tenantId,
      action: 'warehouse.update',
      resourceType: 'warehouse',
      resourceId: id,
      before: { ...before },
      after: { ...after },
    });
    return after;
  }
}

interface BranchRow {
  id: string;
  code: string;
  name: string;
  tax_branch_no: string;
  phone: string | null;
  is_active: boolean;
}
interface WarehouseRow {
  id: string;
  branch_id: string | null;
  code: string;
  name: string;
  type: WarehouseType;
  allow_negative_stock: boolean;
  is_active: boolean;
}

const branchCols = sql`id, code, name, tax_branch_no, phone, is_active`;
const warehouseCols = sql`id, branch_id, code, name, type, allow_negative_stock, is_active`;

const toBranch = (r: BranchRow): Branch => ({
  id: r.id,
  code: r.code,
  name: r.name,
  taxBranchNo: r.tax_branch_no,
  phone: r.phone,
  isActive: r.is_active,
});
const toWarehouse = (r: WarehouseRow): Warehouse => ({
  id: r.id,
  branchId: r.branch_id,
  code: r.code,
  name: r.name,
  type: r.type,
  allowNegativeStock: r.allow_negative_stock,
  isActive: r.is_active,
});

function checkCode(code: string) {
  if (!CODE_RE.test(code)) throw new ValidationError('Code must be 1-20 chars: A-Z, 0-9, _ or -');
}

async function unique<T>(message: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (pgErrorCode(err) === PgErrorCode.UniqueViolation) throw new ConflictError(message);
    throw err;
  }
}
