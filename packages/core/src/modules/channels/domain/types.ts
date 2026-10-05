import type { ChannelCode } from './channel-adapter';

export type ChannelAccountStatus =
  'CONNECTING' | 'CONNECTED' | 'TOKEN_EXPIRED' | 'ERROR' | 'PAUSED' | 'DISCONNECTED';

export interface ChannelAccount {
  id: string;
  channelCode: ChannelCode;
  externalShopId: string;
  shopName: string | null;
  region: string;
  status: ChannelAccountStatus;
  defaultWarehouseId: string | null;
  settings: { autoImportOrders?: boolean; pushStock?: boolean; pollingIntervalSec?: number };
  lastOrderSyncAt: string | null;
  lastError: string | null;
  createdAt: string;
}

export interface ConnectResult {
  authorizeUrl: string;
  state: string;
}

export interface StartConnectInput {
  channelCode: ChannelCode;
  redirectUri: string;
}

export interface CallbackInput {
  channelCode: ChannelCode;
  query: Record<string, string>;
}

export type MappingStatus = 'UNMAPPED' | 'AUTO_MAPPED' | 'CONFIRMED' | 'CONFLICT' | 'BROKEN';

export interface ChannelProductVariantRow {
  id: string;
  channelAccountId: string;
  channelProductId: string;
  externalItemId: string;
  externalVariantId: string;
  externalSku: string | null;
  productTitle: string | null;
  variantId: string | null;
  sku: string | null;
  quantityMultiplier: string;
  mappingStatus: MappingStatus;
  mappingMethod: string | null;
  syncStock: boolean;
  lastPushedQty: string | null;
  lastPushedAt: string | null;
  lastChannelQty: string | null;
  updatedAt: string;
}

export interface ConfirmMappingInput {
  channelProductVariantId: string;
  variantId: string | null;
}

export interface StockPolicyRow {
  id: string;
  channelAccountId: string | null;
  variantId: string | null;
  strategy: 'GLOBAL_POOL' | 'CHANNEL_ALLOCATION';
  safetyStock: string;
  bufferPercent: string;
  maxPushQty: string | null;
  pushZeroBelow: string;
}

export interface UpsertStockPolicyInput {
  channelAccountId?: string | null;
  variantId?: string | null;
  strategy?: 'GLOBAL_POOL' | 'CHANNEL_ALLOCATION';
  safetyStock?: string;
  bufferPercent?: string;
  maxPushQty?: string | null;
  pushZeroBelow?: string;
}

export interface SyncJobRow {
  id: string;
  channelAccountId: string | null;
  jobType:
    | 'ORDER_PULL'
    | 'ORDER_DETAIL'
    | 'PRODUCT_IMPORT'
    | 'STOCK_PUSH'
    | 'PRICE_PUSH'
    | 'STATUS_PUSH'
    | 'RECONCILE'
    | 'TOKEN_REFRESH';
  status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'DEAD' | 'CANCELLED';
  attempts: number;
  output: unknown;
  lastError: string | null;
  scheduledAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface WebhookEventRow {
  id: string;
  channelCode: string;
  channelAccountId: string | null;
  eventType: string;
  externalRef: string | null;
  signatureValid: boolean;
  status: 'RECEIVED' | 'PROCESSING' | 'PROCESSED' | 'IGNORED' | 'FAILED' | 'DEAD';
  attempts: number;
  lastError: string | null;
  receivedAt: string;
  processedAt: string | null;
}

export interface ReconciliationRunRow {
  id: string;
  type: 'CHANNEL_STOCK';
  channelAccountId: string | null;
  status: 'RUNNING' | 'COMPLETED' | 'FAILED';
  checkedCount: number;
  mismatchCount: number;
  startedAt: string;
  finishedAt: string | null;
}

export interface ReconciliationItemRow {
  id: string;
  variantId: string | null;
  channelProductVariantId: string | null;
  expectedQty: string | null;
  actualQty: string | null;
  diff: string | null;
  classification: string | null;
  resolution: 'OPEN' | 'PUSHED_INTERNAL' | 'PULLED_CHANNEL' | 'IGNORED' | 'AUTO_RESOLVED' | null;
}
