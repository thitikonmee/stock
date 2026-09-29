export { RoleService, type CreateRoleInput, type UpdateRoleInput } from './application/role-service';
export {
  PosPinService,
  DEFAULT_POS_PIN_CONFIG,
  type PinVerified,
  type PosPinConfig,
} from './application/pos-pin-service';
export {
  ALL_PERMISSIONS,
  PERMISSION_CATALOG,
  isDangerous,
  isPermissionCode,
  type PermissionCode,
} from './domain/permissions';
export {
  assertCan,
  can,
  tenantWidePermissions,
  type Grant,
  type Principal,
  type ResourceScope,
  type ScopeType,
} from './domain/policy';
export {
  SYSTEM_ROLES,
  SYSTEM_ROLE_CODES,
  isSystemRoleCode,
  type SystemRoleCode,
} from './domain/system-roles';
export {
  createSystemRoles,
  listAssignments,
  loadMembershipAccess,
  replaceAssignments,
  type MembershipAccess,
  type RoleAssignment,
  type RoleRow,
} from './infrastructure/iam-repository';
