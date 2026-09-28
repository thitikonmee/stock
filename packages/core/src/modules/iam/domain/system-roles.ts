import { ALL_PERMISSIONS, type PermissionCode } from './permissions';

export interface SystemRoleDefinition {
  code: SystemRoleCode;
  name: string;
  description: string;
  permissions: readonly PermissionCode[];
}

export const SYSTEM_ROLE_CODES = [
  'OWNER',
  'ADMIN',
  'MANAGER',
  'WAREHOUSE_STAFF',
  'CASHIER',
  'ACCOUNTANT',
  'PURCHASING',
  'MARKETING',
  'VIEWER',
] as const;
export type SystemRoleCode = (typeof SYSTEM_ROLE_CODES)[number];

const except = (...excluded: PermissionCode[]) => ALL_PERMISSIONS.filter((p) => !excluded.includes(p));
const readOnly = ALL_PERMISSIONS.filter((p) => p.endsWith('.read') && p !== 'customer.pii.read');

/**
 * Roles created for every tenant (docs/01-product.md §3). They cannot be edited, only cloned into
 * custom roles. OWNER is held by exactly one membership and is never assignable.
 */
export const SYSTEM_ROLES: readonly SystemRoleDefinition[] = [
  {
    code: 'OWNER',
    name: 'Owner',
    description: 'Everything, including billing and ownership',
    permissions: ALL_PERMISSIONS,
  },
  {
    code: 'ADMIN',
    name: 'Admin',
    description: 'Everything except billing and closing the company',
    permissions: except('billing.manage', 'tenant.manage'),
  },
  {
    code: 'MANAGER',
    name: 'Manager',
    description: 'Runs a branch: stock, orders, POS, approvals',
    permissions: [
      'user.read',
      'product.read',
      'product.create',
      'product.update',
      'price.read',
      'inventory.read',
      'inventory.adjust',
      'inventory.adjust.approve',
      'inventory.transfer',
      'inventory.transfer.approve',
      'inventory.receive',
      'inventory.count',
      'inventory.count.approve',
      'order.read',
      'order.create',
      'order.update',
      'order.cancel',
      'order.refund',
      'order.fulfill',
      'pos.sell',
      'pos.discount',
      'pos.discount.override',
      'pos.refund',
      'pos.void',
      'pos.shift.open',
      'pos.shift.close',
      'pos.cash.in_out',
      'pos.reprint',
      'customer.read',
      'customer.manage',
      'customer.pii.read',
      'promotion.read',
      'payment.read',
      'report.read',
      'report.export',
      'channel.read',
    ],
  },
  {
    code: 'WAREHOUSE_STAFF',
    name: 'Warehouse staff',
    description: 'Receive, transfer, count, pick and pack',
    permissions: [
      'product.read',
      'inventory.read',
      'inventory.transfer',
      'inventory.receive',
      'inventory.count',
      'order.read',
      'order.fulfill',
      'purchase.read',
      'purchase.receive',
    ],
  },
  {
    code: 'CASHIER',
    name: 'Cashier',
    description: 'Sell at the POS; discounts and refunds need a manager',
    permissions: [
      'product.read',
      'price.read',
      'inventory.read',
      'pos.sell',
      'pos.discount',
      'pos.shift.open',
      'pos.shift.close',
      'customer.read',
      'customer.manage',
    ],
  },
  {
    code: 'ACCOUNTANT',
    name: 'Accountant',
    description: 'Read orders, payments and financial reports',
    permissions: [...readOnly, 'report.export', 'report.financial'], // readOnly already includes product.cost.read
  },
  {
    code: 'PURCHASING',
    name: 'Purchasing',
    description: 'Suppliers and purchase orders',
    permissions: [
      'product.read',
      'product.cost.read',
      'inventory.read',
      'supplier.read',
      'supplier.manage',
      'purchase.read',
      'purchase.create',
      'purchase.approve',
      'purchase.receive',
      'report.read',
    ],
  },
  {
    code: 'MARKETING',
    name: 'Marketing',
    description: 'Promotions, coupons and channel listings',
    permissions: [
      'product.read',
      'price.read',
      'promotion.read',
      'promotion.manage',
      'coupon.manage',
      'customer.read',
      'channel.read',
      'channel.mapping',
      'report.read',
    ],
  },
  { code: 'VIEWER', name: 'Viewer', description: 'Read-only access', permissions: readOnly },
];

const SYSTEM_CODES: ReadonlySet<string> = new Set(SYSTEM_ROLE_CODES);

export function isSystemRoleCode(code: string): boolean {
  return SYSTEM_CODES.has(code);
}
