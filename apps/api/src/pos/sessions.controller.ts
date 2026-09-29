import { Body, Controller, HttpCode, Inject, Post } from '@nestjs/common';
import { z } from 'zod';
import { pos, type tenancy } from '@stockos/core';
import { CurrentDevice, DeviceAuth } from '../auth/decorators';
import { parse } from '../common/validation';

const LoginBody = z.strictObject({ employeeCode: z.string().trim().min(1).max(40), pin: z.string() });

/** Cashier PIN login on a registered device (docs/08-api-design.md `POST /pos/sessions`). */
@Controller('pos')
export class PosSessionsController {
  constructor(@Inject(pos.CashierSessionService) private readonly sessions: pos.CashierSessionService) {}

  @DeviceAuth()
  @Post('sessions')
  @HttpCode(200)
  login(@CurrentDevice() device: tenancy.DevicePrincipal, @Body() body: unknown) {
    const input = parse(LoginBody, body);
    return this.sessions.login(device.tenantId, input);
  }
}
