import { Body, Controller, Get, Headers, Inject, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { purchasing, type iam } from '@stockos/core';
import { tenantTx, type Db } from '@stockos/database';
import { ValidationError } from '@stockos/shared';
import { CurrentPrincipal, RequirePermission } from '../auth/decorators';
import { parse, parseIfMatch } from '../common/validation';
import { DB } from '../tokens';

const defined = <T extends object>(o: T) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

const CreateBody = z.strictObject({
  supplierId: z.string(),
  warehouseId: z.string(),
  expectedAt: z.string().optional(),
  note: z.string().trim().max(1000).optional(),
  items: z
    .array(
      z.strictObject({
        variantId: z.string(),
        unitId: z.string().optional(),
        orderedQty: z.string(),
        unitCost: z.string(),
        discountAmount: z.string().optional(),
        taxRate: z.string().optional(),
      }),
    )
    .min(1)
    .max(500),
});
const RejectBody = z.strictObject({ note: z.string().trim().max(500).optional() });
const ReceiveBody = z.strictObject({
  supplierInvoiceNo: z.string().trim().max(60).optional(),
  lines: z
    .array(
      z.strictObject({
        purchaseItemId: z.string(),
        quantity: z.string(),
        lotNo: z.string().trim().max(60).optional(),
        expiryDate: z.string().optional(),
      }),
    )
    .min(1)
    .max(500),
});
const STATUSES = [
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'SENT',
  'PARTIALLY_RECEIVED',
  'RECEIVED',
  'CLOSED',
  'CANCELLED',
] as const;

@Controller('purchases')
export class PurchasesController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(purchasing.PurchaseService) private readonly purchases: purchasing.PurchaseService,
  ) {}

  @RequirePermission('purchase.read')
  @Get()
  list(
    @CurrentPrincipal() p: iam.Principal,
    @Query('status') status?: string,
    @Query('supplierId') supplierId?: string,
    @Query('warehouseId') warehouseId?: string,
  ) {
    if (status && !(STATUSES as readonly string[]).includes(status))
      throw new ValidationError('Unknown status');
    return tenantTx(this.db, p.tenantId, (tx) =>
      this.purchases.list(
        tx,
        p,
        defined({
          status: status as purchasing.PurchaseStatus | undefined,
          supplierId,
          warehouseId,
        }),
      ),
    );
  }

  @RequirePermission('purchase.create')
  @Post()
  create(@CurrentPrincipal() p: iam.Principal, @Body() body: unknown) {
    const input = parse(CreateBody, body);
    return tenantTx(this.db, p.tenantId, (tx) =>
      this.purchases.create(tx, p, { ...defined(input), items: input.items.map((i) => defined(i)) }),
    );
  }

  @RequirePermission('purchase.read')
  @Get(':id')
  get(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string) {
    return tenantTx(this.db, p.tenantId, (tx) => this.purchases.get(tx, p, id));
  }

  @RequirePermission('purchase.create')
  @Post(':id/submit')
  submit(
    @CurrentPrincipal() p: iam.Principal,
    @Param('id') id: string,
    @Headers('if-match') ifMatch?: string,
  ) {
    const version = parseIfMatch(ifMatch);
    return tenantTx(this.db, p.tenantId, (tx) => this.purchases.submit(tx, p, id, version));
  }

  @RequirePermission('purchase.approve')
  @Post(':id/approve')
  approve(
    @CurrentPrincipal() p: iam.Principal,
    @Param('id') id: string,
    @Headers('if-match') ifMatch?: string,
  ) {
    const version = parseIfMatch(ifMatch);
    return tenantTx(this.db, p.tenantId, (tx) => this.purchases.approve(tx, p, id, version));
  }

  @RequirePermission('purchase.approve')
  @Post(':id/reject')
  reject(
    @CurrentPrincipal() p: iam.Principal,
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('if-match') ifMatch?: string,
  ) {
    const version = parseIfMatch(ifMatch);
    const input = parse(RejectBody, body ?? {});
    return tenantTx(this.db, p.tenantId, (tx) => this.purchases.reject(tx, p, id, version, input.note));
  }

  @RequirePermission('purchase.create')
  @Post(':id/send')
  send(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string, @Headers('if-match') ifMatch?: string) {
    const version = parseIfMatch(ifMatch);
    return tenantTx(this.db, p.tenantId, (tx) => this.purchases.markSent(tx, p, id, version));
  }

  @RequirePermission('purchase.create')
  @Post(':id/cancel')
  cancel(
    @CurrentPrincipal() p: iam.Principal,
    @Param('id') id: string,
    @Headers('if-match') ifMatch?: string,
  ) {
    const version = parseIfMatch(ifMatch);
    return tenantTx(this.db, p.tenantId, (tx) => this.purchases.cancel(tx, p, id, version));
  }

  @RequirePermission('purchase.approve')
  @Post(':id/close')
  close(
    @CurrentPrincipal() p: iam.Principal,
    @Param('id') id: string,
    @Headers('if-match') ifMatch?: string,
  ) {
    const version = parseIfMatch(ifMatch);
    return tenantTx(this.db, p.tenantId, (tx) => this.purchases.close(tx, p, id, version));
  }

  @RequirePermission('purchase.receive')
  @Post(':id/receipts')
  receive(
    @CurrentPrincipal() p: iam.Principal,
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    if (!idempotencyKey) throw new ValidationError('Idempotency-Key header is required');
    const input = parse(ReceiveBody, body);
    return tenantTx(this.db, p.tenantId, (tx) =>
      this.purchases.receive(tx, p, id, {
        idempotencyKey,
        ...(input.supplierInvoiceNo ? { supplierInvoiceNo: input.supplierInvoiceNo } : {}),
        lines: input.lines.map((l) => defined(l)),
      }),
    );
  }
}

@Controller('suppliers')
export class SupplierPerformanceController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(purchasing.PurchaseService) private readonly purchases: purchasing.PurchaseService,
  ) {}

  @RequirePermission('purchase.read')
  @Get(':id/performance')
  performance(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string) {
    return tenantTx(this.db, p.tenantId, (tx) => this.purchases.supplierPerformance(tx, p, id));
  }
}
