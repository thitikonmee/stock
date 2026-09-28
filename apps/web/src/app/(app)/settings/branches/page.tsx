'use client';

import { useState, type FormEvent } from 'react';
import { useMe } from '@/components/shell';
import {
  Badge,
  Button,
  Card,
  ErrorBox,
  Field,
  Input,
  Modal,
  PageHeader,
  Select,
  Table,
  Td,
} from '@/components/ui';
import { api } from '@/lib/client/api';
import type { Branch, Warehouse } from '@/lib/client/types';
import { can } from '@/lib/client/types';
import { useResource } from '@/lib/client/use-resource';

const WAREHOUSE_TYPES: Record<string, string> = {
  STORE: 'หน้าร้าน',
  CENTRAL: 'คลังกลาง',
  ONLINE: 'คลังออนไลน์',
  MARKETPLACE_FULFILLMENT: 'คลัง Marketplace',
  TRANSIT: 'ระหว่างขนส่ง',
  VIRTUAL: 'เสมือน',
};

export default function BranchesPage() {
  const { me } = useMe();
  const branches = useResource<Branch[]>('/branches');
  const warehouses = useResource<Warehouse[]>('/warehouses');
  const [dialog, setDialog] = useState<'branch' | 'warehouse' | null>(null);
  const [form, setForm] = useState<Record<string, string | boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const set = (key: string) => (value: string | boolean) => setForm((f) => ({ ...f, [key]: value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      if (dialog === 'branch') {
        await api('/branches', {
          method: 'POST',
          body: { code: form.code, name: form.name, taxBranchNo: form.taxBranchNo || undefined },
        });
        await branches.reload();
      } else {
        await api('/warehouses', {
          method: 'POST',
          body: {
            code: form.code,
            name: form.name,
            branchId: form.branchId || null,
            type: form.type || 'STORE',
            allowNegativeStock: !!form.allowNegativeStock,
          },
        });
        await warehouses.reload();
      }
      setDialog(null);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const openDialog = (kind: 'branch' | 'warehouse') => {
    setForm({});
    setError(undefined);
    setDialog(kind);
  };

  return (
    <>
      <PageHeader title="สาขาและคลังสินค้า" />
      <div className="space-y-6">
        <Card
          title="สาขา"
          actions={
            can(me, 'branch.manage') ? <Button onClick={() => openDialog('branch')}>เพิ่มสาขา</Button> : null
          }
        >
          <ErrorBox error={branches.error} />
          <Table head={['รหัส', 'ชื่อ', 'เลขสาขา (ภาษี)', 'สถานะ']} empty={branches.data?.length === 0}>
            {branches.data?.map((b) => (
              <tr key={b.id}>
                <Td className="font-mono">{b.code}</Td>
                <Td>{b.name}</Td>
                <Td>{b.taxBranchNo === '00000' ? 'สำนักงานใหญ่' : b.taxBranchNo}</Td>
                <Td>{b.isActive ? <Badge tone="green">ใช้งาน</Badge> : <Badge>ปิด</Badge>}</Td>
              </tr>
            ))}
          </Table>
        </Card>
        <Card
          title="คลังสินค้า"
          actions={
            can(me, 'warehouse.manage') ? (
              <Button onClick={() => openDialog('warehouse')}>เพิ่มคลัง</Button>
            ) : null
          }
        >
          <ErrorBox error={warehouses.error} />
          <Table
            head={['รหัส', 'ชื่อ', 'ประเภท', 'สาขา', 'ขายติดลบได้']}
            empty={warehouses.data?.length === 0}
          >
            {warehouses.data?.map((w) => (
              <tr key={w.id}>
                <Td className="font-mono">{w.code}</Td>
                <Td>{w.name}</Td>
                <Td>{WAREHOUSE_TYPES[w.type] ?? w.type}</Td>
                <Td>{branches.data?.find((b) => b.id === w.branchId)?.name ?? '—'}</Td>
                <Td>{w.allowNegativeStock ? 'ได้ (POS offline)' : 'ไม่ได้'}</Td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>

      <Modal
        open={dialog !== null}
        title={dialog === 'branch' ? 'เพิ่มสาขา' : 'เพิ่มคลังสินค้า'}
        onClose={() => setDialog(null)}
      >
        <form onSubmit={submit} className="space-y-4">
          <Field label="รหัส" hint="ตัวพิมพ์ใหญ่/ตัวเลข เช่น BKK01">
            <Input
              value={String(form.code ?? '')}
              onChange={(e) => set('code')(e.target.value.toUpperCase())}
              required
            />
          </Field>
          <Field label="ชื่อ">
            <Input value={String(form.name ?? '')} onChange={(e) => set('name')(e.target.value)} required />
          </Field>
          {dialog === 'branch' ? (
            <Field label="เลขที่สาขา (ตามทะเบียนภาษี)" hint="5 หลัก — สำนักงานใหญ่คือ 00000">
              <Input
                value={String(form.taxBranchNo ?? '')}
                onChange={(e) => set('taxBranchNo')(e.target.value)}
                pattern="\d{5}"
              />
            </Field>
          ) : (
            <>
              <Field label="ประเภท">
                <Select value={String(form.type ?? 'STORE')} onChange={(e) => set('type')(e.target.value)}>
                  {Object.entries(WAREHOUSE_TYPES).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="สาขา">
                <Select value={String(form.branchId ?? '')} onChange={(e) => set('branchId')(e.target.value)}>
                  <option value="">— ไม่ผูกกับสาขา —</option>
                  {branches.data?.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={!!form.allowNegativeStock}
                  onChange={(e) => set('allowNegativeStock')(e.target.checked)}
                />
                อนุญาตให้สต็อกติดลบ (สำหรับ POS ที่ขายตอนออฟไลน์)
              </label>
            </>
          )}
          <ErrorBox error={error} />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setDialog(null)}>
              ยกเลิก
            </Button>
            <Button type="submit" busy={busy}>
              บันทึก
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
