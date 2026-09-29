import { Controller, Get, Inject, Query } from '@nestjs/common';
import { inventory, type iam } from '@stockos/core';
import { tenantTx, type Db } from '@stockos/database';
import { CurrentPrincipal, RequirePermission } from '../auth/decorators';
import { DB } from '../tokens';

@Controller('inventory')
export class InventoryQueryController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(inventory.InventoryQueryService) private readonly queries: inventory.InventoryQueryService,
  ) {}

  @RequirePermission('inventory.read')
  @Get('balances')
  balances(
    @CurrentPrincipal() p: iam.Principal,
    @Query('variantId') variantId?: string,
    @Query('warehouseId') warehouseId?: string,
    @Query('lowStock') lowStock?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return tenantTx(this.db, p.tenantId, (tx) =>
      this.queries.listBalances(tx, p, {
        ...(variantId ? { variantId } : {}),
        ...(warehouseId ? { warehouseId } : {}),
        ...(lowStock === 'true' ? { lowStock: true } : {}),
        ...(cursor ? { cursor } : {}),
        ...(limit ? { limit: Number(limit) } : {}),
      }),
    );
  }

  /** Stock card: the ledger for one SKU (optionally at one warehouse). */
  @RequirePermission('inventory.read')
  @Get('transactions')
  transactions(
    @CurrentPrincipal() p: iam.Principal,
    @Query('variantId') variantId?: string,
    @Query('warehouseId') warehouseId?: string,
    @Query('type') type?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return tenantTx(this.db, p.tenantId, (tx) =>
      this.queries.listTransactions(tx, p, {
        ...(variantId ? { variantId } : {}),
        ...(warehouseId ? { warehouseId } : {}),
        ...(type ? { type } : {}),
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        ...(cursor ? { cursor } : {}),
        ...(limit ? { limit: Number(limit) } : {}),
      }),
    );
  }
}
