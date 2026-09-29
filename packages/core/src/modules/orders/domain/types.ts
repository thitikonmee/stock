import type { OrderStatus } from './order-state-machine';

export type FulfillmentStatus =
  'UNFULFILLED' | 'PARTIALLY_FULFILLED' | 'FULFILLED' | 'RETURNED' | 'PARTIALLY_RETURNED';
export type PaymentStatus =
  'UNPAID' | 'PENDING' | 'PARTIALLY_PAID' | 'PAID' | 'PARTIALLY_REFUNDED' | 'REFUNDED' | 'FAILED';
export type InventoryStatus =
  'NONE' | 'RESERVED' | 'PARTIALLY_RESERVED' | 'COMMITTED' | 'DEDUCTED' | 'RELEASED' | 'BACKORDER' | 'FAILED';

export interface CreateOrderLineInput {
  variantId: string;
  quantity: string;
  /** Manual line discount (money). Omit for none. */
  discountAmount?: string;
}

export interface CreateOrderInput {
  channelCode: 'API' | 'WEBSITE';
  warehouseId?: string;
  customerId?: string;
  lines: readonly CreateOrderLineInput[];
  /** Already paid at creation (e.g. a phone order taken with payment confirmed up front). */
  paid?: boolean;
  note?: string;
  idempotencyKey: string;
}

export interface OrderLine {
  id: string;
  lineNo: number;
  variantId: string;
  sku: string;
  name: string;
  quantity: string;
  unitPrice: string;
  taxRate: string;
  discountAmount: string;
  taxAmount: string;
  lineTotal: string;
  fulfilledQty: string;
  cancelledQty: string;
  returnedQty: string;
  refundedAmount: string;
}

export interface Order {
  id: string;
  orderNo: string;
  channelCode: string;
  warehouseId: string;
  customerId: string | null;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  fulfillmentStatus: FulfillmentStatus;
  inventoryStatus: InventoryStatus;
  holdReason: string | null;
  subtotal: string;
  discountTotal: string;
  taxTotal: string;
  grandTotal: string;
  paidTotal: string;
  refundedTotal: string;
  note: string | null;
  placedAt: string;
  lines: OrderLine[];
}

export interface OrderListQuery {
  status?: OrderStatus;
  channelCode?: string;
  cursor?: string;
  limit?: number;
}
export interface OrderListPage {
  data: Order[];
  page: { nextCursor: string | null };
}

export interface FulfillmentLineInput {
  orderItemId: string;
  quantity: string;
}
export interface CreateFulfillmentInput {
  warehouseId?: string;
  lines: readonly FulfillmentLineInput[];
  idempotencyKey: string;
}

export type FulfillmentRowStatus =
  'PENDING' | 'PICKING' | 'PACKED' | 'SHIPPED' | 'DELIVERED' | 'CANCELLED' | 'RETURNED';

export interface Fulfillment {
  id: string;
  orderId: string;
  warehouseId: string;
  status: FulfillmentRowStatus;
  carrier: string | null;
  trackingNo: string | null;
  shippedAt: string | null;
  items: { orderItemId: string; quantity: string }[];
}

export interface ShipInput {
  carrier?: string;
  trackingNo?: string;
}

export type ReturnCondition = 'SELLABLE' | 'DAMAGED' | 'MISSING';
export interface ReturnLineInput {
  orderItemId: string;
  quantity: string;
}
export interface RequestReturnInput {
  lines: readonly ReturnLineInput[];
  reason?: string;
  receiveWarehouseId?: string;
  idempotencyKey: string;
}

export type ReturnStatus =
  'REQUESTED' | 'APPROVED' | 'REJECTED' | 'IN_TRANSIT' | 'RECEIVED' | 'INSPECTED' | 'COMPLETED' | 'CANCELLED';

export interface OrderReturn {
  id: string;
  orderId: string;
  status: ReturnStatus;
  reason: string | null;
  receiveWarehouseId: string | null;
  items: { orderItemId: string; quantity: string; condition: ReturnCondition | null; restockedQty: string }[];
}

export interface ReceiveReturnLineInput {
  orderItemId: string;
  condition: ReturnCondition;
}
export interface ReceiveReturnInput {
  lines: readonly ReceiveReturnLineInput[];
}

export interface OrderRefundInput {
  lines: readonly { orderItemId: string; quantity: string }[];
  reason: string;
  returnId?: string;
  idempotencyKey: string;
}

export interface OrderRefund {
  id: string;
  docNo: string;
  orderId: string;
  amount: string;
  status: string;
}
