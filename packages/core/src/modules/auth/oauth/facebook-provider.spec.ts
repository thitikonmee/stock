import { beforeEach, describe, expect, it } from 'vitest';
import { FacebookOAuthProvider } from './facebook-provider';
import { FacebookFixtureServer } from './fixtures/fixture-fetcher';

const APP_ID = 'test-facebook-app-id';
const APP_SECRET = 'test-facebook-app-secret';
const REDIRECT_URI = 'https://api.stockos.test/api/v1/auth/oauth/facebook/callback';

function makeProvider(fixture: FacebookFixtureServer) {
  return new FacebookOAuthProvider({ appId: APP_ID, appSecret: APP_SECRET, fetcher: fixture.fetcher() });
}

describe('FacebookOAuthProvider', () => {
  let fixture: FacebookFixtureServer;
  let provider: FacebookOAuthProvider;

  beforeEach(() => {
    fixture = new FacebookFixtureServer();
    provider = makeProvider(fixture);
  });

  it('builds an authorize URL with client_id, redirect_uri, scope, and state', () => {
    const url = provider.buildAuthorizeUrl(REDIRECT_URI, 'opaque-state');
    const parsed = new URL(url);
    expect(parsed.hostname).toBe('www.facebook.com');
    expect(parsed.searchParams.get('client_id')).toBe(APP_ID);
    expect(parsed.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(parsed.searchParams.get('scope')).toContain('email');
    expect(parsed.searchParams.get('state')).toBe('opaque-state');
  });

  it('exchanges a valid code for a profile, always marked email-verified', async () => {
    fixture.issuedProfile = { id: 'fb-999', email: 'owner@example.com', name: 'Somchai Owner' };
    const profile = await provider.exchangeCode(fixture.expectedCode, REDIRECT_URI);
    expect(profile).toEqual({
      providerId: 'fb-999',
      email: 'owner@example.com',
      emailVerified: true,
      name: 'Somchai Owner',
    });
  });

  it('rejects a wrong or replayed code', async () => {
    await expect(provider.exchangeCode('not-the-real-code', REDIRECT_URI)).rejects.toThrow();
  });

  it('falls back to email when Facebook returns no name', async () => {
    fixture.issuedProfile = { id: 'fb-2', email: 'noname@example.com', name: '' };
    const profile = await provider.exchangeCode(fixture.expectedCode, REDIRECT_URI);
    expect(profile.name).toBe('noname@example.com');
  });
});
