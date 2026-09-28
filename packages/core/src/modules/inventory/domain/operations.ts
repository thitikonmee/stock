import { Dec, ValidationError, toQuantity } from '@stockos/shared';

export const BUCKETS = ['ON_HAND', 'RESERVED', 'COMMITTED', 'DAMAGED', 'INCOMING'] as const;
export type Bucket = (typeof BUCKETS)[number];

/** Must match the CHECK constraint on inventory_transactions.transaction_type. */
export const LEDGER_TRANSACTION_TYPES = [
  'OPENING',
  'PURCHASE_RECEIPT',
  'SALE',
  'RETURN',
  'ADJUSTMENT',
  'TRANSFER_OUT',
  'TRANSFER_IN',
  'DAMAGE',
  'LOSS',
  'FOUND',
  'COUNT_VARIANCE',
  'RESERVATION',
  'RELEASE',
  'COMMIT',
  'UNCOMMIT',
  'CANCEL',
  'REFUND_RESTOCK',
  'INCOMING',
  'INCOMING_CANCEL',
  'BUNDLE_ASSEMBLE',
  'BUNDLE_DISASSEMBLE',
  'REBUILD_CORRECTION',
] as const;
export type LedgerTransactionType = (typeof LEDGER_TRANSACTION_TYPES)[number];

/**
 * Pre-condition checked atomically in the UPDATE's WHERE clause.
 * - AVAILABLE: on_hand - reserved - committed - minRemaining >= qty
 * - BUCKET:    the named bucket >= qty
 * - NONE:      inbound movement, always allowed
 */
export type Guard = { kind: 'NONE' } | { kind: 'AVAILABLE' } | { kind: 'BUCKET'; bucket: Bucket };

export interface OperationSpec {
  readonly ledgerType: LedgerTransactionType;
  /** Sign of the change applied to each bucket, per unit of quantity. */
  readonly effects: Readonly<Partial<Record<Bucket, 1 | -1>>>;
  readonly guard: Guard;
  /** Signed operations accept negative quantities (adjustments, count variances). */
  readonly signed: boolean;
}

const NONE: Guard = { kind: 'NONE' };
const AVAILABLE: Guard = { kind: 'AVAILABLE' };
const bucketGuard = (bucket: Bucket): Guard => ({ kind: 'BUCKET', bucket });

/**
 * The effect matrix (docs/04-inventory.md §2). This table is the ONLY definition of how an
 * operation changes stock; InventoryEngine applies it and nothing else writes inventory_balances.
 */
export const OPERATIONS = {
  OPENING: { ledgerType: 'OPENING', effects: { ON_HAND: 1 }, guard: NONE, signed: false },
  RESERVE: { ledgerType: 'RESERVATION', effects: { RESERVED: 1 }, guard: AVAILABLE, signed: false },
  RELEASE: {
    ledgerType: 'RELEASE',
    effects: { RESERVED: -1 },
    guard: bucketGuard('RESERVED'),
    signed: false,
  },
  COMMIT: {
    ledgerType: 'COMMIT',
    effects: { RESERVED: -1, COMMITTED: 1 },
    guard: bucketGuard('RESERVED'),
    signed: false,
  },
  COMMIT_DIRECT: { ledgerType: 'COMMIT', effects: { COMMITTED: 1 }, guard: AVAILABLE, signed: false },
  UNCOMMIT: {
    ledgerType: 'CANCEL',
    effects: { COMMITTED: -1 },
    guard: bucketGuard('COMMITTED'),
    signed: false,
  },
  SHIP: {
    ledgerType: 'SALE',
    effects: { ON_HAND: -1, COMMITTED: -1 },
    guard: bucketGuard('COMMITTED'),
    signed: false,
  },
  SELL_DIRECT: { ledgerType: 'SALE', effects: { ON_HAND: -1 }, guard: AVAILABLE, signed: false },
  RETURN_SELLABLE: { ledgerType: 'RETURN', effects: { ON_HAND: 1 }, guard: NONE, signed: false },
  RETURN_DAMAGED: { ledgerType: 'RETURN', effects: { DAMAGED: 1 }, guard: NONE, signed: false },
  EXPECT_INCOMING: { ledgerType: 'INCOMING', effects: { INCOMING: 1 }, guard: NONE, signed: false },
  CANCEL_INCOMING: {
    ledgerType: 'INCOMING_CANCEL',
    effects: { INCOMING: -1 },
    guard: bucketGuard('INCOMING'),
    signed: false,
  },
  RECEIVE_PURCHASE: {
    ledgerType: 'PURCHASE_RECEIPT',
    effects: { ON_HAND: 1, INCOMING: -1 },
    guard: bucketGuard('INCOMING'),
    signed: false,
  },
  RECEIVE_DIRECT: { ledgerType: 'PURCHASE_RECEIPT', effects: { ON_HAND: 1 }, guard: NONE, signed: false },
  TRANSFER_OUT: {
    ledgerType: 'TRANSFER_OUT',
    effects: { ON_HAND: -1, COMMITTED: -1 },
    guard: bucketGuard('COMMITTED'),
    signed: false,
  },
  TRANSFER_IN: {
    ledgerType: 'TRANSFER_IN',
    effects: { ON_HAND: 1, INCOMING: -1 },
    guard: bucketGuard('INCOMING'),
    signed: false,
  },
  MARK_DAMAGED: {
    ledgerType: 'DAMAGE',
    effects: { ON_HAND: -1, DAMAGED: 1 },
    guard: bucketGuard('ON_HAND'),
    signed: false,
  },
  LOSS: { ledgerType: 'LOSS', effects: { ON_HAND: -1 }, guard: bucketGuard('ON_HAND'), signed: false },
  FOUND: { ledgerType: 'FOUND', effects: { ON_HAND: 1 }, guard: NONE, signed: false },
  ADJUST: { ledgerType: 'ADJUSTMENT', effects: { ON_HAND: 1 }, guard: NONE, signed: true },
  ADJUST_DAMAGED: { ledgerType: 'ADJUSTMENT', effects: { DAMAGED: 1 }, guard: NONE, signed: true },
  COUNT_VARIANCE: { ledgerType: 'COUNT_VARIANCE', effects: { ON_HAND: 1 }, guard: NONE, signed: true },
} as const satisfies Record<string, OperationSpec>;

export type Operation = keyof typeof OPERATIONS;

export function isOperation(value: string): value is Operation {
  return Object.prototype.hasOwnProperty.call(OPERATIONS, value);
}

export interface LineEffect {
  /** Signed delta per touched bucket. */
  deltas: Partial<Record<Bucket, Dec>>;
  guard: Guard;
  /** Positive amount the guard must cover. */
  guardQuantity: Dec;
}

/**
 * Resolve the concrete bucket deltas and guard for one line.
 * Signed operations with a negative quantity become outbound and are guarded by their bucket.
 */
export function computeLineEffect(operation: Operation, quantity: string | Dec): LineEffect {
  const spec: OperationSpec = OPERATIONS[operation];
  const qty = toQuantity(quantity, { allowNegative: spec.signed });

  const deltas: Partial<Record<Bucket, Dec>> = {};
  for (const bucket of BUCKETS) {
    const sign = spec.effects[bucket];
    if (sign !== undefined) deltas[bucket] = qty.times(sign);
  }

  let guard = spec.guard;
  if (spec.signed && qty.isNegative()) {
    const [bucket] = Object.keys(spec.effects) as Bucket[];
    if (!bucket) throw new ValidationError(`Operation ${operation} has no effect`);
    guard = bucketGuard(bucket);
  }
  return { deltas, guard, guardQuantity: qty.abs() };
}

export const ZERO = new Dec(0);
