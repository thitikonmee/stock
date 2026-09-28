import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { tenancy, type iam } from '@stockos/core';
import { tenantTx, type Db } from '@stockos/database';
import {
  CurrentDevice,
  CurrentPrincipal,
  DeviceAuth,
  Public,
  RateLimit,
  RequirePermission,
} from '../auth/decorators';
import { parse } from '../common/validation';
import { DB } from '../tokens';

const CreateBody = z.strictObject({
  code: z.string().trim().toUpperCase().max(20),
  name: z.string().trim().min(1).max(80),
  branchId: z.string(),
  warehouseId: z.string(),
  rdRegistrationNo: z.string().trim().max(40).optional(),
});
const UpdateBody = z.strictObject({
  name: z.string().trim().min(1).max(80).optional(),
  status: z.enum(['ACTIVE', 'DISABLED', 'LOST']).optional(),
});
const RegisterBody = z.strictObject({
  tenantSlug: z.string().trim().max(40),
  registrationCode: z.string().trim().max(20),
  platform: z.enum(['WINDOWS', 'MACOS', 'ANDROID', 'IPADOS', 'WEB']),
  appVersion: z.string().trim().max(40).optional(),
});
const HeartbeatBody = z.strictObject({ appVersion: z.string().trim().max(40).optional() });

/** Back-office management of POS devices. */
@Controller('pos-devices')
export class PosDevicesController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(tenancy.DeviceService) private readonly devices: tenancy.DeviceService,
  ) {}

  @RequirePermission('device.manage')
  @Get()
  list(@CurrentPrincipal() p: iam.Principal) {
    return tenantTx(this.db, p.tenantId, (tx) => this.devices.list(tx, p));
  }

  @RequirePermission('device.manage')
  @Get(':id')
  get(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string) {
    return tenantTx(this.db, p.tenantId, (tx) => this.devices.get(tx, p, id));
  }

  /** Returns a one-time registration code (15 minutes) to type on the device. */
  @RequirePermission('device.manage')
  @Post()
  create(@CurrentPrincipal() p: iam.Principal, @Body() body: unknown) {
    const input = parse(CreateBody, body);
    return tenantTx(this.db, p.tenantId, (tx) =>
      this.devices.create(tx, p, {
        code: input.code,
        name: input.name,
        branchId: input.branchId,
        warehouseId: input.warehouseId,
        ...(input.rdRegistrationNo ? { rdRegistrationNo: input.rdRegistrationNo } : {}),
      }),
    );
  }

  @RequirePermission('device.manage')
  @Post(':id/registration-code')
  @HttpCode(200)
  reissue(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string) {
    return tenantTx(this.db, p.tenantId, (tx) => this.devices.reissueRegistrationCode(tx, p, id));
  }

  @RequirePermission('device.manage')
  @Patch(':id')
  update(@CurrentPrincipal() p: iam.Principal, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(UpdateBody, body);
    return tenantTx(this.db, p.tenantId, (tx) =>
      this.devices.update(tx, p, id, {
        ...(input.name ? { name: input.name } : {}),
        ...(input.status ? { status: input.status } : {}),
      }),
    );
  }
}

/** Endpoints called by the POS app itself. */
@Controller('pos')
export class PosDeviceSessionController {
  constructor(@Inject(tenancy.DeviceService) private readonly devices: tenancy.DeviceService) {}

  @Public()
  @RateLimit('device-register')
  @Post('devices/register')
  @HttpCode(200)
  register(@Body() body: unknown) {
    const input = parse(RegisterBody, body);
    return this.devices.register({
      tenantSlug: input.tenantSlug,
      registrationCode: input.registrationCode,
      platform: input.platform,
      ...(input.appVersion ? { appVersion: input.appVersion } : {}),
    });
  }

  @DeviceAuth()
  @Post('heartbeat')
  @HttpCode(200)
  heartbeat(@CurrentDevice() device: tenancy.DevicePrincipal, @Body() body: unknown) {
    const input = parse(HeartbeatBody, body);
    return this.devices.heartbeat(device, input.appVersion ? { appVersion: input.appVersion } : {});
  }
}
