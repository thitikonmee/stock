import { sql } from 'kysely';
import type { Tx } from '@stockos/database';
import type { SecretBox } from '../../auth/public-api';
import type { AccountRef, ChannelTokenSet } from '../domain/channel-adapter';

/**
 * Reads/writes `channel_credentials`. Tokens are sealed with the same envelope-encryption
 * primitive as TOTP seeds (`auth.SecretBox` — see its own doc comment: "channel tokens later").
 * The AAD binds a sealed value to its `channel_account_id`, so a row copied to another account
 * (e.g. a bad migration) fails to decrypt instead of silently leaking a token cross-account.
 */
export class CredentialVault {
  constructor(private readonly box: SecretBox) {}

  async save(tx: Tx, account: AccountRef, tokens: ChannelTokenSet): Promise<void> {
    const accessSealed = this.box.seal(Buffer.from(tokens.accessToken, 'utf8'), account.channelAccountId);
    const refreshSealed = tokens.refreshToken
      ? this.box.seal(Buffer.from(tokens.refreshToken, 'utf8'), account.channelAccountId)
      : null;
    const extraSealed = tokens.extra
      ? this.box.seal(Buffer.from(JSON.stringify(tokens.extra), 'utf8'), account.channelAccountId)
      : null;
    await sql`
      insert into channel_credentials (tenant_id, channel_account_id, access_token_enc, refresh_token_enc,
                                       dek_wrapped, access_expires_at, refresh_expires_at, scopes, extra_enc,
                                       refreshed_at, version)
      values (${account.tenantId}, ${account.channelAccountId}, ${accessSealed}, ${refreshSealed},
              ${Buffer.alloc(0)}, ${tokens.accessExpiresAt}, ${tokens.refreshExpiresAt},
              ${tokens.scopes ?? null}, ${extraSealed}, now(), 1)
      on conflict (tenant_id, channel_account_id) do update set
        access_token_enc = excluded.access_token_enc,
        refresh_token_enc = excluded.refresh_token_enc,
        access_expires_at = excluded.access_expires_at,
        refresh_expires_at = excluded.refresh_expires_at,
        scopes = excluded.scopes,
        extra_enc = excluded.extra_enc,
        refreshed_at = now(),
        version = channel_credentials.version + 1`.execute(tx);
  }

  async load(
    tx: Tx,
    account: AccountRef,
  ): Promise<(ChannelTokenSet & { version: number; refreshedAt: Date | null }) | null> {
    const { rows } = await sql<{
      access_token_enc: Buffer;
      refresh_token_enc: Buffer | null;
      access_expires_at: Date | null;
      refresh_expires_at: Date | null;
      scopes: string[] | null;
      extra_enc: Buffer | null;
      refreshed_at: Date | null;
      version: string;
    }>`select access_token_enc, refresh_token_enc, access_expires_at, refresh_expires_at, scopes, extra_enc,
              refreshed_at, version
        from channel_credentials where channel_account_id = ${account.channelAccountId}`.execute(tx);
    const row = rows[0];
    if (!row) return null;
    return {
      accessToken: this.box.open(row.access_token_enc, account.channelAccountId).toString('utf8'),
      refreshToken: row.refresh_token_enc
        ? this.box.open(row.refresh_token_enc, account.channelAccountId).toString('utf8')
        : null,
      accessExpiresAt: row.access_expires_at,
      refreshExpiresAt: row.refresh_expires_at,
      scopes: row.scopes ?? undefined,
      extra: row.extra_enc
        ? (JSON.parse(this.box.open(row.extra_enc, account.channelAccountId).toString('utf8')) as Record<
            string,
            string
          >)
        : undefined,
      version: Number(row.version),
      refreshedAt: row.refreshed_at,
    };
  }
}
