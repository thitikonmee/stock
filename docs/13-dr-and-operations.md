# 13 — Backup, Disaster Recovery, Operations, Admin Console (§34, §52, §53)

## Targets
| | RPO | RTO |
|---|---|---|
| AZ failure | 0 (Multi-AZ sync) | < 2 นาที (auto failover) |
| Region failure (Bangkok) | ≤ 5 นาที (Aurora Global, lag ปกติ < 1s) | ≤ 1 ชม. (manual promote + DNS) |
| Logical corruption (bug ลบ/แก้ข้อมูลผิด) | จุดใดก็ได้ใน 35 วัน (PITR) | 2–4 ชม. (restore ไป cluster ใหม่ + extract) |

## Backup
| Asset | วิธี | Retention |
|---|---|---|
| PostgreSQL | Aurora continuous backup (PITR 35 วัน) + daily snapshot → copy ไป DR region + **monthly snapshot เก็บ 7 ปี** (ข้อมูลบัญชี/ภาษี) | ตามคอลัมน์ |
| Logical export | รายสัปดาห์ `pg_dump` ต่อ tenant ใหญ่ (สำหรับ tenant restore/ย้าย) → S3 Glacier | 1 ปี |
| S3 (images, exports, archives) | Versioning + Cross-Region Replication + Object Lock (audit archive) | lifecycle |
| Redis | ไม่ถือว่าเป็น backup target (ไม่มี source of truth ใน Redis) — AOF เปิดเพื่อลดงาน re-drive | — |
| Secrets/Config | Terraform state (S3 + versioning), Secrets Manager replication | |
| Webhook raw payload | archive S3 (Parquet) 1 ปี → ใช้ replay ได้ | 1 ปี |

**ทดสอบ restore ทุกเดือน** (automated): restore snapshot → รัน ledger↔balance reconciliation + smoke test → รายงาน; DR drill เต็มรูปแบบทุกไตรมาส

## Replication
- Aurora Multi-AZ writer + 1–2 readers (reporting/dashboards) ใน primary region
- Aurora Global Database → secondary ใน ap-southeast-1
- App ต้องทน replica lag: หน้า "เพิ่งบันทึก" อ่านจาก writer (read-your-writes ด้วย session flag 5 วินาที)

## Recovery Procedures

### Queue recovery (Redis หาย/ล้าง)
1. Redis กลับมา (หรือ cluster ใหม่)
2. `outbox-relay`: event ที่ `published_at IS NULL` ส่งใหม่อัตโนมัติ
3. Re-drive script: `webhook_events WHERE status IN (RECEIVED, PROCESSING, FAILED)` → set RECEIVED → dispatcher enqueue ใหม่
4. `sync_jobs WHERE status IN (QUEUED, RUNNING)` → re-enqueue
5. Trigger full stock push (safety net) สำหรับ account ที่ active
เพราะทุก handler idempotent → re-drive ซ้ำได้ไม่มีผลเสีย

### Webhook replay
- Admin: เลือกช่วงเวลา/platform/account → replay จาก `webhook_events` (≤ 30 วัน) หรือจาก S3 archive (≤ 1 ปี) → insert ใหม่ด้วย dedup_key เดิม? → **ไม่** (จะถูก dedupe) → replay ใช้ flag `force_reprocess` ที่ reset status ของ event เดิม; business idempotency ป้องกันผลซ้ำ
- ทางเลือกที่ดีกว่าสำหรับช่วงยาว: **order re-sync** ด้วย polling ช่วงเวลานั้น (API ของ platform เป็น source of truth)

### Inventory reconstruction (Balance ผิด → rebuild จาก Ledger)
```sql
-- รันด้วย stockos_platform role, ต่อ tenant, ในช่วง low traffic หรือ lock เฉพาะ SKU ที่ผิด
BEGIN;
SET LOCAL app.tenant_id = :tenant;
SET LOCAL lock_timeout = '5s';

-- 1) lock แถวที่จะ rebuild (ตามลำดับ) → หยุดการเปลี่ยนแปลงชั่วคราว
SELECT 1 FROM inventory_balances
 WHERE tenant_id = :tenant AND (warehouse_id, variant_id) IN (SELECT warehouse_id, variant_id FROM rebuild_targets)
 ORDER BY warehouse_id, variant_id FOR UPDATE;

-- 2) คำนวณจาก ledger (หรือ checkpoint + ledger หลัง checkpoint)
WITH l AS (
  SELECT warehouse_id, variant_id,
    COALESCE(SUM(quantity) FILTER (WHERE bucket='ON_HAND'),0)   AS on_hand,
    COALESCE(SUM(quantity) FILTER (WHERE bucket='RESERVED'),0)  AS reserved,
    COALESCE(SUM(quantity) FILTER (WHERE bucket='COMMITTED'),0) AS committed,
    COALESCE(SUM(quantity) FILTER (WHERE bucket='DAMAGED'),0)   AS damaged,
    COALESCE(SUM(quantity) FILTER (WHERE bucket='INCOMING'),0)  AS incoming
  FROM inventory_transactions
  WHERE tenant_id = :tenant AND (warehouse_id, variant_id) IN (SELECT warehouse_id, variant_id FROM rebuild_targets)
  GROUP BY 1,2)
UPDATE inventory_balances b
   SET on_hand = l.on_hand, reserved = l.reserved, committed = l.committed,
       damaged = l.damaged, incoming = l.incoming, version = b.version + 1, updated_at = now()
  FROM l
 WHERE b.tenant_id = :tenant AND b.warehouse_id = l.warehouse_id AND b.variant_id = l.variant_id;

-- 3) ตรวจ reservations ↔ reserved/committed (Σ open reservations ต้องเท่ากัน) → ถ้าไม่เท่า = bug ใน reservation → หยุด, investigate
-- 4) audit log (action = 'inventory.rebuild', before/after ต่อแถว) + outbox StockChanged (push ใหม่ทุก channel)
COMMIT;
```
- เป็น command ใน Admin console (`Rebuild balances` — dry-run แสดง diff ก่อน, ต้อง 2 คนอนุมัติ)
- **ถ้า ledger เองเสียหาย** (เช่น restore บางส่วน): restore PITR ไป cluster แยก → เทียบ ledger → ledger ที่หายจาก source อื่น: orders/receipts/transfers เป็นเอกสารต้นทาง → **regenerate movements จาก documents** (ทุก movement มี reference_type/id → ตรวจได้ว่าเอกสารไหนไม่มี movement) → stock count ยืนยัน

### Region failover runbook (ย่อ)
1. ประกาศ incident, freeze deploy
2. Promote Aurora secondary (ap-southeast-1) → writer
3. Scale ECS ใน DR region (IaC พร้อม, image ใน ECR replicated)
4. สลับ Route 53 (health-check failover) → api / hooks
5. Webhook ระหว่าง outage: platform retry + เราสั่ง polling ย้อน `outage_start − 30 นาที`
6. ตรวจ ledger↔balance + channel reconciliation ทุก tenant ก่อนประกาศ recovered
7. POS: ยังขาย offline ได้ตลอด → sync เมื่อ API กลับ

## 53. Admin Console (Platform Operations)

แยก app/realm (`admin.stockos.co`), สิทธิ์: `platform.viewer`, `platform.support`, `platform.operator`, `platform.admin`; ทุก action → audit log (ทั้ง platform และแจ้งใน tenant audit เมื่อแตะข้อมูล tenant)

| หน้า | ดู | Action |
|---|---|---|
| Tenants | plan, usage, status, health score, channels | Lock/Unlock tenant, change plan, **impersonate (read-only default, ต้องมี ticket + tenant consent flag)** |
| Users | memberships, sessions, MFA | Force logout, reset MFA (ต้องยืนยันตัวตน) |
| Orders | ค้นข้าม tenant (order_sn), status history, raw channel payload | Re-ingest from channel, release hold |
| Inventory | balance, ledger, reservations ของ SKU | Rebuild balances (dry-run + 2-person), release stuck reservations |
| Channels | accounts ต่อ platform, token expiry, circuit state, error rate | Force token refresh, Pause/Resume account, **Force stock sync**, **Remap SKU** (support) |
| Webhooks | inbox (filter status/platform/account), payload, error | **Retry**, Retry bulk, Ignore (+reason), Replay range |
| Sync Jobs / Queue | depth, age, failure ต่อ queue (Bull Board embed), DLQ | **Retry**, Retry all DLQ (rate-limited), Purge (2-person) |
| Errors | Sentry issues รวม, top errors ต่อ tenant | link |
| Reconciliation | runs, mismatch ต่อ tenant | Run now, resolve |
| Audit Log | ค้นทั้งระบบ | export |
| System Health | SLO dashboards, DB/Redis/queue status, deploy version, feature flags | toggle flags (ต่อ tenant/global) |
