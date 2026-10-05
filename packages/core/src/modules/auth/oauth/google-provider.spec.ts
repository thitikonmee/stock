import { beforeEach, describe, expect, it } from 'vitest';
import { GoogleOAuthProvider } from './google-provider';
import { GoogleFixtureServer } from './fixtures/fixture-fetcher';

const CLIENT_ID = 'test-google-client-id';
const CLIENT_SECRET = 'test-google-client-secret';
const REDIRECT_URI = 'https://api.stockos.test/api/v1/auth/oauth/google/callback';

function makeProvider(fixture: GoogleFixtureServer) {
  return new GoogleOAuthProvider({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    fetcher: fixture.fetcher(),
  });
}

describe('GoogleOAuthProvider', () => {
  let fixture: GoogleFixtureServer;
  let provider: GoogleOAuthProvider;

  beforeEach(() => {
    fixture = new GoogleFixtureServer();
    provider = makeProvider(fixture);
  });

  it('builds an authorize URL with client_id, redirect_uri, scope, and state', () => {
    const url = provider.buildAuthorizeUrl(REDIRECT_URI, 'opaque-state');
    const parsed = new URL(url);
    expect(parsed.hostname).toBe('accounts.google.com');
    expect(parsed.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(parsed.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(parsed.searchParams.get('scope')).toContain('email');
    expect(parsed.searchParams.get('state')).toBe('opaque-state');
    expect(parsed.searchParams.get('response_type')).toBe('code');
  });

  it('exchanges a valid code for a verified profile', async () => {
    fixture.issuedProfile = {
      id: 'g-12345',
      email: 'owner@example.com',
      emailVerified: true,
      name: 'Somchai Owner',
    };
    const profile = await provider.exchangeCode(fixture.expectedCode, REDIRECT_URI);
    expect(profile).toEqual({
      providerId: 'g-12345',
      email: 'owner@example.com',
      emailVerified: true,
      name: 'Somchai Owner',
    });
  });

  it('passes through an unverified email as-is (policy decision belongs to the caller)', async () => {
    fixture.issuedProfile = { id: 'g-2', email: 'unverified@example.com', emailVerified: false, name: 'X' };
    const profile = await provider.exchangeCode(fixture.expectedCode, REDIRECT_URI);
    expect(profile.emailVerified).toBe(false);
  });

  it('rejects a wrong or replayed code', async () => {
    await expect(provider.exchangeCode('not-the-real-code', REDIRECT_URI)).rejects.toThrow();
  });

  it('falls back to email when Google returns no name', async () => {
    fixture.issuedProfile = { id: 'g-3', email: 'noname@example.com', emailVerified: true, name: '' };
    const profile = await provider.exchangeCode(fixture.expectedCode, REDIRECT_URI);
    expect(profile.name).toBe('noname@example.com');
  });
});
