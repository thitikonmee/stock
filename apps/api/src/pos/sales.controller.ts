import { Body, Controller, Get, Headers, Inject, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { pos, type iam } from '@stockos/core';
import { tenantTx, type Db } from '@stockos/database';
import { ValidationError } from '@stockos/shared';
import { CurrentPrincipal, RequirePermission } from '../auth/decorators';
import { parse } from '../common/validation';
import { DB } from '../tokens';

const ManagerOverride = z.object({ employeeCode: z.string().trim().min(1).max(40), pin: z.string() });

const SaleLineBody = z.object({
  variantId: z.string(),
  quantity: z.string(),
  discountAmount: z.string().optional(),
});
const PaymentBody = z.object({
  method: z.enum([
    'CASH',
    'CREDIT_CARD',
    'DEBIT_CARD',
    'PROMPTPAY',
    'QR',
    'BANK_TRANSFER',
    'STORE_CREDIT',
    'VOUCHER',
  ]),
  amount: z.string(),
  tenderedAmount: z.string().optional(),
  providerRef: z.string().trim().max(100).optional(),
});
const SellBody = z.strictObject({
  posDeviceId: z.string(),
  shiftId: z.string(),
  clientTxnId: z.string().uuid(),
  lines: z.array(SaleLineBody).min(1).max(500),
  cartDiscountAmount: z.string().optional(),
  payments: z.array(PaymentBody).min(1).max(10),
  customerId: z.string().optional(),
  note: z.string().trim().max(500).optional(),
  discountOverride: ManagerOverride.optional(),
  stockOverride: ManagerOverride.optional(),
});

const RefundLineBody = z.object({
  orderItemId: z.string(),
  quantity: z.string(),
  restockCondition: z.enum(['SELLABLE', 'DAMAGED']).optional(),
});
const RefundBody = z.strictObject({
  shiftId: z.string(),
  lines: z.array(RefundLineBody).min(1).max(500),
  reason: z.string().trim().min(1).max(300),
  method: z
    .enum([
      'CASH',
      'CREDIT_CARD',
      'DEBIT_CARD',
      'PROMPTPAY',
      'QR',
      'BANK_TRANSFER',
      'STORE_CREDIT',
      'VOUCHER',
    ])
    .optional(),
  managerOverride: ManagerOverride.optional(),
});

/** Sales and refunds at the register (docs/08-api-design.md `/pos/sales*`). */
@Controller('pos')
export class SalesController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(pos.SaleService) private readonly sales: pos.SaleService,
    @Inject(pos.RefundService) private readonly refunds: pos.RefundService,
  ) {}

  @RequirePermission('pos.sell')
  @Post('sales')
  sell(@CurrentPrincipal() p: iam.Principal, @Body() body: unknown) {
    const input = parse(SellBody, body);
    return tenantTx(this.db, p.tenantId, (tx) => this.sales.sell(tx, p, input));
  }

  @RequirePermission('pos.sell')
  @Get('sales/:id')
  get(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string) {
    return tenantTx(this.db, p.tenantId, (tx) => this.sales.get(tx, p, id));
  }

  @RequirePermission('pos.sell')
  @Get('sales')
  list(@CurrentPrincipal() p: iam.Principal, @Query('posDeviceId') posDeviceId?: string) {
    return tenantTx(this.db, p.tenantId, (tx) => this.sales.list(tx, p, posDeviceId));
  }

  @RequirePermission('pos.sell')
  @Post('sales/:id/refunds')
  refund(
    @CurrentPrincipal() p: iam.Principal,
    @Param('id') orderId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    if (!idempotencyKey) throw new ValidationError('Idempotency-Key header is required');
    const input = parse(RefundBody, body);
    return tenantTx(this.db, p.tenantId, (tx) =>
      this.refunds.refund(tx, p, { ...input, orderId, idempotencyKey }),
    );
  }
}
