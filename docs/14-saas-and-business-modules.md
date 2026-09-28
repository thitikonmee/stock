# 14 — SaaS Subscription & Business Modules

## 35. SaaS Subscription Model (§48)

| | **Free** | **Starter** | **Business** | **Enterprise** |
|---|---|---|---|---|
| ราคา (ตั้งต้น, ปรับตามตลาด) | ฿0 | ฿590/เดือน | ฿1,990/เดือน | ติดต่อฝ่ายขาย |
| สาขา | 1 | 1 | 5 | ไม่จำกัด |
| POS devices | 1 | 2 | 10 | ไม่จำกัด |
| SKU | 200 | 2,000 | 20,000 | ไม่จำกัด |
| Orders/เดือน | 300 | 3,000 | 30,000 | ตามสัญญา |
| Marketplace channels (shops) | 0 | 2 | 6 | ไม่จำกัด |
| Users | 2 | 5 | 30 | ไม่จำกัด |
| Offline POS | ❌ | ✅ | ✅ | ✅ |
| Purchasing / Transfer / Count | basic | ✅ | ✅ | ✅ |
| Channel allocation, approval workflow, API access | ❌ | ❌ | ✅ | ✅ |
| SSO, dedicated DB, SLA 99.9%, custom integration | ❌ | ❌ | ❌ | ✅ |

**Add-ons**: +POS ฿190/เครื่อง, +channel ฿390/shop, +สาขา ฿490, order overage ฿0.30/order (หรือ upsell)

### Usage Metering
- Metrics: `orders` (สร้างใหม่ต่อเดือน), `skus` (active variants, gauge), `pos_devices` (active), `channels` (connected accounts), `users` (active memberships), `branches`, `api_calls`
- **Counter events**: increment `usage_counters` ใน tx เดียวกับการสร้าง (atomic `INSERT ... ON CONFLICT DO UPDATE SET value = value + 1`) → ไม่คลาด
- **Gauge metrics**: คำนวณจาก count จริงทุกชั่วโมง
- **Limit enforcement** (`PlanGuard`):
  - Hard limit (สร้าง SKU/POS/channel/user เกิน) → 403 `PLAN_LIMIT_EXCEEDED` + upsell
  - **Orders เกิน → ไม่ block** (ห้ามทำให้ร้านขายไม่ได้/ order marketplace หาย) → soft limit: แจ้งเตือน 80%/100%, คิด overage หรือบังคับ upgrade รอบบิลถัดไป
  - Past due → grace 7 วัน → read-only back-office (**POS และ order sync ยังทำงาน** 14 วัน) → suspend
- Billing provider: Omise/Opn (บัตร + PromptPay recurring) หรือ Stripe; ใบกำกับภาษีค่าบริการ SaaS ออกโดย billing module

## 24. Pricing (Price Lists)
- Price resolution (ใน `pos-engine` + server เหมือนกัน): `channel price list → member tier price list → customer-specific → default retail` ; ภายใน list: ช่วงเวลา valid (scheduled) → tier `min_qty` สูงสุดที่ ≤ qty
- Price lists: RETAIL, WHOLESALE, MEMBER, VIP, SHOPEE, LAZADA, TIKTOK, …; `price_includes_tax`
- Scheduled pricing: `valid_from/valid_to`; job เปิด/ปิด + push ไป channel (ถ้า sync_price)
- Marketplace campaign prices (เช่น Shopee flash sale) มักจัดการบน platform → เราอ่านมาเป็น order price จริง, ไม่ push ทับ (config)

## 25. Promotion Engine
- Types: PERCENT_OFF, FIXED_OFF, BUY_X_GET_Y, BUNDLE_PRICE, FREE_ITEM, TIER_PRICE, CART_THRESHOLD, + coupon, member discount
- **Evaluation order**: (1) line-level ตาม `priority` ASC (2) cart-level (3) coupon (4) points redemption
- **Stacking**: `stackable=false` → promotion ที่ดีที่สุดในกลุ่มเดียวชนะ; `exclusive_group` → เลือกได้ 1 ต่อกลุ่ม; guard: ส่วนลดรวมต่อ line ≤ ราคา, ไม่ติดลบ
- **Best-deal mode** (option): ลอง combination ที่อนุญาต เลือกที่ลูกค้าได้ประโยชน์สุด (จำกัด candidate ≤ 8 เพื่อความเร็ว POS)
- Deterministic: engine เป็น pure function (`evaluate(cart, promotions, now) → adjustments[]`) ใน `packages/pos-engine` — POS offline และ server ได้ผลเดียวกัน; server re-evaluate ตอน sync และบันทึก diff (ไม่แก้ใบเสร็จ)
- `usage_count` / coupon redemption: atomic `UPDATE ... WHERE usage_count < usage_limit`

## 26–27. CRM & Loyalty
- Customer identity: phone (E.164) เป็น key หลัก; email, tax id เป็นรอง; channel buyer id ผ่าน `customer_identities`
- **Merge across channels**: marketplace ส่วนใหญ่ mask เบอร์/ที่อยู่ผู้ซื้อ → auto-merge เฉพาะเมื่อ match แบบแน่นอน (phone ครบ/ email); กรณีอื่นเป็น "suggested merge" ให้คนยืนยัน; merge = `merged_into_id` (ไม่ลบ) + remap orders async
- Stats (total_spent, order_count, last_order_at) update async จาก OrderCompleted/Refunded
- Loyalty: points = ledger (`loyalty_transactions`) + `memberships.points_balance` (atomic update + idempotency key); earn เมื่อ order COMPLETED (หรือ POS paid) ตาม tier multiplier; redeem เป็น payment method `POINTS`; expire job; refund → REVERSE ตามสัดส่วน
- Tier: Silver/Gold/Platinum ตาม `min_spend_12m`; evaluate รายวัน; tier ผูก price list/benefits

## 28. Payment Abstraction
```ts
export interface PaymentProvider {
  code: string;                                   // 'cash' | 'edc_manual' | 'opn' | '2c2p' | 'promptpay_static' | 'kbank_qr'
  createPayment(req: { orderId: string; amount: Money; method: PaymentMethod; idempotencyKey: string; metadata?: object }): Promise<PaymentIntent>;  // QR payload / redirect / immediate success
  getPayment(providerRef: string): Promise<PaymentStatus>;
  refund(req: { paymentId: string; providerRef: string; amount: Money; idempotencyKey: string }): Promise<RefundResult>;
  verifyWebhook?(req: RawWebhookRequest): boolean;
  parseWebhook?(req: RawWebhookRequest): PaymentWebhookEvent;
}
```
- Status: PENDING → AUTHORIZED → SUCCEEDED | FAILED | CANCELLED | EXPIRED; refund partial ได้หลายครั้ง (`refunded_amount ≤ amount`)
- PromptPay dynamic QR: create → แสดง QR บน POS/customer display → รอ webhook/poll (timeout 3 นาที) → SUCCEEDED; static QR (EMVCo, tag 29 PromptPay ID + amount) สร้าง local ได้ (offline) แต่ต้องยืนยันด้วยคน/ตรวจสลิป
- Split payment: หลาย `payments` ต่อ order; order PAID เมื่อ Σ succeeded ≥ grand_total
- Marketplace orders: payment method `MARKETPLACE` (platform เก็บเงิน) + fee จาก settlement report → `platform_fee_total`

## 29. Accounting-ready
- ไม่ทำ GL ใน MVP แต่ทุก transaction มีข้อมูลพอ: revenue (ex/inc VAT), VAT output, discount, COGS (`order_items.unit_cost × qty` ณ เวลา SALE), refund/credit note, payment fee/MDR, platform commission, purchase VAT input
- **Accounting export**: daily journal summary ต่อ branch/channel (CSV/Excel format ของ Express, PEAK, FlowAccount, Xero) → Phase 4 connector ผ่าน API
- เอกสารภาษี: ใบกำกับภาษีอย่างย่อ/เต็มรูป, ใบลดหนี้, รายงานภาษีขาย (ภ.พ.30 support) ; e-Tax Invoice & e-Receipt (Phase 4)

## 30–31. Dashboard & Reports
**Owner dashboard**: ยอดขายวันนี้ (vs เมื่อวาน/สัปดาห์ก่อน), จำนวน order, ยอดแยก channel (POS/Shopee/Lazada/TikTok/Website), ยอดแยกสาขา, Top products, Low stock, Out of stock, Gross profit (revenue − COGS − platform fee), Inventory value (Σ on_hand × avg_cost) — ดูรวม/แยก channel

- Data source: MVP = read replica + materialized summary tables (`sales_daily_summary`, refresh ทุก 5 นาทีด้วย incremental job จาก order events) ; Scale = ClickHouse via CDC
- Reports: Sales, Inventory, Stock Movement, Stock Valuation, COGS, Profit, Purchase, Supplier, Product Performance, Channel Performance, POS, Cashier (shift/variance), Refund, Discount, Tax — export CSV/XLSX (exceljs streaming) / PDF (Playwright render HTML template, ฟอนต์ Sarabun/Noto Sans Thai)
- Report ใหญ่ → async job → S3 → notification + presigned link 24 ชม.

## 32. Notification
- Events: LOW_STOCK, OUT_OF_STOCK, ORDER_FAILED/ON_HOLD, PAYMENT_FAILED, CHANNEL_SYNC_FAILED, STOCK_SYNC_FAILED, WEBHOOK_FAILED, TOKEN_EXPIRING/EXPIRED, ABNORMAL_STOCK (adjustment ผิดปกติ/ขายผิดปกติ), NEGATIVE_STOCK, OVERSOLD, CASH_VARIANCE
- Channels: in-app (SSE), Email (SES), **LINE** (LINE Messaging API ผ่าน Official Account ของ StockOS — ส่งถึง user/group ที่ผูกบัญชีแล้ว; LINE Notify ถูกยกเลิกบริการแล้ว), Webhook (signed)
- Throttle/digest ด้วย `dedup_key` + `throttle_minutes` (เช่น LOW_STOCK รวมเป็น digest ทุก 1 ชม.), severity routing, quiet hours

## 54. AI Features (Future, แยกจาก Core)
| Feature | Input | Output | Guardrail |
|---|---|---|---|
| Demand / Sales forecast | order history (≥ 6 เดือน), seasonality, campaign calendar (11.11, 12.12, Payday) | forecast ต่อ SKU/สัปดาห์ | แสดง confidence interval |
| Reorder recommendation | forecast + lead time + MOQ + stock | draft PO | **สร้างเป็น DRAFT เท่านั้น** — คนอนุมัติ |
| Slow-moving / Dead stock | movement ledger | รายการ + มูลค่าทุนจม | — |
| Price recommendation | ราคา, conversion, คู่แข่ง (ถ้ามีข้อมูล) | ช่วงราคาแนะนำ | ไม่เปลี่ยนราคาเอง |
| Anomaly detection | ledger, adjustments, POS voids/refunds, cash variance | alert (สงสัยทุจริต/ข้อมูลผิด) | alert เท่านั้น |
| Channel allocation suggestion | ยอดขายต่อ channel | ปรับโควต้า | ต้องกด apply |

Architecture: AI service แยก (Python) อ่านจาก **analytics store/replica** เท่านั้น, เขียนผลลัพธ์ลง `ai_recommendations` table; การนำไปใช้ผ่าน API ปกติ (มี permission + approval + audit) — **AI ไม่มีสิทธิ์เขียน inventory โดยตรง**
