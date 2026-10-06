import { sql } from 'kysely';
import { PgErrorCode, pgErrorCode, type Tx } from '@stockos/database';
import { BusinessRuleError, NotFoundError, ValidationError, uuidv7 } from '@stockos/shared';
import { assertCan, type Principal } from '../../iam/public-api';
import type { SecretBox } from '../../auth/public-api';
import { recordAudit } from '../../audit/public-api';
import type { AdapterRegistry } from './adapter-registry';
import type { CredentialVault } from './credential-vault';
import { loadChannelAccount } from './account-repository';
import type { ChannelCode } from '../domain/channel-adapter';
import type { CallbackInput, ChannelAccount, ConnectResult, StartConnectInput } from '../domain/types';

const STATE_AAD = 'channel-connect-state';
const STATE_TTL_MS = 15 * 60 * 1000;

interface StatePayload {
  tenantId: string;
  membershipId: string;
  channelCode: ChannelCode;
  redirectUri: string;
  exp: number;
}

/**
 * Connect/disconnect wizard (docs/06 §17 Auth). `state` carries the initiating tenant through
 * Shopee's redirect round-trip (the callback is `@Public()` — Shopee's redirect has none of our
 * auth cookies/headers) sealed with the same envelope box as channel tokens, so it can't be forged
 * or replayed past its 15-minute TTL.
 */
export class ChannelAccountService {
  constructor(
    private readonly registry: AdapterRegistry,
    private readonly vault: CredentialVault,
    private readonly stateBox: SecretBox,
  ) {}

  startConnect(principal: Principal, input: StartConnectInput): ConnectResult {
    assertCan(principal, 'channel.manage');
    const adapter = this.registry.get(input.channelCode);
    const payload: StatePayload = {
      tenantId: principal.tenantId,
      membershipId: principal.membershipId,
      channelCode: input.channelCode,
      redirectUri: input.redirectUri,
      exp: Date.now() + STATE_TTL_MS,
    };
    const state = this.sealState(payload);
    const authorizeUrl = adapter.buildAuthorizeUrl({
      tenantId: principal.tenantId,
      redirectUri: input.redirectUri,
      state,
    });
    return { authorizeUrl, state };
  }

  /** Called from the `@Public()` callback route — there is no Principal yet, `state` supplies the
   *  tenant. Runs in a `tenantTx` opened by the caller once the state is decoded. */
  decodeState(state: string): StatePayload {
    let payload: StatePayload;
    try {
      payload = JSON.parse(this.stateBox.open(Buffer.from(state, 'base64url'), STATE_AAD).toString('utf8'));
    } catch {
      throw new ValidationError('Invalid or expired connect state');
    }
    if (payload.exp < Date.now()) throw new ValidationError('Connect state expired, start over');
    return payload;
  }

  async completeConnect(tx: Tx, state: StatePayload, callback: CallbackInput): Promise<ChannelAccount> {
    const adapter = this.registry.get(state.channelCode);
    const exchanged = await adapter.exchangeCode(
      { tenantId: state.tenantId, redirectUri: state.redirectUri, state: '' },
      callback.query,
    );
    let channelAccountId: string;
    try {
      const { rows } = await sql<{ id: string }>`
        insert into channel_accounts (tenant_id, id, channel_code, external_shop_id, shop_name, status, connected_by)
        values (${state.tenantId}, ${uuidv7()}, ${state.channelCode}, ${exchanged.externalShopId},
                ${exchanged.shopName ?? null}, 'CONNECTED', ${state.membershipId})
        on conflict (channel_code, region, external_shop_id) where status <> 'DISCONNECTED'
          do update set status = 'CONNECTED', shop_name = excluded.shop_name, last_error = null, updated_at = now()
        returning id`.execute(tx);
      channelAccountId = rows[0]!.id;
    } catch (err) {
      // The shop uniqueness index is global (one marketplace shop belongs to one tenant). When the
      // conflicting row is another tenant's, RLS forbids the DO UPDATE and Postgres reports 42501.
      if (pgErrorCode(err) === PgErrorCode.InsufficientPrivilege) {
        throw new BusinessRuleError(
          'SHOP_ALREADY_CONNECTED',
          'This shop is already connected to another StockOS account',
          { channelCode: state.channelCode, externalShopId: exchanged.externalShopId },
        );
      }
      throw err;
    }
    await this.vault.save(
      tx,
      { tenantId: state.tenantId, channelAccountId, externalShopId: exchanged.externalShopId },
      exchanged,
    );
    await recordAudit(tx, {
      tenantId: state.tenantId,
      action: 'channel.connect',
      resourceType: 'channel_account',
      resourceId: channelAccountId,
      after: { channelCode: state.channelCode, externalShopId: exchanged.externalShopId },
    });
    return (await loadChannelAccount(tx, channelAccountId))!;
  }

  async list(tx: Tx, principal: Principal): Promise<ChannelAccount[]> {
    assertCan(principal, 'channel.read');
    const { rows } = await sql<{ id: string }>`
      select id from channel_accounts where status <> 'DISCONNECTED' order by created_at`.execute(tx);
    const accounts = await Promise.all(rows.map((r) => loadChannelAccount(tx, r.id)));
    return accounts.filter((a): a is ChannelAccount => a !== null);
  }

  async get(tx: Tx, principal: Principal, id: string): Promise<ChannelAccount> {
    assertCan(principal, 'channel.read');
    const account = await loadChannelAccount(tx, id);
    if (!account) throw new NotFoundError('Channel account not found');
    return account;
  }

  async setDefaultWarehouse(
    tx: Tx,
    principal: Principal,
    id: string,
    warehouseId: string,
  ): Promise<ChannelAccount> {
    assertCan(principal, 'channel.manage');
    await this.get(tx, principal, id);
    await sql`update channel_accounts set default_warehouse_id = ${warehouseId} where id = ${id}`.execute(tx);
    return (await loadChannelAccount(tx, id))!;
  }

  async pause(tx: Tx, principal: Principal, id: string): Promise<ChannelAccount> {
    return this.setStatus(tx, principal, id, 'PAUSED', 'channel.pause');
  }

  async resume(tx: Tx, principal: Principal, id: string): Promise<ChannelAccount> {
    return this.setStatus(tx, principal, id, 'CONNECTED', 'channel.resume');
  }

  async disconnect(tx: Tx, principal: Principal, id: string): Promise<ChannelAccount> {
    return this.setStatus(tx, principal, id, 'DISCONNECTED', 'channel.disconnect');
  }

  private async setStatus(
    tx: Tx,
    principal: Principal,
    id: string,
    status: ChannelAccount['status'],
    action: string,
  ): Promise<ChannelAccount> {
    assertCan(principal, 'channel.manage');
    const account = await this.get(tx, principal, id);
    if (account.status === 'DISCONNECTED')
      throw new BusinessRuleError('CHANNEL_DISCONNECTED', 'Already disconnected');
    await sql`update channel_accounts set status = ${status} where id = ${id}`.execute(tx);
    await recordAudit(tx, {
      tenantId: principal.tenantId,
      action,
      resourceType: 'channel_account',
      resourceId: id,
    });
    return (await loadChannelAccount(tx, id))!;
  }

  private sealState(payload: StatePayload): string {
    return this.stateBox.seal(Buffer.from(JSON.stringify(payload), 'utf8'), STATE_AAD).toString('base64url');
  }
}
