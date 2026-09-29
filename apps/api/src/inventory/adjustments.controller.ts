import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { inventory, type iam } from '@stockos/core';
import { tenantTx, type Db } from '@stockos/database';
import { CurrentPrincipal, RequirePermission } from '../auth/decorators';
import { parse } from '../common/validation';
import { DB } from '../tokens';

const reasonCode = z.enum(['DAMAGE', 'LOST', 'FOUND', 'COUNT_ERROR', 'EXPIRED', 'OPENING', 'OTHER']);
const CreateBody = z.strictObject({
  warehouseId: z.string(),
  reasonCode,
  note: z.string().trim().max(500).optional(),
  items: z
    .array(
      z.object({
        variantId: z.string(),
        bucket: z.enum(['ON_HAND', 'DAMAGED']).optional(),
        quantityDelta: z.string(),
        unitCost: z.string().optional(),
        note: z.string().trim().max(200).optional(),
      }),
    )
    .min(1)
    .max(500),
});
const RejectBody = z.strictObject({ note: z.string().trim().max(500).optional() });

const defined = <T extends object>(o: T) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

@Controller('inventory/adjustments')
export class AdjustmentsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(inventory.AdjustmentService) private readonly adjustments: inventory.AdjustmentService,
  ) {}

  @RequirePermission('inventory.read')
  @Get()
  list(
    @CurrentPrincipal() p: iam.Principal,
    @Query('status') status?: inventory.AdjustmentStatus,
    @Query('warehouseId') warehouseId?: string,
  ) {
    return tenantTx(this.db, p.tenantId, (tx) =>
      this.adjustments.list(tx, p, {
        ...(status ? { status } : {}),
        ...(warehouseId ? { warehouseId } : {}),
      }),
    );
  }

  @RequirePermission('inventory.adjust')
  @Post()
  create(@CurrentPrincipal() p: iam.Principal, @Body() body: unknown) {
    const input = parse(CreateBody, body);
    return tenantTx(this.db, p.tenantId, (tx) =>
      this.adjustments.create(tx, p, {
        ...input,
        items: input.items.map((i) => defined(i)),
      }),
    );
  }

  @RequirePermission('inventory.read')
  @Get(':id')
  get(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string) {
    return tenantTx(this.db, p.tenantId, (tx) => this.adjustments.get(tx, p, id));
  }

  @RequirePermission('inventory.adjust.approve')
  @Post(':id/approve')
  approve(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string) {
    return tenantTx(this.db, p.tenantId, (tx) => this.adjustments.approve(tx, p, id));
  }

  @RequirePermission('inventory.adjust.approve')
  @Post(':id/reject')
  reject(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(RejectBody, body);
    return tenantTx(this.db, p.tenantId, (tx) => this.adjustments.reject(tx, p, id, input.note));
  }
}
