import { ValidationError } from '@stockos/shared';
import { readOAuthJson } from './http';
import type { Fetcher, OAuthProfile, OAuthProvider } from './provider';

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  fetcher?: Fetcher;
}

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';

/** Google OAuth2 authorization-code flow (openid + email + profile scopes). Pure translator +
 *  transport, same principle as `channels.ChannelAdapter` — no session/tenant/account decisions
 *  happen here, only "send the user here" and "turn a code into a verified profile". */
export class GoogleOAuthProvider implements OAuthProvider {
  readonly code = 'GOOGLE' as const;
  private readonly fetcher: Fetcher;

  constructor(private readonly config: GoogleOAuthConfig) {
    this.fetcher = config.fetcher ?? ((url, init) => fetch(url, init));
  }

  buildAuthorizeUrl(redirectUri: string, state: string): string {
    const qs = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      access_type: 'online',
      prompt: 'select_account',
    });
    return `${AUTHORIZE_URL}?${qs.toString()}`;
  }

  async exchangeCode(code: string, redirectUri: string): Promise<OAuthProfile> {
    const tokenRes = await this.fetcher(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }).toString(),
    });
    const token = await readOAuthJson<{ access_token: string }>(tokenRes, 'Google');

    const profileRes = await this.fetcher(USERINFO_URL, {
      headers: { authorization: `Bearer ${token.access_token}` },
    });
    const profile = await readOAuthJson<{
      sub: string;
      email?: string;
      email_verified?: boolean;
      name?: string;
    }>(profileRes, 'Google');
    if (!profile.email) throw new ValidationError('Google account has no e-mail address');
    return {
      providerId: profile.sub,
      email: profile.email,
      emailVerified: Boolean(profile.email_verified),
      name: profile.name || profile.email,
    };
  }
}
