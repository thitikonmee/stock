import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { pos, type iam } from '@stockos/core';
import { tenantTx, type Db } from '@stockos/database';
import { CurrentPrincipal, RequirePermission } from '../auth/decorators';
import { parse } from '../common/validation';
import { DB } from '../tokens';

const OpenBody = z.strictObject({ posDeviceId: z.string(), openingCash: z.string() });
const CloseBody = z.strictObject({ countedCash: z.string() });
const CashMovementBody = z.strictObject({
  type: z.enum(['PAY_IN', 'PAY_OUT', 'DROP', 'NO_SALE_OPEN']),
  amount: z.string(),
  reason: z.string().trim().max(200).optional(),
});

/** Shift open/close and cash drawer movements (docs/08-api-design.md `/pos/shifts*`). */
@Controller('pos')
export class ShiftsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(pos.ShiftService) private readonly shifts: pos.ShiftService,
  ) {}

  @RequirePermission('pos.shift.open')
  @Post('shifts')
  open(@CurrentPrincipal() p: iam.Principal, @Body() body: unknown) {
    const input = parse(OpenBody, body);
    return tenantTx(this.db, p.tenantId, (tx) => this.shifts.open(tx, p, input));
  }

  @RequirePermission('pos.shift.close')
  @Post('shifts/:id/close')
  @HttpCode(200)
  close(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(CloseBody, body);
    return tenantTx(this.db, p.tenantId, (tx) => this.shifts.close(tx, p, id, input));
  }

  @RequirePermission('pos.cash.in_out')
  @Post('shifts/:id/cash-movements')
  addCashMovement(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(CashMovementBody, body);
    return tenantTx(this.db, p.tenantId, (tx) => this.shifts.addCashMovement(tx, p, id, input));
  }

  @RequirePermission('pos.sell')
  @Get('shifts/current')
  current(@CurrentPrincipal() p: iam.Principal, @Query('posDeviceId') posDeviceId: string) {
    return tenantTx(this.db, p.tenantId, (tx) => this.shifts.current(tx, p, posDeviceId));
  }

  @RequirePermission('pos.sell')
  @Get('shifts/:id')
  get(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string) {
    return tenantTx(this.db, p.tenantId, (tx) => this.shifts.get(tx, p, id));
  }

  @RequirePermission('pos.sell')
  @Get('shifts')
  list(@CurrentPrincipal() p: iam.Principal, @Query('posDeviceId') posDeviceId?: string) {
    return tenantTx(this.db, p.tenantId, (tx) => this.shifts.list(tx, p, posDeviceId));
  }
}
