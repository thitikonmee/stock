# 08 — API Design (§24, §38)

Spec: [api/openapi.yaml](../api/openapi.yaml) (OpenAPI 3.1 — generate จาก zod schema ใน `packages/contracts` ด้วย `zod-openapi`; ไฟล์ใน repo คือ contract ที่ review)

## Conventions

| เรื่อง | กฎ |
|---|---|
| Base URL | `https://api.stockos.co/api/v1` ; webhooks `https://hooks.stockos.co/webhooks/{platform}` (แยก host/process) |
| Versioning | URL major (`/v1`); เปลี่ยนแบบ additive ไม่ bump; breaking → `/v2` คู่ขนาน ≥ 6 เดือน + `Deprecation`/`Sunset` headers |
| Auth | `Authorization: Bearer <JWT>` (user), `Authorization: Bearer sos_live_...` (API key), `Authorization: Device <token>` (POS) |
| Tenant | มาจาก token claim **เท่านั้น** (`tid`) — ไม่รับ tenant จาก path/header/body (กัน IDOR) ; user หลาย tenant → switch tenant = ขอ token ใหม่ |
| Request ID | รับ `X-Request-Id` (ถ้าไม่มีสร้าง UUIDv7) → echo กลับ + ใส่ log/trace; W3C `traceparent` รองรับ |
| Idempotency | **บังคับ** `Idempotency-Key` สำหรับ POST ที่สร้าง/เปลี่ยน stock หรือเงิน (orders, pos/sales, inventory/*, payments, refunds, purchases/receive) ; key เดิม+body เดิม → คืน response เดิม (`Idempotent-Replayed: true`) ; key เดิม+body ต่าง → 422 `IDEMPOTENCY_KEY_REUSED` ; กำลังประมวลผล → 409 `IDEMPOTENCY_IN_PROGRESS` ; เก็บ 24 ชม. |
| Concurrency | resource ที่แก้ไขได้คืน `ETag: "v{version}"`; PATCH/PUT ต้องส่ง `If-Match` → ไม่ตรง 412 `PRECONDITION_FAILED` |
| Pagination | cursor-based: `?limit=50&cursor=<opaque>` → `{ data: [], page: { nextCursor, hasMore } }` (limit ≤ 200) |
| Filtering/sort | `?status=PAID,SHIPPED&channel=SHOPEE&placedFrom=...&sort=-placedAt` (whitelist fields) |
| Money/qty | ส่งเป็น **string decimal** (`"199.00"`, `"1.500"`) — ไม่ใช้ JSON number |
| Time | ISO-8601 UTC (`2026-10-01T03:00:00Z`); display timezone ตาม tenant |
| Rate limit | ต่อ principal + ต่อ tenant (token bucket Redis) ; headers `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`; 429 + `Retry-After` |
| Error | RFC 9457 `application/problem+json` (ด้านล่าง) |
| Field naming | JSON camelCase; DB snake_case |

### Error format
```json
{
  "type": "https://docs.stockos.co/errors/stock-insufficient",
  "title": "Insufficient stock",
  "status": 409,
  "code": "STOCK_INSUFFICIENT",
  "detail": "SKU-001 at WH-BKK01 has 0 available, requested 1",
  "requestId": "0192f3c1-7a2b-7c4e-9f11-2b1d3a4c5e6f",
  "errors": [
    { "path": "items[0].quantity", "code": "STOCK_INSUFFICIENT", "meta": { "variantId": "…", "available": "0", "requested": "1" } }
  ]
}
```
| HTTP | code (ตัวอย่าง) |
|---|---|
| 400 | `VALIDATION_FAILED` |
| 401 | `UNAUTHENTICATED`, `TOKEN_EXPIRED` |
| 403 | `FORBIDDEN`, `PLAN_LIMIT_EXCEEDED`, `STEP_UP_REQUIRED` |
| 404 | `NOT_FOUND` (ใช้กับ resource ของ tenant อื่นด้วย — ไม่บอกว่ามีอยู่) |
| 409 | `STOCK_INSUFFICIENT`, `INVALID_STATE_TRANSITION`, `DUPLICATE`, `IDEMPOTENCY_IN_PROGRESS`, `SEQ_GAP` |
| 401 (auth) | `INVALID_CREDENTIALS`, `ACCOUNT_LOCKED`, `TOKEN_EXPIRED`, `TOKEN_REUSED`, `INVALID_MFA_CODE` |
| 403 (iam) | `PRIVILEGE_ESCALATION`, `TENANT_INACTIVE` |
| 422 (rules) | `TENANT_SELECTION_REQUIRED` (meta.tenants), `SYSTEM_ROLE_IMMUTABLE`, `MFA_ALREADY_ENABLED` |
| 412 | `PRECONDITION_FAILED` (version) |
| 422 | `IDEMPOTENCY_KEY_REUSED`, `BUSINESS_RULE_VIOLATION` |
| 429 | `RATE_LIMITED` |
| 503 | `DEPENDENCY_UNAVAILABLE` |

## Endpoint Catalog

### Auth / Tenant / IAM
```
POST   /auth/signup                         สร้าง tenant + owner
POST   /auth/login                          → access + refresh (+ mfa_required)
POST   /auth/mfa/verify
POST   /auth/refresh                        rotation
POST   /auth/logout
POST   /auth/switch-tenant
GET    /me
GET    /users            POST /users/invite     PATCH /users/:id     DELETE /users/:id
GET    /roles            POST /roles            PATCH /roles/:id     GET /permissions
POST   /api-keys         DELETE /api-keys/:id
GET    /branches  POST /branches  PATCH /branches/:id
GET    /warehouses  POST /warehouses  PATCH /warehouses/:id  POST /warehouses/:id/locations
POST   /pos-devices/registration-codes     POST /pos-devices/register (device ใช้ code)
GET    /audit-logs
```

### Catalog
```
GET    /products?q=&categoryId=&brandId=&status=&cursor=
POST   /products                            (+ variants[] ใน request เดียว)
GET    /products/:id
PATCH  /products/:id                        If-Match
DELETE /products/:id                        soft delete (ถ้ามี stock ≠ 0 → 409)
POST   /products/:id/variants
PATCH  /variants/:id
GET    /variants/lookup?barcode=|sku=
POST   /products/import                     (xlsx → job)   GET /jobs/:id
GET/POST /categories /brands /units
POST   /barcodes/generate                   (EAN-13 internal prefix 20–29 / Code128)
POST   /barcodes/labels                     → PDF (S3 link)
```

### Inventory
```
GET    /inventory/balances?variantId=&warehouseId=&lowStock=true
GET    /inventory/transactions?variantId=&warehouseId=&from=&to=&type=     (stock card)
POST   /inventory/reserve                   Idempotency-Key  {referenceType, referenceId, items[{warehouseId, variantId, quantity}], ttlSeconds?}
POST   /inventory/release                   Idempotency-Key  {reservationIds[] | referenceType+referenceId}
POST   /inventory/commit                    Idempotency-Key
POST   /inventory/adjust                    Idempotency-Key  → stock_adjustments (may be PENDING_APPROVAL)
POST   /inventory/adjustments/:id/approve | /reject
POST   /inventory/transfer                  Idempotency-Key  → stock_transfers
POST   /inventory/transfers/:id/approve | /ship | /receive | /cancel
POST   /inventory/counts                    GET /inventory/counts/:id
POST   /inventory/counts/:id/items          (batch scan results)
POST   /inventory/counts/:id/submit | /approve
GET    /inventory/valuation?asOf=
```
> `/inventory/reserve|release|commit` เปิดสำหรับ **External API / Website** — order ภายในไม่เรียกผ่าน HTTP แต่เรียก `InventoryEngine` ตรงใน tx

### Orders
```
POST   /orders                              Idempotency-Key  (channel=API/WEBSITE)
GET    /orders?status=&channel=&from=&to=&q=&cursor=
GET    /orders/:id
POST   /orders/:id/confirm | /cancel | /hold | /release-hold
POST   /orders/:id/fulfillments            (pick/pack/ship, partial)
POST   /fulfillments/:id/pack | /ship
POST   /orders/:id/returns                 POST /returns/:id/receive (QC per line)
POST   /orders/:id/refunds                 Idempotency-Key
POST   /orders/:id/reassign-lines          (แก้ mapping ผิด → compensating movements)
```

### POS
```
POST   /pos/sessions                        cashier PIN login (device token + PIN) → short-lived token
POST   /pos/shifts                          open    POST /pos/shifts/:id/close
POST   /pos/shifts/:id/cash-movements
POST   /pos/sales                           Idempotency-Key = clientTxnId (online sale)
POST   /pos/sales/:id/refunds               Idempotency-Key
GET    /pos/sync/pull?cursor=               catalog/prices/promotions/stock delta
POST   /pos/sync/push                       offline events batch
POST   /pos/heartbeat
POST   /payments/promptpay/qr               dynamic QR (gateway)
```

### Channels
```
GET    /channels                            (catalog + capabilities)
GET    /channel-accounts
POST   /channels/shopee/connect             → { authorizeUrl }
POST   /channels/lazada/connect
POST   /channels/tiktok/connect
GET    /channels/{platform}/callback        (OAuth redirect; state = signed, single-use, bound to tenant+user)
POST   /channel-accounts/:id/disconnect | /pause | /resume
POST   /channel-accounts/:id/import-products
GET    /channel-accounts/:id/mappings?status=UNMAPPED
PUT    /channel-mappings/:id                {variantId, quantityMultiplier}      If-Match
POST   /channel-mappings/bulk               (xlsx)
PUT    /channel-accounts/:id/stock-policy
PUT    /channel-accounts/:id/allocations
POST   /channel-accounts/:id/sync           {type: ORDERS|STOCK|PRICES, variantIds?}
POST   /channel-accounts/:id/reconcile
GET    /reconciliation-runs/:id/items       POST /reconciliation-items/:id/resolve {action: PUSH_INTERNAL|PULL_CHANNEL|IGNORE}
GET    /sync-jobs?status=FAILED             POST /sync-jobs/:id/retry
```

### Webhooks (inbound, separate process)
```
POST   /webhooks/shopee
POST   /webhooks/lazada
POST   /webhooks/tiktok
POST   /webhooks/payments/{provider}
```

### Others
```
/customers  /customers/:id/merge  /memberships  /loyalty/transactions
/price-lists  /prices  /promotions  /coupons  /coupons/validate
/suppliers  /purchases  /purchases/:id/approve  /purchases/:id/receipts (partial receive)
/reports/{sales|inventory|movement|valuation|cogs|profit|purchase|supplier|product|channel|pos|cashier|refund|discount|tax}?format=json|csv|xlsx|pdf
/dashboard/summary?date=&branchId=&channel=
/notifications  /notification-rules
/billing/subscription  /billing/usage
/admin/* (platform admin — separate auth realm, ดู 13)
```

### Phase 1 endpoints (implemented)
```
POST /auth/step-up                     {code} → new token pair with fresh 2FA proof
GET|POST /api-keys   DELETE /api-keys/:id
GET|POST /pos-devices   GET|PATCH /pos-devices/:id   POST /pos-devices/:id/registration-code
POST /pos/devices/register            (public, rate limited)   POST /pos/heartbeat (Device auth)
GET /notifications?unread=true   POST /notifications/:id/read   POST /notifications/read-all
GET /billing/usage
```
Error codes added: `RATE_LIMITED` (429 + Retry-After), `MFA_ENROLLMENT_REQUIRED`, `STEP_UP_REQUIRED`, `PLAN_LIMIT_EXCEEDED` (403, meta.metric/limit/used)

### Outbound webhooks (ให้ลูกค้า subscribe) — Phase 3
Events: `order.created`, `order.updated`, `inventory.changed`, `product.updated` ; signed `X-StockOS-Signature: t=<ts>,v1=<hmac-sha256>` ; retry exp 24 ชม. ; delivery log
