'use client';

import { useState, type FormEvent } from 'react';
import { Badge, Button, Card, ErrorBox, Field, Input, Modal, PageHeader, Table, Td } from '@/components/ui';
import { api } from '@/lib/client/api';
import type { Supplier } from '@/lib/client/types';
import { useResource } from '@/lib/client/use-resource';

export default function SuppliersPage() {
  const suppliers = useResource<Supplier[]>('/suppliers');
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ code: '', name: '', taxId: '', defaultLeadTimeDays: 7 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api('/suppliers', {
        method: 'POST',
        body: {
          code: form.code,
          name: form.name,
          ...(form.taxId ? { taxId: form.taxId } : {}),
          defaultLeadTimeDays: Number(form.defaultLeadTimeDays),
        },
      });
      setForm({ code: '', name: '', taxId: '', defaultLeadTimeDays: 7 });
      setOpen(false);
      await suppliers.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(s: Supplier) {
    await api(`/suppliers/${s.id}`, { method: 'PATCH', body: { isActive: !s.isActive } });
    await suppliers.reload();
  }

  return (
    <>
      <PageHeader
        title="ผู้จัดจำหน่าย"
        description="ข้อมูลผู้จัดจำหน่ายพื้นฐาน — ผูกกับ SKU ได้ที่หน้ารายละเอียดสินค้า"
        actions={<Button onClick={() => setOpen(true)}>เพิ่มผู้จัดจำหน่าย</Button>}
      />
      <ErrorBox error={suppliers.error} />
      <Card>
        <Table
          head={['รหัส', 'ชื่อ', 'เลขผู้เสียภาษี', 'เครดิต (วัน)', 'สถานะ', '']}
          empty={suppliers.data?.length === 0}
        >
          {suppliers.data?.map((s) => (
            <tr key={s.id}>
              <Td className="font-mono">{s.code}</Td>
              <Td>{s.name}</Td>
              <Td className="text-slate-600">{s.taxId ?? '—'}</Td>
              <Td>{s.paymentTermsDays}</Td>
              <Td>
                <Badge tone={s.isActive ? 'green' : 'slate'}>{s.isActive ? 'ใช้งาน' : 'ปิด'}</Badge>
              </Td>
              <Td className="text-right">
                <Button variant="secondary" onClick={() => void toggleActive(s)}>
                  {s.isActive ? 'ปิดใช้งาน' : 'เปิดใช้งาน'}
                </Button>
              </Td>
            </tr>
          ))}
        </Table>
      </Card>
      <Modal open={open} title="เพิ่มผู้จัดจำหน่าย" onClose={() => setOpen(false)}>
        <form onSubmit={create} className="space-y-4">
          <Field label="รหัส">
            <Input
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
              required
            />
          </Field>
          <Field label="ชื่อ">
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
          </Field>
          <Field label="เลขผู้เสียภาษี (ถ้ามี)">
            <Input value={form.taxId} onChange={(e) => setForm({ ...form, taxId: e.target.value })} />
          </Field>
          <Field label="Lead time เริ่มต้น (วัน)">
            <Input
              type="number"
              min={0}
              value={form.defaultLeadTimeDays}
              onChange={(e) => setForm({ ...form, defaultLeadTimeDays: Number(e.target.value) })}
            />
          </Field>
          <ErrorBox error={error} />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setOpen(false)}>
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
