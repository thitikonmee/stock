import { Body, Controller, Get, Inject, Param, Post, Put, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { channels, type iam } from '@stockos/core';
import { tenantTx, type Db } from '@stockos/database';
import { NotFoundError, ValidationError } from '@stockos/shared';
import { CurrentPrincipal, Public, RequirePermission } from '../auth/decorators';
import { parse } from '../common/validation';
import { API_BASE_URL, DB, WEB_BASE_URL } from '../tokens';

const SUPPORTED_CHANNELS = ['SHOPEE', 'LAZADA'] as const;
function assertSupportedChannel(code: string): channels.ChannelCode {
  if (!SUPPORTED_CHANNELS.includes(code as (typeof SUPPORTED_CHANNELS)[number])) {
    throw new ValidationError(`Unsupported channel: ${code}`);
  }
  return code as channels.ChannelCode;
}

/** Connect wizard (docs/06 §17 Auth) — start here, land on `ChannelAccountsController` after. */
@Controller('channels')
export class ChannelsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(API_BASE_URL) private readonly apiBaseUrl: string,
    @Inject(WEB_BASE_URL) private readonly webBaseUrl: string,
    @Inject(channels.ChannelAccountService) private readonly accounts: channels.ChannelAccountService,
  ) {}

  @RequirePermission('channel.manage')
  @Post(':channelCode/connect')
  connect(@CurrentPrincipal() p: iam.Principal, @Param('channelCode') channelCode: string) {
    const code = assertSupportedChannel(channelCode.toUpperCase());
    return this.accounts.startConnect(p, {
      channelCode: code,
      redirectUri: `${this.apiBaseUrl}/api/v1/channels/${code.toLowerCase()}/callback`,
    });
  }

  // No auth: the platform's browser redirect here carries none of our session cookies/headers —
  // `state` (sealed by startConnect) is what proves which tenant/user asked for this.
  @Public()
  @Get(':channelCode/callback')
  async callback(
    @Param('channelCode') channelCode: string,
    @Query() query: Record<string, string>,
    @Res() reply: FastifyReply,
  ) {
    const code = assertSupportedChannel(channelCode.toUpperCase());
    try {
      const state = this.accounts.decodeState(query.state ?? '');
      const account = await tenantTx(this.db, state.tenantId, (tx) =>
        this.accounts.completeConnect(tx, state, { channelCode: code, query }),
      );
      void reply.redirect(`${this.webBaseUrl}/channels?connected=${account.id}`, 302);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'connect failed';
      void reply.redirect(`${this.webBaseUrl}/channels?error=${encodeURIComponent(message)}`, 302);
    }
  }
}

const DefaultWarehouseBody = z.strictObject({ warehouseId: z.string() });
const StockPolicyBody = z.strictObject({
  channelAccountId: z.string().nullish(),
  variantId: z.string().nullish(),
  safetyStock: z.string().optional(),
  bufferPercent: z.string().optional(),
  maxPushQty: z.string().nullish(),
  pushZeroBelow: z.string().optional(),
});

/** Everything scoped to one connected shop: mapping, stock policy, sync, reconciliation, webhook
 *  history (docs/06 §20 admin console). */
@Controller('channel-accounts')
export class ChannelAccountsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(channels.ChannelAccountService) private readonly accounts: channels.ChannelAccountService,
    @Inject(channels.MappingService) private readonly mapping: channels.MappingService,
    @Inject(channels.StockSyncService) private readonly stockSync: channels.StockSyncService,
    @Inject(channels.SyncJobService) private readonly syncJobs: channels.SyncJobService,
    @Inject(channels.WebhookQueryService) private readonly webhookEvents: channels.WebhookQueryService,
    @Inject(channels.ReconciliationService) private readonly reconciliation: channels.ReconciliationService,
  ) {}

  @RequirePermission('channel.read')
  @Get()
  list(@CurrentPrincipal() p: iam.Principal) {
    return tenantTx(this.db, p.tenantId, (tx) => this.accounts.list(tx, p));
  }

  @RequirePermission('channel.read')
  @Get(':id')
  get(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string) {
    return tenantTx(this.db, p.tenantId, (tx) => this.accounts.get(tx, p, id));
  }

  @RequirePermission('channel.manage')
  @Put(':id/default-warehouse')
  setDefaultWarehouse(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(DefaultWarehouseBody, body);
    return tenantTx(this.db, p.tenantId, (tx) =>
      this.accounts.setDefaultWarehouse(tx, p, id, input.warehouseId),
    );
  }

  @RequirePermission('channel.manage')
  @Post(':id/pause')
  pause(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string) {
    return tenantTx(this.db, p.tenantId, (tx) => this.accounts.pause(tx, p, id));
  }

  @RequirePermission('channel.manage')
  @Post(':id/resume')
  resume(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string) {
    return tenantTx(this.db, p.tenantId, (tx) => this.accounts.resume(tx, p, id));
  }

  @RequirePermission('channel.manage')
  @Post(':id/disconnect')
  disconnect(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string) {
    return tenantTx(this.db, p.tenantId, (tx) => this.accounts.disconnect(tx, p, id));
  }

  @RequirePermission('channel.mapping')
  @Get(':id/mappings')
  listMappings(
    @CurrentPrincipal() p: iam.Principal,
    @Param('id') id: string,
    @Query('status') status?: string,
  ) {
    return tenantTx(this.db, p.tenantId, (tx) =>
      this.mapping.list(tx, p, id, { ...(status ? { status } : {}) }),
    );
  }

  @RequirePermission('channel.mapping')
  @Post(':id/mappings/import')
  importMappings(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string) {
    return tenantTx(this.db, p.tenantId, (tx) => this.mapping.importProducts(tx, p, id));
  }

  @RequirePermission('channel.sync')
  @Post(':id/sync/stock')
  syncStock(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string) {
    return tenantTx(this.db, p.tenantId, (tx) => this.stockSync.pushAccount(tx, p, id));
  }

  @RequirePermission('channel.sync')
  @Post(':id/sync/orders')
  syncOrders(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string) {
    return tenantTx(this.db, p.tenantId, (tx) => this.syncJobs.runOrderPoll(tx, p, id));
  }

  @RequirePermission('channel.read')
  @Get(':id/sync-jobs')
  listSyncJobs(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string) {
    return tenantTx(this.db, p.tenantId, (tx) => this.syncJobs.list(tx, p, id));
  }

  @RequirePermission('channel.read')
  @Get(':id/webhook-events')
  listWebhookEvents(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string) {
    return tenantTx(this.db, p.tenantId, (tx) => this.webhookEvents.list(tx, p, id));
  }

  @RequirePermission('channel.sync')
  @Post(':id/reconciliation-runs')
  runReconciliation(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string) {
    return tenantTx(this.db, p.tenantId, (tx) => this.reconciliation.run(tx, p, id));
  }

  @RequirePermission('channel.read')
  @Get(':id/reconciliation-runs')
  listReconciliationRuns(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string) {
    return tenantTx(this.db, p.tenantId, (tx) => this.reconciliation.listRuns(tx, p, id));
  }
}

@Controller('channel-mappings')
export class ChannelMappingsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(channels.MappingService) private readonly mapping: channels.MappingService,
  ) {}

  @RequirePermission('channel.mapping')
  @Put(':id')
  confirm(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(z.strictObject({ variantId: z.string().nullable() }), body);
    return tenantTx(this.db, p.tenantId, (tx) =>
      this.mapping.confirmMapping(tx, p, { channelProductVariantId: id, variantId: input.variantId }),
    );
  }
}

@Controller('channel-stock-policies')
export class ChannelStockPoliciesController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(channels.StockPolicyService) private readonly policies: channels.StockPolicyService,
  ) {}

  @RequirePermission('channel.read')
  @Get()
  list(@CurrentPrincipal() p: iam.Principal, @Query('channelAccountId') channelAccountId?: string) {
    return tenantTx(this.db, p.tenantId, (tx) => this.policies.list(tx, p, channelAccountId));
  }

  @RequirePermission('channel.manage')
  @Put()
  upsert(@CurrentPrincipal() p: iam.Principal, @Body() body: unknown) {
    const input = parse(StockPolicyBody, body);
    return tenantTx(this.db, p.tenantId, (tx) =>
      this.policies.upsert(tx, p, {
        channelAccountId: input.channelAccountId ?? null,
        variantId: input.variantId ?? null,
        ...(input.safetyStock !== undefined ? { safetyStock: input.safetyStock } : {}),
        ...(input.bufferPercent !== undefined ? { bufferPercent: input.bufferPercent } : {}),
        maxPushQty: input.maxPushQty ?? null,
        ...(input.pushZeroBelow !== undefined ? { pushZeroBelow: input.pushZeroBelow } : {}),
      }),
    );
  }
}

@Controller('reconciliation-runs')
export class ChannelReconciliationController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(channels.ReconciliationService) private readonly reconciliation: channels.ReconciliationService,
  ) {}

  @RequirePermission('channel.read')
  @Get(':id')
  async get(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string) {
    const run = await tenantTx(this.db, p.tenantId, (tx) => this.reconciliation.getRun(tx, p, id));
    if (!run) throw new NotFoundError('Reconciliation run not found');
    return run;
  }

  @RequirePermission('channel.read')
  @Get(':id/items')
  items(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string) {
    return tenantTx(this.db, p.tenantId, (tx) => this.reconciliation.listItems(tx, p, id));
  }
}
