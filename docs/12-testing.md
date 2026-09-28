# 12 — Testing Strategy & Load Testing (§50, §30, §31)

## Test Pyramid

| ชั้น | Tool | ขอบเขต | รันเมื่อ |
|---|---|---|---|
| **Unit** | Vitest | domain pure logic: order state machine (ทุกคู่ transition), effect matrix, pos-engine (ราคา/VAT/ปัดเศษ/promotion), allocation formula, signature ของแต่ละ adapter (test vector), mapping status machine | ทุก commit |
| **Property-based** | fast-check | inventory invariants: สุ่มลำดับ operation → `available == on_hand − reserved − committed`, ไม่มี bucket < 0 (ยกเว้น allowNegative), Σ ledger == balance; pos-engine: Σ line totals + rounding == grand total | ทุก commit |
| **Integration** | Vitest + **embedded PostgreSQL 16** (ADR-012; หรือ `TEST_PG_SERVER_URL`) | repository, InventoryEngine, RLS, idempotency, outbox, API ผ่าน Fastify inject | ทุก PR |
| **Concurrency** | Vitest + embedded PostgreSQL + pg pool 100 connections | oversell tests (ด้านล่าง) | ทุก PR (แท็ก `@concurrency`) |
| **Contract (adapter)** | recorded fixtures (Polly.js/nock) + JSON schema ของ response | adapter แปลง payload จริงถูก; ทดสอบ error mapping | ทุก PR; + **nightly กับ sandbox จริง** ของ Shopee/Lazada/TikTok |
| **Tenant isolation** | generated test จาก route table | ทุก route ด้วย resource ของ tenant อื่น → 404 | ทุก PR |
| **E2E** | Playwright | back-office flows, POS flows (รวม offline: `context.setOffline(true)`) | merge main + nightly |
| **Load** | k6 | ด้านล่าง | ก่อน release ใหญ่ + weekly บน staging |
| **Chaos** | Toxiproxy (latency/drop ไป Postgres/Redis/marketplace mock), kill worker ระหว่าง job | resilience | nightly/staging |

## Concurrency Tests (บังคับ ต้องผ่านก่อน merge อะไรก็ตามที่แตะ inventory)

### Test 1 — Stock = 1, 100 requests พร้อมกัน
```ts
// tests/concurrency/oversell.spec.ts
it('never oversells: stock=1, 100 concurrent reservations', async () => {
  const { tenantId, warehouseId, variantId } = await seed.variantWithStock({ onHand: 1 });

  const attempts = Array.from({ length: 100 }, (_, i) =>
    db.tenantTx(tenantId, (tx) =>
      engine.apply(tx, reserveCmd({ tenantId, warehouseId, variantId, qty: 1, idempotencyKey: `t1:${i}` })))
      .then(() => 'ok' as const)
      .catch((e) => (e instanceof InsufficientStockError ? 'insufficient' as const : Promise.reject(e))));

  const results = await Promise.all(attempts);   // pool size 100 → contention จริง

  expect(results.filter(r => r === 'ok')).toHaveLength(1);
  expect(results.filter(r => r === 'insufficient')).toHaveLength(99);

  const b = await q.balance(tenantId, warehouseId, variantId);
  expect(b).toMatchObject({ onHand: '1.000', reserved: '1.000', available: '0.000' });
  await expectLedgerMatchesBalance(tenantId);                 // Σ ledger == balance ทุก bucket
  expect(await q.countReservations(tenantId, variantId)).toBe(1);
});
```

### Test 2 — POS + Shopee + Lazada + TikTok ขาย SKU เดียวกันพร้อมกัน
- Stock = 10; ยิงพร้อมกัน: 30 POS sales (API จริงผ่าน Fastify inject), 30 Shopee webhooks, 30 Lazada webhooks, 30 TikTok webhooks (ผ่าน webhook-gateway → worker จริง กับ marketplace mock server)
- Assert: POS สำเร็จ + marketplace orders ที่ได้ stock รวม = 10 พอดี; marketplace ที่ไม่ได้ → ON_HOLD BACKORDER (ไม่ใช่ error, ไม่หาย); POS ที่ไม่ได้ → 409; `on_hand − committed − reserved ≥ 0`; ledger == balance; ไม่มี order ซ้ำ; stock push สุดท้ายที่ mock ได้รับ = 0 ทุก platform

### Test 3 — Idempotency under concurrency
- webhook เดิม (payload เดียวกัน) 50 ครั้งพร้อมกัน → 1 webhook_event, 1 order, 1 movement
- POST `/pos/sales` key เดิม 20 ครั้งพร้อมกัน → 1 order; response เดียวกันทุกครั้ง (หรือ 409 IN_PROGRESS แล้ว retry ได้ผลเดิม)

### Test 4 — Deadlock freedom
- 200 orders สุ่ม 1–5 lines จาก 10 SKUs (ลำดับ line สุ่ม) พร้อมกัน → deadlock (40P01) หลัง retry = 0 failure; ถ้าปิด lock ordering test ต้อง fail (ยืนยันว่า test จับได้จริง)

### Test 5 — Multi-bucket consistency
- ผสม reserve / commit / release / ship / adjust / transfer / count พร้อมกัน 1,000 operations → invariant ครบ

### Test 6 — Offline POS replay
- device ส่ง batch เดิมซ้ำ 3 ครั้ง + ส่งข้าม seq → dedupe + SEQ_GAP; ขายเกิน stock ขณะ offline → apply + NEGATIVE_STOCK alert + marketplace order flagged

### Test 7 — Crash mid-flight
- inject failure หลัง UPDATE balance ก่อน INSERT ledger (test hook) → rollback: balance ไม่เปลี่ยน; retry สำเร็จ 1 ครั้ง

## 31. Load Testing Strategy (k6)

**Targets** (staging ขนาดเท่า prod)
| Scenario | Load | Pass criteria |
|---|---|---|
| Steady mixed | 1,000 orders/min (ผสม: 40% marketplace webhook, 40% POS, 20% website/API) + 200 RPS back-office reads | API p95 < 300ms, reserve p95 < 100ms, error < 0.1%, webhook lag p95 < 30s, 0 oversell |
| Flash sale hot SKU | 5,000 webhook/min บน **SKU เดียว** stock 1,000 | ขายได้ = 1,000 พอดี, lock wait p99 < 1s, ที่เหลือ BACKORDER |
| Peak (11.11) | 3× steady 30 นาที | ไม่มี data loss, queue drain < 10 นาทีหลัง peak |
| Soak | 60% steady 8 ชม. | no memory leak, no connection leak, partition/outbox ไม่บวม |
| Future | 10,000 orders/min | หา bottleneck แรก (คาด: writer CPU / hot rows / Redis) → input ของ Scaling roadmap |
| POS sync storm | 500 devices กลับ online พร้อมกัน แต่ละเครื่อง 300 events | sync เสร็จ < 5 นาที, API p95 ไม่เกิน 500ms |

```js
// tests/load/mixed-orders.js
import http from 'k6/http';
import { check } from 'k6';
import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

export const options = {
  scenarios: {
    pos: { executor: 'constant-arrival-rate', rate: 400, timeUnit: '1m', duration: '15m', preAllocatedVUs: 50, exec: 'posSale' },
    shopee: { executor: 'constant-arrival-rate', rate: 400, timeUnit: '1m', duration: '15m', preAllocatedVUs: 50, exec: 'shopeeWebhook' },
    api: { executor: 'constant-arrival-rate', rate: 200, timeUnit: '1m', duration: '15m', preAllocatedVUs: 20, exec: 'apiOrder' },
  },
  thresholds: {
    'http_req_duration{name:pos_sale}': ['p(95)<200'],
    'http_req_duration{name:api_order}': ['p(95)<300'],
    'http_req_failed{name:pos_sale}': ['rate<0.001'],
  },
};

export function posSale() {
  const id = uuidv4();
  const res = http.post(`${__ENV.API}/pos/sales`, JSON.stringify(buildSale(id)), {
    headers: { Authorization: `Bearer ${__ENV.POS_TOKEN}`, 'Idempotency-Key': id, 'Content-Type': 'application/json' },
    tags: { name: 'pos_sale' },
  });
  check(res, { 'created or insufficient': (r) => r.status === 201 || r.status === 409 });
}
// shopeeWebhook(): POST signed payload ไป webhook-gateway (marketplace mock ตอบ getOrderDetail)
// apiOrder():      POST /orders with Idempotency-Key
```
**Marketplace mock server** (`tests/mocks/marketplaces`): จำลอง Shopee/Lazada/TikTok API (order detail, update_stock) พร้อม latency/error/rate-limit ที่ปรับได้ — ไม่ยิง sandbox จริงตอน load test

**หลัง load test ทุกครั้ง**: รัน ledger↔balance reconciliation + oversell checker (Σ SALE+COMMITTED ≤ Σ receipts ต่อ SKU) → ต้องสะอาด
