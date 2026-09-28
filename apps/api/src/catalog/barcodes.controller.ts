import { Body, Controller, Inject, Post, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { catalog, type iam } from '@stockos/core';
import { tenantTx, type Db } from '@stockos/database';
import { NotFoundError } from '@stockos/shared';
import { CurrentPrincipal, RequirePermission } from '../auth/decorators';
import { parse } from '../common/validation';
import { DB } from '../tokens';

const Generate = z.strictObject({
  variantId: z.string(),
  symbology: z.enum(['EAN13', 'CODE128']).default('EAN13'),
  prefix: z.string().length(2).optional(),
  isPrimary: z.boolean().optional(),
});

const Labels = z.strictObject({
  items: z
    .array(z.object({ variantId: z.string(), quantity: z.number().int().min(1).max(200) }))
    .min(1)
    .max(100),
});

@Controller('barcodes')
export class BarcodesController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(catalog.ProductService) private readonly products: catalog.ProductService,
  ) {}

  @RequirePermission('product.update')
  @Post('generate')
  generate(@CurrentPrincipal() p: iam.Principal, @Body() body: unknown) {
    const input = parse(Generate, body);
    return tenantTx(this.db, p.tenantId, (tx) => this.products.generateBarcode(tx, p, input));
  }

  /** Prints a barcode label sheet for the given SKUs (each must already have a barcode). */
  @RequirePermission('product.read')
  @Post('labels')
  async labels(@CurrentPrincipal() p: iam.Principal, @Body() body: unknown, @Res() reply: FastifyReply) {
    const input = parse(Labels, body);
    const pdf = await tenantTx(this.db, p.tenantId, async (tx) => {
      const items: catalog.LabelItem[] = [];
      for (const line of input.items) {
        const variant = await this.products.getVariant(tx, p, line.variantId);
        const barcode = variant.barcodes[0];
        if (!barcode) throw new NotFoundError(`Variant ${variant.sku} has no barcode yet`);
        items.push({
          barcode,
          symbology: /^\d{13}$/.test(barcode) ? 'EAN13' : 'CODE128',
          sku: variant.sku,
          name: variant.name,
          price: variant.sellingPrice,
          quantity: line.quantity,
        });
      }
      return catalog.renderLabelSheet(items);
    });
    void reply
      .code(200) // Nest defaults POST to 201; this generates a document, it does not create one
      .header('content-type', 'application/pdf')
      .header('content-disposition', 'attachment; filename="labels.pdf"')
      .send(Buffer.from(pdf));
  }
}
