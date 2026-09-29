import type { AuthService, TokenPair } from '../../auth/public-api';
import type { PosPinService } from '../../iam/public-api';

export interface CashierLoginInput {
  employeeCode: string;
  pin: string;
}

export interface CashierSession extends TokenPair {
  membershipId: string;
}

/**
 * Cashier PIN login (docs/08-api-design.md `POST /pos/sessions`, docs/05-pos.md §15). The device
 * token (checked by the caller's `@DeviceAuth()` route) proves it is a registered terminal; the PIN
 * proves who is standing at it. On success this mints an ordinary session (same as password login),
 * so every other `/pos/*` route is just `@RequirePermission('pos.*')` like the rest of the API —
 * no separate "device-scoped" principal type. The tradeoff (a 4-6 digit PIN reaching the same
 * back-office grants as that person's password) is the one docs/05-pos.md §15 describes; RBAC still
 * gates what the session can do, e.g. CASHIER lacks `pos.refund`.
 */
export class CashierSessionService {
  constructor(
    private readonly pins: PosPinService,
    private readonly authService: AuthService,
  ) {}

  async login(tenantId: string, input: CashierLoginInput): Promise<CashierSession> {
    const verified = await this.pins.verify(tenantId, input.employeeCode, input.pin);
    const tokens = await this.authService.startSession(verified.userId, tenantId, verified.membershipId, [
      'pos_pin',
    ]);
    return { ...tokens, membershipId: verified.membershipId };
  }
}
