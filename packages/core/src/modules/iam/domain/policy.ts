import { ForbiddenError } from '@stockos/shared';
import type { PermissionCode } from './permissions';

export type ScopeType = 'TENANT' | 'BRANCH' | 'WAREHOUSE';

export interface Grant {
  permission: PermissionCode;
  scopeType: ScopeType;
  /** null for TENANT scope. */
  scopeId: string | null;
  constraints: Readonly<Record<string, unknown>>;
}

/**
 * The authenticated caller, resolved per request from the credential and the database.
 * An API key acts on behalf of the member who created it (`userId`/`membershipId`), with
 * `grants` narrowed to the key's permissions — revoking or suspending the creator stops the key.
 */
export interface Principal {
  kind: 'USER' | 'API_KEY';
  userId: string;
  tenantId: string;
  membershipId: string;
  /** Login session (null for API keys). */
  sessionId: string | null;
  apiKeyId: string | null;
  /** API keys only: requests allowed per minute. */
  rateLimitPerMin?: number;
  isOwner: boolean;
  grants: readonly Grant[];
  /** Authentication methods of the session, e.g. ['pwd'] or ['pwd', 'otp']. */
  amr: readonly string[];
  /** Unix seconds of the last primary/2FA authentication. */
  authTime: number;
  mfaEnabled: boolean;
  /** The tenant's grace period for mandatory 2FA is over. */
  mfaEnforced: boolean;
}

/** Where a resource lives. A branch grant covers the branch's warehouses when branchId is passed too. */
export interface ResourceScope {
  branchId?: string | null;
  warehouseId?: string | null;
}

export function can(principal: Principal, permission: PermissionCode, scope: ResourceScope = {}): boolean {
  return principal.grants.some((g) => {
    if (g.permission !== permission) return false;
    switch (g.scopeType) {
      case 'TENANT':
        return true;
      case 'BRANCH':
        return scope.branchId != null && g.scopeId === scope.branchId;
      case 'WAREHOUSE':
        return scope.warehouseId != null && g.scopeId === scope.warehouseId;
    }
  });
}

export function assertCan(principal: Principal, permission: PermissionCode, scope: ResourceScope = {}): void {
  if (!can(principal, permission, scope)) {
    throw new ForbiddenError(`Missing permission ${permission}`, { permission });
  }
}

/** Permissions the principal holds for the whole tenant — the ceiling for what they may delegate. */
export function tenantWidePermissions(principal: Principal): ReadonlySet<PermissionCode> {
  return new Set(principal.grants.filter((g) => g.scopeType === 'TENANT').map((g) => g.permission));
}
