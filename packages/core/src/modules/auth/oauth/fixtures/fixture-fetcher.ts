import type { Fetcher } from '../provider';

export interface FixtureProfile {
  id: string;
  email: string;
  emailVerified?: boolean;
  name: string;
}

const DEFAULT_PROFILE: FixtureProfile = {
  id: 'fixture-google-1',
  email: 'owner@example.com',
  emailVerified: true,
  name: 'Fixture Owner',
};

/** In-memory stand-in for Google's token + userinfo endpoints (keyed by pathname only, same
 *  technique as `channels.ShopeeFixtureServer`) — lets the real `GoogleOAuthProvider` (request
 *  shaping, token exchange, profile parsing) run end to end without a real Google Cloud app. */
export class GoogleFixtureServer {
  issuedProfile: FixtureProfile = { ...DEFAULT_PROFILE };
  /** The one `code` value `exchangeCode` will accept — lets a test prove a wrong/replayed code fails. */
  expectedCode = 'fixture-google-code';

  fetcher(): Fetcher {
    return async (url, init) => {
      const u = new URL(url);
      if (u.pathname === '/token') {
        const body = new URLSearchParams(String(init?.body ?? ''));
        if (body.get('code') !== this.expectedCode) {
          return new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Bad code' }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(
          JSON.stringify({
            access_token: 'fixture-google-access-token',
            token_type: 'Bearer',
            expires_in: 3600,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (u.pathname === '/oauth2/v3/userinfo') {
        return new Response(
          JSON.stringify({
            sub: this.issuedProfile.id,
            email: this.issuedProfile.email,
            email_verified: this.issuedProfile.emailVerified ?? true,
            name: this.issuedProfile.name,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ error: 'not_found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    };
  }
}

/** Same role as `GoogleFixtureServer`, for `FacebookOAuthProvider`'s token + /me endpoints. */
export class FacebookFixtureServer {
  issuedProfile: FixtureProfile = {
    id: 'fixture-facebook-1',
    email: 'owner@example.com',
    name: 'Fixture Owner',
  };
  expectedCode = 'fixture-facebook-code';

  fetcher(): Fetcher {
    return async (url) => {
      const u = new URL(url);
      if (u.pathname === '/v18.0/oauth/access_token') {
        if (u.searchParams.get('code') !== this.expectedCode) {
          return new Response(JSON.stringify({ error: { message: 'Bad code', type: 'OAuthException' } }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(
          JSON.stringify({
            access_token: 'fixture-facebook-access-token',
            token_type: 'bearer',
            expires_in: 5183944,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (u.pathname === '/v18.0/me') {
        return new Response(
          JSON.stringify({
            id: this.issuedProfile.id,
            email: this.issuedProfile.email,
            name: this.issuedProfile.name,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ error: { message: 'Unknown path' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    };
  }
}
