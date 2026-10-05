/**
 * An identity provider used for login/self-service-signup (Google, Facebook) — deliberately
 * separate from `channels.ChannelAdapter`: a login provider only ever needs "send the user here to
 * authorize" + "turn an auth code into a verified profile", none of a channel adapter's
 * product/order/stock surface. The injectable `Fetcher` mirrors the same testability pattern
 * (`channels.ShopeeAdapter` etc.) — a fixture server stands in for the real provider's HTTP
 * endpoints so the real signing/request-shaping/parsing code runs end to end without a real
 * Google/Facebook app.
 */
export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export type OAuthProviderCode = 'GOOGLE' | 'FACEBOOK';

export interface OAuthProfile {
  providerId: string;
  email: string;
  /** Whether the provider itself vouches for this email (Google's own `email_verified` claim, or
   *  — for Facebook, which has no separate flag — the fact Facebook only ever returns `email` in
   *  the profile when it has verified and the user has granted the `email` permission). Callers
   *  must reject a login/signup attempt where this is false; a provider implementation must never
   *  set it true without being sure. */
  emailVerified: boolean;
  name: string;
}

export interface OAuthProvider {
  readonly code: OAuthProviderCode;
  buildAuthorizeUrl(redirectUri: string, state: string): string;
  exchangeCode(code: string, redirectUri: string): Promise<OAuthProfile>;
}
