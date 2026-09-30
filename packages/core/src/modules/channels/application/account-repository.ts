import { sql } from 'kysely';
import type { Tx } from '@stockos/database';
import type { ChannelCode } from '../domain/channel-adapter';
import type { ChannelAccount } from '../domain/types';

interface Row {
  id: string;
  channel_code: string;
  external_shop_id: string;
  shop_name: string | null;
  region: string;
  status: ChannelAccount['status'];
  default_warehouse_id: string | null;
  settings: ChannelAccount['settings'] | null;
  last_order_sync_at: Date | null;
  last_error: string | null;
  created_at: Date;
}

const COLS = sql`id, channel_code, external_shop_id, shop_name, region, status, default_warehouse_id,
                  settings, last_order_sync_at, last_error, created_at`;

/** Shared by every service in this module that needs a channel account row — kept out of any one
 *  service so `channel-account-service.ts` (the CRUD-ish owner) and the others don't import each other. */
export async function loadChannelAccount(tx: Tx, id: string): Promise<ChannelAccount | null> {
  const { rows } = await sql<Row>`select ${COLS} from channel_accounts where id = ${id}`.execute(tx);
  const row = rows[0];
  return row ? toChannelAccount(row) : null;
}

export async function loadChannelAccountsForCode(
  tx: Tx,
  channelCode: ChannelCode,
): Promise<ChannelAccount[]> {
  const { rows } = await sql<Row>`
    select ${COLS} from channel_accounts where channel_code = ${channelCode} and status = 'CONNECTED'`.execute(
    tx,
  );
  return rows.map(toChannelAccount);
}

function toChannelAccount(r: Row): ChannelAccount {
  return {
    id: r.id,
    channelCode: r.channel_code as ChannelCode,
    externalShopId: r.external_shop_id,
    shopName: r.shop_name,
    region: r.region,
    status: r.status,
    defaultWarehouseId: r.default_warehouse_id,
    settings: r.settings ?? {},
    lastOrderSyncAt: r.last_order_sync_at?.toISOString() ?? null,
    lastError: r.last_error,
    createdAt: r.created_at.toISOString(),
  };
}
