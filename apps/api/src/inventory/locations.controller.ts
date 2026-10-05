import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { inventory, type iam } from '@stockos/core';
import { tenantTx, type Db } from '@stockos/database';
import { NotFoundError } from '@stockos/shared';
import { CurrentPrincipal, RequirePermission } from '../auth/decorators';
import { parse } from '../common/validation';
import { DB } from '../tokens';

const CreateBody = z.strictObject({
  parentId: z.string().optional(),
  level: z.enum(['ZONE', 'RACK', 'SHELF', 'BIN']),
  code: z.string().trim().min(1).max(20),
  barcode: z.string().trim().max(64).optional(),
  isPickable: z.boolean().optional(),
});
const UpdateBody = z.strictObject({
  isActive: z.boolean().optional(),
  isPickable: z.boolean().optional(),
  barcode: z.string().trim().max(64).nullable().optional(),
});
const MoveBody = z.strictObject({
  lines: z
    .array(
      z.strictObject({
        variantId: z.string(),
        quantity: z.string(),
        fromLocationId: z.string().optional(),
        toLocationId: z.string().optional(),
      }),
    )
    .min(1)
    .max(500),
});

const defined = <T extends object>(o: T) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

@Controller('warehouses/:id/locations')
export class LocationsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(inventory.LocationService) private readonly locations: inventory.LocationService,
  ) {}

  @RequirePermission('inventory.read')
  @Get()
  list(@CurrentPrincipal() p: iam.Principal, @Param('id') warehouseId: string) {
    return tenantTx(this.db, p.tenantId, (tx) => this.locations.list(tx, p, warehouseId));
  }

  @RequirePermission('warehouse.manage')
  @Post()
  create(@CurrentPrincipal() p: iam.Principal, @Param('id') warehouseId: string, @Body() body: unknown) {
    const input = parse(CreateBody, body);
    return tenantTx(this.db, p.tenantId, (tx) =>
      this.locations.create(tx, p, { warehouseId, ...defined(input) }),
    );
  }

  @RequirePermission('warehouse.manage')
  @Patch(':locationId')
  update(
    @CurrentPrincipal() p: iam.Principal,
    @Param('id') warehouseId: string,
    @Param('locationId') locationId: string,
    @Body() body: unknown,
  ) {
    const input = parse(UpdateBody, body);
    return tenantTx(this.db, p.tenantId, async (tx) => {
      const loc = await this.locations.update(tx, p, locationId, defined(input));
      // Rolls the update back: the location must belong to the warehouse in the path.
      if (loc.warehouseId !== warehouseId) throw new NotFoundError('Location not found');
      return loc;
    });
  }

  @RequirePermission('inventory.read')
  @Get('stock')
  stock(
    @CurrentPrincipal() p: iam.Principal,
    @Param('id') warehouseId: string,
    @Query('locationId') locationId?: string,
    @Query('variantId') variantId?: string,
  ) {
    return tenantTx(this.db, p.tenantId, (tx) =>
      this.locations.stock(tx, p, warehouseId, defined({ locationId, variantId })),
    );
  }

  /** Putaway (to only), pick (from only) or bin-to-bin move (both). */
  @RequirePermission('inventory.transfer')
  @Post('moves')
  async move(@CurrentPrincipal() p: iam.Principal, @Param('id') warehouseId: string, @Body() body: unknown) {
    const input = parse(MoveBody, body);
    await tenantTx(this.db, p.tenantId, (tx) =>
      this.locations.move(
        tx,
        p,
        warehouseId,
        input.lines.map((l) => defined(l)),
      ),
    );
    return { moved: input.lines.length };
  }

  @RequirePermission('inventory.read')
  @Get('pick-suggestions')
  pick(
    @CurrentPrincipal() p: iam.Principal,
    @Param('id') warehouseId: string,
    @Query('variantId') variantId = '',
    @Query('quantity') quantity = '',
  ) {
    return tenantTx(this.db, p.tenantId, (tx) =>
      this.locations.pickSuggestions(tx, p, warehouseId, variantId, quantity),
    );
  }

  @RequirePermission('inventory.read')
  @Get('discrepancies')
  discrepancies(@CurrentPrincipal() p: iam.Principal, @Param('id') warehouseId: string) {
    return tenantTx(this.db, p.tenantId, (tx) => this.locations.discrepancies(tx, p, warehouseId));
  }
}
