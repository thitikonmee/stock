/**
 * Permission catalog (docs/01-product.md §3). The `permissions` table is seeded from this list by
 * migrations; an integration test fails if the two drift apart.
 * `dangerous` permissions will require step-up authentication (recent 2FA).
 */
export const PERMISSION_CATALOG = [
  {
    code: 'tenant.manage',
    module: 'tenancy',
    description: 'Change company settings, close tenant',
    dangerous: true,
  },
  {
    code: 'billing.manage',
    module: 'billing',
    description: 'Change plan and payment method',
    dangerous: true,
  },
  { code: 'user.read', module: 'iam', description: 'List users and their roles', dangerous: false },
  {
    code: 'user.manage',
    module: 'iam',
    description: 'Invite, suspend users and assign roles',
    dangerous: true,
  },
  { code: 'role.manage', module: 'iam', description: 'Create and edit custom roles', dangerous: true },
  { code: 'branch.manage', module: 'tenancy', description: 'Create and edit branches', dangerous: false },
  {
    code: 'warehouse.manage',
    module: 'tenancy',
    description: 'Create and edit warehouses',
    dangerous: false,
  },
  {
    code: 'device.manage',
    module: 'tenancy',
    description: 'Register and disable POS devices',
    dangerous: false,
  },
  { code: 'product.read', module: 'catalog', description: 'View products', dangerous: false },
  { code: 'product.create', module: 'catalog', description: 'Create products', dangerous: false },
  { code: 'product.update', module: 'catalog', description: 'Edit products', dangerous: false },
  { code: 'product.delete', module: 'catalog', description: 'Archive products', dangerous: false },
  { code: 'product.cost.read', module: 'catalog', description: 'View cost prices', dangerous: false },
  { code: 'price.read', module: 'pricing', description: 'View price lists', dangerous: false },
  { code: 'price.manage', module: 'pricing', description: 'Edit price lists', dangerous: false },
  {
    code: 'inventory.read',
    module: 'inventory',
    description: 'View stock and stock cards',
    dangerous: false,
  },
  {
    code: 'inventory.adjust',
    module: 'inventory',
    description: 'Request stock adjustments',
    dangerous: false,
  },
  {
    code: 'inventory.adjust.approve',
    module: 'inventory',
    description: 'Approve stock adjustments',
    dangerous: false,
  },
  {
    code: 'inventory.transfer',
    module: 'inventory',
    description: 'Request stock transfers',
    dangerous: false,
  },
  {
    code: 'inventory.transfer.approve',
    module: 'inventory',
    description: 'Approve stock transfers',
    dangerous: false,
  },
  { code: 'inventory.receive', module: 'inventory', description: 'Receive goods', dangerous: false },
  { code: 'inventory.count', module: 'inventory', description: 'Perform stock counts', dangerous: false },
  {
    code: 'inventory.count.approve',
    module: 'inventory',
    description: 'Approve stock count results',
    dangerous: false,
  },
  { code: 'order.read', module: 'orders', description: 'View orders', dangerous: false },
  { code: 'order.create', module: 'orders', description: 'Create manual orders', dangerous: false },
  { code: 'order.update', module: 'orders', description: 'Edit orders', dangerous: false },
  { code: 'order.cancel', module: 'orders', description: 'Cancel orders', dangerous: false },
  { code: 'order.refund', module: 'orders', description: 'Refund orders', dangerous: false },
  { code: 'order.fulfill', module: 'orders', description: 'Pick, pack and ship', dangerous: false },
  { code: 'pos.sell', module: 'pos', description: 'Sell at the POS', dangerous: false },
  { code: 'pos.discount', module: 'pos', description: 'Give discounts within limit', dangerous: false },
  {
    code: 'pos.discount.override',
    module: 'pos',
    description: 'Approve discounts above limit',
    dangerous: false,
  },
  { code: 'pos.refund', module: 'pos', description: 'Refund at the POS', dangerous: false },
  { code: 'pos.void', module: 'pos', description: 'Void POS lines and bills', dangerous: false },
  { code: 'pos.shift.open', module: 'pos', description: 'Open a shift', dangerous: false },
  { code: 'pos.shift.close', module: 'pos', description: 'Close a shift', dangerous: false },
  { code: 'pos.cash.in_out', module: 'pos', description: 'Pay in / pay out cash', dangerous: false },
  { code: 'pos.reprint', module: 'pos', description: 'Reprint receipts', dangerous: false },
  { code: 'purchase.read', module: 'purchasing', description: 'View purchase orders', dangerous: false },
  { code: 'purchase.create', module: 'purchasing', description: 'Create purchase orders', dangerous: false },
  {
    code: 'purchase.approve',
    module: 'purchasing',
    description: 'Approve purchase orders',
    dangerous: false,
  },
  {
    code: 'purchase.receive',
    module: 'purchasing',
    description: 'Receive against purchase orders',
    dangerous: false,
  },
  { code: 'supplier.read', module: 'purchasing', description: 'View suppliers', dangerous: false },
  { code: 'supplier.manage', module: 'purchasing', description: 'Edit suppliers', dangerous: false },
  { code: 'customer.read', module: 'customers', description: 'View customers', dangerous: false },
  { code: 'customer.manage', module: 'customers', description: 'Edit customers', dangerous: false },
  {
    code: 'customer.pii.read',
    module: 'customers',
    description: 'See unmasked phone/address',
    dangerous: false,
  },
  { code: 'customer.export', module: 'customers', description: 'Export customer data', dangerous: true },
  { code: 'promotion.read', module: 'pricing', description: 'View promotions', dangerous: false },
  { code: 'promotion.manage', module: 'pricing', description: 'Edit promotions', dangerous: false },
  { code: 'coupon.manage', module: 'pricing', description: 'Edit coupons', dangerous: false },
  { code: 'loyalty.manage', module: 'customers', description: 'Edit loyalty settings', dangerous: false },
  { code: 'payment.read', module: 'payments', description: 'View payments', dangerous: false },
  { code: 'payment.refund', module: 'payments', description: 'Refund payments', dangerous: false },
  { code: 'report.read', module: 'reporting', description: 'View reports', dangerous: false },
  { code: 'report.export', module: 'reporting', description: 'Export reports', dangerous: false },
  {
    code: 'report.financial',
    module: 'reporting',
    description: 'View profit and cost reports',
    dangerous: false,
  },
  { code: 'channel.read', module: 'channels', description: 'View channel connections', dangerous: false },
  {
    code: 'channel.manage',
    module: 'channels',
    description: 'Connect and disconnect channels',
    dangerous: true,
  },
  { code: 'channel.mapping', module: 'channels', description: 'Map channel SKUs', dangerous: false },
  { code: 'channel.sync', module: 'channels', description: 'Trigger channel syncs', dangerous: false },
  { code: 'settings.manage', module: 'tenancy', description: 'Change business settings', dangerous: true },
  { code: 'audit.read', module: 'audit', description: 'View the audit log', dangerous: false },
  { code: 'api_key.manage', module: 'iam', description: 'Create and revoke API keys', dangerous: true },
  {
    code: 'webhook.manage',
    module: 'integrations',
    description: 'Manage outbound webhooks',
    dangerous: true,
  },
] as const satisfies readonly { code: string; module: string; description: string; dangerous: boolean }[];

export type PermissionCode = (typeof PERMISSION_CATALOG)[number]['code'];

export const ALL_PERMISSIONS: readonly PermissionCode[] = PERMISSION_CATALOG.map((p) => p.code);

const PERMISSION_SET: ReadonlySet<string> = new Set(ALL_PERMISSIONS);

export function isPermissionCode(value: string): value is PermissionCode {
  return PERMISSION_SET.has(value);
}

export function isDangerous(code: PermissionCode): boolean {
  return PERMISSION_CATALOG.find((p) => p.code === code)?.dangerous ?? false;
}
