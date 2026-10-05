import { Body, Controller, Get, Inject, Param, Put } from '@nestjs/common';
import { z } from 'zod';
import { channels, type iam } from '@stockos/core';
import { tenantTx, type Db } from '@stockos/database';
import { CurrentPrincipal, RequirePermission } from '../auth/decorators';
import { parse } from '../common/validation';
import { DB } from '../tokens';

const SetBody = z.strictObject({
  lines: z
    .array(
      z.strictObject({ variantId: z.string(), warehouseId: z.string().optional(), allocatedQty: z.string() }),
    )
    .min(1)
    .max(500),
});

/** CHANNEL_ALLOCATION quota editor for one connected shop (docs/04-inventory.md §8). */
@Controller('channel-accounts/:id/allocations')
export class ChannelAllocationsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(channels.AllocationService) private readonly allocations: channels.AllocationService,
  ) {}

  @RequirePermission('channel.read')
  @Get()
  list(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string) {
    return tenantTx(this.db, p.tenantId, (tx) => this.allocations.list(tx, p, id));
  }

  @RequirePermission('channel.manage')
  @Put()
  set(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(SetBody, body);
    return tenantTx(this.db, p.tenantId, (tx) =>
      this.allocations.set(
        tx,
        p,
        id,
        input.lines.map((l) => ({
          variantId: l.variantId,
          allocatedQty: l.allocatedQty,
          ...(l.warehouseId ? { warehouseId: l.warehouseId } : {}),
        })),
      ),
    );
  }
}
