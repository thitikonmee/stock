import type { Tx } from '@stockos/database';
import { ForbiddenError } from '@stockos/shared';
import { loadMembershipAccess, type PermissionCode, type PosPinService } from '../../iam/public-api';
import type { ManagerOverrideInput } from '../domain/types';

/**
 * "Manager PIN override" (docs/05-pos.md §15): a second person's PIN authorises something the
 * signed-in cashier's own grants do not cover (discount above their limit, selling into negative
 * stock, a refund). Verifies the PIN, then checks that membership actually holds `permission` —
 * a cashier mistyping their own PIN back in must not silently "approve" their own request.
 * Returns the approving membership id, recorded on the order/refund for audit.
 */
export async function verifyManagerOverride(
  tx: Tx,
  pins: PosPinService,
  tenantId: string,
  override: ManagerOverrideInput,
  permission: PermissionCode,
): Promise<string> {
  const verified = await pins.verify(tenantId, override.employeeCode, override.pin);
  const access = await loadMembershipAccess(tx, verified.membershipId);
  if (!access || access.membershipStatus !== 'ACTIVE' || access.userStatus !== 'ACTIVE') {
    throw new ForbiddenError('Manager account is not active');
  }
  if (!access.grants.some((g) => g.permission === permission)) {
    throw new ForbiddenError(`Manager lacks ${permission}`, { permission });
  }
  return verified.membershipId;
}
