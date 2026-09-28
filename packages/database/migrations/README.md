# Migrations

- ไฟล์ `NNNN_description.sql` รันตามลำดับด้วย `pnpm db:migrate` (ใช้ `DATABASE_URL_ADMIN`)
- 1 ไฟล์ = 1 transaction ยกเว้นบรรทัดแรกเป็น `-- migrate:no-transaction` (เช่น `CREATE INDEX CONCURRENTLY`)
- **ห้ามแก้ไฟล์ที่ apply แล้ว** (checksum จะไม่ตรง → migrator error) — เพิ่มไฟล์ใหม่แทน
- Expand → deploy → contract: ห้าม drop/rename column ที่ code เวอร์ชันปัจจุบันยังใช้
- **ตารางใหม่ที่มี `tenant_id` ต้องเปิด RLS เองในไฟล์เดียวกัน**:
  ```sql
  ALTER TABLE x ENABLE ROW LEVEL SECURITY;
  ALTER TABLE x FORCE ROW LEVEL SECURITY;
  CREATE POLICY tenant_isolation ON x
    USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
  ```
  integration test `rls-coverage` จะ fail ถ้าลืม
- `0001_baseline.sql` = snapshot เริ่มต้นจาก `db/schema.sql`; หลังจากนี้ `db/schema.sql` เป็นเอกสารอ้างอิง ส่วน source of truth คือโฟลเดอร์นี้
