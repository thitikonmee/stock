import { sql } from 'kysely';
import type { Tx } from '@stockos/database';
import { BusinessRuleError, Dec, NotFoundError, ValidationError, formatMoney, uuidv7 } from '@stockos/shared';
import type { PriceService, ProductService } from '../../catalog/public-api';
import { InventoryEngine } from '../../inventory/public-api';
import { assertCan, can, type PosPinService, type Principal } from '../../iam/public-api';
import type { DeviceService } from '../../tenancy/public-api';
import { nextDocumentNumber } from '../../tenancy/public-api';
import { computeCart, validatePaymentSplit, type CartLineInput } from '../domain/cart';
import type { PaymentMethod, Sale, SaleInput, SaleLine } from '../domain/types';
import { loadPosSettings } from './settings';
import { verifyManagerOverride } from './manager-override';
import type { ShiftService } from './shift-service';

/**
 * The POS register: scan → cart → pay (docs/05-pos.md §15, §7.2 in docs/08-api-design.md).
 * `sell()` does pricing, VAT/rounding, InventoryEngine.SELL_DIRECT and the order/payment rows in one
 * transaction ("DRAFT (cart) → PAID → COMPLETED ในทีเดียว") — there is no separately persisted cart.
 */
export class SaleService {
  private readonly engine = new InventoryEngine();

  constructor(
    private readonly products: ProductService,
    private readonly prices: PriceService,
    private readonly shifts: ShiftService,
    private readonly pins: PosPinService,
    private readonly devices: DeviceService,
  ) {}

  async sell(tx: Tx, principal: Principal, input: SaleInput): Promise<Sale> {
    assertCan(principal, 'pos.sell');

    // A retried request (same client_txn_id) returns the original sale untouched, before any new work.
    const existing = await this.findByClientTxn(tx, input.posDeviceId, input.clientTxnId);
    if (existing) return existing;

    const device = await this.devices.forSale(tx, input.posDeviceId);
    const shift = await this.shifts.get(tx, principal, input.shiftId);
    if (shift.posDeviceId !== input.posDeviceId) {
      throw new ValidationError('Shift does not belong to this device');
    }
    if (shift.status !== 'OPEN') throw new BusinessRuleError('SHIFT_NOT_OPEN', 'Shift is not open');

    const settings = await loadPosSettings(tx, principal.tenantId);
    const cartLines: CartLineInput[] = await Promise.all(
      input.lines.map(async (line, i) => {
        const info = await this.products.saleInfo(tx, principal, { variantId: line.variantId });
        if (info.status !== 'ACTIVE') {
          throw new BusinessRuleError('VARIANT_NOT_SELLABLE', `${info.sku} is not active`, { sku: info.sku });
        }
        const priced = await this.prices.resolve(tx, principal, line.variantId, {
          priceListCode: settings.priceListCode,
          quantity: line.quantity,
        });
        return {
          lineNo: i + 1,
          variantId: line.variantId,
          sku: info.sku,
          name: info.name,
          quantity: line.quantity,
          unitPrice: priced.price,
          taxRate: info.taxClass === 'VAT7' ? '7' : '0',
          priceIncludesTax: priced.priceIncludesTax,
          ...(line.discountAmount !== undefined ? { discountAmount: line.discountAmount } : {}),
        };
      }),
    );

    const totals = computeCart({
      lines: cartLines,
      ...(input.cartDiscountAmount !== undefined ? { cartDiscountAmount: input.cartDiscountAmount } : {}),
      roundingIncrement: settings.roundingIncrement,
    });
    await this.gateDiscount(tx, principal, totals, settings.maxDiscountPercent, input.discountOverride);
    const { changeAmount } = validatePaymentSplit(input.payments, totals.grandTotal);

    // The order's id IS the client_txn_id (docs/05-pos.md §16) — not a fresh uuid per attempt, so
    // that two concurrent retries of the same sale agree on the reference they hand InventoryEngine
    // (it rejects one idempotency key reused for two different references as tampering).
    const orderId = input.clientTxnId;
    const allowNegative = await this.gateStockOverride(
      tx,
      principal,
      device.warehouseId,
      input.stockOverride,
    );
    // Insufficient stock throws InsufficientStockError (409) straight through to the caller.
    // `replayed` is the real race gate: InventoryEngine claims (tenant, idempotencyKey) atomically,
    // so exactly one concurrent attempt gets `replayed: false` — only it proceeds to number and
    // insert the order. Every loser must stop here too, before nextDocumentNumber(): otherwise a
    // burst of retries would burn a gap-free receipt number each, for a sale that happens once.
    const result = await this.engine.apply(tx, {
      tenantId: principal.tenantId,
      operation: 'SELL_DIRECT',
      idempotencyKey: `pos:${device.id}:${input.clientTxnId}:sale`,
      reference: { type: 'POS_SALE', id: orderId },
      channelCode: 'POS',
      allowNegative,
      lines: cartLines.map((l) => ({
        warehouseId: device.warehouseId,
        variantId: l.variantId,
        quantity: l.quantity,
      })),
    });
    if (result.replayed) {
      // The winner is guaranteed committed by now (Postgres blocks a conflicting insert until the
      // first transaction on that key ends), so its order row is visible here.
      const replay = await this.findByClientTxn(tx, input.posDeviceId, input.clientTxnId);
      if (replay) return replay;
      throw new ValidationError('Idempotency key conflict could not be resolved; retry the request');
    }

    const orderNo = await nextDocumentNumber(tx, principal.tenantId, 'RCPT', { scopeKey: device.code });
    await this.insertOrder(tx, principal, {
      orderId,
      orderNo,
      device,
      shiftId: input.shiftId,
      totals,
      input,
    });
    const lines: SaleLine[] = totals.lines.map((l) => ({ ...l, orderItemId: uuidv7() }));
    for (const line of lines) await this.insertOrderItem(tx, principal.tenantId, orderId, line);
    const payments = await this.insertPayments(tx, principal, orderId, input, device);

    return {
      orderId,
      orderNo,
      status: 'COMPLETED',
      subtotal: totals.subtotal,
      discountTotal: totals.discountTotal,
      taxTotal: totals.taxTotal,
      rounding: totals.rounding,
      grandTotal: totals.grandTotal,
      changeAmount,
      lines,
      payments,
      placedAt: new Date().toISOString(),
    };
  }

  async get(tx: Tx, principal: Principal, orderId: string): Promise<Sale> {
    assertCan(principal, 'pos.sell');
    const sale = await this.loadSale(tx, orderId);
    if (!sale) throw new NotFoundError('Sale not found');
    return sale;
  }

  async list(tx: Tx, principal: Principal, posDeviceId?: string): Promise<Sale[]> {
    assertCan(principal, 'pos.sell');
    const { rows } = await sql<{ id: string }>`
      select id from orders
       where channel_code = 'POS' and (${posDeviceId ?? null}::uuid is null or pos_device_id = ${posDeviceId ?? null})
       order by placed_at desc limit 100`.execute(tx);
    const sales = await Promise.all(rows.map((r) => this.loadSale(tx, r.id)));
    return sales.filter((s): s is Sale => s !== null);
  }

  // ---------------------------------------------------------------- helpers

  private async gateDiscount(
    tx: Tx,
    principal: Principal,
    totals: ReturnType<typeof computeCart>,
    maxDiscountPercent: number,
    override: SaleInput['discountOverride'],
  ): Promise<void> {
    if (totals.discountTotal === '0.00') return;
    assertCan(principal, 'pos.discount');
    const subtotal = new Dec(totals.subtotal);
    const pct = subtotal.isZero() ? new Dec(0) : new Dec(totals.discountTotal).dividedBy(subtotal).times(100);
    if (pct.lessThanOrEqualTo(maxDiscountPercent) || can(principal, 'pos.discount.override')) return;
    if (!override) {
      throw new BusinessRuleError('DISCOUNT_LIMIT_EXCEEDED', 'Discount needs a manager override', {
        maxDiscountPercent,
      });
    }
    await verifyManagerOverride(tx, this.pins, principal.tenantId, override, 'pos.discount.override');
  }

  /** Returns the `allowNegative` flag InventoryEngine should apply (only true when both approved and the warehouse permits it). */
  private async gateStockOverride(
    tx: Tx,
    principal: Principal,
    warehouseId: string,
    override: SaleInput['stockOverride'],
  ): Promise<boolean> {
    if (!override) return false;
    await verifyManagerOverride(tx, this.pins, principal.tenantId, override, 'pos.discount.override');
    const { rows } = await sql<{ allow_negative_stock: boolean }>`
      select allow_negative_stock from warehouses where id = ${warehouseId}`.execute(tx);
    return rows[0]?.allow_negative_stock ?? false;
  }

  private async insertOrder(
    tx: Tx,
    principal: Principal,
    args: {
      orderId: string;
      orderNo: string;
      device: { id: string; branchId: string; warehouseId: string };
      shiftId: string;
      totals: ReturnType<typeof computeCart>;
      input: SaleInput;
    },
  ): Promise<void> {
    const { orderId, orderNo, device, shiftId, totals, input } = args;
    await sql`
      insert into orders (tenant_id, id, order_no, channel_code, branch_id, fulfillment_warehouse_id,
                          pos_device_id, pos_shift_id, client_txn_id, customer_id, cashier_id,
                          status, payment_status, fulfillment_status, inventory_status,
                          price_includes_tax, subtotal, discount_total, tax_total, rounding, grand_total,
                          paid_total, placed_at, paid_at, completed_at, note)
      values (${principal.tenantId}, ${orderId}, ${orderNo}, 'POS', ${device.branchId}, ${device.warehouseId},
              ${device.id}, ${shiftId}, ${input.clientTxnId}, ${input.customerId ?? null}, ${principal.membershipId},
              'COMPLETED', 'PAID', 'FULFILLED', 'DEDUCTED',
              true, ${totals.subtotal}, ${totals.discountTotal}, ${totals.taxTotal}, ${totals.rounding}, ${totals.grandTotal},
              ${totals.grandTotal}, now(), now(), now(), ${input.note ?? null})`.execute(tx);
  }

  private async insertOrderItem(tx: Tx, tenantId: string, orderId: string, line: SaleLine): Promise<void> {
    await sql`
      insert into order_items (tenant_id, id, order_id, line_no, variant_id, sku, name, quantity,
                               unit_price, discount_amount, tax_rate, tax_amount, line_total,
                               fulfilled_qty)
      values (${tenantId}, ${line.orderItemId}, ${orderId}, ${line.lineNo}, ${line.variantId}, ${line.sku}, ${line.name},
              ${line.quantity}, ${line.unitPrice}, ${line.discountAmount}, ${line.taxRate}, ${line.taxAmount},
              ${line.lineTotal}, ${line.quantity})`.execute(tx);
  }

  private async insertPayments(
    tx: Tx,
    principal: Principal,
    orderId: string,
    input: SaleInput,
    device: { id: string },
  ): Promise<Sale['payments']> {
    const results: Sale['payments'][number][] = [];
    for (const [i, p] of input.payments.entries()) {
      const id = uuidv7();
      const change =
        p.method === 'CASH' && p.tenderedAmount !== undefined
          ? formatMoney(new Dec(p.tenderedAmount).minus(p.amount))
          : '0.00';
      await sql`
        insert into payments (tenant_id, id, order_id, method, provider_ref, status, amount, tendered_amount,
                              change_amount, idempotency_key, paid_at, pos_shift_id)
        values (${principal.tenantId}, ${id}, ${orderId}, ${p.method}, ${p.providerRef ?? null}, 'SUCCEEDED',
                ${p.amount}, ${p.tenderedAmount ?? null}, ${change},
                ${`pos:${device.id}:${input.clientTxnId}:payment:${i}`}, now(), ${input.shiftId})`.execute(
        tx,
      );
      results.push({ id, method: p.method as PaymentMethod, amount: p.amount, changeAmount: change });
    }
    return results;
  }

  private async findByClientTxn(tx: Tx, posDeviceId: string, clientTxnId: string): Promise<Sale | null> {
    const { rows } = await sql<{ id: string }>`
      select id from orders where pos_device_id = ${posDeviceId} and client_txn_id = ${clientTxnId}`.execute(
      tx,
    );
    return rows[0] ? this.loadSale(tx, rows[0].id) : null;
  }

  private async loadSale(tx: Tx, orderId: string): Promise<Sale | null> {
    const { rows: orderRows } = await sql<{
      id: string;
      order_no: string;
      status: string;
      subtotal: string;
      discount_total: string;
      tax_total: string;
      rounding: string;
      grand_total: string;
      placed_at: Date;
    }>`
      select id, order_no, status, subtotal, discount_total, tax_total, rounding, grand_total, placed_at
        from orders where id = ${orderId}`.execute(tx);
    const order = orderRows[0];
    if (!order) return null;

    const { rows: itemRows } = await sql<{
      id: string;
      line_no: number;
      variant_id: string;
      sku: string;
      name: string;
      quantity: string;
      unit_price: string;
      tax_rate: string;
      discount_amount: string;
      tax_amount: string;
      line_total: string;
    }>`
      select id, line_no, variant_id, sku, name, quantity, unit_price, tax_rate, discount_amount, tax_amount, line_total
        from order_items where order_id = ${orderId} order by line_no`.execute(tx);

    const { rows: paymentRows } = await sql<{
      id: string;
      method: PaymentMethod;
      amount: string;
      change_amount: string | null;
    }>`
      select id, method, amount, change_amount from payments where order_id = ${orderId} order by created_at`.execute(
      tx,
    );
    const changeAmount = paymentRows.reduce((sum, p) => sum.plus(p.change_amount ?? '0'), new Dec(0));

    return {
      orderId: order.id,
      orderNo: order.order_no,
      status: order.status,
      subtotal: order.subtotal,
      discountTotal: order.discount_total,
      taxTotal: order.tax_total,
      rounding: order.rounding,
      grandTotal: order.grand_total,
      changeAmount: formatMoney(changeAmount),
      lines: itemRows.map((r) => ({
        orderItemId: r.id,
        lineNo: r.line_no,
        variantId: r.variant_id,
        sku: r.sku,
        name: r.name,
        quantity: r.quantity,
        unitPrice: r.unit_price,
        taxRate: r.tax_rate,
        discountAmount: r.discount_amount,
        taxAmount: r.tax_amount,
        lineTotal: r.line_total,
      })),
      payments: paymentRows.map((p) => ({
        id: p.id,
        method: p.method,
        amount: p.amount,
        changeAmount: p.change_amount ?? '0.00',
      })),
      placedAt: order.placed_at.toISOString(),
    };
  }
}
