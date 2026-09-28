import { Body, Controller, Get, Inject, Param, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { catalog, type iam } from '@stockos/core';
import { tenantTx, type Db } from '@stockos/database';
import { CurrentPrincipal, RequirePermission } from '../auth/decorators';
import { parse } from '../common/validation';
import { DB } from '../tokens';

const defined = <T extends object>(o: T) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

const SupplierCreate = z.strictObject({
  code: z.string().trim().toUpperCase().max(20),
  name: z.string().trim().min(1).max(200),
  taxId: z.string().trim().max(20).nullable().optional(),
  paymentTermsDays: z.number().int().min(0).max(365).optional(),
  defaultLeadTimeDays: z.number().int().min(0).max(365).optional(),
  currency: z.string().trim().length(3).optional(),
  isActive: z.boolean().optional(),
});
const SupplierUpdate = SupplierCreate.partial().omit({ code: true });
const LinkProduct = z.strictObject({
  variantId: z.string(),
  supplierSku: z.string().trim().max(60).nullable().optional(),
  lastCost: z.string().nullable().optional(),
  minOrderQty: z.string().nullable().optional(),
  leadTimeDays: z.number().int().min(0).max(365).nullable().optional(),
  isPreferred: z.boolean().optional(),
});

@Controller('suppliers')
export class SuppliersController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(catalog.SupplierService) private readonly suppliers: catalog.SupplierService,
  ) {}

  @RequirePermission('supplier.read')
  @Get()
  list(@CurrentPrincipal() p: iam.Principal) {
    return tenantTx(this.db, p.tenantId, (tx) => this.suppliers.list(tx, p));
  }

  @RequirePermission('supplier.read')
  @Get(':id')
  get(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string) {
    return tenantTx(this.db, p.tenantId, (tx) => this.suppliers.get(tx, p, id));
  }

  @RequirePermission('supplier.manage')
  @Post()
  create(@CurrentPrincipal() p: iam.Principal, @Body() body: unknown) {
    const input = defined(parse(SupplierCreate, body));
    return tenantTx(this.db, p.tenantId, (tx) => this.suppliers.create(tx, p, input));
  }

  @RequirePermission('supplier.manage')
  @Patch(':id')
  update(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string, @Body() body: unknown) {
    const input = defined(parse(SupplierUpdate, body));
    return tenantTx(this.db, p.tenantId, (tx) => this.suppliers.update(tx, p, id, input));
  }

  @RequirePermission('supplier.read')
  @Get(':id/products')
  listProducts(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string) {
    return tenantTx(this.db, p.tenantId, (tx) => this.suppliers.listProducts(tx, p, id));
  }

  @RequirePermission('supplier.manage')
  @Post(':id/products')
  linkProduct(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string, @Body() body: unknown) {
    const input = defined(parse(LinkProduct, body));
    return tenantTx(this.db, p.tenantId, (tx) => this.suppliers.linkProduct(tx, p, id, input));
  }
}
