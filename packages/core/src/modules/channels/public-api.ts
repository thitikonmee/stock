// The only file other modules (and apps/api) may import from the channels module.
export type {
  AccountRef,
  ChannelAdapter,
  ChannelCapabilities,
  ChannelCode,
  ChannelError,
  ChannelErrorKind,
  ChannelTokenSet,
  ConnectContext,
  ExternalOrderRef,
  ExternalProduct,
  ExternalStock,
  ExternalVariant,
  NormalizedChannelOrder,
  NormalizedOrderStatus,
  Page,
  ParsedWebhook,
  RawWebhookRequest,
  StockUpdate,
  StockUpdateResult,
  WebhookVerification,
} from './domain/channel-adapter';
export { computeSellable, DEFAULT_STOCK_POLICY, type StockPolicy } from './domain/stock-policy';
export type {
  CallbackInput,
  ChannelAccount,
  ChannelAccountStatus,
  ChannelProductVariantRow,
  ConfirmMappingInput,
  ConnectResult,
  MappingStatus,
  ReconciliationItemRow,
  ReconciliationRunRow,
  StartConnectInput,
  StockPolicyRow,
  SyncJobRow,
  UpsertStockPolicyInput,
  WebhookEventRow,
} from './domain/types';

export { AdapterRegistry } from './application/adapter-registry';
export { CredentialVault } from './application/credential-vault';
export { TokenManager } from './application/token-manager';
export { ChannelAccountService } from './application/channel-account-service';
export { MappingService } from './application/mapping-service';
export { OrderIngestService, type IngestResult } from './application/order-ingest-service';
export { StockSyncService, type StockSyncResult } from './application/stock-sync-service';
export { StockPolicyService } from './application/stock-policy-service';
export { ReconciliationService } from './application/reconciliation-service';
export { WebhookService, type WebhookHandleResult } from './application/webhook-service';
export { WebhookQueryService } from './application/webhook-query-service';
export { SyncJobService } from './application/sync-job-service';
export { loadChannelAccount } from './application/account-repository';

export { ShopeeAdapter, type ShopeeConfig } from './adapters/shopee/shopee-adapter';
export { ShopeeFixtureServer } from './adapters/shopee/fixtures/fixture-fetcher';
export {
  buildSign as buildShopeeSign,
  verifyWebhookSignature as verifyShopeeWebhookSignature,
} from './adapters/shopee/signing';
export { mapShopeeOrderStatus } from './adapters/shopee/status-map';

export { LazadaAdapter, type LazadaConfig } from './adapters/lazada/lazada-adapter';
export { LazadaFixtureServer } from './adapters/lazada/fixtures/fixture-fetcher';
export {
  buildSign as buildLazadaSign,
  verifyWebhookSignature as verifyLazadaWebhookSignature,
} from './adapters/lazada/signing';
export {
  mapLazadaLineStatus,
  deriveOrderStatus as deriveLazadaOrderStatus,
} from './adapters/lazada/status-map';
