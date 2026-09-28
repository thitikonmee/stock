import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { catalog, type iam } from '@stockos/core';
import { tenantTx, type Db } from '@stockos/database';
import { ValidationError } from '@stockos/shared';
import { CurrentPrincipal, RequirePermission } from '../auth/decorators';
import { parse, parseIfMatch } from '../common/validation';
import { DB } from '../tokens';

const defined = <T extends object>(o: T) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

const optionsSchema = z
  .array(
    z.object({ name: z.string().trim().min(1).max(40), values: z.array(z.string().trim().min(1).max(40)) }),
  )
  .max(4)
  .optional();

const VariantCreate = z.strictObject({
  sku: z.string().trim().toUpperCase().max(40),
  name: z.string().trim().min(1).max(255).optional(),
  optionValues: z.record(z.string(), z.string()).optional(),
  costPrice: z.string().optional(),
  sellingPrice: z.string().optional(),
  weightGrams: z.number().int().min(0).nullable().optional(),
  reorderPoint: z.string().nullable().optional(),
  reorderQty: z.string().nullable().optional(),
  lowStockThreshold: z.string().nullable().optional(),
  barcodes: z.array(z.string().trim().max(64)).max(10).optional(),
});

const ProductCreate = z.strictObject({
  code: z.string().trim().toUpperCase().max(40),
  name: z.string().trim().min(1).max(255),
  description: z.string().trim().max(2000).nullable().optional(),
  brandId: z.string().nullable().optional(),
  categoryId: z.string().nullable().optional(),
  baseUnitId: z.string(),
  type: z.enum(['STANDARD', 'BUNDLE', 'SERVICE', 'NON_STOCK']).optional(),
  options: optionsSchema,
  taxClass: z.enum(['VAT7', 'VAT0', 'EXEMPT']).optional(),
  trackInventory: z.boolean().optional(),
  variants: z.array(VariantCreate).min(1).max(200),
});

const ProductUpdate = z.strictObject({
  name: z.string().trim().min(1).max(255).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  brandId: z.string().nullable().optional(),
  categoryId: z.string().nullable().optional(),
  status: z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']).optional(),
});

const UnitConversionInput = z.strictObject({
  unitId: z.string(),
  factorToBase: z.string(),
  isPurchaseUnit: z.boolean().optional(),
  isSalesUnit: z.boolean().optional(),
});

const ImageUpload = z.strictObject({
  fileName: z.string().trim().max(200).optional(),
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  dataBase64: z.string().min(1),
  variantId: z.string().nullable().optional(),
  altText: z.string().trim().max(200).nullable().optional(),
});

@Controller('products')
export class ProductsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(catalog.ProductService) private readonly products: catalog.ProductService,
    @Inject(catalog.ImageService) private readonly images: catalog.ImageService,
    @Inject(catalog.ImportExportService) private readonly importExport: catalog.ImportExportService,
  ) {}

  @RequirePermission('product.read')
  @Get()
  list(
    @CurrentPrincipal() p: iam.Principal,
    @Query('q') q?: string,
    @Query('categoryId') categoryId?: string,
    @Query('brandId') brandId?: string,
    @Query('status') status?: 'DRAFT' | 'ACTIVE' | 'ARCHIVED',
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return tenantTx(this.db, p.tenantId, (tx) =>
      this.products.list(tx, p, {
        ...(q ? { q } : {}),
        ...(categoryId ? { categoryId } : {}),
        ...(brandId ? { brandId } : {}),
        ...(status ? { status } : {}),
        ...(cursor ? { cursor } : {}),
        ...(limit ? { limit: Number(limit) } : {}),
      }),
    );
  }

  /** Fixed path registered before ':id' so it is never swallowed by the id route. */
  @RequirePermission('product.read')
  @Get('import/template')
  async importTemplate(@Res() reply: FastifyReply) {
    const buffer = await this.importExport.buildTemplate();
    void reply
      .header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('content-disposition', 'attachment; filename="product-import-template.xlsx"')
      .send(Buffer.from(buffer));
  }

  @RequirePermission('product.read')
  @Get('export')
  async export(@CurrentPrincipal() p: iam.Principal, @Res() reply: FastifyReply) {
    const buffer = await tenantTx(this.db, p.tenantId, (tx) => this.importExport.exportXlsx(tx, p));
    void reply
      .header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('content-disposition', 'attachment; filename="products.xlsx"')
      .send(Buffer.from(buffer));
  }

  @RequirePermission('product.create')
  @Post('import')
  async import(
    @CurrentPrincipal() p: iam.Principal,
    @Body() body: Buffer,
    @Headers('x-file-name') fileName: string | undefined,
  ) {
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return {
        id: null,
        status: 'FAILED',
        totalRows: 0,
        createdProducts: 0,
        createdVariants: 0,
        updatedVariants: 0,
        errors: [{ row: 0, message: 'Empty file' }],
      };
    }
    return tenantTx(this.db, p.tenantId, (tx) => this.importExport.importXlsx(tx, p, body, fileName), {
      statementTimeoutMs: 60_000,
    });
  }

  @RequirePermission('product.read')
  @Get(':id')
  async get(
    @CurrentPrincipal() p: iam.Principal,
    @Param('id') id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const product = await tenantTx(this.db, p.tenantId, (tx) => this.products.get(tx, p, id));
    void reply.header('etag', `"v${product.version}"`);
    return product;
  }

  @RequirePermission('product.create')
  @Post()
  async create(
    @CurrentPrincipal() p: iam.Principal,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const input = defined(parse(ProductCreate, body));
    const product = await tenantTx(this.db, p.tenantId, (tx) => this.products.create(tx, p, input));
    void reply.header('etag', `"v${product.version}"`);
    return product;
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
    const input = defined(parse(ProductUpdate, body));
    const product = await tenantTx(this.db, p.tenantId, (tx) =>
      this.products.update(tx, p, id, { ...input, expectedVersion }),
    );
    void reply.header('etag', `"v${product.version}"`);
    return product;
  }

  @RequirePermission('product.delete')
  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string) {
    await tenantTx(this.db, p.tenantId, (tx) => this.products.remove(tx, p, id));
  }

  @RequirePermission('product.update')
  @Post(':id/variants')
  createVariant(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string, @Body() body: unknown) {
    const input = defined(parse(VariantCreate, body));
    return tenantTx(this.db, p.tenantId, (tx) => this.products.addVariant(tx, p, id, input));
  }

  @RequirePermission('product.read')
  @Get(':id/units')
  listUnitConversions(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string) {
    return tenantTx(this.db, p.tenantId, (tx) => this.products.listUnitConversions(tx, p, id));
  }

  @RequirePermission('product.update')
  @Post(':id/units')
  setUnitConversion(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(UnitConversionInput, body);
    return tenantTx(this.db, p.tenantId, (tx) => this.products.setUnitConversion(tx, p, id, input));
  }

  @RequirePermission('product.read')
  @Get(':id/images')
  listImages(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string) {
    return tenantTx(this.db, p.tenantId, (tx) => this.images.list(tx, p, id));
  }

  @RequirePermission('product.update')
  @Post(':id/images')
  uploadImage(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(ImageUpload, body);
    if (!/^[A-Za-z0-9+/]+=*$/.test(input.dataBase64)) throw new ValidationError('Invalid base64 image data');
    const data = Buffer.from(input.dataBase64, 'base64');
    return tenantTx(this.db, p.tenantId, (tx) =>
      this.images.upload(tx, p, id, {
        data,
        contentType: input.contentType,
        variantId: input.variantId ?? null,
        altText: input.altText ?? null,
      }),
    );
  }
}
