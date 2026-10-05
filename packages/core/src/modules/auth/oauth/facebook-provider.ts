import { ValidationError } from '@stockos/shared';
import { readOAuthJson } from './http';
import type { Fetcher, OAuthProfile, OAuthProvider } from './provider';

export interface FacebookOAuthConfig {
  appId: string;
  appSecret: string;
  fetcher?: Fetcher;
}

const AUTHORIZE_URL = 'https://www.facebook.com/v18.0/dialog/oauth';
const TOKEN_URL = 'https://graph.facebook.com/v18.0/oauth/access_token';
const ME_URL = 'https://graph.facebook.com/v18.0/me';

/** Facebook Login (OAuth2 over the Graph API). Same pure translator+transport role as
 *  `GoogleOAuthProvider`. */
export class FacebookOAuthProvider implements OAuthProvider {
  readonly code = 'FACEBOOK' as const;
  private readonly fetcher: Fetcher;

  constructor(private readonly config: FacebookOAuthConfig) {
    this.fetcher = config.fetcher ?? ((url, init) => fetch(url, init));
  }

  buildAuthorizeUrl(redirectUri: string, state: string): string {
    const qs = new URLSearchParams({
      client_id: this.config.appId,
      redirect_uri: redirectUri,
      state,
      scope: 'email,public_profile',
      response_type: 'code',
    });
    return `${AUTHORIZE_URL}?${qs.toString()}`;
  }

  async exchangeCode(code: string, redirectUri: string): Promise<OAuthProfile> {
    const tokenQs = new URLSearchParams({
      client_id: this.config.appId,
      client_secret: this.config.appSecret,
      redirect_uri: redirectUri,
      code,
    });
    const tokenRes = await this.fetcher(`${TOKEN_URL}?${tokenQs.toString()}`);
    const token = await readOAuthJson<{ access_token: string }>(tokenRes, 'Facebook');

    const profileQs = new URLSearchParams({ fields: 'id,name,email', access_token: token.access_token });
    const profileRes = await this.fetcher(`${ME_URL}?${profileQs.toString()}`);
    const profile = await readOAuthJson<{ id: string; name?: string; email?: string }>(
      profileRes,
      'Facebook',
    );
    if (!profile.email) throw new ValidationError('Facebook account has no e-mail address');
    return {
      providerId: profile.id,
      email: profile.email,
      // The Graph API has no separate "email_verified" claim — it only ever returns `email` in
      // the profile response when Facebook has verified it and the user granted the `email`
      // permission, so presence here already means Facebook vouches for it.
      emailVerified: true,
      name: profile.name || profile.email,
    };
  }
}
