import { Controller, Get, Inject, Param } from '@nestjs/common';
import { catalog, type iam } from '@stockos/core';
import { tenantTx, type Db } from '@stockos/database';
import { CurrentPrincipal, RequirePermission } from '../auth/decorators';
import { DB } from '../tokens';

@Controller('jobs')
export class JobsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(catalog.ImportExportService) private readonly importExport: catalog.ImportExportService,
  ) {}

  @RequirePermission('product.read')
  @Get(':id')
  get(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string) {
    return tenantTx(this.db, p.tenantId, (tx) => this.importExport.getJob(tx, p, id));
  }
}
