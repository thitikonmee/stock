import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { auth, type iam } from '@stockos/core';
import { ValidationError } from '@stockos/shared';
import { parse } from '../common/validation';
import { API_BASE_URL, WEB_BASE_URL } from '../tokens';
import { AllowWithoutMfa, Authenticated, CurrentPrincipal, Public, RateLimit } from './decorators';

const SUPPORTED_OAUTH_PROVIDERS = ['google', 'facebook'] as const;
function assertOAuthProvider(provider: string): auth.OAuthProviderCode {
  if (!SUPPORTED_OAUTH_PROVIDERS.includes(provider as (typeof SUPPORTED_OAUTH_PROVIDERS)[number])) {
    throw new ValidationError(`Unsupported sign-in provider: ${provider}`);
  }
  return provider.toUpperCase() as auth.OAuthProviderCode;
}

const SignupBody = z.strictObject({
  companyName: z.string().trim().min(2).max(120),
  slug: z.string().trim().min(3).max(40),
  ownerName: z.string().trim().min(1).max(120),
  email: z.string().trim().max(254),
  password: z.string().max(256),
});
const LoginBody = z.strictObject({
  identifier: z.string().trim().min(1).max(320),
  password: z.string().max(256),
  tenantSlug: z.string().trim().max(40).optional(),
});
const MfaVerifyBody = z.strictObject({ mfaToken: z.string().max(2048), code: z.string().max(10) });
const RefreshBody = z.strictObject({ refreshToken: z.string().min(20).max(200) });
const AcceptBody = z.strictObject({
  token: z.string().max(300),
  password: z.string().max(256),
  displayName: z.string().trim().max(120).optional(),
});
const CodeBody = z.strictObject({ code: z.string().max(10) });
const OAuthResolveBody = z.strictObject({
  ticket: z.string().min(1).max(4096),
  tenantSlug: z.string().trim().max(40).optional(),
});
const OAuthSignupBody = z.strictObject({
  ticket: z.string().min(1).max(4096),
  companyName: z.string().trim().min(2).max(120),
});

@Controller('auth')
export class AuthController {
  constructor(
    @Inject(auth.AuthService) private readonly authService: auth.AuthService,
    @Inject(auth.UserService) private readonly users: auth.UserService,
    @Inject(API_BASE_URL) private readonly apiBaseUrl: string,
    @Inject(WEB_BASE_URL) private readonly webBaseUrl: string,
  ) {}

  @Public()
  @RateLimit('signup')
  @Post('signup')
  signup(@Body() body: unknown) {
    return this.authService.signup(parse(SignupBody, body));
  }

  @Public()
  @RateLimit('login')
  @Post('login')
  @HttpCode(200)
  login(@Body() body: unknown) {
    const input = parse(LoginBody, body);
    return this.authService.login({
      identifier: input.identifier,
      password: input.password,
      ...(input.tenantSlug ? { tenantSlug: input.tenantSlug } : {}),
    });
  }

  @Public()
  @RateLimit('mfa')
  @Post('mfa/verify')
  @HttpCode(200)
  verifyMfa(@Body() body: unknown) {
    return this.authService.verifyMfa(parse(MfaVerifyBody, body));
  }

  @Public()
  @RateLimit('refresh')
  @Post('refresh')
  @HttpCode(200)
  refresh(@Body() body: unknown) {
    return this.authService.refresh(parse(RefreshBody, body).refreshToken);
  }

  @Public()
  @RateLimit('invitation-accept')
  @Post('invitations/accept')
  @HttpCode(200)
  acceptInvitation(@Body() body: unknown) {
    const input = parse(AcceptBody, body);
    return this.users.acceptInvitation({
      token: input.token,
      password: input.password,
      ...(input.displayName ? { displayName: input.displayName } : {}),
    });
  }

  @Public()
  @RateLimit('oauth')
  @Post('oauth/:provider/start')
  @HttpCode(200)
  oauthStart(@Param('provider') provider: string) {
    const code = assertOAuthProvider(provider);
    const redirectUri = `${this.apiBaseUrl}/api/v1/auth/oauth/${provider}/callback`;
    return { authorizeUrl: this.authService.oauthAuthorizeUrl(code, redirectUri) };
  }

  // No auth: the provider's browser redirect here carries none of our session cookies/headers —
  // `state` (sealed by oauthStart) is what proves this followed a request we actually issued. Never
  // returns tokens directly — always hands the browser back to the web app, which exchanges the
  // sealed ticket for a real session itself (see docs on oauthResolve/oauthSignup below).
  @Public()
  @Get('oauth/:provider/callback')
  async oauthCallback(
    @Param('provider') provider: string,
    @Query() query: Record<string, string>,
    @Res() reply: FastifyReply,
  ) {
    const code = assertOAuthProvider(provider);
    try {
      const redirectUri = `${this.apiBaseUrl}/api/v1/auth/oauth/${provider}/callback`;
      const ticket = await this.authService.oauthCallback(
        code,
        query.code ?? '',
        query.state ?? '',
        redirectUri,
      );
      void reply.redirect(`${this.webBaseUrl}/login?oauth=${encodeURIComponent(ticket)}`, 302);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'sign-in failed';
      void reply.redirect(`${this.webBaseUrl}/login?oauthError=${encodeURIComponent(message)}`, 302);
    }
  }

  @Public()
  @RateLimit('oauth')
  @Post('oauth/resolve')
  @HttpCode(200)
  oauthResolve(@Body() body: unknown) {
    const input = parse(OAuthResolveBody, body);
    return this.authService.oauthResolve(input.ticket, input.tenantSlug);
  }

  @Public()
  @RateLimit('oauth')
  @Post('oauth/signup')
  @HttpCode(200)
  oauthSignup(@Body() body: unknown) {
    const input = parse(OAuthSignupBody, body);
    return this.authService.oauthSignup(input.ticket, input.companyName);
  }

  @Authenticated()
  @AllowWithoutMfa()
  @Post('logout')
  @HttpCode(204)
  async logout(@CurrentPrincipal() principal: iam.Principal) {
    await this.authService.logout(principal);
  }

  @Authenticated()
  @AllowWithoutMfa()
  @Post('mfa/setup')
  @HttpCode(200)
  setupMfa(@CurrentPrincipal() principal: iam.Principal) {
    return this.authService.startMfaEnrolment(principal);
  }

  @Authenticated()
  @AllowWithoutMfa()
  @Post('mfa/confirm')
  @HttpCode(204)
  async confirmMfa(@CurrentPrincipal() principal: iam.Principal, @Body() body: unknown) {
    await this.authService.confirmMfaEnrolment(principal, parse(CodeBody, body).code);
  }

  /** Re-prove 2FA to unlock dangerous actions (see STEP_UP_REQUIRED). */
  @Authenticated()
  @RateLimit('mfa')
  @Post('step-up')
  @HttpCode(200)
  stepUp(@CurrentPrincipal() principal: iam.Principal, @Body() body: unknown) {
    return this.authService.stepUp(principal, parse(CodeBody, body).code);
  }
}
