import { Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { inventory, type iam } from '@stockos/core';
import { tenantTx, type Db } from '@stockos/database';
import { CurrentPrincipal, RequirePermission } from '../auth/decorators';
import { parse } from '../common/validation';
import { DB } from '../tokens';

const RunBody = z.strictObject({ warehouseId: z.string().optional(), variantId: z.string().optional() });

@Controller('inventory/reconciliation-runs')
export class ReconciliationController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(inventory.ReconciliationService) private readonly reconciliation: inventory.ReconciliationService,
  ) {}

  /** Compares stored balances against the ledger (source of truth) and reports any mismatch. */
  @RequirePermission('inventory.read')
  @Post()
  run(@CurrentPrincipal() p: iam.Principal, @Body() body: unknown) {
    const input = parse(RunBody, body);
    return tenantTx(this.db, p.tenantId, (tx) => this.reconciliation.run(tx, p, input), {
      statementTimeoutMs: 30_000,
    });
  }

  @RequirePermission('inventory.read')
  @Get(':id')
  get(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string) {
    return tenantTx(this.db, p.tenantId, (tx) => this.reconciliation.get(tx, p, id));
  }

  /** Overwrites every mismatched balance with the ledger-derived value (needs `inventory.adjust.approve`). */
  @RequirePermission('inventory.adjust.approve')
  @Post(':id/rebuild')
  rebuild(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string) {
    return tenantTx(this.db, p.tenantId, (tx) => this.reconciliation.rebuildFromRun(tx, p, id));
  }
}
