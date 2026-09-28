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
