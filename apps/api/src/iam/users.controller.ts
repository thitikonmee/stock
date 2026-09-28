import { Body, Controller, Get, Inject, Param, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import { auth, iam } from '@stockos/core';
import { tenantTx, type Db } from '@stockos/database';
import { CurrentPrincipal, RequirePermission } from '../auth/decorators';
import { parse } from '../common/validation';
import { DB } from '../tokens';

export const RoleAssignmentSchema = z.strictObject({
  roleId: z.string(),
  scopeType: z.enum(['TENANT', 'BRANCH', 'WAREHOUSE']).default('TENANT'),
  scopeId: z.string().nullable().default(null),
});
const InviteBody = z.strictObject({
  email: z.string().trim().max(254),
  roles: z.array(RoleAssignmentSchema).min(1).max(20),
});
const AssignBody = z.strictObject({ roles: z.array(RoleAssignmentSchema).max(20) });

@Controller('users')
export class UsersController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(auth.UserService) private readonly users: auth.UserService,
    @Inject(iam.RoleService) private readonly roles: iam.RoleService,
  ) {}

  @RequirePermission('user.read')
  @Get()
  list(@CurrentPrincipal() p: iam.Principal) {
    return tenantTx(this.db, p.tenantId, (tx) => this.users.listMembers(tx, p));
  }

  @RequirePermission('user.read')
  @Get(':id')
  get(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string) {
    return tenantTx(this.db, p.tenantId, (tx) => this.users.getMember(tx, p, id));
  }

  @RequirePermission('user.manage')
  @Post('invitations')
  invite(@CurrentPrincipal() p: iam.Principal, @Body() body: unknown) {
    const input = parse(InviteBody, body);
    return tenantTx(this.db, p.tenantId, (tx) => this.users.invite(tx, p, input));
  }

  /** Replace the member's role assignments. */
  @RequirePermission('user.manage')
  @Put(':id/roles')
  assignRoles(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string, @Body() body: unknown) {
    const { roles } = parse(AssignBody, body);
    return tenantTx(this.db, p.tenantId, (tx) => this.roles.assign(tx, p, id, roles));
  }
}
