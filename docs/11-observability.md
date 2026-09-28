# 11 — Observability (§42)

Stack: **OpenTelemetry SDK** (auto-instrument http, fastify, pg, ioredis, bullmq) → **OTel Collector** → Tempo (traces), Prometheus/Mimir (metrics), Loki (logs), **Sentry** (errors + release health, POS/web frontend ด้วย)

## Correlation
- ทุก request: `request_id` (รับจาก `X-Request-Id` หรือสร้าง) + `trace_id` (W3C `traceparent`) → ใส่ใน log ทุกบรรทัด, response header, `audit_logs`, `inventory_movements.request_id`, `outbox_events.headers`
- Queue job: producer inject trace context ลง job data → consumer สร้าง span ลูก (link) → ตามรอยได้ตั้งแต่ webhook → order ingest → reserve → push stock
- POS: `device_id`, `seq`, `client_txn_id` ใน log ฝั่ง server

## Structured Logging (pino, JSON)
```json
{"level":"info","time":"2026-10-01T03:00:00.123Z","service":"worker","env":"prod","version":"1.4.2",
 "request_id":"…","trace_id":"…","span_id":"…","tenant_id":"…","user_id":"…",
 "module":"inventory","event":"inventory.movement.applied","movement_type":"RESERVATION",
 "reference":"ORDER:…","lines":2,"duration_ms":7}
```
| แหล่ง | สิ่งที่ log |
|---|---|
| API | method, route (template ไม่ใช่ raw path), status, duration, principal type, tenant |
| Database | slow query > 200ms (`auto_explain` + `pg_stat_statements`), deadlock, lock wait > 1s (`log_lock_waits`) |
| Queue | enqueue/start/complete/fail, attempts, wait time, job type, account |
| Webhook | received, signature result, dedup hit, processing result |
| Channel API | platform, api path, status, platform error code, latency, rate-limit remaining (**ไม่ log token/PII**) |
| Inventory | ทุก movement (type, lines, idempotent replay?, insufficient) |

ระดับ: `error` = ต้องมีคนดู, `warn` = ผิดปกติแต่ระบบจัดการได้, `info` = business event, `debug` ปิดใน prod (เปิดต่อ tenant ชั่วคราวได้ผ่าน feature flag)

## Metrics (Prometheus naming)

| Metric | Type | Labels |
|---|---|---|
| `orders_created_total` | counter | channel, status (→ orders/min) |
| `inventory_movements_total` | counter | type, result(`applied|replayed|insufficient`) |
| `inventory_movement_duration_seconds` | histogram | type |
| `inventory_lock_wait_seconds` | histogram | — |
| `inventory_negative_balances` | gauge | — (ควรเป็น 0 นอกจาก offline) |
| `webhook_received_total` | counter | platform, signature(`valid|invalid`), duplicate(bool) |
| `webhook_processing_lag_seconds` | histogram | platform (received → processed) |
| `webhook_events_pending` | gauge | platform, status |
| `channel_api_requests_total` / `_duration_seconds` | counter/histogram | platform, api, outcome |
| `channel_sync_latency_seconds` | histogram | platform (StockChanged committed → push acked) |
| `channel_stock_mismatch_total` | counter | platform, classification |
| `channel_accounts_unhealthy` | gauge | platform, status |
| `queue_depth` / `queue_oldest_job_age_seconds` | gauge | queue |
| `queue_jobs_total` | counter | queue, result |
| `dlq_depth` | gauge | queue |
| `outbox_unpublished` / `outbox_lag_seconds` | gauge | — |
| `http_server_duration_seconds` | histogram | route, method, status (OTel) |
| `pos_devices_offline` | gauge | — |
| `pos_sync_lag_seconds` | histogram | (occurred_at → applied) |
| `db_pool_in_use`, `pg_replication_lag_seconds` | gauge | |

**Cardinality rule**: ห้ามใช้ `tenant_id`, `variant_id`, `order_id` เป็น label (ใช้ใน log/trace แทน); per-tenant usage ไปที่ `usage_counters`

## SLOs & Alerts

| SLO | Target | Alert (burn-rate) |
|---|---|---|
| API availability (non-5xx) | 99.9% / 30d | 2%/1h fast burn → page |
| API latency general | p95 < 300ms | p95 > 500ms 10 นาที |
| POS sale API | p95 < 200ms | |
| Inventory reserve | p95 < 100ms | p99 > 500ms |
| Webhook ingest (gateway) | 99.95% 2xx, p99 < 500ms | |
| Webhook → processed lag | p95 < 30s | oldest pending > 5 นาที |
| Stock push latency | p95 < 30s | > 2 นาที 10 นาที ติด |
| Ledger↔balance mismatch | 0 | ≥ 1 → **page ทันที** |
| Negative stock (non-offline) | 0 | ≥ 1 → page |
| DLQ | 0 growth | depth > 0 → ticket, > 100 → page |
| Outbox lag | < 5s | > 60s → page |

Alert routing: PagerDuty/Opsgenie (on-call) สำหรับ page; Slack `#alerts` สำหรับ warning; **tenant-facing alerts** (token expired, sync failed) ไป Notification module ของลูกค้า ไม่ใช่ on-call

## Dashboards (Grafana)
1. **Business pulse**: orders/min ต่อ channel, GMV, inventory updates/min
2. **Inventory health**: movement rate, insufficient rate, lock wait, deadlocks, negative/overcommitted count
3. **Channel integrations**: ต่อ platform — API latency/error, rate-limit hits, circuit state, webhook success rate, sync latency, mismatch, unhealthy accounts
4. **Queues**: depth, age, throughput, failure, DLQ ต่อ queue
5. **API**: RED metrics ต่อ route
6. **Database**: connections, TPS, replication lag, slow queries, bloat, partition sizes
7. **POS fleet**: devices online/offline, sync lag, app versions
