import type { Tx } from '@stockos/database';
import { addOutboxEvent } from '@stockos/queue';
import { Dec, IdempotencyKeyReusedError, ValidationError, isUuid, uuidv7 } from '@stockos/shared';
import { InsufficientStockError } from '../domain/errors';
import { OPERATIONS, computeLineEffect, isOperation, type LineEffect } from '../domain/operations';
import type { BalanceSnapshot, MovementCommand, MovementLineInput, MovementResult } from '../domain/types';
import {
  applyBalanceDelta,
  ensureBalanceRow,
  readBalances,
  type UpdatedBalance,
} from '../infrastructure/balance-repository';
import { releaseFromLocations } from '../infrastructure/location-repository';
import {
  findMovementByKey,
  insertLedgerLines,
  insertMovement,
  movementKeys,
} from '../infrastructure/ledger-repository';

const MAX_LINES = 500;
/** Outbound operations where someone physically picks the goods off a shelf (bins first). */
const PICKING_OPERATIONS = new Set(['SHIP', 'SELL_DIRECT', 'TRANSFER_OUT']);

interface PreparedLine {
  input: MovementLineInput;
  effect: LineEffect;
}

/**
 * The only writer of inventory_balances. Every call:
 *  1. claims the idempotency key (replays return without touching stock),
 *  2. locks balance rows in (warehouse, variant) order to avoid deadlocks,
 *  3. applies a guarded, single-statement update per line,
 *  4. appends ledger rows with before/after quantities,
 *  5. records a StockChanged outbox event — all in the caller's transaction.
 *
 * Must be called inside `tenantTx(db, cmd.tenantId, ...)`. Any error rolls back the whole movement.
 */
export class InventoryEngine {
  async apply(tx: Tx, cmd: MovementCommand): Promise<MovementResult> {
    const lines = prepare(cmd);
    const movementId = uuidv7();

    if (!(await insertMovement(tx, movementId, cmd))) {
      return this.replay(tx, cmd);
    }

    const ledgerType = OPERATIONS[cmd.operation].ledgerType;
    const minRemaining = new Dec(cmd.minRemaining ?? 0);
    const balances: UpdatedBalance[] = [];

    for (const line of sortForLocking(lines)) {
      const balance = await this.applyLine(tx, cmd, line, minRemaining);
      await insertLedgerLines(tx, {
        movementId,
        ledgerType,
        cmd,
        line: line.input,
        deltas: line.effect.deltas,
        after: balance,
      });
      balances.push(balance);
    }

    await addOutboxEvent(tx, {
      tenantId: cmd.tenantId,
      aggregateType: 'InventoryMovement',
      aggregateId: movementId,
      eventType: 'StockChanged',
      payload: {
        movementId,
        operation: cmd.operation,
        reference: cmd.reference,
        channelCode: cmd.channelCode ?? null,
        items: balances.map((b) => ({
          warehouseId: b.warehouseId,
          variantId: b.variantId,
          available: b.available,
          version: b.version,
        })),
      },
    });

    return { movementId, replayed: false, balances: balances.map(withoutProduct) };
  }

  private async applyLine(tx: Tx, cmd: MovementCommand, line: PreparedLine, minRemaining: Dec) {
    const request = {
      tenantId: cmd.tenantId,
      warehouseId: line.input.warehouseId,
      variantId: line.input.variantId,
      deltas: line.effect.deltas,
      guard: line.effect.guard,
      guardQuantity: line.effect.guardQuantity,
      minRemaining,
      allowNegative: cmd.allowNegative ?? false,
      channelAccountId: cmd.channelAccountId,
    };

    let outcome = await applyBalanceDelta(tx, request);
    if (!outcome.ok && outcome.reason === 'GUARD' && line.effect.guard.kind === 'NONE') {
      // Unguarded (inbound) movement on a (warehouse, variant) that has no balance row yet.
      await ensureBalanceRow(tx, cmd.tenantId, line.input.warehouseId, line.input.variantId);
      outcome = await applyBalanceDelta(tx, request);
      if (!outcome.ok && outcome.reason === 'GUARD') {
        throw new ValidationError('Unknown warehouse or variant', {
          warehouseId: line.input.warehouseId,
          variantId: line.input.variantId,
        });
      }
    }
    if (!outcome.ok) {
      throw new InsufficientStockError({
        warehouseId: line.input.warehouseId,
        variantId: line.input.variantId,
        operation: cmd.operation,
        requested: line.effect.guardQuantity.toFixed(3),
        ...(outcome.reason === 'GUARD' ? await this.currentAvailable(tx, cmd.tenantId, line.input) : {}),
      });
    }
    const onHandDelta = line.effect.deltas.ON_HAND;
    if (onHandDelta?.isNegative()) {
      await releaseFromLocations(tx, {
        warehouseId: line.input.warehouseId,
        variantId: line.input.variantId,
        quantity: onHandDelta.abs(),
        onHandAfter: new Dec(outcome.balance.onHand),
        binsFirst: PICKING_OPERATIONS.has(cmd.operation),
      });
    }
    return outcome.balance;
  }

  private async currentAvailable(tx: Tx, tenantId: string, line: MovementLineInput) {
    const [balance] = await readBalances(tx, tenantId, [line]);
    return { available: balance?.available ?? '0.000' };
  }

  private async replay(tx: Tx, cmd: MovementCommand): Promise<MovementResult> {
    const existing = await findMovementByKey(tx, cmd.tenantId, cmd.idempotencyKey);
    if (!existing) {
      // Conflict row vanished (its transaction rolled back after we waited) — let the caller retry.
      throw new ValidationError('Idempotency key conflict could not be resolved; retry the request');
    }
    if (
      existing.movementType !== cmd.operation ||
      existing.referenceType !== cmd.reference.type ||
      existing.referenceId !== cmd.reference.id
    ) {
      throw new IdempotencyKeyReusedError('Idempotency key was already used for a different movement', {
        idempotencyKey: cmd.idempotencyKey,
      });
    }
    const keys = await movementKeys(tx, cmd.tenantId, existing.id);
    return { movementId: existing.id, replayed: true, balances: await readBalances(tx, cmd.tenantId, keys) };
  }
}

function prepare(cmd: MovementCommand): PreparedLine[] {
  if (!isOperation(cmd.operation)) throw new ValidationError(`Unknown operation ${String(cmd.operation)}`);
  if (!isUuid(cmd.tenantId) || !isUuid(cmd.reference.id))
    throw new ValidationError('Invalid tenant or reference id');
  if (!cmd.idempotencyKey || cmd.idempotencyKey.length > 200)
    throw new ValidationError('Invalid idempotency key');
  if (cmd.lines.length === 0 || cmd.lines.length > MAX_LINES) {
    throw new ValidationError(`A movement needs 1..${MAX_LINES} lines`);
  }
  return cmd.lines.map((input) => {
    if (!isUuid(input.warehouseId) || !isUuid(input.variantId)) {
      throw new ValidationError('Invalid warehouse or variant id');
    }
    return { input, effect: computeLineEffect(cmd.operation, input.quantity) };
  });
}

/** Global lock order for balance rows: (warehouse_id, variant_id). Never change without updating docs. */
function sortForLocking(lines: PreparedLine[]): PreparedLine[] {
  return [...lines].sort((a, b) => {
    const byWarehouse = a.input.warehouseId.localeCompare(b.input.warehouseId);
    return byWarehouse !== 0 ? byWarehouse : a.input.variantId.localeCompare(b.input.variantId);
  });
}

function withoutProduct({ productId: _productId, ...rest }: UpdatedBalance): BalanceSnapshot {
  return rest;
}
