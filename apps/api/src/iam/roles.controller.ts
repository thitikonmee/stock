import { Body, Controller, Get, Headers, Inject, Param, Patch, Post, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { iam } from '@stockos/core';
import { tenantTx, type Db } from '@stockos/database';
import { NotFoundError } from '@stockos/shared';
import { CurrentPrincipal, RequirePermission } from '../auth/decorators';
import { parse, parseIfMatch } from '../common/validation';
import { DB } from '../tokens';

const CreateRoleBody = z.strictObject({
  code: z.string().trim().max(40),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(300).optional(),
  permissions: z.array(z.string().max(60)).max(100),
});
const UpdateRoleBody = z.strictObject({
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(300).optional(),
  permissions: z.array(z.string().max(60)).max(100).optional(),
});

@Controller('roles')
export class RolesController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(iam.RoleService) private readonly roles: iam.RoleService,
  ) {}

  @RequirePermission('user.read')
  @Get()
  list(@CurrentPrincipal() p: iam.Principal) {
    return tenantTx(this.db, p.tenantId, (tx) => this.roles.list(tx, p));
  }

  @RequirePermission('user.read')
  @Get(':id')
  async get(
    @CurrentPrincipal() p: iam.Principal,
    @Param('id') id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const role = (await tenantTx(this.db, p.tenantId, (tx) => this.roles.list(tx, p))).find(
      (r) => r.id === id,
    );
    if (!role) throw new NotFoundError('Role not found');
    void reply.header('etag', `"v${role.version}"`);
    return role;
  }

  @RequirePermission('role.manage')
  @Post()
  create(@CurrentPrincipal() p: iam.Principal, @Body() body: unknown) {
    const input = parse(CreateRoleBody, body);
    return tenantTx(this.db, p.tenantId, (tx) =>
      this.roles.create(tx, p, {
        ...input,
        ...(input.description ? { description: input.description } : {}),
      }),
    );
  }

  @RequirePermission('role.manage')
  @Patch(':id')
  async update(
    @CurrentPrincipal() p: iam.Principal,
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const expectedVersion = parseIfMatch(ifMatch);
    const input = parse(UpdateRoleBody, body);
    const role = await tenantTx(this.db, p.tenantId, (tx) =>
      this.roles.update(tx, p, id, {
        expectedVersion,
        ...(input.name ? { name: input.name } : {}),
        ...(input.description ? { description: input.description } : {}),
        ...(input.permissions ? { permissions: input.permissions } : {}),
      }),
    );
    void reply.header('etag', `"v${role.version}"`);
    return role;
  }
}
