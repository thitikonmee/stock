import type { Operation } from './operations';

export interface MovementLineInput {
  warehouseId: string;
  variantId: string;
  /** Decimal string (max 3 dp). Negative only for signed operations. */
  quantity: string;
  locationId?: string;
  referenceLineId?: string;
  unitCost?: string;
}

export interface MovementCommand {
  tenantId: string;
  operation: Operation;
  /**
   * Unique per business action, e.g. `order:{id}:reserve`, `pos:{device}:{clientTxnId}:sale`.
   * Replaying the same key returns the original movement without changing stock again.
   */
  idempotencyKey: string;
  reference: { type: string; id: string };
  lines: readonly MovementLineInput[];
  channelCode?: string;
  channelAccountId?: string;
  userId?: string;
  deviceId?: string;
  reasonCode?: string;
  note?: string;
  /** Business time (e.g. offline POS sale time). Defaults to now. */
  occurredAt?: Date;
  /** AVAILABLE guard keeps this much stock untouched (allocation for other channels). */
  minRemaining?: string;
  /** Allow going below zero where the warehouse permits it (offline POS sync, manager override). */
  allowNegative?: boolean;
  requestId?: string;
}

export interface BalanceSnapshot {
  warehouseId: string;
  variantId: string;
  onHand: string;
  reserved: string;
  committed: string;
  damaged: string;
  incoming: string;
  available: string;
  version: string;
}

export interface MovementResult {
  movementId: string;
  /** True when the idempotency key had already been applied; stock was not changed again. */
  replayed: boolean;
  /** Balances after the movement (current balances when replayed). */
  balances: BalanceSnapshot[];
}
