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
  Notice,
  PageHeader,
  Select,
  Table,
  Td,
  formatDate,
} from '@/components/ui';
import { api } from '@/lib/client/api';
import type { Branch, PosDevice, Warehouse } from '@/lib/client/types';
import { useResource } from '@/lib/client/use-resource';

const STATUS: Record<PosDevice['status'], { label: string; tone: 'amber' | 'green' | 'slate' | 'red' }> = {
  PENDING: { label: 'รอลงทะเบียน', tone: 'amber' },
  ACTIVE: { label: 'ใช้งาน', tone: 'green' },
  DISABLED: { label: 'ปิดใช้งาน', tone: 'slate' },
  LOST: { label: 'สูญหาย', tone: 'red' },
};

export default function DevicesPage() {
  const { me } = useMe();
  const devices = useResource<PosDevice[]>('/pos-devices');
  const { data: branches } = useResource<Branch[]>('/branches');
  const { data: warehouses } = useResource<Warehouse[]>('/warehouses');
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ code: '', name: '', branchId: '', warehouseId: '' });
  const [code, setCode] = useState<{ registrationCode: string; expiresAt: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    await run(async () => {
      const res = await api<{ registrationCode: string; expiresAt: string }>('/pos-devices', {
        method: 'POST',
        body: form,
      });
      setCode(res);
      await devices.reload();
    });
  }

  const branchWarehouses = (warehouses ?? []).filter((w) => !w.branchId || w.branchId === form.branchId);

  return (
    <>
      <PageHeader
        title="เครื่อง POS"
        description="สร้างเครื่องแล้วนำรหัสลงทะเบียนไปใส่ในแอป POS ภายใน 15 นาที"
        actions={
          <Button
            onClick={() => {
              const branchId = branches?.[0]?.id ?? '';
              setForm({
                code: '',
                name: '',
                branchId,
                warehouseId: warehouses?.find((w) => !w.branchId || w.branchId === branchId)?.id ?? '',
              });
              setCode(null);
              setError(undefined);
              setOpen(true);
            }}
          >
            เพิ่มเครื่อง
          </Button>
        }
      />
      <ErrorBox error={error ?? devices.error} />
      <Card>
        <Table
          head={['รหัส', 'ชื่อ', 'สาขา', 'สถานะ', 'แอป', 'ใช้งานล่าสุด', '']}
          empty={devices.data?.length === 0}
        >
          {devices.data?.map((d) => (
            <tr key={d.id}>
              <Td className="font-mono">{d.code}</Td>
              <Td>{d.name}</Td>
              <Td>{branches?.find((b) => b.id === d.branchId)?.name ?? '—'}</Td>
              <Td>
                <Badge tone={STATUS[d.status].tone}>{STATUS[d.status].label}</Badge>
              </Td>
              <Td className="text-slate-600">{d.platform ? `${d.platform} ${d.appVersion ?? ''}` : '—'}</Td>
              <Td className="text-slate-600">{formatDate(d.lastSeenAt)}</Td>
              <Td className="text-right">
                <div className="flex justify-end gap-2">
                  {d.status !== 'LOST' ? (
                    <Button
                      variant="secondary"
                      onClick={() =>
                        void run(async () => {
                          const res = await api<{ registrationCode: string; expiresAt: string }>(
                            `/pos-devices/${d.id}/registration-code`,
                            { method: 'POST' },
                          );
                          setCode(res);
                          setOpen(true);
                          await devices.reload();
                        })
                      }
                    >
                      รหัสใหม่
                    </Button>
                  ) : null}
                  {d.status === 'ACTIVE' ? (
                    <Button
                      variant="danger"
                      onClick={() =>
                        void run(async () => {
                          await api(`/pos-devices/${d.id}`, {
                            method: 'PATCH',
                            body: { status: 'DISABLED' },
                          });
                          await devices.reload();
                        })
                      }
                    >
                      ปิดใช้งาน
                    </Button>
                  ) : null}
                </div>
              </Td>
            </tr>
          ))}
        </Table>
      </Card>

      <Modal
        open={open}
        title={code ? 'รหัสลงทะเบียนเครื่อง' : 'เพิ่มเครื่อง POS'}
        onClose={() => setOpen(false)}
      >
        {code ? (
          <div className="space-y-4">
            <p className="text-sm text-slate-600">
              ในแอป POS ให้ใส่ชื่อร้าน <strong className="font-mono">{me?.tenant.slug}</strong> และรหัสนี้
              (ใช้ได้ครั้งเดียว หมดอายุ {formatDate(code.expiresAt)})
            </p>
            <div className="rounded-lg bg-slate-900 py-5 text-center font-mono text-3xl tracking-widest text-white">
              {code.registrationCode}
            </div>
            <Notice tone="warning">รหัสจะแสดงเพียงครั้งเดียว</Notice>
            <div className="flex justify-end">
              <Button onClick={() => setOpen(false)}>เสร็จสิ้น</Button>
            </div>
          </div>
        ) : (
          <form onSubmit={create} className="space-y-4">
            <Field label="รหัสเครื่อง" hint="เช่น POS01">
              <Input
                value={form.code}
                onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
                required
              />
            </Field>
            <Field label="ชื่อ">
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="เคาน์เตอร์ 1"
                required
              />
            </Field>
            <Field label="สาขา">
              <Select
                value={form.branchId}
                onChange={(e) => setForm({ ...form, branchId: e.target.value, warehouseId: '' })}
                required
              >
                {branches?.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="ตัดสต็อกจากคลัง">
              <Select
                value={form.warehouseId}
                onChange={(e) => setForm({ ...form, warehouseId: e.target.value })}
                required
              >
                <option value="" disabled>
                  — เลือกคลัง —
                </option>
                {branchWarehouses.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </Select>
            </Field>
            <ErrorBox error={error} />
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setOpen(false)}>
                ยกเลิก
              </Button>
              <Button type="submit" busy={busy}>
                สร้างเครื่อง
              </Button>
            </div>
          </form>
        )}
      </Modal>
    </>
  );
}
