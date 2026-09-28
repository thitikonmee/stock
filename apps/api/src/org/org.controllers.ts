import { Body, Controller, Get, Inject, Param, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { tenancy, type iam } from '@stockos/core';
import { tenantTx, type Db } from '@stockos/database';
import { Authenticated, CurrentPrincipal, RequirePermission } from '../auth/decorators';
import { parse } from '../common/validation';
import { DB } from '../tokens';

const code = z.string().trim().toUpperCase().max(20);
const BranchCreate = z.strictObject({
  code,
  name: z.string().trim().min(1).max(120),
  taxBranchNo: z.string().trim().optional(),
  phone: z.string().trim().max(30).nullable().optional(),
});
const BranchUpdate = BranchCreate.partial().extend({ isActive: z.boolean().optional() });
const warehouseType = z.enum(['STORE', 'CENTRAL', 'ONLINE', 'MARKETPLACE_FULFILLMENT', 'TRANSIT', 'VIRTUAL']);
const WarehouseCreate = z.strictObject({
  code,
  name: z.string().trim().min(1).max(120),
  branchId: z.string().nullable().optional(),
  type: warehouseType.optional(),
  allowNegativeStock: z.boolean().optional(),
});
const WarehouseUpdate = z.strictObject({
  code: code.optional(),
  name: z.string().trim().min(1).max(120).optional(),
  type: warehouseType.optional(),
  allowNegativeStock: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

/** Drop undefined keys so optional inputs satisfy exactOptionalPropertyTypes-style service types. */
const defined = <T extends object>(o: T) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

@Controller('branches')
export class BranchesController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(tenancy.OrgService) private readonly org: tenancy.OrgService,
  ) {}

  @Authenticated()
  @Get()
  list(@CurrentPrincipal() p: iam.Principal) {
    return tenantTx(this.db, p.tenantId, (tx) => this.org.listBranches(tx));
  }

  @Authenticated()
  @Get(':id')
  get(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string) {
    return tenantTx(this.db, p.tenantId, (tx) => this.org.getBranch(tx, id));
  }

  @RequirePermission('branch.manage')
  @Post()
  create(@CurrentPrincipal() p: iam.Principal, @Body() body: unknown) {
    const input = defined(parse(BranchCreate, body));
    return tenantTx(this.db, p.tenantId, (tx) => this.org.createBranch(tx, p, input));
  }

  @RequirePermission('branch.manage')
  @Patch(':id')
  update(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string, @Body() body: unknown) {
    const input = defined(parse(BranchUpdate, body));
    return tenantTx(this.db, p.tenantId, (tx) => this.org.updateBranch(tx, p, id, input));
  }
}

@Controller('warehouses')
export class WarehousesController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(tenancy.OrgService) private readonly org: tenancy.OrgService,
  ) {}

  @Authenticated()
  @Get()
  list(@CurrentPrincipal() p: iam.Principal) {
    return tenantTx(this.db, p.tenantId, (tx) => this.org.listWarehouses(tx));
  }

  @Authenticated()
  @Get(':id')
  get(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string) {
    return tenantTx(this.db, p.tenantId, (tx) => this.org.getWarehouse(tx, id));
  }

  @RequirePermission('warehouse.manage')
  @Post()
  create(@CurrentPrincipal() p: iam.Principal, @Body() body: unknown) {
    const input = defined(parse(WarehouseCreate, body));
    return tenantTx(this.db, p.tenantId, (tx) => this.org.createWarehouse(tx, p, input));
  }

  @RequirePermission('warehouse.manage')
  @Patch(':id')
  update(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string, @Body() body: unknown) {
    const input = defined(parse(WarehouseUpdate, body));
    return tenantTx(this.db, p.tenantId, (tx) => this.org.updateWarehouse(tx, p, id, input));
  }
}
