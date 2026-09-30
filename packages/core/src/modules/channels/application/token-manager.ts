import { sql } from 'kysely';
import type { Tx } from '@stockos/database';
import { BusinessRuleError } from '@stockos/shared';
import type { AdapterRegistry } from './adapter-registry';
import type { CredentialVault } from './credential-vault';
import type { AccountRef, ChannelCode } from '../domain/channel-adapter';

/**
 * Refreshes a shop's access token before it expires. Shopee (and most platforms) rotate the
 * refresh token on every use — two workers refreshing the same account at once would leave one
 * with a dead refresh token — so this takes `pg_advisory_xact_lock(hashtext(channel_account_id))`
 * before touching credentials, the same single-flight technique used for money (docs §POS refund
 * idempotency) applied here to "the only refresh token we have left".
 */
export class TokenManager {
  constructor(
    private readonly registry: AdapterRegistry,
    private readonly vault: CredentialVault,
  ) {}

  async getValidAccessToken(tx: Tx, account: AccountRef, channelCode: ChannelCode): Promise<string> {
    await sql`select pg_advisory_xact_lock(hashtext(${account.channelAccountId}))`.execute(tx);
    const tokens = await this.vault.load(tx, account);
    if (!tokens) throw new BusinessRuleError('CHANNEL_NOT_CONNECTED', 'No credentials for this account');

    const ttlLeftMs = tokens.accessExpiresAt ? tokens.accessExpiresAt.getTime() - Date.now() : Infinity;
    const totalTtlMs =
      tokens.accessExpiresAt && tokens.refreshedAt
        ? tokens.accessExpiresAt.getTime() - tokens.refreshedAt.getTime()
        : null;
    const needsRefresh = totalTtlMs ? ttlLeftMs < totalTtlMs * 0.2 : ttlLeftMs < 5 * 60 * 1000;
    if (!needsRefresh) return tokens.accessToken;

    const adapter = this.registry.get(channelCode);
    const refreshed = await adapter.refreshToken(account, tokens);
    await this.vault.save(tx, account, refreshed);
    return refreshed.accessToken;
  }
}
