// The only file other modules may import from the inventory module (enforced by ESLint boundaries).
export { InventoryEngine } from './application/inventory-engine';
export { InsufficientStockError } from './domain/errors';
export { BUCKETS, LEDGER_TRANSACTION_TYPES, OPERATIONS, isOperation } from './domain/operations';
export type { Bucket, Operation, OperationSpec } from './domain/operations';
export type { BalanceSnapshot, MovementCommand, MovementLineInput, MovementResult } from './domain/types';
export { readBalances } from './infrastructure/balance-repository';
