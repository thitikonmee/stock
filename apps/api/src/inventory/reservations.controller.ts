import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { inventory, type iam } from '@stockos/core';
import { tenantTx, type Db } from '@stockos/database';
import { ValidationError } from '@stockos/shared';
import { CurrentPrincipal, RequirePermission } from '../auth/decorators';
import { parse } from '../common/validation';
import { DB } from '../tokens';

const ReserveBody = z.strictObject({
  referenceType: z.string().trim().min(1).max(40),
  referenceId: z.string(),
  items: z
    .array(z.object({ warehouseId: z.string(), variantId: z.string(), quantity: z.string() }))
    .min(1)
    .max(500),
  ttlSeconds: z.number().int().min(1).max(86_400).optional(),
});
const ReleaseBody = z.strictObject({ quantity: z.string().optional() });

@Controller('inventory')
export class ReservationsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(inventory.ReservationService) private readonly reservations: inventory.ReservationService,
  ) {}

  @RequirePermission('inventory.read')
  @Post('reserve')
  reserve(
    @CurrentPrincipal() p: iam.Principal,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    if (!idempotencyKey) throw new ValidationError('Idempotency-Key header is required');
    const input = parse(ReserveBody, body);
    return tenantTx(this.db, p.tenantId, (tx) =>
      this.reservations.reserve(tx, p, { ...input, idempotencyKey }),
    );
  }

  @RequirePermission('inventory.read')
  @Get('reservations')
  list(
    @CurrentPrincipal() p: iam.Principal,
    @Query('referenceType') referenceType?: string,
    @Query('referenceId') referenceId?: string,
    @Query('status') status?: inventory.ReservationStatus,
  ) {
    return tenantTx(this.db, p.tenantId, (tx) =>
      this.reservations.list(tx, p, {
        ...(referenceType ? { referenceType } : {}),
        ...(referenceId ? { referenceId } : {}),
        ...(status ? { status } : {}),
      }),
    );
  }

  @RequirePermission('inventory.read')
  @Get('reservations/:id')
  get(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string) {
    return tenantTx(this.db, p.tenantId, (tx) => this.reservations.get(tx, p, id));
  }

  @RequirePermission('inventory.read')
  @Post('reservations/:id/release')
  release(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(ReleaseBody, body);
    return tenantTx(this.db, p.tenantId, (tx) => this.reservations.release(tx, p, id, input.quantity));
  }

  @RequirePermission('inventory.read')
  @Post('reservations/:id/commit')
  commit(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string) {
    return tenantTx(this.db, p.tenantId, (tx) => this.reservations.commit(tx, p, id));
  }

  /** No scheduler process exists yet (Phase 3 scope) — an operator (or, later, a cron) calls this
   *  to release everything past its TTL. */
  @RequirePermission('inventory.read')
  @Post('reservations/sweep')
  @HttpCode(200)
  async sweep(@CurrentPrincipal() p: iam.Principal) {
    const released = await tenantTx(this.db, p.tenantId, (tx) =>
      this.reservations.releaseExpired(tx, p.tenantId),
    );
    return { released };
  }
}
