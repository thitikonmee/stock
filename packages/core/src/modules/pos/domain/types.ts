export type ShiftStatus = 'OPEN' | 'CLOSED' | 'RECONCILED';

export interface Shift {
  id: string;
  posDeviceId: string;
  cashierId: string;
  status: ShiftStatus;
  openedAt: string;
  closedAt: string | null;
  openingCash: string;
  expectedCash: string | null;
  countedCash: string | null;
  cashVariance: string | null;
  summary: Record<string, unknown> | null;
  closedBy: string | null;
}

export type CashMovementType = 'PAY_IN' | 'PAY_OUT' | 'DROP' | 'NO_SALE_OPEN';

export interface CashMovement {
  id: string;
  shiftId: string;
  type: CashMovementType;
  amount: string;
  reason: string | null;
  userId: string;
  approvedBy: string | null;
  occurredAt: string;
}

export type PaymentMethod =
  'CASH' | 'CREDIT_CARD' | 'DEBIT_CARD' | 'PROMPTPAY' | 'QR' | 'BANK_TRANSFER' | 'STORE_CREDIT' | 'VOUCHER';

export interface SaleLineInput {
  variantId: string;
  quantity: string;
  /** Manual line discount (money). Omit for none. */
  discountAmount?: string;
}

export interface SalePaymentInput {
  method: PaymentMethod;
  amount: string;
  tenderedAmount?: string;
  providerRef?: string;
}

/** A manager's PIN, verified at the moment of the request, to approve something the cashier alone cannot. */
export interface ManagerOverrideInput {
  employeeCode: string;
  pin: string;
}

export interface SaleInput {
  posDeviceId: string;
  shiftId: string;
  clientTxnId: string;
  lines: readonly SaleLineInput[];
  cartDiscountAmount?: string;
  payments: readonly SalePaymentInput[];
  customerId?: string;
  note?: string;
  discountOverride?: ManagerOverrideInput;
  stockOverride?: ManagerOverrideInput;
}

export interface SaleLine {
  orderItemId: string;
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
}

export interface Sale {
  orderId: string;
  orderNo: string;
  status: string;
  subtotal: string;
  discountTotal: string;
  taxTotal: string;
  rounding: string;
  grandTotal: string;
  changeAmount: string;
  lines: readonly SaleLine[];
  payments: readonly { id: string; method: PaymentMethod; amount: string; changeAmount: string }[];
  placedAt: string;
}

export interface RefundLineInput {
  orderItemId: string;
  quantity: string;
  /** SELLABLE puts stock back on hand; DAMAGED restocks to the damaged bucket; omit to not restock. */
  restockCondition?: 'SELLABLE' | 'DAMAGED';
}

export interface RefundInput {
  orderId: string;
  /** The refunding device's currently open shift — its drawer is what the cash actually leaves. */
  shiftId: string;
  lines: readonly RefundLineInput[];
  reason: string;
  method?: PaymentMethod;
  idempotencyKey: string;
  managerOverride?: ManagerOverrideInput;
}

export interface Refund {
  id: string;
  docNo: string;
  orderId: string;
  amount: string;
  status: string;
}
