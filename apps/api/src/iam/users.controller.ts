import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import { auth, iam, notifications } from '@stockos/core';
import { tenantTx, type Db } from '@stockos/database';
import type { Logger } from '@stockos/shared';
import { CurrentPrincipal, RequirePermission } from '../auth/decorators';
import { parse } from '../common/validation';
import { DB, LOGGER, MAILER, WEB_BASE_URL } from '../tokens';

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
const StatusBody = z.strictObject({ status: z.enum(['ACTIVE', 'SUSPENDED']) });
const EmployeeCodeBody = z.strictObject({ employeeCode: z.string().trim().min(1).max(20) });

@Controller('users')
export class UsersController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(auth.UserService) private readonly users: auth.UserService,
    @Inject(iam.RoleService) private readonly roles: iam.RoleService,
    @Inject(MAILER) private readonly mailer: notifications.EmailSender,
    @Inject(WEB_BASE_URL) private readonly webBaseUrl: string,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  @RequirePermission('user.read')
  @Get()
  list(@CurrentPrincipal() p: iam.Principal) {
    return tenantTx(this.db, p.tenantId, (tx) => this.users.listMembers(tx, p));
  }

  @RequirePermission('user.read')
  @Get('invitations')
  listInvitations(@CurrentPrincipal() p: iam.Principal) {
    return tenantTx(this.db, p.tenantId, (tx) => this.users.listInvitations(tx, p));
  }

  @RequirePermission('user.read')
  @Get(':id')
  get(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string) {
    return tenantTx(this.db, p.tenantId, (tx) => this.users.getMember(tx, p, id));
  }

  /**
   * Creates the invitation, then e-mails it after the transaction commits. A mail outage never
   * loses the invitation: the response still carries the link for the inviter to share.
   */
  @RequirePermission('user.manage')
  @Post('invitations')
  async invite(@CurrentPrincipal() p: iam.Principal, @Body() body: unknown) {
    const input = parse(InviteBody, body);
    const created = await tenantTx(this.db, p.tenantId, (tx) => this.users.invite(tx, p, input));
    const acceptUrl = `${this.webBaseUrl}/invite/accept?token=${encodeURIComponent(created.token)}`;
    let emailSent = false;
    try {
      await this.mailer.send(
        notifications.invitationEmail({
          to: created.email,
          companyName: created.companyName,
          inviterName: created.inviterName,
          acceptUrl,
          expiresAt: created.expiresAt,
        }),
      );
      emailSent = true;
    } catch (err) {
      this.logger.warn(
        { err, event: 'invitation.email.failed', invitationId: created.invitationId },
        'invitation e-mail failed',
      );
    }
    return {
      invitationId: created.invitationId,
      email: created.email,
      expiresAt: created.expiresAt,
      token: created.token,
      acceptUrl,
      emailSent,
    };
  }

  @RequirePermission('user.manage')
  @Delete('invitations/:id')
  @HttpCode(204)
  async revokeInvitation(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string) {
    await tenantTx(this.db, p.tenantId, (tx) => this.users.revokeInvitation(tx, p, id));
  }

  /** Suspend or reactivate a member. */
  @RequirePermission('user.manage')
  @Patch(':id')
  setStatus(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string, @Body() body: unknown) {
    const { status } = parse(StatusBody, body);
    return tenantTx(this.db, p.tenantId, (tx) => this.users.setMemberStatus(tx, p, id, status));
  }

  /** Set the employee code a cashier logs into the POS with. */
  @RequirePermission('user.manage')
  @Put(':id/employee-code')
  setEmployeeCode(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string, @Body() body: unknown) {
    const { employeeCode } = parse(EmployeeCodeBody, body);
    return tenantTx(this.db, p.tenantId, (tx) => this.users.setEmployeeCode(tx, p, id, employeeCode));
  }

  /** Replace the member's role assignments. */
  @RequirePermission('user.manage')
  @Put(':id/roles')
  assignRoles(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string, @Body() body: unknown) {
    const { roles } = parse(AssignBody, body);
    return tenantTx(this.db, p.tenantId, (tx) => this.roles.assign(tx, p, id, roles));
  }
}
