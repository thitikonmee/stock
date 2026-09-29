import { sql } from 'kysely';
import { tenantTx, type Db, type Tx } from '@stockos/database';
import { UnauthenticatedError, ValidationError } from '@stockos/shared';
import { recordAudit } from '../../audit/public-api';
import { assertCan, type Principal } from '../domain/policy';
import { assertAcceptablePin, hashPin, verifyPin } from '../infrastructure/pin-hash';

export interface PosPinConfig {
  maxFailedAttempts: number;
  lockoutMinutes: number;
}

export const DEFAULT_POS_PIN_CONFIG: PosPinConfig = { maxFailedAttempts: 5, lockoutMinutes: 15 };

export interface PinVerified {
  membershipId: string;
  userId: string;
}

/**
 * Cashier PIN login (docs/05-pos.md §15: "PIN 4-6 หลัก, lock หลังผิด 5 ครั้ง"). The PIN hash lives on
 * `tenant_memberships` (one per person per tenant), so this is an iam concern, not `pos`'s — the pos
 * module only calls `verify()` through this public-api and never touches `tenant_memberships` itself.
 *
 * `setPin` runs inside the caller's transaction like any other write. `verify` deliberately does not:
 * a failed attempt must be persisted even though the overall request goes on to throw (same reasoning
 * as auth/application/auth-service.ts's own login lockout, which this mirrors).
 */
export class PosPinService {
  constructor(
    private readonly db: Db,
    private readonly config: PosPinConfig = DEFAULT_POS_PIN_CONFIG,
  ) {}

  /** A member sets their own PIN; setting someone else's needs `user.manage`. */
  async setPin(tx: Tx, principal: Principal, membershipId: string, pin: string): Promise<void> {
    if (membershipId !== principal.membershipId) assertCan(principal, 'user.manage');
    assertAcceptablePin(pin);
    const hash = await hashPin(pin);
    const { rows } = await sql`
      update tenant_memberships
         set pos_pin_hash = ${hash}, pos_pin_failed_count = 0, pos_pin_locked_until = null
       where id = ${membershipId} returning id`.execute(tx);
    if (rows.length === 0) throw new ValidationError('Unknown membership', { membershipId });
    await recordAudit(tx, {
      tenantId: principal.tenantId,
      action: 'pos_pin.set',
      resourceType: 'tenant_membership',
      resourceId: membershipId,
    });
  }

  /** Remove a PIN (e.g. offboarding); `user.manage` always required since it is never self-service alone. */
  async clearPin(tx: Tx, principal: Principal, membershipId: string): Promise<void> {
    assertCan(principal, 'user.manage');
    await sql`update tenant_memberships set pos_pin_hash = null where id = ${membershipId}`.execute(tx);
    await recordAudit(tx, {
      tenantId: principal.tenantId,
      action: 'pos_pin.clear',
      resourceType: 'tenant_membership',
      resourceId: membershipId,
    });
  }

  /** Verify an employee code + PIN within one tenant (the device's tenant). Never reveals which part was wrong. */
  async verify(tenantId: string, employeeCode: string, pin: string): Promise<PinVerified> {
    const row = await tenantTx(this.db, tenantId, (tx) => this.loadForVerify(tx, employeeCode));
    if (!row) {
      // Still pay the hashing cost so a missing employee code is not distinguishable by timing.
      await verifyPin(undefined, pin);
      throw new UnauthenticatedError('INVALID_CREDENTIALS', 'Invalid employee code or PIN');
    }
    if (row.pos_pin_locked_until && row.pos_pin_locked_until > new Date()) {
      throw new UnauthenticatedError('ACCOUNT_LOCKED', 'Too many failed attempts, try again later');
    }
    const ok = await verifyPin(row.pos_pin_hash, pin);
    if (!ok) {
      await this.recordFailure(tenantId, row.id);
      throw new UnauthenticatedError('INVALID_CREDENTIALS', 'Invalid employee code or PIN');
    }
    await this.resetFailures(tenantId, row.id);
    return { membershipId: row.id, userId: row.user_id };
  }

  private async loadForVerify(tx: Tx, employeeCode: string) {
    const { rows } = await sql<{
      id: string;
      user_id: string;
      pos_pin_hash: string | null;
      pos_pin_locked_until: Date | null;
    }>`
      select id, user_id, pos_pin_hash, pos_pin_locked_until
        from tenant_memberships
       where employee_code = ${employeeCode} and status = 'ACTIVE' and pos_pin_hash is not null`.execute(tx);
    return rows[0];
  }

  private async recordFailure(tenantId: string, membershipId: string): Promise<void> {
    await tenantTx(this.db, tenantId, (tx) =>
      sql`with next as (
            select id, case when pos_pin_locked_until < now() then 1 else pos_pin_failed_count + 1 end as n
              from tenant_memberships where id = ${membershipId} for update)
          update tenant_memberships m set pos_pin_failed_count = next.n,
                 pos_pin_locked_until = case when next.n >= ${this.config.maxFailedAttempts}
                                     then now() + make_interval(mins => ${this.config.lockoutMinutes})
                                     when m.pos_pin_locked_until < now() then null else m.pos_pin_locked_until end
            from next where m.id = next.id`.execute(tx),
    );
  }

  private async resetFailures(tenantId: string, membershipId: string): Promise<void> {
    await tenantTx(this.db, tenantId, (tx) =>
      sql`update tenant_memberships set pos_pin_failed_count = 0, pos_pin_locked_until = null
           where id = ${membershipId}`.execute(tx),
    );
  }
}
