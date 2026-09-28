import { Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { billing, notifications, type iam } from '@stockos/core';
import { tenantTx, type Db } from '@stockos/database';
import { AllowWithoutMfa, Authenticated, CurrentPrincipal } from '../auth/decorators';
import { DB } from '../tokens';

@Controller('notifications')
export class NotificationsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(notifications.NotificationService)
    private readonly notifications: notifications.NotificationService,
  ) {}

  @Authenticated()
  @AllowWithoutMfa()
  @Get()
  list(@CurrentPrincipal() p: iam.Principal, @Query('unread') unread?: string) {
    return tenantTx(this.db, p.tenantId, (tx) =>
      this.notifications.listMine(tx, p, { unreadOnly: unread === 'true' }),
    );
  }

  @Authenticated()
  @Post(':id/read')
  @HttpCode(204)
  async read(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string) {
    await tenantTx(this.db, p.tenantId, (tx) => this.notifications.markRead(tx, p, id));
  }

  @Authenticated()
  @Post('read-all')
  @HttpCode(200)
  async readAll(@CurrentPrincipal() p: iam.Principal) {
    return { updated: await tenantTx(this.db, p.tenantId, (tx) => this.notifications.markAllRead(tx, p)) };
  }
}

@Controller('billing')
export class BillingController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(billing.PlanService) private readonly plans: billing.PlanService,
  ) {}

  /** Plan, limits and current usage — every member may see it (the UI shows upgrade hints). */
  @Authenticated()
  @Get('usage')
  usage(@CurrentPrincipal() p: iam.Principal) {
    return tenantTx(this.db, p.tenantId, (tx) => this.plans.summary(tx));
  }
}
