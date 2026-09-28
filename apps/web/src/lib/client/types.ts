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
