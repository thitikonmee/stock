# 09 — Authentication, Authorization, Security, Tenant Isolation

## 25. Authentication

| Principal | กลไก | อายุ |
|---|---|---|
| **User (back-office)** | email/phone + password (argon2id, m=64MB,t=3) → **JWT access token** (EdDSA/ES256, `kid` rotation) + **opaque refresh token** (hash เก็บใน `user_sessions`) | access 15 นาที, refresh 30 วัน (sliding), absolute 90 วัน |
| **2FA** | TOTP (RFC 6238) + recovery codes; **บังคับ** สำหรับ Owner/Admin และทุก role ที่มี `settings.manage`, `role.manage`, `billing.manage`, `api_key.manage` | |
| **Step-up auth** | action อันตราย (`permissions.is_dangerous`: ลบ product ทั้งหมด, เปลี่ยน owner, export ลูกค้า, disconnect channel, bulk adjust) → ต้องยืนยัน 2FA ภายใน 5 นาที (`amr`/`auth_time` claim) | |
| **POS device** | Registration code (ใช้ครั้งเดียว, 15 นาที) → device keypair/secret → `Device` token (JWT อายุ 7 วัน, refresh ด้วย device secret; offline grace 72 ชม.) | |
| **Cashier on device** | PIN → `pos session token` (อายุ = shift, scope = pos.* ของ device นั้น) | |
| **API key** | `sk_live_<prefix>_<secret>`; เก็บ sha256; scope = permission subset; IP allowlist optional | จนกว่าจะ revoke/expire |
| **Platform admin** | แยก realm (SSO บริษัท + hardware key/WebAuthn), แยก domain `admin.stockos.co`, VPN/IP allowlist | 8 ชม. |
| **SSO (Enterprise)** | OIDC/SAML ผ่าน WorkOS/Keycloak → map group → role | |

**JWT claims**: `sub` (user id), `tid` (tenant id), `mid` (membership id), `sid` (session id), `roles_ver` (สำหรับ invalidate cache เมื่อ role เปลี่ยน), `amr`, `auth_time`, `iat/exp`. **ไม่ใส่ permission list ใน JWT** (ใหญ่ + stale) → server resolve จาก cache (Redis, key `perm:{tid}:{mid}:{roles_ver}`, TTL 5 นาที)

**Refresh token rotation + reuse detection**: ทุก refresh ออก token ใหม่, token เก่า `rotated_at` → ถ้ามีคนใช้ token ที่ถูก rotate แล้ว = ถูกขโมย → revoke ทั้ง `family_id` + แจ้ง user

**Web session storage**: refresh token ใน `HttpOnly; Secure; SameSite=Strict` cookie (path `/auth`), access token ใน memory; CSRF: SameSite + double-submit token สำหรับ cookie endpoints

**Account protection**: rate limit login ต่อ IP + ต่อ identifier, lockout แบบ progressive (5 ครั้ง → 15 นาที), breached password check (k-anonymity HIBP), แจ้งเตือน login จาก device ใหม่

## Authorization (RBAC + scope + constraints)

```ts
// ทุก controller method ต้องประกาศ — ไม่มี = build fail (custom lint rule)
@RequirePermission('inventory.adjust', { scope: (req) => ({ warehouseId: req.body.warehouseId }) })
async adjust(@Body() dto: AdjustDto, @Ctx() ctx: RequestContext) { ... }
```
การตัดสิน (`PolicyService.can(ctx, permission, resourceScope, attributes)`):
1. membership ACTIVE, tenant ACTIVE (ไม่ LOCKED/SUSPENDED)
2. มี role ที่ให้ permission นี้ และ **scope ครอบคลุม** resource (TENANT ครอบทั้งหมด; BRANCH ครอบ warehouse/POS ในสาขา; WAREHOUSE เฉพาะคลังนั้น)
3. **constraints** ผ่าน (เช่น `max_discount_pct`, `max_amount`, `max_qty`) — ไม่ผ่านแต่มี approver → คืน `APPROVAL_REQUIRED`
4. plan feature เปิด (เช่น `channel_allocation`)

**Resource-level check (กัน IDOR)**: ทุก query มี tenant filter (RLS + repository บังคับ) และ ถ้า role เป็น branch/warehouse-scoped → repository เพิ่ม filter scope อัตโนมัติ; load resource แล้วไม่ใช่ของ tenant → **404** (ไม่ใช่ 403)

**Privilege escalation guard**:
- สร้าง/แก้ role ได้เฉพาะ permission ที่ตัวเองมี
- assign role ได้เฉพาะ role ที่ ⊆ สิทธิ์ตัวเอง และ scope ⊆ scope ตัวเอง
- ห้ามแก้ role ของตัวเอง; ห้ามลด Owner คนสุดท้าย; เปลี่ยน owner ต้อง step-up + email confirm ทั้ง 2 ฝ่าย
- Segregation of duties: ผู้ขอ ≠ ผู้อนุมัติ (DB CHECK ใน adjustments + app rule ใน PO/refund)

## Tenant Isolation (defense-in-depth 5 ชั้น)

| ชั้น | กลไก |
|---|---|
| 1. Identity | tenant มาจาก token claim เท่านั้น |
| 2. App context | `RequestContext` (AsyncLocalStorage) ถือ tenantId; repository base class **บังคับ** ใช้ `ctx.tenantId` — ไม่มี method ที่รับ tenantId จาก caller |
| 3. DB session | `db.tenantTx(tenantId)` → `SET LOCAL app.tenant_id`; pool connection ถูก reset (`DISCARD ALL`) เมื่อคืน pool; ใช้ PgBouncer transaction mode ได้เพราะ `SET LOCAL` อยู่ใน tx |
| 4. RLS | `FORCE ROW LEVEL SECURITY` + policy ทุก table; app role `NOBYPASSRLS` |
| 5. Schema | composite FK `(tenant_id, id)` — reference ข้าม tenant เป็นไปไม่ได้ |
| + Cache/Queue/Storage | Redis key prefix `t:{tenantId}:`; job payload มี tenantId และ worker ตั้ง context ก่อนทำงาน; S3 key `tenants/{tenantId}/...` + presigned URL อายุสั้น |
| + Test | integration test อัตโนมัติ: สร้าง 2 tenants → ทุก endpoint GET/PATCH/DELETE ด้วย id ของอีก tenant ต้องได้ 404 (generated จาก route list) |

## 26. Security Controls

| ภัย | การป้องกัน |
|---|---|
| **SQL Injection** | Kysely/parameterized เท่านั้น; ห้าม string concat SQL (lint rule `no-restricted-syntax` บน template ที่ไม่ใช่ `sql` tag); dynamic column/sort ผ่าน whitelist; DB role least privilege |
| **IDOR / Broken Access Control** | 5 ชั้นข้างบน + UUIDv7 (ไม่ enumerable) + automated cross-tenant test |
| **Privilege escalation** | guard ข้างบน + audit ทุก role/permission change + alert เมื่อมีการให้ Admin/Owner |
| **Replay attack** | Idempotency-Key, webhook dedup + timestamp tolerance, JWT `exp` สั้น, refresh rotation, POS seq |
| **Webhook spoofing** | HMAC verify จาก raw body (constant-time `timingSafeEqual`), secret ต่อ platform ใน Secrets Manager, unknown shop → ignore, **ดึง order detail จาก API เสมอ** (แม้ webhook ปลอมผ่าน ก็สร้างได้แค่ order ที่มีจริงบน platform) |
| **Duplicate order** | unique index (account, channel_order_id) / (device, client_txn_id) / idempotency keys |
| **XSS** | React auto-escape, CSP เข้ม (`default-src 'self'`, nonce), sanitize rich text (DOMPurify), ชื่อสินค้าจาก marketplace ถือเป็น untrusted |
| **CSRF** | SameSite=Strict cookie + token สำหรับ cookie-auth endpoints; API ใช้ Bearer |
| **SSRF** | outbound webhook URL ของลูกค้า: resolve DNS → block private/link-local/metadata IP, egress ผ่าน proxy แยก |
| **Mass assignment** | zod schema strict (`.strict()`), DTO แยก create/update |
| **File upload** | ตรวจ MIME/magic bytes, ขนาด, scan (ClamAV Lambda), upload ตรง S3 ด้วย presigned POST |
| **Excel import** | ป้องกัน formula injection ตอน export (prefix `'` เมื่อขึ้นต้นด้วย `= + - @`) |
| **Rate limit / DoS** | WAF (AWS managed rules + rate-based), API token bucket ต่อ principal/tenant/IP, request body limit, query timeout |
| **Secrets** | AWS Secrets Manager + KMS; ไม่มี secret ใน env ของ image/repo; rotation 90 วัน; gitleaks ใน CI |
| **Encryption** | TLS 1.2+ ทุกที่ (รวม DB/Redis in-transit), RDS/S3/EBS at-rest KMS; channel tokens + TOTP secret = **envelope encryption** ระดับ field (AES-256-GCM, DEK ต่อ tenant wrapped ด้วย KMS CMK) |
| **IP restrictions** | ต่อ membership (`ip_allowlist`), ต่อ API key, platform admin ผ่าน VPN |
| **Audit log** | ทุก write (who/what/when/where/before/after), immutable (trigger + no UPDATE grant), export ไป S3 Object Lock (WORM) รายวัน |
| **Dependency** | Renovate, `pnpm audit`, Snyk/Trivy image scan, SBOM (CycloneDX) |
| **Logging hygiene** | redact: password, token, `Authorization`, บัตร, เบอร์โทร/ที่อยู่ (mask) — pino redact paths + test |

## PDPA (พ.ร.บ.คุ้มครองข้อมูลส่วนบุคคล)
- บทบาท: ร้านค้า (tenant) = Data Controller, StockOS = **Data Processor** → DPA ในสัญญา SaaS
- เก็บข้อมูลลูกค้าเท่าที่จำเป็น; consent marketing แยก (`customers.pdpa_consent`)
- PII masking ตาม permission (`customer.pii.read`); ข้อมูลผู้ซื้อจาก marketplace (ชื่อ/ที่อยู่) ใช้เพื่อ fulfillment เท่านั้น + ลบ/mask หลัง X วันตามนโยบาย platform
- Data subject request: export/erase → erase = anonymize (ชื่อ → "ลบแล้ว", เบอร์ → hash) โดยคง order/tax record (กฎหมายบัญชี/ภาษีต้องเก็บ 5–7 ปี)
- Data residency: primary ในไทย (ap-southeast-7); breach notification ภายใน 72 ชม. (runbook)
- Access log ของ platform admin ที่เข้าข้อมูล tenant (impersonation) → แจ้ง tenant ใน audit log

## Implementation notes (Phase 1, 2026-09-28)
- **JWT**: ES256 implemented on `node:crypto` (`packages/core/src/modules/auth/infrastructure/jwt.ts`) — accepts only `alg: ES256` with a known `kid`, always checks `iss`/`aud`/`exp`; rotated keys stay valid via `JWT_PREVIOUS_PUBLIC_KEYS_PATH`
- **Every request** re-checks the session (`user_sessions.revoked_at`), membership status and tenant status → logout / suspension take effect immediately, not after the 15-minute token lifetime
- **Refresh reuse**: a rotated token presented again after a 10 s grace window revokes the whole family; within the window (double submit from one client) it is rejected without revoking
- **Login before tenant context**: `auth_user_memberships()` is a narrow `SECURITY DEFINER` function owned by `stockos_platform`; invitation tokens embed the tenant id so acceptance runs under that tenant's RLS
- **Fail-closed routes**: the global `AuthGuard` rejects any route without `@Public` / `@Authenticated` / `@RequirePermission`; `tests/integration/api-access.test.ts` walks every registered route (401 without token, 404 cross-tenant)
- **TOTP**: RFC 6238, ±1 step, replay-protected by `users.mfa_last_step`; seed sealed with AES-256-GCM bound to the user id

### Phase 1 completion (2026-09-28)
- **Rate limiting**: per-IP fixed windows in Postgres (`rate_limit_buckets`, UNLOGGED) on signup / login / MFA / refresh / invitation accept / device registration → 429 + `Retry-After`. Complements per-account lockout (which cannot stop one IP trying many accounts). High-volume per-key API limits → Redis later.
- **Mandatory 2FA**: members holding any dangerous permission must enrol once `tenants.mfa_enforced_from` passes (7-day grace from signup); until then only `/me`, `/auth/mfa/*`, `/auth/logout` work (`MFA_ENROLLMENT_REQUIRED`). Members with 2FA need an `otp` proof ≤ 15 min old for dangerous permissions (`STEP_UP_REQUIRED` → `POST /auth/step-up`).
- **API keys** (`sk_live_<prefix>_<secret>`): act on behalf of the creating member; effective permissions = key ∩ creator's current grants; never dangerous permissions; optional IP allowlist; revoking the key or suspending the creator stops it immediately.
- **POS devices**: one-time 10-char code (15 min, rate limited, hash only) + shop slug → device token `pd_<tenant>.<device>.<secret>`; `Authorization: Device …`; disable / lost / re-issue revoke it immediately.
- **Web BFF** (ADR-014): tokens only in HttpOnly/SameSite=Strict cookies; `document.cookie` is empty (checked by E2E); CSRF header + Origin check; security headers (X-Frame-Options DENY, nosniff, Referrer-Policy).
- **Client IP** (ADR-015): X-Forwarded-For trusted only from private/loopback hops, so rate limits cannot be bypassed by forging the header (integration test).
- **Invitation e-mail** is sent after the transaction commits; failure never loses the invitation (link returned to the inviter). HTML e-mail escapes all interpolated values.
