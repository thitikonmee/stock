import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import type { Tx } from '@stockos/database';
import { uuidv7 } from '@stockos/shared';
import { systemPrincipal, type Principal } from '../../iam/public-api';
import { recordAudit } from '../../audit/public-api';
import type { ReservationService } from '../../inventory/public-api';
import { nextDocumentNumber } from '../../tenancy/public-api';
import {
  computeOrderTotals,
  canTransition,
  type OrderService,
  type FulfillmentService,
  type OrderStatus,
} from '../../orders/public-api';
import type { NotificationService } from '../../notifications/public-api';
import type { NormalizedChannelOrder, NormalizedOrderStatus } from '../domain/channel-adapter';
import type { ChannelAccount } from '../domain/types';
import { deterministicUuid } from './deterministic-id';

const SYSTEM_PERMISSIONS = [
  'order.create',
  'order.read',
  'order.update',
  'order.cancel',
  'order.fulfill',
  'inventory.read',
  'channel.read',
  'channel.mapping',
] as const;

/** Linear order of statuses this ingest walks through one event at a time to catch a normalized
 *  status up from wherever the internal order currently sits (docs §21 "out-of-order... กระโดด
 *  ไปข้างหน้า"). Terminal branches (CANCELLED, RETURN) are handled outside this line. */
const LINE: OrderStatus[] = [
  'PENDING',
  'PAID',
  'CONFIRMED',
  'PROCESSING',
  'PACKED',
  'SHIPPED',
  'DELIVERED',
  'COMPLETED',
];

const NORMALIZED_TO_INTERNAL: Partial<Record<NormalizedOrderStatus, OrderStatus>> = {
  PENDING: 'PENDING',
  CONFIRMED: 'CONFIRMED',
  PACKED: 'PACKED',
  SHIPPED: 'SHIPPED',
  DELIVERED: 'DELIVERED',
  COMPLETED: 'COMPLETED',
};

export interface IngestResult {
  outcome: 'CREATED' | 'ADVANCED' | 'ON_HOLD' | 'NO_CHANGE' | 'STALE' | 'CANCELLED' | 'DEFERRED';
  orderId?: string;
  detail?: string;
}

/**
 * Turns one `NormalizedChannelOrder` (from a webhook or a polling pull) into inventory effects and
 * an internal order (docs/06 §"Shopee order → stock flow"). Runs as `iam.systemPrincipal` — there
 * is no logged-in user behind a webhook — but reuses the same Principal-gated `orders.OrderService`
 * / `orders.FulfillmentService` methods a staff member's click would go through, so every inventory
 * effect still runs through `inventory.ReservationService` → `InventoryEngine`, never raw SQL here.
 */
export class OrderIngestService {
  constructor(
    private readonly reservations: ReservationService,
    private readonly orderService: OrderService,
    private readonly fulfillmentService: FulfillmentService,
    private readonly notifications: NotificationService,
  ) {}

  async ingestOne(
    tx: Tx,
    tenantId: string,
    account: ChannelAccount,
    normalized: NormalizedChannelOrder,
    source: 'CHANNEL_WEBHOOK' | 'CHANNEL_POLL',
  ): Promise<IngestResult> {
    const principal = systemPrincipal(tenantId, SYSTEM_PERMISSIONS);
    const snapshot = await this.loadChannelOrder(tx, account.id, normalized.externalOrderId);
    if (snapshot && snapshot.externalUpdateTime >= normalized.updateTime.getTime()) {
      return { outcome: 'STALE' };
    }

    const lineMappings = await this.resolveLines(tx, account.id, normalized);
    const unmapped = lineMappings.filter((l) => !l.variantId);
    const payloadHash = createHash('sha256').update(JSON.stringify(normalized.raw)).digest();

    await this.upsertChannelOrder(
      tx,
      tenantId,
      account.id,
      normalized,
      payloadHash,
      snapshot?.orderId ?? null,
    );

    if (unmapped.length > 0) {
      await sql`update channel_orders set processing_status = 'ON_HOLD',
                  error = ${`Unmapped SKU: ${unmapped.map((l) => l.externalSku ?? l.externalVariantId).join(', ')}`}
                where tenant_id = ${tenantId} and channel_account_id = ${account.id}
                  and external_order_id = ${normalized.externalOrderId}`.execute(tx);
      await this.notifications.notify(tx, {
        tenantId,
        eventType: 'CHANNEL_UNMAPPED_SKU',
        severity: 'WARNING',
        title: `${account.channelCode}: order ${normalized.externalOrderId} has an unmapped SKU`,
        body: unmapped.map((l) => l.externalSku ?? l.externalVariantId).join(', '),
        toPermission: 'channel.mapping',
        dedupKey: `unmapped:${account.id}:${normalized.externalOrderId}`,
        throttleMinutes: 60,
      });
      return { outcome: 'ON_HOLD', detail: 'unmapped SKU' };
    }

    let orderId = snapshot?.orderId ?? null;
    let created = false;
    if (!orderId && normalized.normalizedStatus !== 'CANCELLED') {
      orderId = await this.createOrder(tx, principal, tenantId, account, normalized, lineMappings);
      created = true;
    }
    if (!orderId) {
      await this.markProcessed(tx, tenantId, account.id, normalized.externalOrderId, null);
      return { outcome: 'NO_CHANGE', detail: 'cancelled before an order was ever created' };
    }

    const result = await this.advance(tx, principal, orderId, normalized.normalizedStatus, account, source);
    await this.markProcessed(tx, tenantId, account.id, normalized.externalOrderId, orderId);
    return created ? { outcome: 'CREATED', orderId } : { outcome: result, orderId };
  }

  // ---------------------------------------------------------------- state progression

  private async advance(
    tx: Tx,
    principal: Principal,
    orderId: string,
    target: NormalizedOrderStatus,
    account: ChannelAccount,
    source: 'CHANNEL_WEBHOOK' | 'CHANNEL_POLL',
  ): Promise<IngestResult['outcome']> {
    if (target === 'NO_CHANGE') return 'NO_CHANGE';
    if (target === 'RETURN_REQUESTED') return 'DEFERRED'; // channel-initiated returns: Phase 6 follow-up

    if (target === 'CANCELLED') {
      const order = await this.orderService.get(tx, principal, orderId);
      if (!canTransition(order.status, 'CANCEL')) return 'DEFERRED'; // already shipped — needs a human
      await this.orderService.cancel(tx, principal, orderId, `Cancelled on ${account.channelCode}`);
      return 'CANCELLED';
    }

    const targetInternal = NORMALIZED_TO_INTERNAL[target];
    if (!targetInternal) return 'NO_CHANGE';
    const targetIdx = LINE.indexOf(targetInternal);

    let advanced = false;
    for (;;) {
      const order = await this.orderService.get(tx, principal, orderId);
      const idx = LINE.indexOf(order.status);
      if (idx === -1 || idx >= targetIdx) break;
      switch (order.status) {
        case 'PENDING':
          await this.orderService.markPaid(tx, principal, orderId);
          break;
        case 'PAID':
          await this.orderService.confirm(tx, principal, orderId);
          break;
        case 'CONFIRMED':
        case 'PROCESSING': {
          const fulfillment = await this.ensureFulfillment(tx, principal, orderId, order, account);
          if (targetInternal === 'PACKED') {
            if (fulfillment.status === 'PICKING')
              await this.fulfillmentService.pack(tx, principal, fulfillment.id);
          } else {
            await this.fulfillmentService.ship(tx, principal, fulfillment.id, {});
          }
          break;
        }
        case 'PACKED': {
          const fulfillment = await this.ensureFulfillment(tx, principal, orderId, order, account);
          await this.fulfillmentService.ship(tx, principal, fulfillment.id, {});
          break;
        }
        case 'SHIPPED':
          await this.orderService.deliver(tx, principal, orderId);
          break;
        case 'DELIVERED':
          await this.orderService.complete(tx, principal, orderId);
          break;
        default:
          return advanced ? 'ADVANCED' : 'NO_CHANGE';
      }
      advanced = true;
    }
    if (advanced) {
      await recordAudit(tx, {
        tenantId: principal.tenantId,
        action: 'channel.order.ingest',
        resourceType: 'order',
        resourceId: orderId,
        after: { source, target: targetInternal },
      });
    }
    return advanced ? 'ADVANCED' : 'NO_CHANGE';
  }

  private async ensureFulfillment(
    tx: Tx,
    principal: Principal,
    orderId: string,
    order: { warehouseId: string; lines: readonly { id: string; quantity: string }[] },
    account: ChannelAccount,
  ) {
    const existing = await this.fulfillmentService.list(tx, principal, orderId);
    if (existing[0]) return existing[0];
    return this.fulfillmentService.create(tx, principal, orderId, {
      idempotencyKey: deterministicUuid(`fulfillment:${orderId}`),
      warehouseId: account.defaultWarehouseId ?? order.warehouseId,
      lines: order.lines.map((l) => ({ orderItemId: l.id, quantity: l.quantity })),
    });
  }

  // ---------------------------------------------------------------- creation

  private async createOrder(
    tx: Tx,
    principal: Principal,
    tenantId: string,
    account: ChannelAccount,
    normalized: NormalizedChannelOrder,
    lineMappings: ResolvedLine[],
  ): Promise<string> {
    const orderId = deterministicUuid(`channel-order:${account.id}:${normalized.externalOrderId}`);
    const warehouseId = account.defaultWarehouseId ?? (await this.resolveDefaultWarehouse(tx));
    const totals = computeOrderTotals(
      lineMappings.map((l, i) => ({
        lineNo: i + 1,
        variantId: l.variantId!,
        sku: l.sku!,
        name: l.name,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        taxRate: '7',
        priceIncludesTax: true,
        discountAmount: l.discount,
      })),
    );
    const orderNo = await nextDocumentNumber(tx, tenantId, 'SO', { scopeKey: account.channelCode });

    const { rows } = await sql<{ id: string }>`
      insert into orders (tenant_id, id, order_no, channel_code, channel_account_id, channel_order_id,
                          fulfillment_warehouse_id, status, payment_status, inventory_status, price_includes_tax,
                          subtotal, discount_total, tax_total, rounding, grand_total, buyer_snapshot,
                          shipping_address, channel_status, channel_updated_at, placed_at)
      values (${tenantId}, ${orderId}, ${orderNo}, ${account.channelCode}, ${account.id}, ${normalized.externalOrderId},
              ${warehouseId}, 'PENDING', 'UNPAID', 'RESERVED', true,
              ${totals.subtotal}, ${totals.discountTotal}, ${totals.taxTotal}, '0.00', ${totals.grandTotal},
              ${JSON.stringify(normalized.buyer)}::jsonb,
              ${normalized.shippingAddress ? JSON.stringify(normalized.shippingAddress) : null}::jsonb,
              ${normalized.externalStatus}, ${normalized.updateTime}, ${normalized.createdAt})
      on conflict (tenant_id, id) do nothing
      returning id`.execute(tx);
    if (rows.length === 0) return orderId; // concurrent ingest of the same channel order already created it

    for (const line of totals.lines) {
      await sql`
        insert into order_items (tenant_id, id, order_id, line_no, variant_id, sku, name, channel_item_ref,
                                 quantity, unit_price, discount_amount, tax_rate, tax_amount, line_total)
        values (${tenantId}, ${uuidv7()}, ${orderId}, ${line.lineNo}, ${line.variantId}, ${line.sku}, ${line.name},
                ${JSON.stringify(lineMappings[line.lineNo - 1]!.channelItemRef)}::jsonb,
                ${line.quantity}, ${line.unitPrice}, ${line.discountAmount}, ${line.taxRate}, ${line.taxAmount},
                ${line.lineTotal})`.execute(tx);
    }
    for (const line of lineMappings) {
      await this.reservations.reserve(tx, principal, {
        referenceType: 'ORDER',
        referenceId: orderId,
        idempotencyKey: `order:${orderId}:reserve:${line.variantId}`,
        channelCode: account.channelCode,
        ttlSeconds: 24 * 3600, // platform, not our checkout, owns the cancel window — long TTL, polling/webhook will move it on
        items: [{ warehouseId, variantId: line.variantId!, quantity: line.quantity }],
      });
    }
    await sql`insert into order_status_history (tenant_id, id, order_id, from_status, to_status, source, source_ref, actor_id)
              values (${tenantId}, ${uuidv7()}, ${orderId}, null, 'PENDING', 'CHANNEL_WEBHOOK', ${normalized.externalOrderId}, null)`.execute(
      tx,
    );
    await recordAudit(tx, {
      tenantId,
      action: 'channel.order.create',
      resourceType: 'order',
      resourceId: orderId,
      after: { orderNo, channelCode: account.channelCode, externalOrderId: normalized.externalOrderId },
    });
    return orderId;
  }

  private async resolveDefaultWarehouse(tx: Tx): Promise<string> {
    const { rows } = await sql<{ id: string }>`
      select id from warehouses where is_active order by created_at limit 1`.execute(tx);
    if (!rows[0]) throw new Error('No active warehouse to fulfil channel orders from');
    return rows[0].id;
  }

  private async resolveLines(
    tx: Tx,
    channelAccountId: string,
    normalized: NormalizedChannelOrder,
  ): Promise<ResolvedLine[]> {
    return Promise.all(
      normalized.lines.map(async (line) => {
        const { rows } = await sql<{ variant_id: string | null; sku: string | null }>`
          select cpv.variant_id, pv.sku
            from channel_product_variants cpv
            left join product_variants pv on pv.id = cpv.variant_id
           where cpv.channel_account_id = ${channelAccountId}
             and cpv.external_item_id = ${line.externalItemId}
             and cpv.external_variant_id = ${line.externalVariantId}`.execute(tx);
        const row = rows[0];
        return {
          variantId: row?.variant_id ?? null,
          sku: row?.sku ?? null,
          name: line.name,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          discount: line.discount,
          externalSku: line.externalSku,
          externalVariantId: line.externalVariantId,
          channelItemRef: {
            item_id: line.externalItemId,
            model_id: line.externalVariantId,
            order_item_id: line.externalLineId,
          },
        };
      }),
    );
  }

  // ---------------------------------------------------------------- channel_orders snapshot

  private async loadChannelOrder(
    tx: Tx,
    channelAccountId: string,
    externalOrderId: string,
  ): Promise<{ orderId: string | null; externalUpdateTime: number } | null> {
    const { rows } = await sql<{ order_id: string | null; external_update_time: Date }>`
      select order_id, external_update_time from channel_orders
       where channel_account_id = ${channelAccountId} and external_order_id = ${externalOrderId}`.execute(tx);
    const row = rows[0];
    return row ? { orderId: row.order_id, externalUpdateTime: row.external_update_time.getTime() } : null;
  }

  private async upsertChannelOrder(
    tx: Tx,
    tenantId: string,
    channelAccountId: string,
    normalized: NormalizedChannelOrder,
    payloadHash: Buffer,
    existingOrderId: string | null,
  ): Promise<void> {
    await sql`
      insert into channel_orders (tenant_id, id, channel_account_id, external_order_id, order_id, external_status,
                                  external_update_time, payload, payload_hash, processing_status)
      values (${tenantId}, ${uuidv7()}, ${channelAccountId}, ${normalized.externalOrderId}, ${existingOrderId},
              ${normalized.externalStatus}, ${normalized.updateTime}, ${JSON.stringify(normalized.raw)}::jsonb,
              ${payloadHash}, 'PENDING')
      on conflict (tenant_id, channel_account_id, external_order_id) do update set
        external_status = excluded.external_status, external_update_time = excluded.external_update_time,
        payload = excluded.payload, payload_hash = excluded.payload_hash, processing_status = 'PENDING',
        error = null, updated_at = now()`.execute(tx);
  }

  private async markProcessed(
    tx: Tx,
    tenantId: string,
    channelAccountId: string,
    externalOrderId: string,
    orderId: string | null,
  ): Promise<void> {
    await sql`update channel_orders set processing_status = 'PROCESSED', order_id = coalesce(${orderId}, order_id),
                updated_at = now()
              where tenant_id = ${tenantId} and channel_account_id = ${channelAccountId}
                and external_order_id = ${externalOrderId}`.execute(tx);
  }
}

interface ResolvedLine {
  variantId: string | null;
  sku: string | null;
  name: string;
  quantity: string;
  unitPrice: string;
  discount: string;
  externalSku: string | null;
  externalVariantId: string;
  channelItemRef: Record<string, string>;
}
