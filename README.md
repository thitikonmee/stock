# StockOS — Stock + POS + Omnichannel Commerce SaaS (Thailand)

> ชื่อโค้ดเนม `StockOS` (ใช้ชั่วคราว) — ระบบที่มี **Central Inventory เป็น Single Source of Truth**
> ขายผ่าน POS / Shopee / Lazada / TikTok Shop / Website / API โดยรักษาความถูกต้องของ Stock และ Scale เป็น SaaS เชิงพาณิชย์ได้

## Development

**Prerequisites**: Node 22+ (`.nvmrc`), corepack (มากับ Node). ไม่ต้องมี Docker สำหรับรัน test — test สตาร์ต PostgreSQL 16 แบบ embedded ให้เอง

```bash
corepack enable            # ติดตั้ง pnpm ตามเวอร์ชันใน package.json
pnpm install
pnpm test                  # unit tests
pnpm test:int              # integration (PostgreSQL จริง, RLS, engine, outbox)
pnpm test:concurrency      # oversell / idempotency / deadlock tests
pnpm lint && pnpm typecheck && pnpm build
```

รัน API บนเครื่อง (ต้องมี PostgreSQL — ใช้ `docker compose up -d postgres` หรือ Postgres ของตัวเอง):

```bash
cp .env.example .env
pnpm gen:keys               # JWT signing key (.secrets/) + prints LOCAL_MASTER_KEY_BASE64 for .env
pnpm db:migrate            # ใช้ DATABASE_URL_ADMIN
pnpm db:local-roles        # ตั้งรหัสผ่าน role สำหรับ local เท่านั้น
pnpm build && node apps/api/dist/main.js   # หรือ pnpm --filter @stockos/api dev
curl localhost:3000/health/ready
```

ใช้ Postgres ภายนอกแทน embedded ใน test: `TEST_PG_SERVER_URL=postgres://user:pw@host:5432 pnpm test:int`

### โครงสร้าง (Phase 0)

| Path                                  | คืออะไร                                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------------------------ |
| `apps/api`                            | NestJS + Fastify: request id, request context, RFC 9457 errors, `/health`, `/health/ready` |
| `apps/outbox-relay`                   | ส่ง event จาก `outbox_events` ไป BullMQ                                                    |
| `packages/core/src/modules/inventory` | ★ `InventoryEngine` — ตัวเดียวที่เขียน `inventory_balances` + ledger                       |
| `packages/database`                   | Kysely, `tenantTx` (RLS + retry), SQL migrator + migrations                                |
| `packages/queue`                      | Transactional outbox, relay, `processOnce`, BullMQ publisher                               |
| `packages/shared`                     | UUIDv7, Decimal quantity, domain errors, logger, request context                           |
| `packages/config`                     | Env schema (zod) — บูตไม่ขึ้นถ้า config ผิด                                                |
| `tests/`                              | integration + concurrency tests และ support (embedded Postgres, seeds, invariant checks)   |

## เอกสาร

| #   | เอกสาร                                                                       | ครอบคลุม                                                                      |
| --- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 00  | [docs/00-assumptions-and-decisions.md](docs/00-assumptions-and-decisions.md) | Assumptions, ADR                                                              |
| 01  | [docs/01-product.md](docs/01-product.md)                                     | Product overview, requirements, roles, features, MVP, roadmap, UX             |
| 02  | [docs/02-architecture.md](docs/02-architecture.md)                           | System/module architecture, deployment, scaling, tech stack, folder structure |
| 03  | [docs/03-database.md](docs/03-database.md)                                   | ERD, schema, relationships, index, partitioning, RLS                          |
| 04  | [docs/04-inventory.md](docs/04-inventory.md)                                 | Ledger, reservation, concurrency, state machines, allocation                  |
| 05  | [docs/05-pos.md](docs/05-pos.md)                                             | POS, offline POS, hardware                                                    |
| 06  | [docs/06-channel-integrations.md](docs/06-channel-integrations.md)           | Shopee, Lazada, TikTok, adapter framework, webhooks                           |
| 07  | [docs/07-async-and-events.md](docs/07-async-and-events.md)                   | Queue, background jobs, events                                                |
| 08  | [docs/08-api-design.md](docs/08-api-design.md)                               | API conventions (+ [api/openapi.yaml](api/openapi.yaml))                      |
| 09  | [docs/09-security.md](docs/09-security.md)                                   | AuthN/AuthZ, tenant isolation, security, PDPA                                 |
| 10  | [docs/10-reconciliation-and-errors.md](docs/10-reconciliation-and-errors.md) | Reconciliation, error handling, 25 edge cases                                 |
| 11  | [docs/11-observability.md](docs/11-observability.md)                         | Logs, metrics, traces, SLOs                                                   |
| 12  | [docs/12-testing.md](docs/12-testing.md)                                     | Test & load strategy                                                          |
| 13  | [docs/13-dr-and-operations.md](docs/13-dr-and-operations.md)                 | Backup/DR, rebuild, admin console                                             |
| 14  | [docs/14-saas-and-business-modules.md](docs/14-saas-and-business-modules.md) | Subscription, pricing, promotion, CRM, payment, reports, AI                   |
| 15  | [docs/15-roadmap-and-tasks.md](docs/15-roadmap-and-tasks.md)                 | Phase 0–12, task breakdown, Definition of Done                                |
| 16  | [docs/16-engineering-handbook.md](docs/16-engineering-handbook.md)           | Conventions, git, env, docker, CI/CD                                          |

## หลักการที่ห้ามละเมิด (Non-negotiables)

1. **ไม่มี `products.stock`** — Stock อยู่ใน `inventory_balances` ที่เปลี่ยนได้ **เฉพาะ** ผ่าน `InventoryEngine` ซึ่งเขียน ledger ใน DB transaction เดียวกันเสมอ (ESLint บังคับ)
2. **ทุก write ที่มาจากภายนอกต้อง idempotent** — webhook, API (`Idempotency-Key`), queue job, offline POS sync
3. **ทุกแถวมี `tenant_id`** + PostgreSQL Row-Level Security (test บังคับว่าทุกตารางเปิด RLS)
4. **Core ไม่รู้จัก Shopee/Lazada/TikTok** — รู้จักแค่ `ChannelAdapter` interface
5. **ห้ามเรียก external API ภายใน DB transaction** — ใช้ Transactional Outbox
6. **Ledger เป็น append-only** — แก้ไขด้วย compensating entry เท่านั้น (trigger + grants บังคับ)
7. **AI แนะนำได้ แต่ไม่เขียน Stock เอง**
