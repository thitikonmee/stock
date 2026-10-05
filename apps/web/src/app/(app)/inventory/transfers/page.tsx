'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { ArrowRight, Plus, Trash2 } from 'lucide-react';
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
  formatDate,
} from '@/components/ui';
import { api } from '@/lib/client/api';
import type { Transfer, Warehouse } from '@/lib/client/types';
import { can } from '@/lib/client/types';
import { useResource } from '@/lib/client/use-resource';
import { TRANSFER_STATUS } from '@/lib/client/warehouse-labels';

export default function TransfersPage() {
  const { me } = useMe();
  const [status, setStatus] = useState('');
  const transfers = useResource<Transfer[]>(`/inventory/transfers${status ? `?status=${status}` : ''}`);
  const { data: warehouses } = useResource<Warehouse[]>('/warehouses');
  const [open, setOpen] = useState(false);
  const name = (id: string) => warehouses?.find((w) => w.id === id)?.name ?? '—';

  return (
    <>
      <PageHeader
        breadcrumb={[{ label: 'คลังสินค้า', href: '/inventory/stock' }, { label: 'โอนสต็อก' }]}
        title="โอนสต็อกระหว่างคลัง"
        description="ขอโอน → อนุมัติ (กันสต็อกต้นทาง) → ส่งของ (ระหว่างขนส่ง) → ปลายทางรับของ (รับบางส่วน/ชำรุดได้)"
        actions={
          can(me, 'inventory.transfer') ? (
            <Button onClick={() => setOpen(true)}>
              <Plus className="size-4" aria-hidden />
              ขอโอนสต็อก
            </Button>
          ) : undefined
        }
      />
      <ErrorBox error={transfers.error} />
      <Card
        title="รายการโอน"
        actions={
          <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-48">
            <option value="">ทุกสถานะ</option>
            {Object.entries(TRANSFER_STATUS).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </Select>
        }
      >
        <Table
          head={['เลขที่', 'จาก → ไป', 'รายการ', 'สถานะ', 'สร้างเมื่อ']}
          empty={transfers.data?.length === 0}
        >
          {transfers.data?.map((t) => (
            <tr key={t.id} className="hover:bg-slate-50">
              <Td className="font-mono">
                <Link href={`/inventory/transfers/${t.id}`} className="text-brand-700 hover:underline">
                  {t.docNo}
                </Link>
              </Td>
              <Td>
                <span className="inline-flex items-center gap-1.5">
                  {name(t.fromWarehouseId)}
                  <ArrowRight className="size-3.5 text-slate-400" aria-hidden />
                  {name(t.toWarehouseId)}
                </span>
              </Td>
              <Td>{t.items.length}</Td>
              <Td>
                <Badge tone={TRANSFER_STATUS[t.status].tone}>{TRANSFER_STATUS[t.status].label}</Badge>
              </Td>
              <Td className="text-slate-600">{formatDate(t.createdAt)}</Td>
            </tr>
          ))}
        </Table>
      </Card>
      {open ? (
        <CreateTransferModal
          warehouses={warehouses ?? []}
          onClose={() => setOpen(false)}
          onCreated={transfers.reload}
        />
      ) : null}
    </>
  );
}

function CreateTransferModal({
  warehouses,
  onClose,
  onCreated,
}: {
  warehouses: Warehouse[];
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const [from, setFrom] = useState(warehouses[0]?.id ?? '');
  const [to, setTo] = useState(warehouses[1]?.id ?? '');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState([{ sku: '', quantity: '' }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const items = await Promise.all(
        lines
          .filter((l) => l.sku && l.quantity)
          .map(async (l) => ({
            variantId: (await api<{ id: string }>(`/variants/lookup?sku=${encodeURIComponent(l.sku)}`)).id,
            quantity: l.quantity,
          })),
      );
      await api('/inventory/transfers', {
        method: 'POST',
        body: { fromWarehouseId: from, toWarehouseId: to, ...(note ? { note } : {}), items },
      });
      onClose();
      await onCreated();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open title="ขอโอนสต็อก" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {warehouses.length < 2 ? (
          <p className="text-sm text-amber-700">ต้องมีอย่างน้อย 2 คลังก่อน (ตั้งค่า → สาขาและคลัง)</p>
        ) : null}
        <div className="grid grid-cols-2 gap-3">
          <Field label="จากคลัง">
            <Select value={from} onChange={(e) => setFrom(e.target.value)}>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="ไปคลัง">
            <Select value={to} onChange={(e) => setTo(e.target.value)}>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="หมายเหตุ">
          <Input value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <div className="space-y-2">
          <p className="text-sm font-medium text-slate-700">รายการ</p>
          {lines.map((l, i) => (
            <div key={i} className="flex gap-2">
              <Input
                placeholder="SKU"
                value={l.sku}
                onChange={(e) =>
                  setLines(
                    lines.map((x, idx) => (idx === i ? { ...x, sku: e.target.value.toUpperCase() } : x)),
                  )
                }
              />
              <Input
                placeholder="จำนวน"
                inputMode="decimal"
                className="w-28"
                value={l.quantity}
                onChange={(e) =>
                  setLines(lines.map((x, idx) => (idx === i ? { ...x, quantity: e.target.value } : x)))
                }
              />
              <Button
                variant="ghost"
                aria-label="ลบแถว"
                onClick={() => setLines(lines.length > 1 ? lines.filter((_, idx) => idx !== i) : lines)}
              >
                <Trash2 className="size-4" aria-hidden />
              </Button>
            </div>
          ))}
          <Button variant="secondary" onClick={() => setLines([...lines, { sku: '', quantity: '' }])}>
            เพิ่มแถว
          </Button>
        </div>
        <ErrorBox error={error} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            ยกเลิก
          </Button>
          <Button type="submit" busy={busy} disabled={from === to}>
            ส่งคำขอโอน
          </Button>
        </div>
      </form>
    </Modal>
  );
}
