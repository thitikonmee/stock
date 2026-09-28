import { describe, expect, it } from 'vitest';
import { ForbiddenError } from '@stockos/shared';
import { ALL_PERMISSIONS, PERMISSION_CATALOG, isPermissionCode } from './permissions';
import { assertCan, can, tenantWidePermissions, type Grant, type Principal } from './policy';
import { SYSTEM_ROLES, SYSTEM_ROLE_CODES } from './system-roles';

const principal = (grants: Grant[]): Principal => ({
  userId: 'u',
  tenantId: 't',
  membershipId: 'm',
  sessionId: 's',
  isOwner: false,
  grants,
  amr: ['pwd'],
  authTime: 0,
});
const grant = (
  permission: Grant['permission'],
  scopeType: Grant['scopeType'] = 'TENANT',
  scopeId: string | null = null,
): Grant => ({
  permission,
  scopeType,
  scopeId,
  constraints: {},
});

describe('policy', () => {
  it('tenant grants cover every resource', () => {
    const p = principal([grant('inventory.adjust')]);
    expect(can(p, 'inventory.adjust')).toBe(true);
    expect(can(p, 'inventory.adjust', { branchId: 'b1', warehouseId: 'w1' })).toBe(true);
    expect(can(p, 'inventory.transfer')).toBe(false);
  });

  it('branch grants only cover that branch', () => {
    const p = principal([grant('inventory.adjust', 'BRANCH', 'b1')]);
    expect(can(p, 'inventory.adjust', { branchId: 'b1', warehouseId: 'w9' })).toBe(true);
    expect(can(p, 'inventory.adjust', { branchId: 'b2' })).toBe(false);
    expect(can(p, 'inventory.adjust')).toBe(false); // tenant-wide action needs a tenant grant
  });

  it('warehouse grants only cover that warehouse', () => {
    const p = principal([grant('inventory.count', 'WAREHOUSE', 'w1')]);
    expect(can(p, 'inventory.count', { branchId: 'b1', warehouseId: 'w1' })).toBe(true);
    expect(can(p, 'inventory.count', { branchId: 'b1', warehouseId: 'w2' })).toBe(false);
  });

  it('assertCan throws ForbiddenError', () => {
    expect(() => assertCan(principal([]), 'user.manage')).toThrow(ForbiddenError);
  });

  it('only tenant-scoped grants count as delegable', () => {
    const p = principal([grant('user.read'), grant('inventory.adjust', 'BRANCH', 'b1')]);
    expect([...tenantWidePermissions(p)]).toEqual(['user.read']);
  });
});

describe('catalog and system roles', () => {
  it('has unique permission codes', () => {
    expect(new Set(ALL_PERMISSIONS).size).toBe(PERMISSION_CATALOG.length);
  });

  it('defines every system role with known permissions', () => {
    expect(SYSTEM_ROLES.map((r) => r.code)).toEqual([...SYSTEM_ROLE_CODES]);
    for (const role of SYSTEM_ROLES) {
      expect(role.permissions.length).toBeGreaterThan(0);
      expect(new Set(role.permissions).size, `${role.code} lists a permission twice`).toBe(
        role.permissions.length,
      );
      for (const p of role.permissions) expect(isPermissionCode(p)).toBe(true);
    }
  });

  it('keeps the cashier away from refunds, overrides and user management', () => {
    const cashier = SYSTEM_ROLES.find((r) => r.code === 'CASHIER')!;
    for (const p of ['pos.refund', 'pos.discount.override', 'user.manage', 'inventory.adjust'] as const) {
      expect(cashier.permissions).not.toContain(p);
    }
  });

  it('never gives ADMIN billing or tenant closure', () => {
    const admin = SYSTEM_ROLES.find((r) => r.code === 'ADMIN')!;
    expect(admin.permissions).not.toContain('billing.manage');
    expect(admin.permissions).not.toContain('tenant.manage');
  });
});
