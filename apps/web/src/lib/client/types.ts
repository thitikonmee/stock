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
