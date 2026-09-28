# 00 — Assumptions & Architecture Decision Records

## A. Assumptions (สมมติฐานที่ใช้ออกแบบ — ให้ Product Owner ยืนยัน)

| # | Assumption | ผลต่อการออกแบบ | ถ้าไม่จริง |
|---|---|---|---|
| A1 | ลูกค้าเป้าหมาย: SME–Mid-market ไทย, 1–50 สาขา, 100–50,000 SKU, 10–5,000 orders/วัน/tenant | Shared DB + RLS ได้ | Enterprise ขนาดใหญ่ → dedicated DB (รองรับไว้แล้วผ่าน tenant routing) |
| A2 | Load รวมทั้งแพลตฟอร์ม ปีแรก ≤ 1,000 orders/min peak (11.11, 12.12), เป้า 10,000/min ใน 2–3 ปี | Modular monolith + Postgres ตัวเดียว + read replica พอสำหรับ Phase 1–2 | ต้อง shard เร็วขึ้น (ดู 02-architecture §Scaling) |
| A3 | สกุลเงิน THB เท่านั้นใน MVP, VAT 7% (รองรับ inclusive/exclusive), ทศนิยมเงิน 2 ตำแหน่ง | `NUMERIC(14,2)` สำหรับเงิน, `NUMERIC(14,3)` สำหรับจำนวน | multi-currency: เพิ่ม `currency` column ไว้แล้ว |
| A4 | จำนวนสินค้าบาง SKU เป็นทศนิยม (เช่น ขายเป็นกิโล/เมตร) | Quantity = `NUMERIC(14,3)` ไม่ใช่ `INT` | — |
| A5 | Stock ของ Marketplace ตัดตอน **SHIPPED** (default) ส่วน POS ตัดตอน **ชำระเงินเสร็จ** — ตั้งค่าได้ต่อ tenant | Reservation → Commit → Deduct | — |
| A6 | Marketplace (Shopee/Lazada/TikTok) เป็นผู้เก็บเงินและ fulfillment อาจเป็นของร้าน (dropoff/pickup) หรือ platform (FBS/FBL) | Warehouse ประเภท `MARKETPLACE_FULFILLMENT` แยก | — |
| A7 | 1 Channel account = 1 shop (Shopee shop_id / Lazada seller / TikTok shop_cipher) และ tenant มีได้หลาย shop ต่อ platform | `channel_accounts` N ต่อ tenant | — |
| A8 | POS ต้องขายได้ offline สูงสุด 72 ชม. ต่อเนื่อง | Local SQLite/IndexedDB + outbox | — |
| A9 | POS ส่วนใหญ่ใช้ PC/Windows หรือ Android POS (Sunmi/iMin) หรือ iPad | ใช้ PWA เป็นหลัก + Native bridge (Tauri/Capacitor) สำหรับ hardware | — |
| A10 | ใบกำกับภาษีอย่างย่อจาก POS ต้องใช้เครื่องที่ขออนุมัติกรมสรรพากร (ภ.พ.06) — รูปแบบเลขที่ใบเสร็จ per device | Receipt number = `{branch}-{device}-{yyMM}-{seq}` gap-free ต่อ device | e-Tax Invoice/e-Receipt อยู่ Phase 4 |
| A11 | Hosting: AWS **ap-southeast-7 (Bangkok)** เป็น primary, ap-southeast-1 (Singapore) เป็น DR | Data residency ใกล้ลูกค้า, latency ต่ำ, สอดคล้อง PDPA | ใช้ GCP asia-southeast1/สำรอง on-prem ได้ด้วย Terraform module |
| A12 | ทีมพัฒนาเริ่มต้น 4–8 คน, TypeScript เป็นภาษาหลัก | Monorepo TS เดียว (backend + web + POS) | — |
| A13 | Marketplace API spec (endpoint, token TTL, rate limit) เปลี่ยนบ่อย | ทุกค่าเป็น config ของ Adapter ไม่ hard-code ใน core; **ต้อง verify กับ official docs ตอน implement** | — |
| A14 | Payment gateway ไทย (เช่น Opn/Omise, 2C2P, GB Prime Pay, KBank/SCB API) เลือกภายหลัง | Payment Provider abstraction | — |
| A15 | Cost method = **Moving Weighted Average** (ถัวเฉลี่ยเคลื่อนที่) ต่อ variant ต่อ tenant; FIFO เป็น future | `inventory_cost_layers` เตรียมไว้ | — |

## B. Architecture Decision Records (ADR)

รูปแบบ: Context → Decision → Consequences. เก็บ ADR ใหม่ที่ `docs/adr/NNNN-title.md`

### ADR-001 Modular Monolith ก่อน Microservices
- **Context**: ทีมเล็ก, domain ยังเปลี่ยน, inventory ต้องการ strong consistency ข้าม order/inventory
- **Decision**: NestJS modular monolith 1 codebase, deploy เป็น 3 process types: `api`, `worker`, `scheduler` (+ `webhook-gateway` แยกเพื่อ availability) — module boundary บังคับด้วย lint rule (ห้าม import ข้าม module ยกเว้นผ่าน `public-api.ts`)
- **Consequences**: transaction ข้าม order+inventory ทำใน DB transaction เดียวได้ (ง่ายและถูกต้องกว่า saga); แยก service ภายหลังได้เพราะ boundary ชัด

### ADR-002 PostgreSQL เป็น system of record เดียว
- **Decision**: PostgreSQL 16 (AWS RDS/Aurora PostgreSQL). ไม่ใช้ NoSQL สำหรับ transaction data. JSONB เฉพาะ raw payload/attributes
- **Consequences**: ได้ ACID + row lock + RLS + partitioning; scale ด้วย read replica → partition → shard-by-tenant (Citus หรือ multi-cluster routing)

### ADR-003 Shared schema + `tenant_id` + Row-Level Security
- **Decision**: ทุก table มี `tenant_id`, composite FK `(tenant_id, x_id)` กันการอ้างอิงข้าม tenant, RLS policy `tenant_id = current_setting('app.tenant_id')::uuid`. App role ไม่มี `BYPASSRLS`
- **Consequences**: ถูกและ operate ง่าย; noisy neighbor แก้ด้วย per-tenant rate limit + ย้าย tenant ใหญ่ไป dedicated cluster (tenant routing table)

### ADR-004 Inventory = Balance (current state) + Ledger (source of truth) ใน transaction เดียว
- **Decision**: `inventory_balances` 1 แถวต่อ (tenant, warehouse, variant); ทุกการเปลี่ยนแปลง = conditional atomic `UPDATE ... WHERE available >= qty RETURNING` + `INSERT inventory_transactions` ใน tx เดียว
- **Rejected**: Event sourcing ล้วน (query stock ช้า/ซับซ้อน), Redis เป็น stock หลัก (ไม่ durable, ไม่ ACID กับ order)
- **Consequences**: Stock ถูกต้องเชิง transaction; balance rebuild ได้จาก ledger เสมอ

### ADR-005 Pessimistic (row-level) concurrency สำหรับ stock, Optimistic สำหรับ master data
- **Decision**: Stock ใช้ single-statement conditional update (ได้ row lock โดยปริยาย) + lock ordering; Product/price/settings ใช้ `version` column (optimistic, HTTP `If-Match`)
- **Rejected**: Redis distributed lock สำหรับ stock (ไม่จำเป็นเมื่อ DB row lock ทำงานอยู่แล้ว และเพิ่ม failure mode)

### ADR-006 Transactional Outbox + BullMQ (MVP) → SQS/Kafka (Scale)
- **Decision**: domain event ถูกเขียนลง `outbox_events` ใน tx เดียวกับ state change; relay process publish ไป BullMQ (Redis). Consumer idempotent ด้วย `processed_events`
- **Consequences**: ไม่มี dual-write problem; เปลี่ยน broker ได้โดยไม่แตะ domain code

### ADR-007 Webhook Inbox Pattern
- **Decision**: webhook-gateway ทำแค่ verify signature → insert `webhook_events` (unique dedup key) → 200 OK ภายใน < 300ms; processing async
- **Consequences**: ไม่เสีย webhook ถึง backend ช้า/ล่ม, replay ได้

### ADR-008 POS = Offline-first PWA + Native Shell
- **Decision**: React PWA (Vite) ใช้ SQLite (WASM + OPFS) หรือ IndexedDB (Dexie) เป็น local DB; Native shell (Tauri สำหรับ Windows/macOS, Capacitor สำหรับ Android/iPad) ให้เข้าถึง printer/drawer/serial
- **Consequences**: codebase เดียวทุก device; hardware ผ่าน `HardwareBridge` interface

### ADR-009 Money & Quantity
- **Decision**: เงิน `NUMERIC(14,2)` ใน DB, ใน TS ใช้ `decimal.js` (ห้ามใช้ `number` คำนวณเงิน); quantity `NUMERIC(14,3)`
- **Consequences**: ไม่มี floating point error ในใบเสร็จ/VAT

### ADR-010 IDs
- **Decision**: UUIDv7 (time-ordered) เป็น PK ทุก table — ลด index fragmentation เทียบ UUIDv4, สร้างฝั่ง client ได้ (สำคัญกับ offline POS), ไม่เปิดเผยจำนวน record (กัน enumeration)
- เลขเอกสารที่มนุษย์อ่าน (`SO-2026-000123`, `PO-...`) แยกเป็น `doc_no` จาก `document_sequences`

### ADR-011 TypeScript 6 (ยังไม่ใช้ 7)  — 2026-09-28
- **Context**: TypeScript 7 (native compiler) ออกแล้ว แต่ typescript-eslint ยังไม่รองรับ TS 7.0
- **Decision**: pin `typescript@^6` ทั้ง monorepo; ประเมินใหม่เมื่อ typescript-eslint รองรับ TS 7 (ย้ายได้ทันทีเพราะ config ไม่ใช้ feature เฉพาะเวอร์ชัน — ทดสอบแล้วว่า typecheck/build ผ่านบน TS 7.0.2)
- **Consequences**: build ช้ากว่า TS 7 แต่ lint/boundary rules ทำงาน

### ADR-012 Test database = embedded PostgreSQL 16 (แทน Testcontainers) — 2026-09-28
- **Context**: เครื่อง dev บางเครื่องไม่มี Docker; concurrency tests ต้องการ Postgres จริงหลาย connection (max_connections สูง)
- **Decision**: `tests/support/global-setup.ts` สตาร์ต PostgreSQL 16 (`embedded-postgres`) ครั้งเดียวต่อ test run, migrate เป็น template DB, แต่ละ test file clone template (เร็ว, แยกขาด); ตั้ง `TEST_PG_SERVER_URL` เพื่อใช้ server ภายนอกแทน
- **Consequences**: ไม่ต้องใช้ Docker ทั้ง local และ CI; test ใช้ Postgres เวอร์ชันเดียวกับ production target

### ADR-013 DI tokens แบบ explicit ใน NestJS
- **Decision**: inject ด้วย `@Inject(TOKEN)` เสมอ ไม่พึ่ง `emitDecoratorMetadata` → โค้ดทำงานเหมือนกันทั้ง tsc, esbuild (vitest) และ swc
