import { sql } from 'kysely';
import type { Tx } from '@stockos/database';
import { uuidv7 } from '@stockos/shared';
import { isPermissionCode, type PermissionCode } from '../domain/permissions';
import type { Grant, ScopeType } from '../domain/policy';
import { SYSTEM_ROLES } from '../domain/system-roles';

export interface MembershipAccess {
  membershipId: string;
  userId: string;
  membershipStatus: string;
  tenantStatus: string;
  isOwner: boolean;
  grants: Grant[];
}

/** Everything needed to authorise one request, in one round trip. Caller's tx is tenant-scoped. */
export async function loadMembershipAccess(tx: Tx, membershipId: string): Promise<MembershipAccess | null> {
  const { rows } = await sql<{
    user_id: string;
    status: string;
    is_owner: boolean;
    tenant_status: string;
    permission_code: string | null;
    scope_type: ScopeType | null;
    scope_id: string | null;
    constraints: Record<string, unknown> | null;
  }>`
    select m.user_id, m.status, m.is_owner, t.status as tenant_status,
           rp.permission_code, mr.scope_type, mr.scope_id, rp.constraints
      from tenant_memberships m
      join tenants t on t.id = m.tenant_id
      left join membership_roles mr on mr.tenant_id = m.tenant_id and mr.membership_id = m.id
      left join role_permissions rp on rp.tenant_id = mr.tenant_id and rp.role_id = mr.role_id
     where m.id = ${membershipId}`.execute(tx);
  const first = rows[0];
  if (!first) return null;
  const grants: Grant[] = [];
  for (const r of rows) {
    if (!r.permission_code || !r.scope_type || !isPermissionCode(r.permission_code)) continue;
    grants.push({
      permission: r.permission_code,
      scopeType: r.scope_type,
      scopeId: r.scope_id,
      constraints: r.constraints ?? {},
    });
  }
  return {
    membershipId,
    userId: first.user_id,
    membershipStatus: first.status,
    tenantStatus: first.tenant_status,
    isOwner: first.is_owner,
    grants,
  };
}

/** Create the fixed system roles for a new tenant. Returns role ids by code. */
export async function createSystemRoles(tx: Tx, tenantId: string): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const role of SYSTEM_ROLES) {
    const id = uuidv7();
    ids.set(role.code, id);
    await sql`insert into roles (tenant_id, id, code, name, is_system, description)
              values (${tenantId}, ${id}, ${role.code}, ${role.name}, true, ${role.description})`.execute(tx);
    await insertRolePermissions(tx, tenantId, id, role.permissions);
  }
  return ids;
}

export async function insertRolePermissions(
  tx: Tx,
  tenantId: string,
  roleId: string,
  permissions: readonly PermissionCode[],
) {
  const unique = [...new Set(permissions)];
  if (unique.length === 0) return;
  await sql`insert into role_permissions (tenant_id, role_id, permission_code)
            select ${tenantId}, ${roleId}, unnest(${unique}::text[])`.execute(tx);
}

export interface RoleRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  version: number;
  permissions: PermissionCode[];
}

export async function listRoles(tx: Tx, roleId?: string): Promise<RoleRow[]> {
  const { rows } = await sql<{
    id: string;
    code: string;
    name: string;
    description: string | null;
    is_system: boolean;
    version: number;
    permissions: string[] | null;
  }>`
    select r.id, r.code, r.name, r.description, r.is_system, r.version,
           array_agg(rp.permission_code order by rp.permission_code) filter (where rp.permission_code is not null) as permissions
      from roles r
      left join role_permissions rp on rp.tenant_id = r.tenant_id and rp.role_id = r.id
     where (${roleId ?? null}::uuid is null or r.id = ${roleId ?? null}::uuid)
     group by r.tenant_id, r.id
     order by r.is_system desc, r.name`.execute(tx);
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    description: r.description,
    isSystem: r.is_system,
    version: r.version,
    permissions: (r.permissions ?? []).filter(isPermissionCode),
  }));
}

export interface RoleAssignment {
  roleId: string;
  scopeType: ScopeType;
  scopeId: string | null;
}

export async function listAssignments(
  tx: Tx,
  membershipId: string,
): Promise<(RoleAssignment & { roleCode: string })[]> {
  const { rows } = await sql<{
    role_id: string;
    scope_type: ScopeType;
    scope_id: string | null;
    code: string;
  }>`
    select mr.role_id, mr.scope_type, mr.scope_id, r.code
      from membership_roles mr join roles r on r.tenant_id = mr.tenant_id and r.id = mr.role_id
     where mr.membership_id = ${membershipId}
     order by r.code`.execute(tx);
  return rows.map((r) => ({
    roleId: r.role_id,
    scopeType: r.scope_type,
    scopeId: r.scope_id,
    roleCode: r.code,
  }));
}

export async function replaceAssignments(
  tx: Tx,
  tenantId: string,
  membershipId: string,
  assignments: readonly RoleAssignment[],
  grantedBy: string | null,
): Promise<void> {
  await sql`delete from membership_roles where membership_id = ${membershipId}`.execute(tx);
  for (const a of assignments) {
    await sql`insert into membership_roles (tenant_id, membership_id, role_id, scope_type, scope_id, granted_by)
              values (${tenantId}, ${membershipId}, ${a.roleId}, ${a.scopeType}, ${a.scopeId}, ${grantedBy})`.execute(
      tx,
    );
  }
}

/** True when the id exists in this tenant (RLS hides other tenants' rows). */
export async function scopeExists(tx: Tx, scopeType: ScopeType, scopeId: string): Promise<boolean> {
  const table = scopeType === 'BRANCH' ? sql`branches` : sql`warehouses`;
  const { rows } = await sql<{ one: number }>`select 1 as one from ${table} where id = ${scopeId}`.execute(
    tx,
  );
  return rows.length > 0;
}
