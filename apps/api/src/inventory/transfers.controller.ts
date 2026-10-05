import { Body, Controller, Get, Headers, Inject, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { inventory, type iam } from '@stockos/core';
import { tenantTx, type Db } from '@stockos/database';
import { ValidationError } from '@stockos/shared';
import { CurrentPrincipal, RequirePermission } from '../auth/decorators';
import { parse, parseIfMatch } from '../common/validation';
import { DB } from '../tokens';

const CreateBody = z.strictObject({
  fromWarehouseId: z.string(),
  toWarehouseId: z.string(),
  note: z.string().trim().max(500).optional(),
  items: z
    .array(z.strictObject({ variantId: z.string(), quantity: z.string() }))
    .min(1)
    .max(500),
});
const QtyLines = z.strictObject({
  lines: z
    .array(z.strictObject({ itemId: z.string(), quantity: z.string() }))
    .max(500)
    .optional(),
});
const ReceiveBody = z.strictObject({
  lines: z
    .array(z.strictObject({ itemId: z.string(), receivedQty: z.string(), damagedQty: z.string().optional() }))
    .min(1)
    .max(500),
});
const STATUSES = [
  'DRAFT',
  'REQUESTED',
  'APPROVED',
  'PICKING',
  'SHIPPED',
  'PARTIALLY_RECEIVED',
  'RECEIVED',
  'COMPLETED',
  'CANCELLED',
] as const;

@Controller('inventory/transfers')
export class TransfersController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(inventory.TransferService) private readonly transfers: inventory.TransferService,
  ) {}

  @RequirePermission('inventory.read')
  @Get()
  list(
    @CurrentPrincipal() p: iam.Principal,
    @Query('status') status?: string,
    @Query('warehouseId') warehouseId?: string,
  ) {
    if (status && !(STATUSES as readonly string[]).includes(status))
      throw new ValidationError('Unknown status');
    return tenantTx(this.db, p.tenantId, (tx) =>
      this.transfers.list(tx, p, {
        ...(status ? { status: status as inventory.TransferStatus } : {}),
        ...(warehouseId ? { warehouseId } : {}),
      }),
    );
  }

  @RequirePermission('inventory.transfer')
  @Post()
  create(@CurrentPrincipal() p: iam.Principal, @Body() body: unknown) {
    const input = parse(CreateBody, body);
    return tenantTx(this.db, p.tenantId, (tx) =>
      this.transfers.create(tx, p, {
        fromWarehouseId: input.fromWarehouseId,
        toWarehouseId: input.toWarehouseId,
        items: input.items,
        ...(input.note ? { note: input.note } : {}),
      }),
    );
  }

  @RequirePermission('inventory.read')
  @Get(':id')
  get(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string) {
    return tenantTx(this.db, p.tenantId, (tx) => this.transfers.get(tx, p, id));
  }

  @RequirePermission('inventory.transfer.approve')
  @Post(':id/approve')
  approve(
    @CurrentPrincipal() p: iam.Principal,
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('if-match') ifMatch?: string,
  ) {
    const version = parseIfMatch(ifMatch);
    const input = parse(QtyLines, body ?? {});
    return tenantTx(this.db, p.tenantId, (tx) =>
      this.transfers.approve(tx, p, id, version, input.lines ?? []),
    );
  }

  @RequirePermission('inventory.transfer')
  @Post(':id/ship')
  ship(
    @CurrentPrincipal() p: iam.Principal,
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('if-match') ifMatch?: string,
  ) {
    const version = parseIfMatch(ifMatch);
    const input = parse(QtyLines, body ?? {});
    return tenantTx(this.db, p.tenantId, (tx) => this.transfers.ship(tx, p, id, version, input.lines ?? []));
  }

  @RequirePermission('inventory.transfer')
  @Post(':id/receive')
  receive(
    @CurrentPrincipal() p: iam.Principal,
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    if (!idempotencyKey) throw new ValidationError('Idempotency-Key header is required');
    const input = parse(ReceiveBody, body);
    return tenantTx(this.db, p.tenantId, (tx) =>
      this.transfers.receive(
        tx,
        p,
        id,
        idempotencyKey,
        input.lines.map((l) => ({
          itemId: l.itemId,
          receivedQty: l.receivedQty,
          ...(l.damagedQty ? { damagedQty: l.damagedQty } : {}),
        })),
      ),
    );
  }

  @RequirePermission('inventory.transfer.approve')
  @Post(':id/complete')
  complete(
    @CurrentPrincipal() p: iam.Principal,
    @Param('id') id: string,
    @Headers('if-match') ifMatch?: string,
  ) {
    const version = parseIfMatch(ifMatch);
    return tenantTx(this.db, p.tenantId, (tx) => this.transfers.complete(tx, p, id, version));
  }

  @RequirePermission('inventory.transfer')
  @Post(':id/cancel')
  cancel(
    @CurrentPrincipal() p: iam.Principal,
    @Param('id') id: string,
    @Headers('if-match') ifMatch?: string,
  ) {
    const version = parseIfMatch(ifMatch);
    return tenantTx(this.db, p.tenantId, (tx) => this.transfers.cancel(tx, p, id, version));
  }
}
