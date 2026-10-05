import { Body, Controller, Get, Headers, Inject, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { inventory, type iam } from '@stockos/core';
import { tenantTx, type Db } from '@stockos/database';
import { ValidationError } from '@stockos/shared';
import { CurrentPrincipal, RequirePermission } from '../auth/decorators';
import { parse, parseIfMatch } from '../common/validation';
import { DB } from '../tokens';

const CreateBody = z.strictObject({
  warehouseId: z.string(),
  countType: z.enum(['FULL', 'CYCLE', 'BLIND', 'SPOT']),
  variantIds: z.array(z.string()).max(5000).optional(),
  categoryIds: z.array(z.string()).max(200).optional(),
  varianceTolerance: z.string().optional(),
});
const RecordBody = z.strictObject({
  mode: z.enum(['SET', 'ADD']).default('SET'),
  lines: z
    .array(z.strictObject({ variantId: z.string(), quantity: z.string(), countedAt: z.string().optional() }))
    .min(1)
    .max(1000),
});
const STATUSES = [
  'DRAFT',
  'IN_PROGRESS',
  'SUBMITTED',
  'PENDING_APPROVAL',
  'APPROVED',
  'POSTED',
  'CANCELLED',
] as const;

@Controller('inventory/counts')
export class CountsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(inventory.CountService) private readonly counts: inventory.CountService,
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
      this.counts.list(tx, p, {
        ...(status ? { status: status as inventory.CountStatus } : {}),
        ...(warehouseId ? { warehouseId } : {}),
      }),
    );
  }

  @RequirePermission('inventory.count')
  @Post()
  create(@CurrentPrincipal() p: iam.Principal, @Body() body: unknown) {
    const input = parse(CreateBody, body);
    return tenantTx(
      this.db,
      p.tenantId,
      (tx) =>
        this.counts.create(tx, p, {
          warehouseId: input.warehouseId,
          countType: input.countType,
          ...(input.variantIds ? { variantIds: input.variantIds } : {}),
          ...(input.categoryIds ? { categoryIds: input.categoryIds } : {}),
          ...(input.varianceTolerance ? { varianceTolerance: input.varianceTolerance } : {}),
        }),
      { statementTimeoutMs: 30_000 },
    );
  }

  @RequirePermission('inventory.read')
  @Get(':id')
  get(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string) {
    return tenantTx(this.db, p.tenantId, (tx) => this.counts.get(tx, p, id));
  }

  /** Counted quantities from one device (mobile scanner or offline sync). */
  @RequirePermission('inventory.count')
  @Post(':id/lines')
  record(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(RecordBody, body);
    return tenantTx(this.db, p.tenantId, (tx) =>
      this.counts.record(
        tx,
        p,
        id,
        input.mode,
        input.lines.map((l) => ({
          variantId: l.variantId,
          quantity: l.quantity,
          ...(l.countedAt ? { countedAt: l.countedAt } : {}),
        })),
      ),
    );
  }

  @RequirePermission('inventory.count')
  @Post(':id/submit')
  submit(
    @CurrentPrincipal() p: iam.Principal,
    @Param('id') id: string,
    @Headers('if-match') ifMatch?: string,
  ) {
    const version = parseIfMatch(ifMatch);
    return tenantTx(this.db, p.tenantId, (tx) => this.counts.submit(tx, p, id, version), {
      statementTimeoutMs: 30_000,
    });
  }

  @RequirePermission('inventory.count.approve')
  @Post(':id/recount')
  recount(
    @CurrentPrincipal() p: iam.Principal,
    @Param('id') id: string,
    @Headers('if-match') ifMatch?: string,
  ) {
    const version = parseIfMatch(ifMatch);
    return tenantTx(this.db, p.tenantId, (tx) => this.counts.requestRecount(tx, p, id, version));
  }

  @RequirePermission('inventory.count.approve')
  @Post(':id/approve')
  approve(
    @CurrentPrincipal() p: iam.Principal,
    @Param('id') id: string,
    @Headers('if-match') ifMatch?: string,
  ) {
    const version = parseIfMatch(ifMatch);
    return tenantTx(this.db, p.tenantId, (tx) => this.counts.approve(tx, p, id, version), {
      statementTimeoutMs: 30_000,
    });
  }

  @RequirePermission('inventory.count')
  @Post(':id/cancel')
  cancel(
    @CurrentPrincipal() p: iam.Principal,
    @Param('id') id: string,
    @Headers('if-match') ifMatch?: string,
  ) {
    const version = parseIfMatch(ifMatch);
    return tenantTx(this.db, p.tenantId, (tx) => this.counts.cancel(tx, p, id, version));
  }
}
