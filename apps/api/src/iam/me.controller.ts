import { Controller, Get, Inject } from '@nestjs/common';
import { sql } from 'kysely';
import { iam } from '@stockos/core';
import { tenantTx, type Db } from '@stockos/database';
import { AllowWithoutMfa, Authenticated, CurrentPrincipal } from '../auth/decorators';
import { DB } from '../tokens';

@Controller('me')
export class MeController {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Who am I, in which company, and what may I do (the UI hides what the API would refuse). */
  @Authenticated()
  @AllowWithoutMfa()
  @Get()
  async me(@CurrentPrincipal() principal: iam.Principal) {
    const row = await tenantTx(this.db, principal.tenantId, async (tx) => {
      const { rows } = await sql<{
        display_name: string;
        email: string | null;
        mfa_enabled: boolean;
        slug: string;
        name: string;
      }>`
        select u.display_name, u.email::text as email, u.mfa_enabled, t.slug::text as slug, t.name
          from users u cross join tenants t
         where u.id = ${principal.userId} and t.id = ${principal.tenantId}`.execute(tx);
      return rows[0]!;
    });
    return {
      userId: principal.userId,
      membershipId: principal.membershipId,
      displayName: row.display_name,
      email: row.email,
      mfaEnabled: row.mfa_enabled,
      isOwner: principal.isOwner,
      authType: principal.kind,
      // The UI must send the member to 2FA setup before anything else.
      mfaEnrollmentRequired:
        principal.kind === 'USER' &&
        principal.mfaEnforced &&
        !principal.mfaEnabled &&
        principal.grants.some((g) => iam.isDangerous(g.permission)),
      tenant: { id: principal.tenantId, slug: row.slug, name: row.name },
      grants: principal.grants.map((g) => ({
        permission: g.permission,
        scopeType: g.scopeType,
        scopeId: g.scopeId,
      })),
    };
  }
}
