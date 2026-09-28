import { Controller, Delete, Get, HttpCode, Inject, Param, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { catalog, type iam } from '@stockos/core';
import { tenantTx, type Db } from '@stockos/database';
import { CurrentPrincipal, RequirePermission } from '../auth/decorators';
import { DB } from '../tokens';

@Controller('images')
export class ImagesController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(catalog.ImageService) private readonly images: catalog.ImageService,
  ) {}

  @RequirePermission('product.read')
  @Get(':id')
  async get(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string, @Res() reply: FastifyReply) {
    const { data, contentType } = await tenantTx(this.db, p.tenantId, (tx) => this.images.read(tx, p, id));
    void reply
      .header('content-type', contentType)
      .header('cache-control', 'private, max-age=86400')
      .send(data);
  }

  @RequirePermission('product.update')
  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string) {
    await tenantTx(this.db, p.tenantId, (tx) => this.images.remove(tx, p, id));
  }
}
