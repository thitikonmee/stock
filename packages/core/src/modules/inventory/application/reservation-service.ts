import { sql } from 'kysely';
import type { Tx } from '@stockos/database';
import {
  BusinessRuleError,
  Dec,
  NotFoundError,
  ValidationError,
  formatQuantity,
  isUuid,
  uuidv7,
} from '@stockos/shared';
import { assertCan, type Principal } from '../../iam/public-api';
import { InventoryEngine } from './inventory-engine';

export type ReservationStatus =
  'RESERVED' | 'COMMITTED' | 'PARTIALLY_FULFILLED' | 'FULFILLED' | 'RELEASED' | 'EXPIRED';

export interface Reservation {
  id: string;
  warehouseId: string;
  variantId: string;
  quantity: string;
  fulfilledQty: string;
  releasedQty: string;
  status: ReservationStatus;
  referenceType: string;
  referenceId: string;
  expiresAt: string | null;
}

export interface ReserveLine {
  warehouseId: string;
  variantId: string;
  quantity: string;
}
export interface ReserveInput {
  referenceType: string;
  referenceId: string;
  items: readonly ReserveLine[];
  /** Soft reservation TTL. Omitted = no expiry (the caller is expected to release explicitly). */
  ttlSeconds?: number;
  idempotencyKey: string;
  channelCode?: string;
}

/**
 * Order-line-level holds on top of InventoryEngine's bucket movements (docs/04-inventory.md).
 * `RESERVE` is soft (has a TTL, meant to be swept — see `releaseExpired`); `commit` promotes a
 * reservation to a hard hold (COMMITTED) with no expiry, e.g. once payment is confirmed.
 */
export class ReservationService {
  private readonly engine = new InventoryEngine();

  async reserve(tx: Tx, principal: Principal, input: ReserveInput): Promise<Reservation[]> {
    assertCan(principal, 'inventory.read'); // reservation is triggered by order/channel flows, not a direct user action
    if (input.items.length === 0) throw new ValidationError('At least one line is required');
    const expiresAt = input.ttlSeconds ? new Date(Date.now() + input.ttlSeconds * 1000) : null;

    const result = await this.engine.apply(tx, {
      tenantId: principal.tenantId,
      operation: 'RESERVE',
      idempotencyKey: input.idempotencyKey,
      reference: { type: input.referenceType, id: input.referenceId },
      ...(input.channelCode ? { channelCode: input.channelCode } : {}),
      lines: input.items.map((i) => ({
        warehouseId: i.warehouseId,
        variantId: i.variantId,
        quantity: i.quantity,
      })),
    });

    const rows: Reservation[] = [];
    for (const item of input.items) {
      // A replayed movement did not touch the balance again, so the reservation row's own quantity
      // must not grow either — only a genuinely new RESERVE accumulates onto an existing row (e.g.
      // reserving more against the same order line in a later call).
      const { rows: existing } = await sql<ReservationRow>`
        insert into inventory_reservations (tenant_id, id, warehouse_id, variant_id, quantity, status,
                                            reference_type, reference_id, channel_code, expires_at)
        values (${principal.tenantId}, ${uuidv7()}, ${item.warehouseId}, ${item.variantId}, ${item.quantity},
                'RESERVED', ${input.referenceType}, ${input.referenceId}, ${input.channelCode ?? null}, ${expiresAt})
        on conflict (tenant_id, reference_type, reference_id, warehouse_id, variant_id) do update
          set quantity = case when ${result.replayed} then inventory_reservations.quantity
                               else inventory_reservations.quantity + excluded.quantity end,
              expires_at = coalesce(excluded.expires_at, inventory_reservations.expires_at),
              updated_at = now()
        returning ${cols}`.execute(tx);
      rows.push(toReservation(existing[0]!));
    }
    return rows;
  }

  async release(tx: Tx, principal: Principal, id: string, quantity?: string): Promise<Reservation> {
    assertCan(principal, 'inventory.read');
    const r = await this.getOrThrow(tx, id);
    if (r.status !== 'RESERVED') {
      throw new BusinessRuleError('RESERVATION_NOT_RELEASABLE', `Reservation is ${r.status}, not RESERVED`);
    }
    const qty = quantity ?? formatQuantity(new Dec(r.quantity).minus(r.releasedQty));
    await this.engine.apply(tx, {
      tenantId: principal.tenantId,
      operation: 'RELEASE',
      idempotencyKey: `reservation:${id}:release:${qty}`,
      reference: { type: r.referenceType, id: r.referenceId },
      lines: [{ warehouseId: r.warehouseId, variantId: r.variantId, quantity: qty }],
    });
    return this.updateStatus(tx, id, { releasedDelta: qty, fullQty: r.quantity, terminalStatus: 'RELEASED' });
  }

  async commit(tx: Tx, principal: Principal, id: string): Promise<Reservation> {
    assertCan(principal, 'inventory.read');
    const r = await this.getOrThrow(tx, id);
    if (r.status !== 'RESERVED') {
      throw new BusinessRuleError('RESERVATION_NOT_COMMITTABLE', `Reservation is ${r.status}, not RESERVED`);
    }
    const remaining = new Dec(r.quantity).minus(r.releasedQty);
    await this.engine.apply(tx, {
      tenantId: principal.tenantId,
      operation: 'COMMIT',
      idempotencyKey: `reservation:${id}:commit`,
      reference: { type: r.referenceType, id: r.referenceId },
      lines: [{ warehouseId: r.warehouseId, variantId: r.variantId, quantity: formatQuantity(remaining) }],
    });
    await sql`update inventory_reservations set status = 'COMMITTED', expires_at = null where id = ${id}`.execute(
      tx,
    );
    return this.getOrThrow(tx, id);
  }

  /** The reverse of `commit`: a COMMITTED hold given back (e.g. order cancelled after confirmation). */
  async uncommit(tx: Tx, principal: Principal, id: string): Promise<Reservation> {
    assertCan(principal, 'inventory.read');
    const r = await this.getOrThrow(tx, id);
    if (r.status !== 'COMMITTED') {
      throw new BusinessRuleError('RESERVATION_NOT_COMMITTED', `Reservation is ${r.status}, not COMMITTED`);
    }
    const remaining = new Dec(r.quantity).minus(r.releasedQty).minus(r.fulfilledQty);
    await this.engine.apply(tx, {
      tenantId: principal.tenantId,
      operation: 'UNCOMMIT',
      idempotencyKey: `reservation:${id}:uncommit`,
      reference: { type: r.referenceType, id: r.referenceId },
      lines: [{ warehouseId: r.warehouseId, variantId: r.variantId, quantity: formatQuantity(remaining) }],
    });
    return this.updateStatus(tx, id, {
      releasedDelta: formatQuantity(remaining),
      fullQty: r.quantity,
      terminalStatus: 'RELEASED',
    });
  }

  /** Record that `quantity` of a COMMITTED hold left the building (a shipment). Does not itself move
   *  stock — the caller applies InventoryEngine's SHIP operation; this just keeps the reservation's
   *  own bookkeeping (`fulfilled_qty`) in step so its status flips to FULFILLED once fully shipped. */
  async markFulfilled(tx: Tx, principal: Principal, id: string, quantity: string): Promise<Reservation> {
    assertCan(principal, 'inventory.read');
    const { rows } = await sql<ReservationRow>`
      update inventory_reservations
         set fulfilled_qty = fulfilled_qty + ${quantity}::numeric,
             status = case when released_qty + fulfilled_qty + ${quantity}::numeric >= quantity
                           then 'FULFILLED' else 'PARTIALLY_FULFILLED' end
       where id = ${id} and tenant_id = ${principal.tenantId}
      returning ${cols}`.execute(tx);
    const row = rows[0];
    if (!row) throw new NotFoundError('Reservation not found');
    return toReservation(row);
  }

  async get(tx: Tx, principal: Principal, id: string): Promise<Reservation> {
    assertCan(principal, 'inventory.read');
    return this.getOrThrow(tx, id);
  }

  async list(
    tx: Tx,
    principal: Principal,
    query: { referenceType?: string; referenceId?: string; status?: ReservationStatus },
  ): Promise<Reservation[]> {
    assertCan(principal, 'inventory.read');
    const { rows } = await sql<ReservationRow>`
      select ${cols} from inventory_reservations
       where (${query.referenceType ?? null}::text is null or reference_type = ${query.referenceType ?? null})
         and (${query.referenceId ?? null}::uuid is null or reference_id = ${query.referenceId ?? null})
         and (${query.status ?? null}::text is null or status = ${query.status ?? null})
       order by created_at desc limit 200`.execute(tx);
    return rows.map(toReservation);
  }

  /** Release every RESERVED row past its expiry. Meant to run on a schedule (no scheduler yet — Phase 3
   *  exposes it as an admin-triggered endpoint; a cron/worker can call the same code later). */
  async releaseExpired(tx: Tx, tenantId: string): Promise<number> {
    const { rows } = await sql<{
      id: string;
      warehouse_id: string;
      variant_id: string;
      quantity: string;
      released_qty: string;
      reference_type: string;
      reference_id: string;
    }>`
      select id, warehouse_id, variant_id, quantity, released_qty, reference_type, reference_id
        from inventory_reservations
       where tenant_id = ${tenantId} and status = 'RESERVED' and expires_at is not null and expires_at < now()
       order by id
       for update skip locked`.execute(tx);
    for (const r of rows) {
      const remaining = formatQuantity(new Dec(r.quantity).minus(r.released_qty));
      await this.engine.apply(tx, {
        tenantId,
        operation: 'RELEASE',
        idempotencyKey: `reservation:${r.id}:expire`,
        reference: { type: r.reference_type, id: r.reference_id },
        lines: [{ warehouseId: r.warehouse_id, variantId: r.variant_id, quantity: remaining }],
      });
      await sql`update inventory_reservations set status = 'EXPIRED', released_qty = quantity where id = ${r.id}`.execute(
        tx,
      );
    }
    return rows.length;
  }

  private async updateStatus(
    tx: Tx,
    id: string,
    opts: { releasedDelta: string; fullQty: string; terminalStatus: ReservationStatus },
  ): Promise<Reservation> {
    const { rows } = await sql<ReservationRow>`
      update inventory_reservations
         set released_qty = released_qty + ${opts.releasedDelta}::numeric,
             status = case when released_qty + fulfilled_qty + ${opts.releasedDelta}::numeric >= quantity
                           then ${opts.terminalStatus} else status end
       where id = ${id}
      returning ${cols}`.execute(tx);
    return toReservation(rows[0]!);
  }

  private async getOrThrow(tx: Tx, id: string): Promise<Reservation> {
    if (!isUuid(id)) throw new NotFoundError('Reservation not found');
    const { rows } =
      await sql<ReservationRow>`select ${cols} from inventory_reservations where id = ${id}`.execute(tx);
    const row = rows[0];
    if (!row) throw new NotFoundError('Reservation not found');
    return toReservation(row);
  }
}

interface ReservationRow {
  id: string;
  warehouse_id: string;
  variant_id: string;
  quantity: string;
  fulfilled_qty: string;
  released_qty: string;
  status: ReservationStatus;
  reference_type: string;
  reference_id: string;
  expires_at: Date | null;
}
const cols = sql`id, warehouse_id, variant_id, quantity, fulfilled_qty, released_qty, status, reference_type, reference_id, expires_at`;
const toReservation = (r: ReservationRow): Reservation => ({
  id: r.id,
  warehouseId: r.warehouse_id,
  variantId: r.variant_id,
  quantity: r.quantity,
  fulfilledQty: r.fulfilled_qty,
  releasedQty: r.released_qty,
  status: r.status,
  referenceType: r.reference_type,
  referenceId: r.reference_id,
  expiresAt: r.expires_at?.toISOString() ?? null,
});
