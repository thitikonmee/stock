// The only file other modules may import from the inventory module (enforced by ESLint boundaries).
export { InventoryEngine } from './application/inventory-engine';
export { InsufficientStockError } from './domain/errors';
export { BUCKETS, LEDGER_TRANSACTION_TYPES, OPERATIONS, isOperation } from './domain/operations';
export type { Bucket, Operation, OperationSpec } from './domain/operations';
export type { BalanceSnapshot, MovementCommand, MovementLineInput, MovementResult } from './domain/types';
export { readBalances, syncNegativeStockPolicy } from './infrastructure/balance-repository';
export { readAvgCost } from './infrastructure/cost-repository';

export {
  InventoryQueryService,
  type BalancePage,
  type BalanceQuery,
  type BalanceRow,
  type LedgerLine,
  type TransactionPage,
  type TransactionQuery,
} from './application/query-service';
export {
  ReservationService,
  type Reservation,
  type ReservationStatus,
  type ReserveInput,
  type ReserveLine,
} from './application/reservation-service';
export {
  AdjustmentService,
  type Adjustment,
  type AdjustmentBucket,
  type AdjustmentItem,
  type AdjustmentItemInput,
  type AdjustmentReasonCode,
  type AdjustmentStatus,
  type CreateAdjustmentInput,
} from './application/adjustment-service';
export {
  ReceivingService,
  type OpeningStockImportResult,
  type ReceiveInput,
  type ReceiveLine as ReceivingLine,
  type ReceiveResult,
} from './application/receiving-service';
export {
  ReconciliationService,
  type ReconciliationItem,
  type ReconciliationRun,
} from './application/reconciliation-service';
export type { BucketDiff } from './infrastructure/rebuild-repository';
