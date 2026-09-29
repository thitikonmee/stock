import { randomInt } from 'node:crypto';
import { sql } from 'kysely';
import { PgErrorCode, pgErrorCode, platformTx, tenantTx, type Db, type Tx } from '@stockos/database';
import {
  BusinessRuleError,
  ConflictError,
  ForbiddenError,
  hashEquals,
  isUuid,
  newOpaqueToken,
  NotFoundError,
  sha256,
  UnauthenticatedError,
  uuidv7,
  ValidationError,
} from '@stockos/shared';
import { recordAudit } from '../../audit/public-api';
import { PlanService } from '../../billing/public-api';
import { assertCan, type Principal } from '../../iam/public-api';

export type DeviceStatus = 'PENDING' | 'ACTIVE' | 'DISABLED' | 'LOST';
export type DevicePlatform = 'WINDOWS' | 'MACOS' | 'ANDROID' | 'IPADOS' | 'WEB';

export interface PosDevice {
  id: string;
  code: string;
  name: string;
  branchId: string;
  warehouseId: string;
  rdRegistrationNo: string | null;
  status: DeviceStatus;
  platform: DevicePlatform | null;
  appVersion: string | null;
  lastSeenAt: Date | null;
  registeredAt: Date | null;
}

/** The authenticated POS device (for /pos/* endpoints). */
export interface DevicePrincipal {
  tenantId: string;
  deviceId: string;
  branchId: string;
  warehouseId: string;
}

export interface RegistrationCode {
  /** Typed on the device, e.g. `K7Q4M-Z9XPA`. Shown once. */
  registrationCode: string;
  expiresAt: Date;
}

// No 0/O/1/I to avoid typos. 10 chars from 32 symbols = 50 bits, valid 15 minutes, rate limited.
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_LENGTH = 10;
const CODE_TTL_MS = 15 * 60 * 1000;
const TOKEN_PREFIX = 'pd_';

export class DeviceService {
  private readonly plans = new PlanService();

  constructor(private readonly db: Db) {}

  async list(tx: Tx, principal: Principal): Promise<PosDevice[]> {
    assertCan(principal, 'device.manage');
    const { rows } = await sql<DeviceRow>`select ${cols} from pos_devices order by code`.execute(tx);
    return rows.map(toDevice);
  }

  async get(tx: Tx, principal: Principal, id: string): Promise<PosDevice> {
    const device = await this.find(tx, id);
    assertCan(principal, 'device.manage', { branchId: device.branchId, warehouseId: device.warehouseId });
    return device;
  }

  /**
   * Resolve which branch/warehouse a device sells from, for the POS module (packages/core/src/modules/pos).
   * No `device.manage` gate: a cashier's own request names its own device, not someone else's to manage —
   * `sell()`/`open shift()` etc. authorize the *action* (`pos.sell` and so on), not device administration.
   */
  async forSale(tx: Tx, id: string): Promise<PosDevice> {
    // No tenantId parameter needed: RLS already scopes `pos_devices` to the caller's tenant inside tenantTx.
    const device = await this.find(tx, id);
    if (device.status !== 'ACTIVE') throw new BusinessRuleError('DEVICE_NOT_ACTIVE', 'Device is not active');
    return device;
  }

  async create(
    tx: Tx,
    principal: Principal,
    input: { code: string; name: string; branchId: string; warehouseId: string; rdRegistrationNo?: string },
  ): Promise<PosDevice & RegistrationCode> {
    if (!isUuid(input.branchId) || !isUuid(input.warehouseId))
      throw new ValidationError('Unknown branch or warehouse');
    assertCan(principal, 'device.manage', { branchId: input.branchId, warehouseId: input.warehouseId });
    if (!/^[A-Z0-9][A-Z0-9_-]{0,19}$/.test(input.code))
      throw new ValidationError('Code must be 1-20 chars: A-Z, 0-9, _ or -');

    const { rows } = await sql<{ branch_id: string | null }>`
      select w.branch_id from warehouses w join branches b on b.id = ${input.branchId}
       where w.id = ${input.warehouseId}`.execute(tx);
    const warehouse = rows[0];
    if (!warehouse) throw new ValidationError('Unknown branch or warehouse');
    if (warehouse.branch_id && warehouse.branch_id !== input.branchId) {
      throw new ValidationError('The warehouse belongs to another branch');
    }
    await this.plans.assertWithinLimit(tx, principal.tenantId, 'pos_devices');

    const id = uuidv7();
    const code = newRegistrationCode();
    try {
      await sql`insert into pos_devices (tenant_id, id, branch_id, warehouse_id, code, name, rd_registration_no, status,
                                         registration_code_hash, registration_expires_at, created_by)
                values (${principal.tenantId}, ${id}, ${input.branchId}, ${input.warehouseId}, ${input.code}, ${input.name},
                        ${input.rdRegistrationNo ?? null}, 'PENDING', ${sha256(code.normalized)}, ${code.expiresAt},
                        ${principal.membershipId})`.execute(tx);
    } catch (err) {
      if (pgErrorCode(err) === PgErrorCode.UniqueViolation)
        throw new ConflictError(`Device code ${input.code} already exists`);
      throw err;
    }
    await recordAudit(tx, {
      tenantId: principal.tenantId,
      action: 'device.create',
      resourceType: 'pos_device',
      resourceId: id,
      after: { ...input },
    });
    return { ...(await this.find(tx, id)), registrationCode: code.display, expiresAt: code.expiresAt };
  }

  /** New one-time code (replacement hardware, reinstall). The old device token stops working. */
  async reissueRegistrationCode(tx: Tx, principal: Principal, id: string): Promise<RegistrationCode> {
    const device = await this.get(tx, principal, id);
    if (device.status === 'LOST')
      throw new BusinessRuleError('DEVICE_LOST', 'A lost device cannot be re-registered; create a new one');
    const code = newRegistrationCode();
    await sql`update pos_devices set status = 'PENDING', device_secret_hash = null, registered_at = null,
                     registration_code_hash = ${sha256(code.normalized)}, registration_expires_at = ${code.expiresAt}
               where id = ${id}`.execute(tx);
    await recordAudit(tx, {
      tenantId: principal.tenantId,
      action: 'device.registration_code.reissue',
      resourceType: 'pos_device',
      resourceId: id,
    });
    return { registrationCode: code.display, expiresAt: code.expiresAt };
  }

  async update(
    tx: Tx,
    principal: Principal,
    id: string,
    input: { name?: string; status?: 'ACTIVE' | 'DISABLED' | 'LOST' },
  ) {
    const before = await this.get(tx, principal, id);
    if (input.status === 'ACTIVE' && !before.registeredAt) {
      throw new BusinessRuleError('DEVICE_NOT_REGISTERED', 'Register the device before activating it');
    }
    if (before.status === 'LOST' && input.status && input.status !== 'LOST') {
      throw new BusinessRuleError('DEVICE_LOST', 'A lost device stays lost; create a new one');
    }
    await sql`update pos_devices set name = coalesce(${input.name ?? null}, name), status = coalesce(${input.status ?? null}, status)
               where id = ${id}`.execute(tx);
    const after = await this.find(tx, id);
    await recordAudit(tx, {
      tenantId: principal.tenantId,
      action: 'device.update',
      resourceType: 'pos_device',
      resourceId: id,
      before: { name: before.name, status: before.status },
      after: { name: after.name, status: after.status },
    });
    return after;
  }

  /** Public: the device exchanges shop slug + one-time code for its long-lived device token. */
  async register(input: {
    tenantSlug: string;
    registrationCode: string;
    platform: DevicePlatform;
    appVersion?: string;
  }) {
    const normalized = input.registrationCode.toUpperCase().replace(/[\s-]/g, '');
    if (normalized.length !== CODE_LENGTH) throw invalidCode();
    const { rows } = await platformTx(this.db, (tx) =>
      sql<{
        id: string | null;
      }>`select tenant_id_by_slug(${input.tenantSlug.trim().toLowerCase()}) as id`.execute(tx),
    );
    const tenantId = rows[0]?.id;
    if (!tenantId) throw invalidCode();

    return tenantTx(this.db, tenantId, async (tx) => {
      const { rows: devices } = await sql<{
        id: string;
        branch_id: string;
        warehouse_id: string;
        registration_code_hash: Buffer;
        registration_expires_at: Date;
      }>`
        select id, branch_id, warehouse_id, registration_code_hash, registration_expires_at from pos_devices
         where registration_code_hash = ${sha256(normalized)} and status = 'PENDING' for update`.execute(tx);
      const device = devices[0];
      if (
        !device ||
        !hashEquals(device.registration_code_hash, sha256(normalized)) ||
        device.registration_expires_at < new Date()
      ) {
        throw invalidCode();
      }
      const secret = newOpaqueToken();
      await sql`update pos_devices set status = 'ACTIVE', device_secret_hash = ${sha256(secret)}, registered_at = now(),
                       registration_code_hash = null, registration_expires_at = null,
                       platform = ${input.platform}, app_version = ${input.appVersion ?? null}, last_seen_at = now()
                 where id = ${device.id}`.execute(tx);
      await recordAudit(tx, {
        tenantId,
        action: 'device.registered',
        resourceType: 'pos_device',
        resourceId: device.id,
        actor: { type: 'POS_DEVICE', id: device.id },
        after: { platform: input.platform, appVersion: input.appVersion ?? null },
      });
      return {
        deviceId: device.id,
        tenantId,
        branchId: device.branch_id,
        warehouseId: device.warehouse_id,
        deviceToken: `${TOKEN_PREFIX}${tenantId}.${device.id}.${secret}`,
      };
    });
  }

  /** Resolve `Authorization: Device <token>`. Disabled/lost devices are rejected immediately. */
  async authenticate(token: string): Promise<DevicePrincipal> {
    const [tenantId, deviceId, secret] = token.startsWith(TOKEN_PREFIX)
      ? token.slice(TOKEN_PREFIX.length).split('.')
      : [];
    if (!isUuid(tenantId) || !isUuid(deviceId) || !secret) throw new UnauthenticatedError();
    return tenantTx(this.db, tenantId, async (tx) => {
      const { rows } = await sql<{
        device_secret_hash: Buffer | null;
        status: string;
        branch_id: string;
        warehouse_id: string;
        tenant_status: string;
      }>`
        select d.device_secret_hash, d.status, d.branch_id, d.warehouse_id, t.status as tenant_status
          from pos_devices d join tenants t on t.id = d.tenant_id where d.id = ${deviceId}`.execute(tx);
      const d = rows[0];
      if (
        !d?.device_secret_hash ||
        d.status !== 'ACTIVE' ||
        !hashEquals(d.device_secret_hash, sha256(secret))
      ) {
        throw new UnauthenticatedError();
      }
      if (!['TRIAL', 'ACTIVE', 'PAST_DUE'].includes(d.tenant_status)) {
        throw new ForbiddenError('This company account is not active', {}, 'TENANT_INACTIVE');
      }
      return { tenantId, deviceId, branchId: d.branch_id, warehouseId: d.warehouse_id };
    });
  }

  async heartbeat(device: DevicePrincipal, input: { appVersion?: string }): Promise<{ serverTime: string }> {
    await tenantTx(this.db, device.tenantId, (tx) =>
      sql`update pos_devices set last_seen_at = now(), app_version = coalesce(${input.appVersion ?? null}, app_version)
           where id = ${device.deviceId}`.execute(tx),
    );
    // Devices use serverTime to measure clock drift for offline sales (docs/05-pos.md).
    return { serverTime: new Date().toISOString() };
  }

  private async find(tx: Tx, id: string): Promise<PosDevice> {
    const row = isUuid(id)
      ? (await sql<DeviceRow>`select ${cols} from pos_devices where id = ${id}`.execute(tx)).rows[0]
      : undefined;
    if (!row) throw new NotFoundError('Device not found');
    return toDevice(row);
  }
}

function newRegistrationCode() {
  let normalized = '';
  for (let i = 0; i < CODE_LENGTH; i++) normalized += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return {
    normalized,
    display: `${normalized.slice(0, 5)}-${normalized.slice(5)}`,
    expiresAt: new Date(Date.now() + CODE_TTL_MS),
  };
}

function invalidCode() {
  return new UnauthenticatedError('UNAUTHENTICATED', 'Invalid or expired registration code');
}

interface DeviceRow {
  id: string;
  code: string;
  name: string;
  branch_id: string;
  warehouse_id: string;
  rd_registration_no: string | null;
  status: DeviceStatus;
  platform: DevicePlatform | null;
  app_version: string | null;
  last_seen_at: Date | null;
  registered_at: Date | null;
}
const cols = sql`id, code, name, branch_id, warehouse_id, rd_registration_no, status, platform, app_version, last_seen_at, registered_at`;
const toDevice = (r: DeviceRow): PosDevice => ({
  id: r.id,
  code: r.code,
  name: r.name,
  branchId: r.branch_id,
  warehouseId: r.warehouse_id,
  rdRegistrationNo: r.rd_registration_no,
  status: r.status,
  platform: r.platform,
  appVersion: r.app_version,
  lastSeenAt: r.last_seen_at,
  registeredAt: r.registered_at,
});
