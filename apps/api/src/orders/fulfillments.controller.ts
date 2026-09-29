import { Body, Controller, Get, Headers, Inject, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { orders, type iam } from '@stockos/core';
import { tenantTx, type Db } from '@stockos/database';
import { NotFoundError, ValidationError } from '@stockos/shared';
import { CurrentPrincipal, RequirePermission } from '../auth/decorators';
import { parse } from '../common/validation';
import { DB } from '../tokens';

const FulfillmentLineBody = z.object({ orderItemId: z.string(), quantity: z.string() });
const CreateFulfillmentBody = z.strictObject({
  warehouseId: z.string().optional(),
  lines: z.array(FulfillmentLineBody).min(1).max(500),
});
const ShipBody = z.strictObject({
  carrier: z.string().trim().max(60).optional(),
  trackingNo: z.string().trim().max(120).optional(),
});
const ReceiveReturnLineBody = z.object({
  orderItemId: z.string(),
  condition: z.enum(['SELLABLE', 'DAMAGED', 'MISSING']),
});
const ReceiveReturnBody = z.strictObject({ lines: z.array(ReceiveReturnLineBody).min(1).max(500) });

/** Pick/pack/ship (docs/08-api-design.md `/orders/:id/fulfillments`, `/fulfillments/:id/*`). */
@Controller()
export class FulfillmentsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(orders.FulfillmentService) private readonly fulfillments: orders.FulfillmentService,
  ) {}

  @RequirePermission('order.fulfill')
  @Post('orders/:orderId/fulfillments')
  create(
    @CurrentPrincipal() p: iam.Principal,
    @Param('orderId') orderId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    if (!idempotencyKey) throw new ValidationError('Idempotency-Key header is required');
    const input = parse(CreateFulfillmentBody, body);
    return tenantTx(this.db, p.tenantId, (tx) =>
      this.fulfillments.create(tx, p, orderId, { ...input, idempotencyKey }),
    );
  }

  @RequirePermission('order.read')
  @Get('orders/:orderId/fulfillments')
  list(@CurrentPrincipal() p: iam.Principal, @Param('orderId') orderId: string) {
    return tenantTx(this.db, p.tenantId, (tx) => this.fulfillments.list(tx, p, orderId));
  }

  @RequirePermission('order.fulfill')
  @Post('fulfillments/:id/pack')
  pack(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string) {
    return tenantTx(this.db, p.tenantId, (tx) => this.fulfillments.pack(tx, p, id));
  }

  @RequirePermission('order.fulfill')
  @Post('fulfillments/:id/ship')
  ship(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(ShipBody, body);
    return tenantTx(this.db, p.tenantId, (tx) => this.fulfillments.ship(tx, p, id, input));
  }
}

/** Return QC receiving (`/returns/:id/receive`). */
@Controller('returns')
export class ReturnsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(orders.ReturnService) private readonly returns: orders.ReturnService,
  ) {}

  @RequirePermission('order.update')
  @Get(':id')
  async get(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string) {
    const ret = await tenantTx(this.db, p.tenantId, (tx) => this.returns.get(tx, p, id));
    if (!ret) throw new NotFoundError('Return not found');
    return ret;
  }

  @RequirePermission('order.update')
  @Post(':id/receive')
  receive(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(ReceiveReturnBody, body);
    return tenantTx(this.db, p.tenantId, (tx) => this.returns.receive(tx, p, id, input));
  }
}
