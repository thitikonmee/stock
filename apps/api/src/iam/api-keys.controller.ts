import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { auth, type iam } from '@stockos/core';
import { tenantTx, type Db } from '@stockos/database';
import { CurrentPrincipal, RequirePermission } from '../auth/decorators';
import { parse } from '../common/validation';
import { DB } from '../tokens';

const CreateBody = z.strictObject({
  name: z.string().trim().min(1).max(80),
  permissions: z.array(z.string().max(60)).min(1).max(60),
  expiresInDays: z.number().int().optional(),
  ipAllowlist: z.array(z.string().max(50)).max(20).optional(),
});

@Controller('api-keys')
export class ApiKeysController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(auth.ApiKeyService) private readonly keys: auth.ApiKeyService,
  ) {}

  @RequirePermission('api_key.manage')
  @Get()
  list(@CurrentPrincipal() p: iam.Principal) {
    return tenantTx(this.db, p.tenantId, (tx) => this.keys.list(tx, p));
  }

  /** The secret is returned once in this response and never again. */
  @RequirePermission('api_key.manage')
  @Post()
  create(@CurrentPrincipal() p: iam.Principal, @Body() body: unknown) {
    const input = parse(CreateBody, body);
    return tenantTx(this.db, p.tenantId, (tx) =>
      this.keys.create(tx, p, {
        name: input.name,
        permissions: input.permissions,
        ...(input.expiresInDays !== undefined ? { expiresInDays: input.expiresInDays } : {}),
        ...(input.ipAllowlist ? { ipAllowlist: input.ipAllowlist } : {}),
      }),
    );
  }

  @RequirePermission('api_key.manage')
  @Delete(':id')
  @HttpCode(204)
  async revoke(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string) {
    await tenantTx(this.db, p.tenantId, (tx) => this.keys.revoke(tx, p, id));
  }
}
