import { Body, Controller, Get, Headers, Inject, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { catalog, type iam } from '@stockos/core';
import { tenantTx, type Db } from '@stockos/database';
import { CurrentPrincipal, RequirePermission } from '../auth/decorators';
import { parse, parseIfMatch } from '../common/validation';
import { DB } from '../tokens';

const defined = <T extends object>(o: T) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

const VariantUpdate = z.strictObject({
  name: z.string().trim().min(1).max(255).optional(),
  costPrice: z.string().optional(),
  sellingPrice: z.string().optional(),
  weightGrams: z.number().int().min(0).nullable().optional(),
  reorderPoint: z.string().nullable().optional(),
  reorderQty: z.string().nullable().optional(),
  lowStockThreshold: z.string().nullable().optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'ARCHIVED']).optional(),
});

const AddBarcode = z.strictObject({
  barcode: z.string().trim().max(64),
  symbology: z.enum(['EAN13', 'EAN8', 'UPCA', 'UPCE', 'CODE128', 'QR', 'INTERNAL']),
  unitId: z.string().nullable().optional(),
  isPrimary: z.boolean().optional(),
});

const BundleComponents = z.strictObject({
  components: z
    .array(z.object({ variantId: z.string(), quantity: z.string() }))
    .min(1)
    .max(50),
});

@Controller('variants')
export class VariantsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(catalog.ProductService) private readonly products: catalog.ProductService,
  ) {}

  @RequirePermission('product.read')
  @Get('lookup')
  lookup(
    @CurrentPrincipal() p: iam.Principal,
    @Query('barcode') barcode?: string,
    @Query('sku') sku?: string,
  ) {
    return tenantTx(this.db, p.tenantId, (tx) =>
      this.products.lookup(tx, p, { ...(barcode ? { barcode } : {}), ...(sku ? { sku } : {}) }),
    );
  }

  @RequirePermission('product.update')
  @Patch(':id')
  async update(
    @CurrentPrincipal() p: iam.Principal,
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const expectedVersion = parseIfMatch(ifMatch);
    const input = defined(parse(VariantUpdate, body));
    const variant = await tenantTx(this.db, p.tenantId, (tx) =>
      this.products.updateVariant(tx, p, id, { ...input, expectedVersion }),
    );
    void reply.header('etag', `"v${variant.version}"`);
    return variant;
  }

  @RequirePermission('product.update')
  @Post(':id/barcodes')
  addBarcode(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string, @Body() body: unknown) {
    const input = defined(parse(AddBarcode, body));
    return tenantTx(this.db, p.tenantId, (tx) => this.products.addBarcode(tx, p, id, input));
  }

  @RequirePermission('product.read')
  @Get(':id/bundle-components')
  getBundleComponents(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string) {
    return tenantTx(this.db, p.tenantId, (tx) => this.products.getBundleComponents(tx, p, id));
  }

  @RequirePermission('product.update')
  @Post(':id/bundle-components')
  setBundleComponents(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(BundleComponents, body);
    return tenantTx(this.db, p.tenantId, (tx) =>
      this.products.setBundleComponents(tx, p, id, input.components),
    );
  }
}
