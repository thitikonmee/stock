import { sql } from 'kysely';
import { PgErrorCode, pgErrorCode, type Tx } from '@stockos/database';
import { BusinessRuleError, Dec, NotFoundError, formatMoney, toMoney, uuidv7 } from '@stockos/shared';
import { recordAudit } from '../../audit/public-api';
import { assertCan, type Principal } from '../../iam/public-api';
import type { DeviceService } from '../../tenancy/public-api';
import type { CashMovement, CashMovementType, Shift } from '../domain/types';

export interface OpenShiftInput {
  posDeviceId: string;
  openingCash: string;
}
export interface CloseShiftInput {
  countedCash: string;
}
export interface CashMovementInput {
  type: CashMovementType;
  amount: string;
  reason?: string;
}

/** Shift open/close, Z-report and cash drawer movements (docs/05-pos.md §15). */
export class ShiftService {
  constructor(private readonly devices: DeviceService) {}

  async open(tx: Tx, principal: Principal, input: OpenShiftInput): Promise<Shift> {
    assertCan(principal, 'pos.shift.open');
    await this.devices.forSale(tx, input.posDeviceId);
    const openingCash = formatMoney(toMoney(input.openingCash));
    const id = uuidv7();
    try {
      await sql`
        insert into pos_shifts (tenant_id, id, pos_device_id, cashier_id, status, opened_at, opening_cash)
        values (${principal.tenantId}, ${id}, ${input.posDeviceId}, ${principal.membershipId}, 'OPEN', now(), ${openingCash})`.execute(
        tx,
      );
    } catch (err) {
      if (pgErrorCode(err) === PgErrorCode.UniqueViolation) {
        throw new BusinessRuleError('SHIFT_ALREADY_OPEN', 'This device already has an open shift');
      }
      throw err;
    }
    await recordAudit(tx, {
      tenantId: principal.tenantId,
      action: 'pos.shift.open',
      resourceType: 'pos_shift',
      resourceId: id,
      after: { posDeviceId: input.posDeviceId, openingCash },
    });
    return this.getOrThrow(tx, id);
  }

  async close(tx: Tx, principal: Principal, shiftId: string, input: CloseShiftInput): Promise<Shift> {
    assertCan(principal, 'pos.shift.close');
    const shift = await this.getOrThrow(tx, shiftId);
    if (shift.status !== 'OPEN') throw new BusinessRuleError('SHIFT_NOT_OPEN', 'Shift is not open');

    const [cashSales, movements, byMethod, salesCount, refundTotal, cashRefunds] = await Promise.all([
      this.sumPayments(tx, shiftId, 'CASH'),
      this.sumMovements(tx, shiftId),
      this.sumByMethod(tx, shiftId),
      this.countSales(tx, shiftId),
      this.sumRefunds(tx, shiftId),
      this.sumRefunds(tx, shiftId, 'CASH'),
    ]);
    const expected = new Dec(shift.openingCash)
      .plus(cashSales)
      .plus(movements.payIn)
      .minus(movements.payOut)
      .minus(movements.drop)
      .minus(cashRefunds);
    const counted = toMoney(input.countedCash);
    const variance = counted.minus(expected);

    await sql`
      update pos_shifts
         set status = 'CLOSED', closed_at = now(), expected_cash = ${formatMoney(expected)},
             counted_cash = ${formatMoney(counted)}, cash_variance = ${formatMoney(variance)},
             closed_by = ${principal.membershipId},
             summary = ${JSON.stringify({ byMethod, salesCount, refundTotal: formatMoney(refundTotal) })}::jsonb
       where id = ${shiftId}`.execute(tx);
    await recordAudit(tx, {
      tenantId: principal.tenantId,
      action: 'pos.shift.close',
      resourceType: 'pos_shift',
      resourceId: shiftId,
      after: {
        expectedCash: formatMoney(expected),
        countedCash: formatMoney(counted),
        variance: formatMoney(variance),
      },
    });
    return this.getOrThrow(tx, shiftId);
  }

  async addCashMovement(
    tx: Tx,
    principal: Principal,
    shiftId: string,
    input: CashMovementInput,
  ): Promise<CashMovement> {
    assertCan(principal, 'pos.cash.in_out');
    const shift = await this.getOrThrow(tx, shiftId);
    if (shift.status !== 'OPEN') throw new BusinessRuleError('SHIFT_NOT_OPEN', 'Shift is not open');
    const amount = formatMoney(toMoney(input.amount));
    const id = uuidv7();
    await sql`
      insert into pos_cash_movements (tenant_id, id, shift_id, type, amount, reason, user_id, approved_by, occurred_at)
      values (${principal.tenantId}, ${id}, ${shiftId}, ${input.type}, ${amount}, ${input.reason ?? null},
              ${principal.membershipId}, ${principal.membershipId}, now())`.execute(tx);
    await recordAudit(tx, {
      tenantId: principal.tenantId,
      action: 'pos.cash_movement.create',
      resourceType: 'pos_cash_movement',
      resourceId: id,
      after: { shiftId, type: input.type, amount },
    });
    const { rows } =
      await sql<CashMovementRow>`select ${movementCols} from pos_cash_movements where id = ${id}`.execute(tx);
    return toMovement(rows[0]!);
  }

  async get(tx: Tx, principal: Principal, shiftId: string): Promise<Shift> {
    assertCan(principal, 'pos.sell');
    return this.getOrThrow(tx, shiftId);
  }

  async current(tx: Tx, principal: Principal, posDeviceId: string): Promise<Shift | null> {
    assertCan(principal, 'pos.sell');
    const { rows } = await sql<ShiftRow>`
      select ${shiftCols} from pos_shifts where pos_device_id = ${posDeviceId} and status = 'OPEN'`.execute(
      tx,
    );
    return rows[0] ? toShift(rows[0]) : null;
  }

  async list(tx: Tx, principal: Principal, posDeviceId?: string): Promise<Shift[]> {
    assertCan(principal, 'pos.sell');
    const { rows } = await sql<ShiftRow>`
      select ${shiftCols} from pos_shifts
       where (${posDeviceId ?? null}::uuid is null or pos_device_id = ${posDeviceId ?? null})
       order by opened_at desc limit 100`.execute(tx);
    return rows.map(toShift);
  }

  private async getOrThrow(tx: Tx, id: string): Promise<Shift> {
    const { rows } = await sql<ShiftRow>`select ${shiftCols} from pos_shifts where id = ${id}`.execute(tx);
    const row = rows[0];
    if (!row) throw new NotFoundError('Shift not found');
    return toShift(row);
  }

  private async sumPayments(tx: Tx, shiftId: string, method: string): Promise<Dec> {
    const { rows } = await sql<{ total: string | null }>`
      select sum(amount) as total from payments
       where pos_shift_id = ${shiftId} and method = ${method} and status = 'SUCCEEDED'`.execute(tx);
    return new Dec(rows[0]?.total ?? '0');
  }

  private async sumByMethod(tx: Tx, shiftId: string): Promise<Record<string, string>> {
    const { rows } = await sql<{ method: string; total: string }>`
      select method, sum(amount) as total from payments
       where pos_shift_id = ${shiftId} and status = 'SUCCEEDED' group by method`.execute(tx);
    return Object.fromEntries(rows.map((r) => [r.method, formatMoney(new Dec(r.total))]));
  }

  private async countSales(tx: Tx, shiftId: string): Promise<number> {
    const { rows } = await sql<{ n: string }>`
      select count(*) as n from orders where pos_shift_id = ${shiftId} and status <> 'CANCELLED'`.execute(tx);
    return Number(rows[0]?.n ?? 0);
  }

  /** Refunds paid out of THIS shift's drawer — not the original sale's shift (docs/05-pos.md §16). */
  private async sumRefunds(tx: Tx, shiftId: string, method?: string): Promise<Dec> {
    const { rows } = await sql<{ total: string | null }>`
      select sum(r.amount) as total from refunds r
        join payments p on p.id = r.payment_id
       where r.pos_shift_id = ${shiftId} and r.status = 'SUCCEEDED'
         and (${method ?? null}::text is null or p.method = ${method ?? null})`.execute(tx);
    return new Dec(rows[0]?.total ?? '0');
  }

  private async sumMovements(tx: Tx, shiftId: string): Promise<{ payIn: Dec; payOut: Dec; drop: Dec }> {
    const { rows } = await sql<{ type: CashMovementType; total: string }>`
      select type, sum(amount) as total from pos_cash_movements where shift_id = ${shiftId} group by type`.execute(
      tx,
    );
    const byType = Object.fromEntries(rows.map((r) => [r.type, new Dec(r.total)]));
    return {
      payIn: byType['PAY_IN'] ?? new Dec(0),
      payOut: byType['PAY_OUT'] ?? new Dec(0),
      drop: byType['DROP'] ?? new Dec(0),
    };
  }
}

interface ShiftRow {
  id: string;
  pos_device_id: string;
  cashier_id: string;
  status: Shift['status'];
  opened_at: Date;
  closed_at: Date | null;
  opening_cash: string;
  expected_cash: string | null;
  counted_cash: string | null;
  cash_variance: string | null;
  summary: Record<string, unknown> | null;
  closed_by: string | null;
}
const shiftCols = sql`id, pos_device_id, cashier_id, status, opened_at, closed_at, opening_cash,
  expected_cash, counted_cash, cash_variance, summary, closed_by`;
const toShift = (r: ShiftRow): Shift => ({
  id: r.id,
  posDeviceId: r.pos_device_id,
  cashierId: r.cashier_id,
  status: r.status,
  openedAt: r.opened_at.toISOString(),
  closedAt: r.closed_at?.toISOString() ?? null,
  openingCash: r.opening_cash,
  expectedCash: r.expected_cash,
  countedCash: r.counted_cash,
  cashVariance: r.cash_variance,
  summary: r.summary,
  closedBy: r.closed_by,
});

interface CashMovementRow {
  id: string;
  shift_id: string;
  type: CashMovementType;
  amount: string;
  reason: string | null;
  user_id: string;
  approved_by: string | null;
  occurred_at: Date;
}
const movementCols = sql`id, shift_id, type, amount, reason, user_id, approved_by, occurred_at`;
const toMovement = (r: CashMovementRow): CashMovement => ({
  id: r.id,
  shiftId: r.shift_id,
  type: r.type,
  amount: r.amount,
  reason: r.reason,
  userId: r.user_id,
  approvedBy: r.approved_by,
  occurredAt: r.occurred_at.toISOString(),
});
