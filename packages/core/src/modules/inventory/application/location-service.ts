import { sql } from 'kysely';
import type { Tx } from '@stockos/database';
import {
  BusinessRuleError,
  ConflictError,
  Dec,
  NotFoundError,
  ValidationError,
  formatQuantity,
  isUuid,
  toQuantity,
} from '@stockos/shared';
import { PgErrorCode, pgErrorCode } from '@stockos/database';
import { recordAudit } from '../../audit/public-api';
import { assertCan, type Principal } from '../../iam/public-api';

export type LocationLevel = 'ZONE' | 'RACK' | 'SHELF' | 'BIN';
const LEVELS: readonly LocationLevel[] = ['ZONE', 'RACK', 'SHELF', 'BIN'];

export interface WarehouseLocation {
  id: string;
  warehouseId: string;
  parentId: string | null;
  level: LocationLevel;
  code: string;
  fullCode: string;
  barcode: string | null;
  isPickable: boolean;
  isActive: boolean;
}

export interface LocationStock {
  locationId: string;
  fullCode: string;
  variantId: string;
  sku: string;
  variantName: string;
  onHand: string;
}

export interface CreateLocationInput {
  warehouseId: string;
  parentId?: string;
  level: LocationLevel;
  code: string;
  barcode?: string;
  isPickable?: boolean;
}

export interface LocationMoveLine {
  variantId: string;
  quantity: string;
  fromLocationId?: string;
  toLocationId?: string;
}

export interface PickSuggestion {
  locationId: string;
  fullCode: string;
  quantity: string;
}

export interface LocationDiscrepancy {
  variantId: string;
  sku: string;
  warehouseOnHand: string;
  locatedOnHand: string;
  /** warehouse on_hand − Σ bins: > 0 = not put away yet, < 0 = bins claim more than exists. */
  unlocated: string;
}

/**
 * Bin-level stock (docs/04-inventory.md §9 "Location (bin) inventory"). `inventory_balances` stays
 * the source of truth for sellable stock (reservations, availability) at warehouse level; bins only
 * track *where* that on_hand sits, for putaway, picking and counting. The invariant is
 * Σ bin on_hand ≤ warehouse on_hand, the difference being stock not put away yet ("unlocated").
 *
 * Putaway checks the unlocated amount while holding the warehouse balance row lock (FOR UPDATE —
 * a read lock only; the row itself is still only ever written by InventoryEngine), so two
 * concurrent putaways can't both claim the same unlocated units. Moves/picks out of a bin are a
 * single conditional UPDATE (… WHERE on_hand >= qty), atomic on their own.
 */
export class LocationService {
  async create(tx: Tx, principal: Principal, input: CreateLocationInput): Promise<WarehouseLocation> {
    assertCan(principal, 'warehouse.manage', { warehouseId: input.warehouseId });
    await requireWarehouse(tx, input.warehouseId);
    const code = input.code.trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9_.]{0,19}$/.test(code))
      throw new ValidationError('code must be 1-20 chars: A-Z 0-9 _ .');

    let fullCode = code;
    if (input.parentId) {
      if (!isUuid(input.parentId)) throw new ValidationError('Unknown parent location');
      const { rows } = await sql<{ warehouse_id: string; level: LocationLevel; full_code: string }>`
        select warehouse_id, level, full_code from warehouse_locations where id = ${input.parentId}`.execute(
        tx,
      );
      const parent = rows[0];
      if (!parent || parent.warehouse_id !== input.warehouseId)
        throw new ValidationError('Unknown parent location');
      if (LEVELS.indexOf(input.level) <= LEVELS.indexOf(parent.level)) {
        throw new ValidationError(`A ${input.level} cannot sit inside a ${parent.level}`);
      }
      fullCode = `${parent.full_code}-${code}`;
    } else if (input.level !== 'ZONE') {
      throw new ValidationError('Only a ZONE may be top-level');
    }

    try {
      const { rows } = await sql<{ id: string }>`
        insert into warehouse_locations (tenant_id, warehouse_id, parent_id, level, code, full_code, barcode, is_pickable)
        values (${principal.tenantId}, ${input.warehouseId}, ${input.parentId ?? null}, ${input.level}, ${code},
                ${fullCode}, ${input.barcode ?? null}, ${input.isPickable ?? true})
        returning id`.execute(tx);
      await sql`update warehouses set use_locations = true where id = ${input.warehouseId} and not use_locations`.execute(
        tx,
      );
      await recordAudit(tx, {
        tenantId: principal.tenantId,
        action: 'warehouse.location.create',
        resourceType: 'warehouse_location',
        resourceId: rows[0]!.id,
        after: { fullCode },
      });
      return this.getOrThrow(tx, rows[0]!.id);
    } catch (err) {
      if (pgErrorCode(err) === PgErrorCode.UniqueViolation) {
        throw new ConflictError(`Location ${fullCode} already exists`, { fullCode });
      }
      throw err;
    }
  }

  async update(
    tx: Tx,
    principal: Principal,
    id: string,
    input: { isActive?: boolean; isPickable?: boolean; barcode?: string | null },
  ): Promise<WarehouseLocation> {
    const loc = await this.getOrThrow(tx, id);
    assertCan(principal, 'warehouse.manage', { warehouseId: loc.warehouseId });
    if (input.isActive === false) {
      const { rows } = await sql<{ n: string }>`
        select coalesce(sum(on_hand), 0) as n from inventory_location_balances where location_id = ${id}`.execute(
        tx,
      );
      if (new Dec(rows[0]!.n).greaterThan(0)) {
        throw new BusinessRuleError(
          'LOCATION_NOT_EMPTY',
          'Move the stock out of this location before deactivating it',
        );
      }
    }
    await sql`update warehouse_locations set
                is_active = coalesce(${input.isActive ?? null}::boolean, is_active),
                is_pickable = coalesce(${input.isPickable ?? null}::boolean, is_pickable),
                barcode = case when ${input.barcode !== undefined} then ${input.barcode ?? null} else barcode end
              where id = ${id}`.execute(tx);
    return this.getOrThrow(tx, id);
  }

  async list(tx: Tx, principal: Principal, warehouseId: string): Promise<WarehouseLocation[]> {
    assertCan(principal, 'inventory.read', { warehouseId });
    await requireWarehouse(tx, warehouseId);
    const { rows } = await sql<LocationRow>`
      select ${locCols} from warehouse_locations where warehouse_id = ${warehouseId} order by full_code`.execute(
      tx,
    );
    return rows.map(toLocation);
  }

  async stock(
    tx: Tx,
    principal: Principal,
    warehouseId: string,
    query: { locationId?: string; variantId?: string } = {},
  ): Promise<LocationStock[]> {
    assertCan(principal, 'inventory.read', { warehouseId });
    await requireWarehouse(tx, warehouseId);
    if (query.locationId && !isUuid(query.locationId)) return [];
    if (query.variantId && !isUuid(query.variantId)) return [];
    const { rows } = await sql<{
      location_id: string;
      full_code: string;
      variant_id: string;
      sku: string;
      variant_name: string;
      on_hand: string;
    }>`
      select b.location_id, l.full_code, b.variant_id, v.sku, v.name as variant_name, b.on_hand
        from inventory_location_balances b
        join warehouse_locations l on l.id = b.location_id
        join product_variants v on v.id = b.variant_id
       where b.warehouse_id = ${warehouseId} and b.on_hand > 0
         and (${query.locationId ?? null}::uuid is null or b.location_id = ${query.locationId ?? null})
         and (${query.variantId ?? null}::uuid is null or b.variant_id = ${query.variantId ?? null})
       order by l.full_code, v.sku limit 1000`.execute(tx);
    return rows.map((r) => ({
      locationId: r.location_id,
      fullCode: r.full_code,
      variantId: r.variant_id,
      sku: r.sku,
      variantName: r.variant_name,
      onHand: r.on_hand,
    }));
  }

  /**
   * Moves stock into, between or out of bins. A line with only `toLocationId` is a putaway from
   * unlocated stock; only `fromLocationId` is a pick (stock leaving the bin); both is a bin-to-bin move.
   */
  async move(
    tx: Tx,
    principal: Principal,
    warehouseId: string,
    lines: readonly LocationMoveLine[],
  ): Promise<void> {
    assertCan(principal, 'inventory.transfer', { warehouseId });
    await requireWarehouse(tx, warehouseId);
    if (lines.length === 0 || lines.length > 500) throw new ValidationError('Send 1..500 lines');
    for (const line of lines) {
      if (!isUuid(line.variantId))
        throw new ValidationError('Unknown variant', { variantId: line.variantId });
      if (!line.fromLocationId && !line.toLocationId)
        throw new ValidationError('A line needs a from or to location');
      if (line.fromLocationId && line.fromLocationId === line.toLocationId) {
        throw new ValidationError('from and to must differ');
      }
      const qty = toQuantity(line.quantity);
      if (line.toLocationId) await this.requireLocation(tx, warehouseId, line.toLocationId);
      if (line.fromLocationId) {
        await this.requireLocation(tx, warehouseId, line.fromLocationId, false);
        const { rows } = await sql`
          update inventory_location_balances set on_hand = on_hand - ${formatQuantity(qty)}, updated_at = now()
           where location_id = ${line.fromLocationId} and variant_id = ${line.variantId}
             and on_hand >= ${formatQuantity(qty)}
          returning 1`.execute(tx);
        if (rows.length === 0) {
          throw new BusinessRuleError('LOCATION_STOCK_INSUFFICIENT', 'Not enough stock in that location', {
            locationId: line.fromLocationId,
            variantId: line.variantId,
          });
        }
      } else {
        // Putaway: lock the warehouse balance row, then make sure enough stock is still unlocated.
        const { rows } = await sql<{ on_hand: string }>`
          select on_hand from inventory_balances where warehouse_id = ${warehouseId} and variant_id = ${line.variantId}
          for update`.execute(tx);
        const { rows: located } = await sql<{ n: string }>`
          select coalesce(sum(on_hand), 0) as n from inventory_location_balances
           where warehouse_id = ${warehouseId} and variant_id = ${line.variantId}`.execute(tx);
        const unlocated = new Dec(rows[0]?.on_hand ?? 0).minus(located[0]!.n);
        if (qty.greaterThan(unlocated)) {
          throw new BusinessRuleError(
            'LOCATION_STOCK_INSUFFICIENT',
            'Not enough unlocated stock to put away',
            {
              variantId: line.variantId,
              unlocated: formatQuantity(unlocated.isNegative() ? new Dec(0) : unlocated),
            },
          );
        }
      }
      if (line.toLocationId) {
        await sql`
          insert into inventory_location_balances (tenant_id, warehouse_id, location_id, variant_id, on_hand)
          values (${principal.tenantId}, ${warehouseId}, ${line.toLocationId}, ${line.variantId}, ${formatQuantity(qty)})
          on conflict (tenant_id, location_id, variant_id)
            do update set on_hand = inventory_location_balances.on_hand + excluded.on_hand, updated_at = now()`.execute(
          tx,
        );
      }
    }
    await recordAudit(tx, {
      tenantId: principal.tenantId,
      action: 'warehouse.location.move',
      resourceType: 'warehouse',
      resourceId: warehouseId,
      after: { lines: lines.length },
    });
  }

  /** Which bins to pick `quantity` from: pickable, active bins, fullest first. */
  async pickSuggestions(
    tx: Tx,
    principal: Principal,
    warehouseId: string,
    variantId: string,
    quantity: string,
  ): Promise<{ suggestions: PickSuggestion[]; shortfall: string }> {
    assertCan(principal, 'inventory.read', { warehouseId });
    await requireWarehouse(tx, warehouseId);
    if (!isUuid(variantId)) throw new ValidationError('Unknown variant');
    let remaining = toQuantity(quantity);
    const { rows } = await sql<{ location_id: string; full_code: string; on_hand: string }>`
      select b.location_id, l.full_code, b.on_hand
        from inventory_location_balances b join warehouse_locations l on l.id = b.location_id
       where b.warehouse_id = ${warehouseId} and b.variant_id = ${variantId} and b.on_hand > 0
         and l.is_active and l.is_pickable
       order by b.on_hand desc, l.full_code`.execute(tx);
    const suggestions: PickSuggestion[] = [];
    for (const r of rows) {
      if (remaining.lessThanOrEqualTo(0)) break;
      const take = Dec.min(remaining, r.on_hand);
      suggestions.push({ locationId: r.location_id, fullCode: r.full_code, quantity: formatQuantity(take) });
      remaining = remaining.minus(take);
    }
    return { suggestions, shortfall: formatQuantity(remaining.isNegative() ? new Dec(0) : remaining) };
  }

  /** SKUs whose bins don't add up to the warehouse on_hand (reconcile job/report). */
  async discrepancies(tx: Tx, principal: Principal, warehouseId: string): Promise<LocationDiscrepancy[]> {
    assertCan(principal, 'inventory.read', { warehouseId });
    await requireWarehouse(tx, warehouseId);
    const { rows } = await sql<{ variant_id: string; sku: string; wh: string; located: string }>`
      select coalesce(b.variant_id, lb.variant_id) as variant_id, v.sku,
             coalesce(b.on_hand, 0) as wh, coalesce(lb.located, 0) as located
        from (select variant_id, on_hand from inventory_balances where warehouse_id = ${warehouseId}) b
        full join (select variant_id, sum(on_hand) as located from inventory_location_balances
                    where warehouse_id = ${warehouseId} group by variant_id) lb on lb.variant_id = b.variant_id
        join product_variants v on v.id = coalesce(b.variant_id, lb.variant_id)
       where coalesce(b.on_hand, 0) <> coalesce(lb.located, 0)
       order by v.sku limit 1000`.execute(tx);
    return rows.map((r) => ({
      variantId: r.variant_id,
      sku: r.sku,
      warehouseOnHand: formatQuantity(new Dec(r.wh)),
      locatedOnHand: formatQuantity(new Dec(r.located)),
      unlocated: formatQuantity(new Dec(r.wh).minus(r.located)),
    }));
  }

  private async requireLocation(tx: Tx, warehouseId: string, id: string, mustBeActive = true): Promise<void> {
    if (!isUuid(id)) throw new ValidationError('Unknown location', { locationId: id });
    const { rows } = await sql<{ warehouse_id: string; is_active: boolean }>`
      select warehouse_id, is_active from warehouse_locations where id = ${id}`.execute(tx);
    const loc = rows[0];
    if (!loc || loc.warehouse_id !== warehouseId)
      throw new ValidationError('Unknown location', { locationId: id });
    if (mustBeActive && !loc.is_active) throw new ValidationError('Location is inactive', { locationId: id });
  }

  private async getOrThrow(tx: Tx, id: string): Promise<WarehouseLocation> {
    if (!isUuid(id)) throw new NotFoundError('Location not found');
    const { rows } =
      await sql<LocationRow>`select ${locCols} from warehouse_locations where id = ${id}`.execute(tx);
    if (!rows[0]) throw new NotFoundError('Location not found');
    return toLocation(rows[0]);
  }
}

interface LocationRow {
  id: string;
  warehouse_id: string;
  parent_id: string | null;
  level: LocationLevel;
  code: string;
  full_code: string;
  barcode: string | null;
  is_pickable: boolean;
  is_active: boolean;
}
const locCols = sql`id, warehouse_id, parent_id, level, code, full_code, barcode, is_pickable, is_active`;

function toLocation(r: LocationRow): WarehouseLocation {
  return {
    id: r.id,
    warehouseId: r.warehouse_id,
    parentId: r.parent_id,
    level: r.level,
    code: r.code,
    fullCode: r.full_code,
    barcode: r.barcode,
    isPickable: r.is_pickable,
    isActive: r.is_active,
  };
}

/** 404 for an unknown warehouse — including another tenant's, which RLS hides. */
async function requireWarehouse(tx: Tx, warehouseId: string): Promise<void> {
  if (!isUuid(warehouseId)) throw new NotFoundError('Warehouse not found');
  const { rows } = await sql`select 1 from warehouses where id = ${warehouseId}`.execute(tx);
  if (rows.length === 0) throw new NotFoundError('Warehouse not found');
}
