import { Body, Controller, Get, Headers, Inject, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { orders, type iam } from '@stockos/core';
import { tenantTx, type Db } from '@stockos/database';
import { ValidationError } from '@stockos/shared';
import { CurrentPrincipal, RequirePermission } from '../auth/decorators';
import { parse } from '../common/validation';
import { DB } from '../tokens';

const OrderLineBody = z.object({
  variantId: z.string(),
  quantity: z.string(),
  discountAmount: z.string().optional(),
});
const CreateOrderBody = z.strictObject({
  channelCode: z.enum(['API', 'WEBSITE']),
  warehouseId: z.string().optional(),
  customerId: z.string().optional(),
  lines: z.array(OrderLineBody).min(1).max(500),
  paid: z.boolean().optional(),
  note: z.string().trim().max(500).optional(),
});
const HoldBody = z.strictObject({ reason: z.string().trim().min(1).max(200) });
const CancelBody = z.strictObject({ reason: z.string().trim().max(200).optional() });

const ReturnLineBody = z.object({ orderItemId: z.string(), quantity: z.string() });
const RequestReturnBody = z.strictObject({
  lines: z.array(ReturnLineBody).min(1).max(500),
  reason: z.string().trim().max(300).optional(),
  receiveWarehouseId: z.string().optional(),
});

const RefundLineBody = z.object({ orderItemId: z.string(), quantity: z.string() });
const RefundBody = z.strictObject({
  lines: z.array(RefundLineBody).min(1).max(500),
  reason: z.string().trim().min(1).max(300),
  returnId: z.string().optional(),
});

/** Manual/API/website orders (docs/08-api-design.md Orders). */
@Controller('orders')
export class OrdersController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(orders.OrderService) private readonly ordersService: orders.OrderService,
    @Inject(orders.ReturnService) private readonly returns: orders.ReturnService,
    @Inject(orders.RefundService) private readonly refunds: orders.RefundService,
  ) {}

  @RequirePermission('order.create')
  @Post()
  create(
    @CurrentPrincipal() p: iam.Principal,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    if (!idempotencyKey) throw new ValidationError('Idempotency-Key header is required');
    const input = parse(CreateOrderBody, body);
    return tenantTx(this.db, p.tenantId, (tx) =>
      this.ordersService.create(tx, p, { ...input, idempotencyKey }),
    );
  }

  @RequirePermission('order.read')
  @Get()
  list(
    @CurrentPrincipal() p: iam.Principal,
    @Query('status') status?: orders.OrderStatus,
    @Query('channelCode') channelCode?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return tenantTx(this.db, p.tenantId, (tx) =>
      this.ordersService.list(tx, p, {
        ...(status ? { status } : {}),
        ...(channelCode ? { channelCode } : {}),
        ...(cursor ? { cursor } : {}),
        ...(limit ? { limit: Number(limit) } : {}),
      }),
    );
  }

  @RequirePermission('order.read')
  @Get(':id')
  get(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string) {
    return tenantTx(this.db, p.tenantId, (tx) => this.ordersService.get(tx, p, id));
  }

  @RequirePermission('order.update')
  @Post(':id/pay')
  markPaid(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string) {
    return tenantTx(this.db, p.tenantId, (tx) => this.ordersService.markPaid(tx, p, id));
  }

  @RequirePermission('order.update')
  @Post(':id/confirm')
  confirm(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string) {
    return tenantTx(this.db, p.tenantId, (tx) => this.ordersService.confirm(tx, p, id));
  }

  @RequirePermission('order.cancel')
  @Post(':id/cancel')
  cancel(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(CancelBody, body);
    return tenantTx(this.db, p.tenantId, (tx) => this.ordersService.cancel(tx, p, id, input.reason));
  }

  @RequirePermission('order.update')
  @Post(':id/hold')
  hold(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(HoldBody, body);
    return tenantTx(this.db, p.tenantId, (tx) => this.ordersService.hold(tx, p, id, input.reason));
  }

  @RequirePermission('order.update')
  @Post(':id/release-hold')
  releaseHold(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string) {
    return tenantTx(this.db, p.tenantId, (tx) => this.ordersService.releaseHold(tx, p, id));
  }

  @RequirePermission('order.read')
  @Get(':id/returns')
  listReturns(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string) {
    return tenantTx(this.db, p.tenantId, (tx) => this.returns.listForOrder(tx, p, id));
  }

  @RequirePermission('order.update')
  @Post(':id/returns')
  requestReturn(
    @CurrentPrincipal() p: iam.Principal,
    @Param('id') id: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    if (!idempotencyKey) throw new ValidationError('Idempotency-Key header is required');
    const input = parse(RequestReturnBody, body);
    return tenantTx(this.db, p.tenantId, (tx) =>
      this.returns.request(tx, p, id, { ...input, idempotencyKey }),
    );
  }

  @RequirePermission('order.refund')
  @Post(':id/refunds')
  refund(
    @CurrentPrincipal() p: iam.Principal,
    @Param('id') id: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    if (!idempotencyKey) throw new ValidationError('Idempotency-Key header is required');
    const input = parse(RefundBody, body);
    return tenantTx(this.db, p.tenantId, (tx) =>
      this.refunds.refund(tx, p, id, { ...input, idempotencyKey }),
    );
  }
}
