import { Body, Controller, Get, Inject, Param, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { catalog, type iam } from '@stockos/core';
import { tenantTx, type Db } from '@stockos/database';
import { Authenticated, CurrentPrincipal, RequirePermission } from '../auth/decorators';
import { parse } from '../common/validation';
import { DB } from '../tokens';

const defined = <T extends object>(o: T) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

const BrandCreate = z.strictObject({
  name: z.string().trim().min(1).max(120),
  isActive: z.boolean().optional(),
});
const BrandUpdate = BrandCreate.partial();

@Controller('brands')
export class BrandsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(catalog.CatalogMasterDataService) private readonly catalogSvc: catalog.CatalogMasterDataService,
  ) {}

  @Authenticated()
  @Get()
  list(@CurrentPrincipal() p: iam.Principal) {
    return tenantTx(this.db, p.tenantId, (tx) => this.catalogSvc.listBrands(tx, p));
  }

  @RequirePermission('product.create')
  @Post()
  create(@CurrentPrincipal() p: iam.Principal, @Body() body: unknown) {
    const input = defined(parse(BrandCreate, body));
    return tenantTx(this.db, p.tenantId, (tx) => this.catalogSvc.createBrand(tx, p, input));
  }

  @RequirePermission('product.update')
  @Patch(':id')
  update(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string, @Body() body: unknown) {
    const input = defined(parse(BrandUpdate, body));
    return tenantTx(this.db, p.tenantId, (tx) => this.catalogSvc.updateBrand(tx, p, id, input));
  }
}

const CategoryCreate = z.strictObject({
  parentId: z.string().nullable().optional(),
  name: z.string().trim().min(1).max(120),
  sortOrder: z.number().int().optional(),
});
const CategoryUpdate = z.strictObject({
  name: z.string().trim().min(1).max(120).optional(),
  sortOrder: z.number().int().optional(),
});

@Controller('categories')
export class CategoriesController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(catalog.CatalogMasterDataService) private readonly catalogSvc: catalog.CatalogMasterDataService,
  ) {}

  @Authenticated()
  @Get()
  list(@CurrentPrincipal() p: iam.Principal) {
    return tenantTx(this.db, p.tenantId, (tx) => this.catalogSvc.listCategories(tx, p));
  }

  @Authenticated()
  @Get(':id')
  get(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string) {
    return tenantTx(this.db, p.tenantId, (tx) => this.catalogSvc.getCategory(tx, id));
  }

  @RequirePermission('product.create')
  @Post()
  create(@CurrentPrincipal() p: iam.Principal, @Body() body: unknown) {
    const input = defined(parse(CategoryCreate, body));
    return tenantTx(this.db, p.tenantId, (tx) => this.catalogSvc.createCategory(tx, p, input));
  }

  @RequirePermission('product.update')
  @Patch(':id')
  update(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string, @Body() body: unknown) {
    const input = defined(parse(CategoryUpdate, body));
    return tenantTx(this.db, p.tenantId, (tx) => this.catalogSvc.updateCategory(tx, p, id, input));
  }
}

const UnitCreate = z.strictObject({
  code: z.string().trim().toUpperCase().max(20),
  name: z.string().trim().min(1).max(80),
  allowDecimal: z.boolean().optional(),
});

@Controller('units')
export class UnitsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(catalog.CatalogMasterDataService) private readonly catalogSvc: catalog.CatalogMasterDataService,
  ) {}

  @Authenticated()
  @Get()
  list(@CurrentPrincipal() p: iam.Principal) {
    return tenantTx(this.db, p.tenantId, (tx) => this.catalogSvc.listUnits(tx, p));
  }

  @RequirePermission('product.create')
  @Post()
  create(@CurrentPrincipal() p: iam.Principal, @Body() body: unknown) {
    const input = defined(parse(UnitCreate, body));
    return tenantTx(this.db, p.tenantId, (tx) => this.catalogSvc.createUnit(tx, p, input));
  }
}
