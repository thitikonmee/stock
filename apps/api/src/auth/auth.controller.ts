import { Body, Controller, HttpCode, Inject, Post } from '@nestjs/common';
import { z } from 'zod';
import { auth, type iam } from '@stockos/core';
import { parse } from '../common/validation';
import { AllowWithoutMfa, Authenticated, CurrentPrincipal, Public, RateLimit } from './decorators';

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

@Controller('auth')
export class AuthController {
  constructor(
    @Inject(auth.AuthService) private readonly authService: auth.AuthService,
    @Inject(auth.UserService) private readonly users: auth.UserService,
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
