# 07 — Queue, Background Jobs, Event-driven Architecture

## 22. Queue Architecture

### เปรียบเทียบ (§33)

| | **BullMQ (Redis)** | **RabbitMQ** | **AWS SQS** (+SNS/EventBridge) | Kafka / MSK |
|---|---|---|---|---|
| Operate | ง่าย (ใช้ Redis ที่มีอยู่แล้ว) | ต้อง operate cluster, quorum queues | Managed 100% | หนัก (MSK ช่วยได้) |
| Delayed / scheduled job | ✅ built-in | plugin | ✅ ≤ 15 นาที | ❌ |
| Priority | ✅ | ✅ | ❌ (ต้องแยก queue) | ❌ |
| Rate limit ต่อ group (ต่อ shop) | ✅ (BullMQ Pro groups / ทำเองด้วย token bucket) | ทำเอง | ทำเอง | ทำเอง |
| Dedup by jobId | ✅ | ❌ | FIFO queue (5 นาที) | ❌ |
| Durability | ขึ้นกับ Redis AOF/replica (อาจเสีย job ไม่กี่วินาทีตอน failover) | ดี | ดีมาก | ดีมาก |
| Throughput | สูง (หมื่น jobs/s) | สูง | ไม่จำกัดในทางปฏิบัติ | สูงมาก + replay |
| Dashboard | Bull Board | management UI | CloudWatch | tools |
| เหมาะกับ | MVP → กลาง | ทีมที่มี ops | Scale, managed | Event streaming, CDC, analytics |

### แนะนำตาม Scale
- **S0–S1 (MVP → 1,000 orders/min)**: **BullMQ** + **Transactional Outbox ใน Postgres** → ความเสี่ยงเรื่อง Redis durability ถูกลบเพราะ source of truth อยู่ใน Postgres (outbox, webhook_events, sync_jobs) — ถ้า Redis เสีย job → relay/dispatcher ส่งใหม่จาก DB ได้
- **S2 (1k–5k/min)**: channel jobs ย้ายไป **SQS** (แยก queue ต่อ job type + DLQ native) ; BullMQ เหลือสำหรับ delayed/coalescing jobs
- **S3 (10k+/min, หลาย service)**: **Kafka (MSK)** เป็น event backbone (domain events, CDC → analytics) + SQS สำหรับ work queues
- Code ไม่ผูกกับ broker: `QueuePort` / `EventBus` interface ใน `packages/queue`

### Queue Topology (BullMQ)

| Queue | Producer | Concurrency/worker | Priority | Retry (attempts, backoff) | Notes |
|---|---|---|---|---|---|
| `webhook-process` | dispatcher | 20 | 1 | 10, exp 10s→1h | jobId = webhook_event_id |
| `order-ingest` | webhook handler, polling | 20 | 1 | 8, exp | jobId = `{account}|{external_order_id}|{update_time}` |
| `stock-push` | StockChanged handler | 10 | 1 (zero/low stock) / 5 | 8, exp 5s→10m | jobId = `{account}|{variant}` + delay 1–2s (coalesce); rate limit per shop |
| `price-push` | PriceChanged | 5 | 5 | 8 | |
| `order-status-push` | fulfillment (ship/cancel ไป platform) | 5 | 2 | 10 | ตรวจสถานะก่อน retry (UNKNOWN_OUTCOME) |
| `channel-poll` | scheduler | 5 | 3 | 3 | ต่อ account ทุก 5 นาที |
| `product-import` | user action | 2 | 7 | 3 | long-running, checkpoint cursor |
| `reconcile` | scheduler/user | 2 | 8 | 3 | |
| `token-refresh` | scheduler | 5 | 1 | 5 | single-flight lock |
| `notifications` | event handlers | 20 | 5 | 5 | email/LINE/webhook |
| `reports` | user | 2 | 9 | 2 | ผลลัพธ์ไป S3, link หมดอายุ 24 ชม. |
| `maintenance` | scheduler | 1 | 9 | 1 | partition create, archive, purge |

**Job id**: BullMQ custom jobId ห้ามมี `:` → คั่นด้วย `|`

**DLQ**: BullMQ ไม่มี DLQ ในตัว → เมื่อ `attemptsMade === attempts` → handler `failed` ย้าย job เข้า queue `{name}.dlq` + update `sync_jobs.status = DEAD` + alert → Admin console "Retry" = move กลับ queue หลัก (ใหม่ jobId)

**Worker rules**
1. ทุก handler **idempotent** (dedupe ด้วย `processed_events(consumer, event_id)` หรือ natural key)
2. Graceful shutdown: SIGTERM → หยุดรับ job ใหม่ → รอ job ปัจจุบัน ≤ 60s
3. Stalled job (worker crash) → BullMQ `stalledInterval` 30s → job กลับเข้าคิวอัตโนมัติ → เพราะ idempotent จึงรันซ้ำได้
4. Job payload เล็ก (id อ้างอิง) — worker อ่านข้อมูลล่าสุดจาก DB เสมอ
5. ห้ามถือ DB transaction ข้ามการเรียก external API

### Transactional Outbox → Queue

```mermaid
sequenceDiagram
    participant UC as Use case (tx)
    participant DB as Postgres
    participant R as outbox-relay
    participant Q as BullMQ / EventBus
    participant C as Consumers
    UC->>DB: BEGIN; state change; INSERT outbox_events; COMMIT
    loop every 200ms (หรือ LISTEN/NOTIFY wake-up)
        R->>DB: SELECT ... WHERE published_at IS NULL ORDER BY created_at LIMIT 500 FOR UPDATE SKIP LOCKED
        R->>Q: publish (eventId = outbox.id)
        R->>DB: UPDATE published_at = now()
    end
    Q->>C: deliver (at-least-once)
    C->>DB: INSERT processed_events(consumer, event_id) ON CONFLICT DO NOTHING → ถ้าซ้ำ skip
```
- Relay publish ก่อน mark → ถ้า crash ระหว่างนั้น = publish ซ้ำ (ไม่หาย) → consumer dedupe
- Ordering: ต่อ aggregate สำคัญ (เช่น StockChanged ของ variant เดียว) → consumer ที่ต้องการลำดับใช้ **version** ใน payload (ignore ถ้า version ≤ ที่ประมวลผลแล้ว) แทนการพึ่ง ordering ของ queue

## 33. Background Jobs (Scheduler)

| Job | ความถี่ | หน้าที่ |
|---|---|---|
| Sync Orders (poll) | 5 นาที/account (+ daily sweep 3 วัน) | เก็บ order ที่ webhook หาย |
| Sync Products | manual + ทุกวัน 02:00 | ตรวจ listing ใหม่/ถูกลบ → mapping status |
| Sync Inventory (full push) | ทุก 6 ชม. | push ทุก mapped SKU ที่ `last_pushed_qty ≠ computed` (safety net) |
| Sync Prices | เมื่อ scheduled price เริ่ม/หมด + ทุกวัน | |
| Reservation expiry | 1 นาที | release soft reservation หมดอายุ |
| Token refresh | 10 นาที | refresh token ที่เหลือ < 20% TTL; แจ้งเตือน refresh token ใกล้หมด (≤ 7 วัน) |
| Retry failed webhooks | ต่อเนื่อง (dispatcher) | |
| Channel reconciliation | ทุก 1 ชม. (SKU ขายเร็ว) / ทุกคืน (ทั้งหมด) | [10](10-reconciliation-and-errors.md) |
| Ledger↔balance reconciliation | ทุกคืน 03:00 | |
| Low stock / reorder check | ทุก 15 นาที (event-driven เป็นหลัก) | |
| Daily inventory snapshot | 00:05 ทุกวัน | `inventory_daily_snapshots` สำหรับ report |
| Generate reports / scheduled emails | ตาม schedule | |
| Usage metering rollup | ทุกชั่วโมง | |
| Partition maintenance / archive | ทุกวัน | pg_partman, webhook archive, outbox purge |
| Promotion activation | ทุกนาที | SCHEDULED → ACTIVE → ENDED |

Leader election: `pg_try_advisory_lock(hashtext('scheduler'))` — instance เดียวที่ได้ lock เป็นคน enqueue; job แต่ละตัวใช้ jobId ตามรอบเวลา (`poll|{account}|{yyyyMMddHHmm}`) กันซ้ำแม้มี 2 leader ชั่วขณะ

## 23. Event-driven Architecture (§35)

### Event envelope
```json
{
  "id": "0192f3c1-...",              // outbox id (UUIDv7) = dedupe key
  "type": "InventoryReserved",
  "version": 1,
  "tenantId": "…",
  "aggregateType": "InventoryBalance",
  "aggregateId": "…",
  "occurredAt": "2026-10-01T10:00:00.000Z",
  "actor": { "type": "USER", "id": "…" },
  "traceId": "…", "requestId": "…",
  "payload": { }
}
```
Schema อยู่ใน `packages/contracts/events/*.ts` (zod) — เปลี่ยน breaking → bump `version`, consumer รองรับ 2 version ช่วง migrate

### Sync vs Async

**หลักการ**: สิ่งที่ต้อง *ถูกต้องพร้อมกัน* (invariant) → **synchronous ใน DB transaction เดียว**. สิ่งที่เป็น *ผลตามมา* (side effect, ข้ามระบบ, ช้าได้) → **asynchronous ผ่าน outbox**

| Event | Sync/Async | เหตุผล / Consumers |
|---|---|---|
| **OrderCreated** | สร้างใน tx เดียวกับ reserve (sync) → event publish async | Consumers: notifications, customer stats, loyalty (earn pending), analytics |
| **OrderPaid** | state + COMMIT sync | async: loyalty, accounting export, notification |
| **OrderCancelled** | state + RELEASE/CANCEL sync | async: channel cancel push (ถ้า cancel จากฝั่งเรา), coupon reversal, stock push |
| **OrderRefunded** | payment refund record sync | async: loyalty reverse, accounting |
| **InventoryReserved / Released / Deducted / Adjusted** | **Sync** (เป็นส่วนหนึ่งของ tx) | event async → StockChanged fan-out |
| **StockUpdated (StockChanged)** | async | → `ChannelSyncRequested` ต่อ mapped account, low-stock check, POS stock snapshot push (SSE), cache invalidation |
| **ProductUpdated** | async | search index, channel product push (ถ้าเปิด), POS catalog delta |
| **PriceChanged** | async | price-push, POS catalog delta |
| **ChannelSyncRequested** | async (job) | stock-push worker |
| **ChannelSyncCompleted** | async | update `last_pushed_*`, metrics |
| **ChannelSyncFailed** | async | retry/DLQ, notification (throttled), account health |
| **WebhookReceived** | async | order-ingest |
| **LowStockDetected / OutOfStock / NegativeStockDetected** | async | notifications, reorder suggestion |
| **PurchaseReceived** | stock sync, event async | cost update (sync ใน tx), notification, supplier performance |
| **ShiftClosed** | async | cashier report, cash variance alert |

**ห้าม**: ใช้ event async เพื่อรักษา invariant ของ stock (เช่น "OrderCreated → consumer ไปตัด stock") — จะเกิด window ที่ order มีแต่ stock ยังไม่ถูกจอง = oversell
