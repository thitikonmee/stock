import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth } from '@stockos/core';
import { platformTx } from '@stockos/database';
import { addMember, call, createTestApi, signup, type Api } from '../support/api';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

let db: TestDatabase;
let api: Api;
let google: auth.GoogleFixtureServer;

beforeAll(async () => {
  db = await createTestDatabase();
  google = new auth.GoogleFixtureServer();
  api = await createTestApi(db, {
    oauthProviders: {
      GOOGLE: new auth.GoogleOAuthProvider({
        clientId: 'test-client',
        clientSecret: 'test-secret',
        fetcher: google.fetcher(),
      }),
    },
  });
});
afterAll(async () => {
  await api.close();
  await db.drop();
});

/** Drives the real redirect dance (start -> callback) against the Google fixture and returns the
 *  sealed login ticket the web app would receive on `?oauth=`. */
async function oauthTicket(code = google.expectedCode): Promise<string> {
  const start = await call(api, 'POST', '/api/v1/auth/oauth/google/start');
  expect(start.status).toBe(200);
  const state = new URL(start.body.authorizeUrl).searchParams.get('state')!;
  const res = await call(
    api,
    'GET',
    `/api/v1/auth/oauth/google/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
  );
  expect(res.status).toBe(302);
  const location = new URL(String(res.headers.location), 'https://x.test');
  const ticket = location.searchParams.get('oauth');
  if (!ticket) throw new Error(`callback did not return a ticket: ${location.toString()}`);
  return ticket;
}

describe('oauth start', () => {
  it('returns a well-formed Google authorize URL', async () => {
    const res = await call(api, 'POST', '/api/v1/auth/oauth/google/start');
    expect(res.status).toBe(200);
    const url = new URL(res.body.authorizeUrl);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://api.stockos.test/api/v1/auth/oauth/google/callback',
    );
    expect(url.searchParams.get('client_id')).toBe('test-client');
    expect(url.searchParams.get('state')).toBeTruthy();
  });

  it('rejects an unsupported provider', async () => {
    const res = await call(api, 'POST', '/api/v1/auth/oauth/twitter/start');
    expect(res).toMatchObject({ status: 400, body: { code: 'VALIDATION_FAILED' } });
  });

  it('redirects to a web error page for a bad code or a tampered/expired state', async () => {
    const start = await call(api, 'POST', '/api/v1/auth/oauth/google/start');
    const state = new URL(start.body.authorizeUrl).searchParams.get('state')!;

    const badCode = await call(
      api,
      'GET',
      `/api/v1/auth/oauth/google/callback?code=wrong-code&state=${encodeURIComponent(state)}`,
    );
    expect(badCode.status).toBe(302);
    const badCodeLocation = new URL(String(badCode.headers.location), 'https://x.test');
    expect(badCodeLocation.searchParams.get('oauth')).toBeNull();
    expect(badCodeLocation.searchParams.get('oauthError')).toBeTruthy();

    const badState = await call(
      api,
      'GET',
      `/api/v1/auth/oauth/google/callback?code=${google.expectedCode}&state=not-a-real-state`,
    );
    expect(badState.status).toBe(302);
    const badStateLocation = new URL(String(badState.headers.location), 'https://x.test');
    expect(badStateLocation.searchParams.get('oauthError')).toBeTruthy();
  });

  it('rejects an e-mail the provider never confirmed, before a ticket is ever issued', async () => {
    google.issuedProfile = {
      id: 'g-unverified',
      email: 'unverified@example.com',
      emailVerified: false,
      name: 'Nope',
    };
    const start = await call(api, 'POST', '/api/v1/auth/oauth/google/start');
    const state = new URL(start.body.authorizeUrl).searchParams.get('state')!;
    const res = await call(
      api,
      'GET',
      `/api/v1/auth/oauth/google/callback?code=${google.expectedCode}&state=${encodeURIComponent(state)}`,
    );
    expect(res.status).toBe(302);
    const location = new URL(String(res.headers.location), 'https://x.test');
    expect(location.searchParams.get('oauth')).toBeNull();
    expect(location.searchParams.get('oauthError')).toBeTruthy();
  });
});

describe('self-service signup via Google', () => {
  it('asks for a company name on first sign-in, then logs straight in next time', async () => {
    google.issuedProfile = {
      id: 'g-1',
      email: 'new-owner@example.com',
      emailVerified: true,
      name: 'New Owner',
    };

    const ticket = await oauthTicket();
    const resolved = await call(api, 'POST', '/api/v1/auth/oauth/resolve', { body: { ticket } });
    expect(resolved).toMatchObject({
      status: 200,
      body: { needsSignup: true, suggestedName: 'New Owner', email: 'new-owner@example.com' },
    });

    const signedUp = await call(api, 'POST', '/api/v1/auth/oauth/signup', {
      body: { ticket, companyName: 'New Owner Shop' },
    });
    expect(signedUp.status, JSON.stringify(signedUp.body)).toBe(200);
    expect(signedUp.body).toMatchObject({ tokenType: 'Bearer' });
    const { tenantId, userId, accessToken } = signedUp.body;

    const me = await call(api, 'GET', '/api/v1/me', { token: accessToken });
    expect(me.body).toMatchObject({ isOwner: true, tenant: { id: tenantId } });

    const branches = await call(api, 'GET', '/api/v1/branches', { token: accessToken });
    const warehouses = await call(api, 'GET', '/api/v1/warehouses', { token: accessToken });
    expect(branches.body).toMatchObject([{ code: 'HQ' }]);
    expect(warehouses.body).toMatchObject([{ code: 'MAIN', branchId: branches.body[0].id }]);

    const identity = await platformTx(db.app, (tx) =>
      sql<{ provider: string }>`select provider from user_identities where user_id = ${userId}`.execute(tx),
    );
    expect(identity.rows).toEqual([{ provider: 'GOOGLE' }]);

    // Same verified e-mail, fresh ticket, second time around: logs straight in, no signup step.
    const secondTicket = await oauthTicket();
    const secondResolve = await call(api, 'POST', '/api/v1/auth/oauth/resolve', {
      body: { ticket: secondTicket },
    });
    expect(secondResolve).toMatchObject({ status: 200, body: { mfaRequired: false, tokenType: 'Bearer' } });
    const me2 = await call(api, 'GET', '/api/v1/me', { token: secondResolve.body.accessToken });
    expect(me2.body.tenant.id).toBe(tenantId);
  });

  it('rejects a tampered ticket at resolve and at signup', async () => {
    const ticket = await oauthTicket();
    const tampered = ticket.slice(0, -4) + 'XXXX';

    const resolveRes = await call(api, 'POST', '/api/v1/auth/oauth/resolve', { body: { ticket: tampered } });
    expect(resolveRes).toMatchObject({ status: 401, body: { code: 'OAUTH_FAILED' } });

    const signupRes = await call(api, 'POST', '/api/v1/auth/oauth/signup', {
      body: { ticket: tampered, companyName: 'Whatever Co' },
    });
    expect(signupRes).toMatchObject({ status: 401, body: { code: 'OAUTH_FAILED' } });

    const garbage = await call(api, 'POST', '/api/v1/auth/oauth/resolve', {
      body: { ticket: 'not-a-real-ticket' },
    });
    expect(garbage).toMatchObject({ status: 401, body: { code: 'OAUTH_FAILED' } });
  });

  it('two concurrent signups for the same brand-new e-mail create exactly one tenant', async () => {
    google.issuedProfile = {
      id: 'g-race',
      email: 'race@example.com',
      emailVerified: true,
      name: 'Race Condition',
    };
    const ticket = await oauthTicket();

    const [first, second] = await Promise.all([
      call(api, 'POST', '/api/v1/auth/oauth/signup', { body: { ticket, companyName: 'Race Co A' } }),
      call(api, 'POST', '/api/v1/auth/oauth/signup', { body: { ticket, companyName: 'Race Co B' } }),
    ]);
    const results = [first, second].sort((x, y) => x.status - y.status);
    expect(results[0]).toMatchObject({ status: 200 });
    expect(results[1]).toMatchObject({ status: 409, body: { code: 'DUPLICATE' } });

    const users = await platformTx(db.app, (tx) =>
      sql<{ n: number }>`select count(*)::int as n from users where email = 'race@example.com'`.execute(tx),
    );
    expect(users.rows[0]!.n).toBe(1);
  });
});

describe('existing account linking', () => {
  it('lets an invited member who already set a password also sign in with Google', async () => {
    const owner = await signup(api, 'LinkCo');
    const member = await addMember(api, owner, [{ roleCode: 'VIEWER' }]);
    google.issuedProfile = { id: 'g-link', email: member.email, emailVerified: true, name: 'Linked Member' };

    const ticket = await oauthTicket();
    const resolved = await call(api, 'POST', '/api/v1/auth/oauth/resolve', { body: { ticket } });
    expect(resolved).toMatchObject({ status: 200, body: { mfaRequired: false, tokenType: 'Bearer' } });
    const me = await call(api, 'GET', '/api/v1/me', { token: resolved.body.accessToken });
    expect(me.body.tenant.id).toBe(owner.tenantId);
  });

  it('asks which company when the e-mail belongs to several tenants', async () => {
    const a = await signup(api, 'MultiA');
    const b = await signup(api, 'MultiB');
    const member = await addMember(api, a, [{ roleCode: 'VIEWER' }]);
    const roles = await call(api, 'GET', '/api/v1/roles', { token: b.accessToken });
    const invite = await call(api, 'POST', '/api/v1/users/invitations', {
      token: b.accessToken,
      body: {
        email: member.email,
        roles: [{ roleId: roles.body.find((r: { code: string }) => r.code === 'VIEWER').id }],
      },
    });
    await call(api, 'POST', '/api/v1/auth/invitations/accept', {
      body: { token: invite.body.token, password: member.password },
    });

    google.issuedProfile = { id: 'g-multi', email: member.email, emailVerified: true, name: 'Multi Member' };
    const ticket = await oauthTicket();
    const ambiguous = await call(api, 'POST', '/api/v1/auth/oauth/resolve', { body: { ticket } });
    expect(ambiguous).toMatchObject({ status: 422, body: { code: 'TENANT_SELECTION_REQUIRED' } });
    expect(ambiguous.body.meta.tenants.map((x: { slug: string }) => x.slug).sort()).toEqual(
      [a.slug, b.slug].sort(),
    );

    const secondTicket = await oauthTicket();
    const chosen = await call(api, 'POST', '/api/v1/auth/oauth/resolve', {
      body: { ticket: secondTicket, tenantSlug: b.slug },
    });
    expect(chosen.status, JSON.stringify(chosen.body)).toBe(200);
    const me = await call(api, 'GET', '/api/v1/me', { token: chosen.body.accessToken });
    expect(me.body.tenant.id).toBe(b.tenantId);
  });

  it('requires MFA the same way password login does', async () => {
    const owner = await signup(api, 'MfaCo');
    const setup = await call(api, 'POST', '/api/v1/auth/mfa/setup', { token: owner.accessToken });
    const secret = auth.base32Decode(setup.body.secret);
    const step = auth.currentStep();
    await call(api, 'POST', '/api/v1/auth/mfa/confirm', {
      token: owner.accessToken,
      body: { code: auth.totpAt(secret, step) },
    });

    google.issuedProfile = { id: 'g-mfa', email: owner.email, emailVerified: true, name: 'MFA Owner' };
    const ticket = await oauthTicket();
    const resolved = await call(api, 'POST', '/api/v1/auth/oauth/resolve', { body: { ticket } });
    expect(resolved).toMatchObject({ status: 200, body: { mfaRequired: true } });
    expect(resolved.body.accessToken).toBeUndefined();

    const verified = await call(api, 'POST', '/api/v1/auth/mfa/verify', {
      body: { mfaToken: resolved.body.mfaToken, code: auth.totpAt(secret, step + 1) },
    });
    expect(verified.status, JSON.stringify(verified.body)).toBe(200);
  });
});
