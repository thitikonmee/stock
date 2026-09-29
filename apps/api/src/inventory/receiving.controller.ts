import { Body, Controller, Get, Headers, Inject, Post, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { inventory, type iam } from '@stockos/core';
import { tenantTx, type Db } from '@stockos/database';
import { ValidationError } from '@stockos/shared';
import { CurrentPrincipal, RequirePermission } from '../auth/decorators';
import { parse } from '../common/validation';
import { DB } from '../tokens';

const ReceiveBody = z.strictObject({
  note: z.string().trim().max(500).optional(),
  lines: z
    .array(
      z.object({
        warehouseId: z.string(),
        variantId: z.string(),
        quantity: z.string(),
        unitCost: z.string().optional(),
      }),
    )
    .min(1)
    .max(500),
});

@Controller('inventory')
export class ReceivingController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(inventory.ReceivingService) private readonly receiving: inventory.ReceivingService,
  ) {}

  /** Ad-hoc goods receipt / opening balance for one or more SKUs, with optional unit cost
   *  (feeds the moving average cost). */
  @RequirePermission('inventory.receive')
  @Post('receive')
  receive(
    @CurrentPrincipal() p: iam.Principal,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    if (!idempotencyKey) throw new ValidationError('Idempotency-Key header is required');
    const input = parse(ReceiveBody, body);
    return tenantTx(this.db, p.tenantId, (tx) => this.receiving.receive(tx, p, { ...input, idempotencyKey }));
  }

  @RequirePermission('inventory.receive')
  @Get('opening-stock/template')
  async template(@Res() reply: FastifyReply) {
    const buffer = await this.receiving.buildTemplate();
    void reply
      .header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('content-disposition', 'attachment; filename="opening-stock-template.xlsx"')
      .send(Buffer.from(buffer));
  }

  @RequirePermission('inventory.receive')
  @Post('opening-stock/import')
  async importOpeningStock(@CurrentPrincipal() p: iam.Principal, @Body() body: Buffer) {
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return { totalRows: 0, applied: 0, errors: [{ row: 0, message: 'Empty file' }] };
    }
    return tenantTx(this.db, p.tenantId, (tx) => this.receiving.importOpeningStock(tx, p, body), {
      statementTimeoutMs: 60_000,
    });
  }
}
