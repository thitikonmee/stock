# 15 — Development Roadmap, Phases, Task Breakdown, Definition of Done (§38–40, §57)

ทีมอ้างอิง: 2 Backend, 1 Backend/Integration, 2 Frontend (web + POS), 1 QA/SDET, 0.5 DevOps, 0.5 PM/Designer ≈ 7 คน
MVP (Phase 0–8) ≈ **7–8 เดือน** (บาง phase ทำขนานกันได้ ดู Gantt ใน [01-product.md](01-product.md))

> ลำดับ phase ตาม §57. หมายเหตุ: **Phase 3 Inventory ต้องเสร็จก่อน Phase 4 POS และ Phase 5 Order** เพราะทั้งสองเรียก InventoryEngine

---

## Phase 0 — Architecture (2 สัปดาห์)
- **สถานะ (2026-09-28)**: ✅ monorepo, CI, env schema, `tenantTx`, migrator, outbox + relay, API skeleton, **InventoryEngine + concurrency tests (ดึงมาจาก Phase 3)** — ⏳ ค้าง: web/POS app shells, Dockerfile, marketplace partner registration (งานของทีมธุรกิจ), POS hardware
- **Goal**: ตัดสินใจที่แก้ยากให้จบ + โครงที่ทุกคนใช้ร่วม
- **Features**: ADR-001..010 review, monorepo skeleton, CI, local docker, coding conventions, module boundary lint, test harness (embedded PostgreSQL, ADR-012), marketplace developer accounts (Shopee/Lazada/TikTok partner registration — **ใช้เวลาอนุมัติหลายสัปดาห์ เริ่มทันที**), POS hardware procurement สำหรับทดสอบ
- **DB**: migration tool + helpers (`uuid_generate_v7`, `current_tenant_id`, RLS template)
- **API**: error format, request id, idempotency middleware (skeleton)
- **Backend**: `packages/shared`, `packages/database` (tenantTx), `packages/queue` (outbox skeleton)
- **Frontend**: design system (shadcn), app shells (web, pos)
- **Tests**: CI pipeline รันได้, ตัวอย่าง concurrency test
- **Dependencies**: —
- **DoD**: `docker compose up` + `pnpm dev` ใช้งานได้บนเครื่องใหม่ < 15 นาที; CI เขียว; ADR merged

## Phase 1 — Foundation (4 สัปดาห์)
- **สถานะ (2026-09-28)**: ✅ signup (tenant + owner + system roles + HQ branch + MAIN warehouse), login + lockout, TOTP 2FA, refresh rotation + reuse detection, logout, RBAC + scopes + privilege-escalation guard, custom roles (If-Match), invitations, branches/warehouses, audit log, generated cross-tenant / auth-coverage tests — ⏳ ค้าง: API keys, POS device registration, document sequences, plan limits, notifications, frontend (login/onboarding/users & roles), login rate limit ต่อ IP (Redis), บังคับ 2FA สำหรับ Owner/Admin + step-up
- **Goal**: multi-tenant, auth, RBAC, audit พร้อมให้ module อื่นเสียบ
- **Features**: signup tenant, login, refresh rotation, 2FA TOTP, invite user, system roles + permission check + scope, API keys, branch/warehouse/POS device registration, audit log, document sequences, plan/limits skeleton, notification skeleton (in-app/email)
- **DB**: tenants, users, user_sessions, permissions, roles, role_permissions, tenant_memberships, membership_roles, api_keys, branches, warehouses, pos_devices, document_sequences, audit_logs, plans, tenant_subscriptions, usage_counters, idempotency_keys, outbox_events, processed_events, notifications
- **API**: `/auth/*`, `/me`, `/users`, `/roles`, `/permissions`, `/branches`, `/warehouses`, `/pos-devices/*`, `/api-keys`, `/audit-logs`
- **Backend**: auth, tenancy, audit, notifications (basic), billing (limits), outbox-relay
- **Frontend**: login/2FA, onboarding wizard (ร้าน → สาขา → คลัง), users & roles, settings
- **Tests**: auth flows, token reuse detection, RLS (fail-closed เมื่อไม่ตั้ง tenant), **cross-tenant 404 generated test**, privilege escalation tests
- **Dependencies**: Phase 0
- **DoD**: ผ่าน OWASP ASVS L2 checklist ส่วน auth/session; tenant isolation test ครอบคลุม 100% routes

## Phase 2 — Product (3 สัปดาห์)
- **Goal**: catalog พร้อมขาย
- **Features**: product + variant matrix, SKU/barcode (unique), categories tree, brands, units + conversion, bundle definition, images (S3), bulk import/export Excel, barcode generation + label PDF, suppliers (basic), search (trigram)
- **DB**: products, product_variants, variant_barcodes, product_units, bundle_components, product_images, categories, brands, units, suppliers, supplier_products, price_lists, prices (retail default)
- **API**: `/products`, `/variants/*`, `/categories`, `/brands`, `/units`, `/barcodes/*`, `/products/import`
- **Backend**: catalog, pricing (basic), jobs (import)
- **Frontend**: product list/search, product editor (variant matrix), import wizard, label printing
- **Tests**: optimistic lock (If-Match), barcode uniqueness, import 10k rows < 60s, search p95 < 150ms @ 100k SKUs
- **Dependencies**: Phase 1
- **DoD**: สร้าง Nike Air Max 5 variants + barcode + พิมพ์ label ได้จริง

## Phase 3 — Inventory ★ (4 สัปดาห์)
- **Goal**: InventoryEngine ที่ถูกต้องภายใต้ concurrency
- **Features**: balances, ledger, movements (idempotent), effect matrix, reservation (soft/hard, expiry), opening stock import, manual adjustment (+approval threshold), stock card, low-stock threshold, moving average cost, ledger↔balance reconciliation job, rebuild command
- **DB**: inventory_balances, inventory_movements, inventory_transactions (partitioned), inventory_reservations, variant_costs, stock_adjustments(+items), reconciliation_runs/items
- **API**: `/inventory/balances`, `/inventory/transactions`, `/inventory/reserve|release|commit`, `/inventory/adjust`, `/inventory/adjustments/:id/approve`
- **Backend**: inventory (engine, reservation, cost, reconciliation), events StockChanged
- **Frontend**: stock overview (ต่อคลัง), stock card, adjustment form + approval inbox, low stock list
- **Tests**: **Concurrency tests 1,3,4,5,7** (ดู [12](12-testing.md)), property-based invariants, reconciliation detect injected corruption, rebuild restores
- **Dependencies**: Phase 2
- **DoD**: stock=1 × 100 concurrent = 1 success ใน CI ทุก PR; ledger==balance หลัง 10k random ops; reserve p95 < 100ms

## Phase 4 — POS (6 สัปดาห์, เริ่มขนาน Phase 5 ได้หลัง Phase 3)
- **Goal**: POS ใช้หน้าร้านจริงได้ รวม offline
- **Features**: device registration, cashier PIN, shift open/close + Z-report, cart (pos-engine), manual discount (+override), VAT/rounding, cash + PromptPay static/dynamic QR + card (EDC manual approval code), split payment, receipt (Thai raster printing), reprint, hold/resume, refund/exchange, customer quick-add, **offline mode** (local DB, outbox, sync push/pull, conflict rules), hardware bridge (Tauri Windows + Capacitor Android Sunmi) — iPad Phase 4.5
- **DB**: pos_shifts, pos_cash_movements, pos_device_events, pos_sync_batches, orders/order_items/payments/refunds (POS subset), customers (basic)
- **API**: `/pos/sessions`, `/pos/shifts`, `/pos/sales`, `/pos/sales/:id/refunds`, `/pos/sync/pull|push`, `/pos/heartbeat`, `/payments/promptpay/qr`
- **Backend**: pos, orders (POS path), payments (cash/QR/card), customers (basic)
- **Frontend**: POS app ทั้งหมด; back-office: shift report, device management
- **Tests**: pos-engine unit (VAT/rounding/split), Playwright POS flow online + offline (setOffline), sync replay/dup/gap tests (Test 6), printer driver tests กับเครื่องจริง, speed test (scan→cart ≤ 50ms บน Sunmi V2)
- **Dependencies**: Phase 3
- **DoD**: pilot 1 ร้านจริง 1 สัปดาห์ ไม่มี stock/เงินคลาด; ถอดสาย LAN กลางกะแล้วขายต่อ 2 ชม. → sync ครบไม่ซ้ำ

## Phase 5 — Order (4 สัปดาห์)
- **Goal**: OMS กลางที่ทุก channel ใช้
- **Features**: normalized order model, state machine + inventory effects, order list/detail/filters, manual order (API/website channel), confirm/cancel (partial), hold/release, fulfillment (pick/pack/ship, partial), returns + QC restock, refunds (partial), order status history, customer linking, FulfillmentRouter (multi-warehouse)
- **DB**: orders, order_items, order_status_history, fulfillments(+items), order_returns(+items), payments, refunds(+items)
- **API**: `/orders/*`, `/fulfillments/*`, `/returns/*`, `/orders/:id/refunds`
- **Backend**: orders (state machine, router), payments (refund)
- **Frontend**: order inbox (by status/channel), order detail timeline, pick/pack mobile screens, return inspection
- **Tests**: state machine exhaustive unit tests, effect correctness per transition, partial ship/cancel/refund integration tests
- **Dependencies**: Phase 3
- **DoD**: ทุก transition มี test; order ใดก็ตาม ledger movements อธิบายได้ครบ (reference link)

## Phase 6 — Shopee (4 สัปดาห์)
- **Goal**: channel framework + adapter แรก (กำหนดมาตรฐานให้ adapter ถัดไป)
- **Features**: channel framework (registry, TokenManager, RateLimiter, HttpClient+circuit breaker, webhook-gateway, dispatcher, OrderIngestService, StockSyncService, mapping service), Shopee connect (OAuth), product import + auto-map, mapping UI, webhook + polling, order ingest, stock push (debounce/coalesce), GLOBAL_POOL + safety stock + buffer, channel reconciliation, admin console (webhooks/sync jobs/DLQ)
- **DB**: channels, channel_accounts, channel_credentials, channel_warehouses, channel_stock_policies, channel_products, channel_product_variants, channel_orders(+items), webhook_events, sync_jobs
- **API**: `/channels/shopee/connect`, callback, `/channel-accounts/*`, `/channel-mappings/*`, `/webhooks/shopee`, `/reconciliation-runs/*`, `/sync-jobs/*`
- **Backend**: channels, webhooks, integrations/shopee, worker queues
- **Frontend**: channel connect wizard, mapping screen (unmapped/conflict), stock policy settings, sync status/health, reconciliation screen
- **Tests**: signature test vectors, adapter contract tests (fixtures), marketplace mock E2E, **Test 2 (Shopee+POS concurrent)**, webhook dup/out-of-order/missing tests, token refresh race test, nightly sandbox test
- **Dependencies**: Phase 5, Shopee partner approval
- **DoD**: ร้าน pilot เชื่อม Shopee จริง 2 สัปดาห์: 0 oversell ที่เกิดจากระบบ, sync latency p95 < 30s, 0 order หาย (เทียบ report Shopee)

## Phase 7 — Lazada (3 สัปดาห์)
- **Goal**: พิสูจน์ว่า framework ใช้ซ้ำได้ (ไม่แก้ core)
- **Features**: Lazada adapter (auth, sign, products, orders ระดับ item status, sellable stock update, webhook), per-line partial cancel
- **DB**: ไม่มี table ใหม่ (ถ้าต้องเพิ่ม = สัญญาณว่า abstraction รั่ว → review)
- **API**: `/channels/lazada/connect`, `/webhooks/lazada`
- **Tests**: เหมือน Shopee + item-level status normalization
- **Dependencies**: Phase 6
- **DoD**: diff ของ PR ไม่แตะ `modules/inventory`, `modules/orders` (ยกเว้น bug fix แยก PR)

## Phase 8 — TikTok Shop (3 สัปดาห์, ขนานกับ Phase 7 ได้ถ้ามีคน)
- **Goal**: channel ที่ 3
- **Features**: TikTok adapter (auth + shop_cipher, sign, webhook signature, products, orders, packages, inventory update ต่อ warehouse)
- **Tests**: เหมือนข้างบน + package split
- **Dependencies**: Phase 6
- **DoD**: Test 2 ครบ 4 ช่องทาง (POS+Shopee+Lazada+TikTok) ผ่าน → **MVP Release** 🎉

## Phase 9 — Warehouse (5 สัปดาห์)
- **Goal**: operation คลังครบ
- **Features**: purchase order + approval + partial receive + cost update, supplier performance, stock transfer (partial, in-transit), stock count (full/cycle/blind, mobile scanning, offline count), warehouse locations (zone/rack/shelf/bin) + putaway/pick by bin, CHANNEL_ALLOCATION strategy
- **DB**: purchases, purchase_items, goods_receipts(+items), stock_transfers(+items), stock_counts(+items), warehouse_locations, inventory_location_balances, channel_allocations
- **API**: `/purchases/*`, `/inventory/transfers/*`, `/inventory/counts/*`, `/warehouses/:id/locations`, `/channel-accounts/:id/allocations`
- **Frontend**: PO screens, receive (mobile scan), transfer, count (mobile), bin management, allocation editor
- **Tests**: partial receive/transfer, count with concurrent sales (movement_since_snapshot), allocation concurrency
- **Dependencies**: MVP
- **DoD**: นับ stock 5,000 SKU ด้วยมือถือ 3 เครื่องพร้อมกันระหว่างเปิดขาย → variance ถูกต้อง

## Phase 10 — Reporting (4 สัปดาห์)
- **Goal**: owner ตัดสินใจจากข้อมูลได้
- **Features**: dashboard เต็ม, 15 reports, export CSV/XLSX/PDF, scheduled email, daily snapshots, summary tables, accounting export (CSV formats), promotion engine เต็ม + coupons + loyalty (ถ้ายังไม่ทำ)
- **DB**: sales_daily_summary, inventory_daily_snapshots, promotions, coupons, coupon_redemptions, membership_tiers, memberships, loyalty_transactions
- **Tests**: report numbers reconcile กับ ledger/orders (golden dataset), export 1M rows streaming
- **Dependencies**: MVP
- **DoD**: ยอดใน dashboard == ผลรวม orders; valuation == Σ on_hand × avg_cost

## Phase 11 — SaaS (3 สัปดาห์)
- **Goal**: เก็บเงินได้
- **Features**: plans/limits enforcement, usage metering, billing (Omise/Stripe), trial, invoices, dunning (past-due flow), self-serve upgrade, platform admin console เต็ม
- **Tests**: limit enforcement ทุก resource, orders over limit ไม่ block, dunning timeline
- **Dependencies**: Phase 1
- **DoD**: ลูกค้าสมัคร → trial → จ่ายเงิน → ใช้งาน ได้โดยไม่มีคนช่วย

## Phase 12 — Scale (6 สัปดาห์+)
- **Goal**: 10,000 orders/min readiness
- **Features**: PgBouncer/RDS Proxy, partitions ทั้งหมด, read replica routing, CDC → ClickHouse, แยก Channel Integration Service, SQS สำหรับ channel jobs, hot-SKU reservation buckets, tenant routing (dedicated DB สำหรับ Enterprise), OpenSearch (ถ้าจำเป็น)
- **Tests**: load test 10k/min, soak 8 ชม., chaos (kill writer → failover)
- **DoD**: ผ่าน load targets ใน [12](12-testing.md) ที่ 10k/min หรือมี bottleneck report + แผน

---

## 39. Development Task Breakdown (Epics → Stories, ตัวอย่าง Phase 3 ละเอียด, อื่นระดับ epic)

### Epic INV — Inventory Core (Phase 3)
| ID | Task | Est. (d) | Owner |
|---|---|---|---|
| INV-1 | Migration: balances, movements, transactions (partition + pg_partman), reservations, variant_costs + immutability trigger | 2 | BE1 |
| INV-2 | `EFFECT_MATRIX` + `GUARDS` (domain, pure) + unit tests ทุก type | 2 | BE1 |
| INV-3 | `InventoryEngine.apply()` (idempotency gate, lock ordering, conditional update, ledger lines, outbox) | 4 | BE1 |
| INV-4 | `tenantTx` retry wrapper (40P01/40001/55P03) + timeouts | 1 | BE2 |
| INV-5 | Reservation service (soft/hard, TTL, partial fulfill/release) + expiry job (SKIP LOCKED) | 3 | BE2 |
| INV-6 | Moving average cost update ใน receipt path | 1 | BE2 |
| INV-7 | Adjustment document + approval threshold + SoD | 3 | BE2 |
| INV-8 | Stock card API + balances API (cursor pagination) | 2 | BE1 |
| INV-9 | Ledger↔balance reconciliation job + rebuild command (dry-run, 2-person) | 3 | BE1 |
| INV-10 | Concurrency test suite (Tests 1,3,4,5,7) + property-based | 4 | QA |
| INV-11 | UI: stock overview, stock card, adjustment + approval inbox | 5 | FE1 |
| INV-12 | Low stock detection → notification | 1 | BE2 |
| INV-13 | Metrics + dashboards (inventory health) | 1 | DevOps |

### Epics อื่น (สรุป)
| Epic | Stories หลัก |
|---|---|
| FND Foundation | repo/CI, db helpers, auth (login/refresh/2FA), RBAC policy + decorators, tenancy (branch/warehouse/device), audit interceptor, idempotency middleware, outbox relay, error handler, OTel setup |
| CAT Catalog | product CRUD + variant matrix, barcode, import/export, labels, search |
| POS | device reg, PIN session, pos-engine, cart UI, payments, receipt printing (raster Thai), shift/Z-report, refund/exchange, hold/resume, local DB schema, sync engine (push/pull/seq/gap), conflict rules server-side, hardware bridge (Tauri, Capacitor Sunmi) |
| OMS Orders | model, state machine, effects wiring, fulfillment/partial, returns/QC, refunds, router, UI inbox |
| CHN Channel framework | adapter interface, registry, token manager (single-flight), rate limiter (Lua), http client + circuit breaker, webhook-gateway, dispatcher, ingest service, stock sync (debounce/coalesce/versions), mapping service + UI, policy engine, reconciliation, admin console |
| SHP/LZD/TTS Adapters | auth/sign, products, orders (+status mapping), inventory, price, webhook verify/parse, contract tests, sandbox nightly |
| WH Warehouse | PO + receive, transfer, count (mobile), locations, allocation |
| RPT Reporting | summary tables, dashboard, reports, exports, scheduler |
| SAAS | plans, metering, billing, dunning, admin |
| OPS | Terraform, environments, backups + restore test, alerts, runbooks, DR drill |

## 40. Definition of Done (ทุก story)

**Code**
- [ ] ผ่าน lint, typecheck (strict), format; ไม่มี import ข้าม module boundary
- [ ] Code review ≥ 1 คน (**≥ 2 คน** ถ้าแตะ `modules/inventory`, `modules/orders`, auth, RLS, migrations)
- [ ] ไม่มี TODO ที่ไม่มี ticket

**Correctness**
- [ ] Unit tests สำหรับ domain logic; integration test สำหรับ repository/API (coverage ของ domain ≥ 90%, overall ≥ 75%)
- [ ] ถ้าแตะ stock/เงิน: concurrency + idempotency test ใหม่หรือ existing ครอบคลุม; invariants ผ่าน
- [ ] ทุก write endpoint: permission declared, tenant isolation test (generated) ผ่าน, audit log ถูกเขียน
- [ ] POST ที่แตะ stock/เงินรองรับ `Idempotency-Key`

**Data**
- [ ] Migration backward-compatible (expand/contract), รันบน copy ของ staging data แล้ว, มี index สำหรับ query ใหม่ (EXPLAIN แนบใน PR ถ้า query สำคัญ)
- [ ] ไม่มี UPDATE/DELETE บน ledger/audit

**Operability**
- [ ] Logs มี request_id/tenant_id; metric สำหรับ feature ใหม่ (ถ้าเป็น flow หลัก); alert ถ้ามี failure mode ใหม่
- [ ] Error ใช้ problem+json + code ที่ document แล้ว
- [ ] Feature flag สำหรับ feature ที่เสี่ยง (ปิดได้ต่อ tenant)

**Docs & Product**
- [ ] OpenAPI อัปเดต; ADR ถ้ามีการตัดสินใจเชิงสถาปัตยกรรม; runbook ถ้ามี operation ใหม่
- [ ] UI รองรับ TH/EN, mobile responsive (ถ้าเป็นหน้า warehouse/owner), a11y พื้นฐาน
- [ ] Demo บน staging ให้ PO แล้ว PO accept

**Phase-level DoD** = DoD ทุก story + เกณฑ์ใน phase นั้น + ไม่มี Sev1/Sev2 ค้าง + load/concurrency targets ของ phase ผ่าน
