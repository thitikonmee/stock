export interface Grant {
  permission: string;
  scopeType: 'TENANT' | 'BRANCH' | 'WAREHOUSE';
  scopeId: string | null;
}

export interface Me {
  userId: string;
  membershipId: string;
  displayName: string;
  email: string | null;
  mfaEnabled: boolean;
  mfaEnrollmentRequired: boolean;
  isOwner: boolean;
  authType: 'USER' | 'API_KEY';
  tenant: { id: string; slug: string; name: string };
  grants: Grant[];
}

export interface RoleAssignment {
  roleId: string;
  scopeType: 'TENANT' | 'BRANCH' | 'WAREHOUSE';
  scopeId: string | null;
  roleCode?: string;
}

export interface Member {
  membershipId: string;
  userId: string;
  email: string | null;
  displayName: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'INVITED' | 'REMOVED';
  isOwner: boolean;
  mfaEnabled: boolean;
  roles: RoleAssignment[];
}

export interface Invitation {
  id: string;
  email: string;
  roles: RoleAssignment[];
  invitedBy: string | null;
  expiresAt: string;
  createdAt: string;
}

export interface Role {
  id: string;
  code: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  version: number;
  permissions: string[];
}

export interface Permission {
  code: string;
  module: string;
  description: string;
  dangerous: boolean;
}

export interface Branch {
  id: string;
  code: string;
  name: string;
  taxBranchNo: string;
  phone: string | null;
  isActive: boolean;
}

export interface Warehouse {
  id: string;
  branchId: string | null;
  code: string;
  name: string;
  type: string;
  allowNegativeStock: boolean;
  isActive: boolean;
}

export interface PosDevice {
  id: string;
  code: string;
  name: string;
  branchId: string;
  warehouseId: string;
  status: 'PENDING' | 'ACTIVE' | 'DISABLED' | 'LOST';
  platform: string | null;
  appVersion: string | null;
  lastSeenAt: string | null;
  registeredAt: string | null;
}

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  permissions: string[];
  ipAllowlist: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface AppNotification {
  id: string;
  eventType: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  title: string;
  body: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface PlanSummary {
  planId: string;
  planName: string;
  status: string;
  currentPeriodEnd: string | null;
  limits: Record<string, number | null>;
  usage: Record<string, number>;
}

export const can = (me: Me | undefined, permission: string) =>
  !!me?.grants.some((g) => g.permission === permission);

// --- Catalog (Phase 2) -----------------------------------------------------------

export interface Brand {
  id: string;
  name: string;
  isActive: boolean;
}

export interface Category {
  id: string;
  parentId: string | null;
  name: string;
  path: string;
  sortOrder: number;
}

export interface Unit {
  id: string;
  code: string;
  name: string;
  allowDecimal: boolean;
}

export type ProductType = 'STANDARD' | 'BUNDLE' | 'SERVICE' | 'NON_STOCK';
export type ProductStatus = 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
export type VariantStatus = 'ACTIVE' | 'INACTIVE' | 'ARCHIVED';

export interface Variant {
  id: string;
  productId: string;
  sku: string;
  name: string;
  optionValues: Record<string, string>;
  costPrice: string;
  sellingPrice: string;
  weightGrams: number | null;
  reorderPoint: string | null;
  reorderQty: string | null;
  lowStockThreshold: string | null;
  status: VariantStatus;
  version: number;
  barcodes: string[];
}

export interface Product {
  id: string;
  code: string;
  name: string;
  description: string | null;
  brandId: string | null;
  categoryId: string | null;
  baseUnitId: string;
  type: ProductType;
  options: { name: string; values: string[] }[];
  taxClass: 'VAT7' | 'VAT0' | 'EXEMPT';
  trackInventory: boolean;
  status: ProductStatus;
  version: number;
  variants: Variant[];
}

export interface ProductPage {
  data: Product[];
  page: { nextCursor: string | null };
}

export interface ProductImage {
  id: string;
  productId: string;
  variantId: string | null;
  sortOrder: number;
  contentType: string;
  sizeBytes: number;
  altText: string | null;
}

export interface Supplier {
  id: string;
  code: string;
  name: string;
  taxId: string | null;
  paymentTermsDays: number;
  defaultLeadTimeDays: number;
  currency: string;
  isActive: boolean;
}

export interface SupplierProduct {
  supplierId: string;
  variantId: string;
  supplierSku: string | null;
  lastCost: string | null;
  minOrderQty: string | null;
  leadTimeDays: number | null;
  isPreferred: boolean;
}

export interface ImportJob {
  id: string;
  status: 'PROCESSING' | 'COMPLETED' | 'FAILED';
  totalRows: number;
  createdProducts: number;
  createdVariants: number;
  updatedVariants: number;
  errors: { row: number; message: string }[];
}

export interface BundleComponent {
  variantId: string;
  sku: string;
  name: string;
  quantity: string;
}

export interface UnitConversion {
  unitId: string;
  unitCode: string;
  factorToBase: string;
  isPurchaseUnit: boolean;
  isSalesUnit: boolean;
}

// --- Inventory (Phase 3) ----------------------------------------------------------

export interface StockBalance {
  warehouseId: string;
  variantId: string;
  sku: string;
  variantName: string;
  onHand: string;
  reserved: string;
  committed: string;
  damaged: string;
  incoming: string;
  available: string;
  lowStockThreshold: string | null;
  version: string;
}
export interface StockBalancePage {
  data: StockBalance[];
  page: { nextCursor: string | null };
}

export interface LedgerLine {
  id: string;
  createdAt: string;
  occurredAt: string;
  transactionType: string;
  bucket: string;
  quantity: string;
  beforeQuantity: string;
  afterQuantity: string;
  unitCost: string | null;
  referenceType: string;
  referenceId: string;
  reasonCode: string | null;
  note: string | null;
}
export interface LedgerPage {
  data: LedgerLine[];
  page: { nextCursor: string | null };
}

export type AdjustmentStatus =
  'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'POSTED' | 'REJECTED' | 'CANCELLED';
export type AdjustmentReasonCode =
  'DAMAGE' | 'LOST' | 'FOUND' | 'COUNT_ERROR' | 'EXPIRED' | 'OPENING' | 'OTHER';

export interface AdjustmentItem {
  id: string;
  variantId: string;
  bucket: 'ON_HAND' | 'DAMAGED';
  quantityDelta: string;
  unitCost: string | null;
  note: string | null;
}
export interface Adjustment {
  id: string;
  docNo: string;
  warehouseId: string;
  reasonCode: AdjustmentReasonCode;
  status: AdjustmentStatus;
  note: string | null;
  requestedBy: string;
  approvedBy: string | null;
  items: AdjustmentItem[];
}

export interface Variant {
  id: string;
  sku: string;
  name: string;
  sellingPrice: string;
  status: 'ACTIVE' | 'INACTIVE' | 'ARCHIVED';
  barcodes: string[];
}

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
  summary: { byMethod?: Record<string, string>; salesCount?: number; refundTotal?: string } | null;
  closedBy: string | null;
}

export type PosPaymentMethod =
  'CASH' | 'CREDIT_CARD' | 'DEBIT_CARD' | 'PROMPTPAY' | 'QR' | 'BANK_TRANSFER' | 'STORE_CREDIT' | 'VOUCHER';

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
  lines: SaleLine[];
  payments: { id: string; method: PosPaymentMethod; amount: string; changeAmount: string }[];
  placedAt: string;
}

export interface ManagerOverride {
  employeeCode: string;
  pin: string;
}

export interface Customer {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  totalSpent: string;
  orderCount: number;
}

export type OrderStatus =
  | 'DRAFT'
  | 'PENDING'
  | 'PAID'
  | 'CONFIRMED'
  | 'PROCESSING'
  | 'PACKED'
  | 'SHIPPED'
  | 'DELIVERED'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'RETURNED'
  | 'REFUNDED'
  | 'PARTIALLY_REFUNDED'
  | 'ON_HOLD';

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
  paymentStatus: string;
  fulfillmentStatus: string;
  inventoryStatus: string;
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
export interface OrderListPage {
  data: Order[];
  page: { nextCursor: string | null };
}

export type FulfillmentRowStatus =
  'PENDING' | 'PICKING' | 'PACKED' | 'SHIPPED' | 'DELIVERED' | 'CANCELLED' | 'RETURNED';
export interface OrderFulfillment {
  id: string;
  orderId: string;
  warehouseId: string;
  status: FulfillmentRowStatus;
  carrier: string | null;
  trackingNo: string | null;
  shippedAt: string | null;
  items: { orderItemId: string; quantity: string }[];
}

export type ReturnCondition = 'SELLABLE' | 'DAMAGED' | 'MISSING';
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

export interface OrderRefund {
  id: string;
  docNo: string;
  orderId: string;
  amount: string;
  status: string;
}

// --- Channels (Phase 6) -----------------------------------------------------------

export type ChannelAccountStatus =
  'CONNECTING' | 'CONNECTED' | 'TOKEN_EXPIRED' | 'ERROR' | 'PAUSED' | 'DISCONNECTED';

export interface ChannelAccount {
  id: string;
  channelCode: string;
  externalShopId: string;
  shopName: string | null;
  region: string;
  status: ChannelAccountStatus;
  defaultWarehouseId: string | null;
  settings: Record<string, unknown>;
  lastOrderSyncAt: string | null;
  lastError: string | null;
  createdAt: string;
}

export type MappingStatus = 'UNMAPPED' | 'AUTO_MAPPED' | 'CONFIRMED' | 'CONFLICT' | 'BROKEN';

export interface ChannelProductVariantRow {
  id: string;
  channelAccountId: string;
  channelProductId: string;
  externalItemId: string;
  externalVariantId: string;
  externalSku: string | null;
  productTitle: string | null;
  variantId: string | null;
  sku: string | null;
  quantityMultiplier: string;
  mappingStatus: MappingStatus;
  mappingMethod: string | null;
  syncStock: boolean;
  lastPushedQty: string | null;
  lastPushedAt: string | null;
  lastChannelQty: string | null;
  updatedAt: string;
}

export interface StockPolicyRow {
  id: string;
  channelAccountId: string | null;
  variantId: string | null;
  strategy: 'GLOBAL_POOL' | 'CHANNEL_ALLOCATION';
  safetyStock: string;
  bufferPercent: string;
  maxPushQty: string | null;
  pushZeroBelow: string;
}

export interface SyncJobRow {
  id: string;
  channelAccountId: string | null;
  jobType: string;
  status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'DEAD' | 'CANCELLED';
  attempts: number;
  output: unknown;
  lastError: string | null;
  scheduledAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface WebhookEventRow {
  id: string;
  channelCode: string;
  channelAccountId: string | null;
  eventType: string;
  externalRef: string | null;
  signatureValid: boolean;
  status: 'RECEIVED' | 'PROCESSING' | 'PROCESSED' | 'IGNORED' | 'FAILED' | 'DEAD';
  attempts: number;
  lastError: string | null;
  receivedAt: string;
  processedAt: string | null;
}

export interface ReconciliationRunRow {
  id: string;
  type: string;
  channelAccountId: string | null;
  status: 'RUNNING' | 'COMPLETED' | 'FAILED';
  checkedCount: number;
  mismatchCount: number;
  startedAt: string;
  finishedAt: string | null;
}

export interface ReconciliationItemRow {
  id: string;
  variantId: string | null;
  channelProductVariantId: string | null;
  expectedQty: string | null;
  actualQty: string | null;
  diff: string | null;
  classification: string | null;
  resolution: string | null;
}

// ---------------------------------------------------------------- Phase 9: warehouse operations

export type PurchaseStatus =
  | 'DRAFT'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'SENT'
  | 'PARTIALLY_RECEIVED'
  | 'RECEIVED'
  | 'CLOSED'
  | 'CANCELLED';

export interface PurchaseItem {
  id: string;
  variantId: string;
  sku: string;
  variantName: string;
  unitId: string;
  unitCode: string;
  unitFactor: string;
  orderedQty: string;
  receivedQty: string;
  cancelledQty: string;
  outstandingQty: string;
  unitCost: string;
  discountAmount: string;
  taxRate: string;
  lineTotal: string;
}

export interface Purchase {
  id: string;
  docNo: string;
  supplierId: string;
  supplierName: string;
  warehouseId: string;
  status: PurchaseStatus;
  expectedAt: string | null;
  subtotal: string;
  discountTotal: string;
  taxTotal: string;
  grandTotal: string;
  note: string | null;
  createdBy: string;
  approvedBy: string | null;
  approvedAt: string | null;
  version: number;
  createdAt: string;
  items: PurchaseItem[];
  receipts: {
    id: string;
    docNo: string;
    supplierInvoiceNo: string | null;
    receivedAt: string;
    lines: number;
  }[];
}

export interface SupplierPerformance {
  supplierId: string;
  purchaseOrders: number;
  receivedOrders: number;
  onTimeRate: string | null;
  fillRate: string | null;
  avgLeadTimeDays: string | null;
  totalSpend: string;
}

export type TransferStatus =
  | 'DRAFT'
  | 'REQUESTED'
  | 'APPROVED'
  | 'PICKING'
  | 'SHIPPED'
  | 'PARTIALLY_RECEIVED'
  | 'RECEIVED'
  | 'COMPLETED'
  | 'CANCELLED';

export interface TransferItem {
  id: string;
  variantId: string;
  sku: string;
  variantName: string;
  requestedQty: string;
  approvedQty: string | null;
  shippedQty: string;
  receivedQty: string;
  damagedQty: string;
  inTransitQty: string;
}

export interface Transfer {
  id: string;
  docNo: string;
  fromWarehouseId: string;
  toWarehouseId: string;
  status: TransferStatus;
  note: string | null;
  requestedBy: string;
  approvedBy: string | null;
  shippedAt: string | null;
  receivedAt: string | null;
  version: number;
  createdAt: string;
  items: TransferItem[];
}

export type CountType = 'FULL' | 'CYCLE' | 'BLIND' | 'SPOT';
export type CountStatus =
  'DRAFT' | 'IN_PROGRESS' | 'SUBMITTED' | 'PENDING_APPROVAL' | 'APPROVED' | 'POSTED' | 'CANCELLED';

export interface CountItem {
  id: string;
  variantId: string;
  sku: string;
  variantName: string;
  snapshotQty: string | null;
  countedQty: string | null;
  movementSinceSnapshot: string | null;
  variance: string | null;
  countedAt: string | null;
  recountRequired: boolean;
}

export interface StockCount {
  id: string;
  docNo: string;
  warehouseId: string;
  countType: CountType;
  status: CountStatus;
  varianceTolerance: string;
  createdBy: string;
  approvedBy: string | null;
  startedAt: string | null;
  submittedAt: string | null;
  postedAdjustmentId: string | null;
  version: number;
  createdAt: string;
  totals: { items: number; counted: number; withVariance: number; recountRequired: number };
  items?: CountItem[];
}

export type LocationLevel = 'ZONE' | 'RACK' | 'SHELF' | 'BIN';

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

export interface LocationDiscrepancy {
  variantId: string;
  sku: string;
  warehouseOnHand: string;
  locatedOnHand: string;
  unlocated: string;
}

export interface ChannelAllocation {
  channelAccountId: string;
  warehouseId: string;
  variantId: string;
  sku: string;
  variantName: string;
  allocatedQty: string;
  consumedQty: string;
  remainingQty: string;
  unallocatedQty: string;
}
