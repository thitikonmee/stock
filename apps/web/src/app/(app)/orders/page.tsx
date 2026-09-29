'use client';

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { useMe } from '@/components/shell';
import {
  Badge,
  Button,
  Card,
  ErrorBox,
  Field,
  Input,
  Loading,
  Modal,
  PageHeader,
  Select,
  Table,
  Td,
  formatDate,
} from '@/components/ui';
import { api } from '@/lib/client/api';
import type { Order, OrderListPage, OrderStatus, Warehouse } from '@/lib/client/types';
import { can } from '@/lib/client/types';
import { useResource } from '@/lib/client/use-resource';

const STATUS_LABEL: Record<OrderStatus, string> = {
  DRAFT: 'แบบร่าง',
  PENDING: 'รอชำระเงิน',
  PAID: 'ชำระแล้ว',
  CONFIRMED: 'ยืนยันแล้ว',
  PROCESSING: 'กำลังจัดเตรียม',
  PACKED: 'แพ็กแล้ว',
  SHIPPED: 'จัดส่งแล้ว',
  DELIVERED: 'ถึงลูกค้าแล้ว',
  COMPLETED: 'เสร็จสมบูรณ์',
  CANCELLED: 'ยกเลิก',
  RETURNED: 'ตีคืน',
  REFUNDED: 'คืนเงินแล้ว',
  PARTIALLY_REFUNDED: 'คืนเงินบางส่วน',
  ON_HOLD: 'พักไว้',
};
const STATUS_TONE: Record<OrderStatus, 'slate' | 'amber' | 'green' | 'red' | 'teal'> = {
  DRAFT: 'slate',
  PENDING: 'amber',
  PAID: 'teal',
  CONFIRMED: 'teal',
  PROCESSING: 'teal',
  PACKED: 'teal',
  SHIPPED: 'green',
  DELIVERED: 'green',
  COMPLETED: 'green',
  CANCELLED: 'slate',
  RETURNED: 'red',
  REFUNDED: 'red',
  PARTIALLY_REFUNDED: 'amber',
  ON_HOLD: 'amber',
};

export default function OrdersPage() {
  const { me } = useMe();
  const { data: warehouses } = useResource<Warehouse[]>('/warehouses');
  const [status, setStatus] = useState('');
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>();
  const [createOpen, setCreateOpen] = useState(false);

  async function load() {
    setLoading(true);
    setError(undefined);
    try {
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      const res = await api<OrderListPage>(`/orders?${params.toString()}`);
      setOrders(res.data);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, [status]);

  return (
    <>
      <PageHeader
        title="ออเดอร์"
        description="ออเดอร์จากช่องทาง API/เว็บไซต์ — ดูสถานะ ยืนยัน จัดส่ง รับคืน และคืนเงิน"
        actions={
          can(me, 'order.create') ? (
            <Button onClick={() => setCreateOpen(true)}>สร้างออเดอร์</Button>
          ) : undefined
        }
      />
      <div className="mb-4 flex flex-wrap items-end gap-4">
        <Field label="สถานะ">
          <Select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">ทั้งหมด</option>
            {Object.entries(STATUS_LABEL).map(([code, label]) => (
              <option key={code} value={code}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <ErrorBox error={error} />
      <Card>
        <Table
          head={['เลขที่', 'ช่องทาง', 'สถานะ', 'การจัดส่ง', 'ยอดสุทธิ', 'วันที่']}
          empty={!loading && orders.length === 0}
        >
          {orders.map((o) => (
            <tr key={o.id}>
              <Td className="font-mono">
                <Link href={`/orders/${o.id}`} className="text-brand-700 underline">
                  {o.orderNo}
                </Link>
              </Td>
              <Td>{o.channelCode}</Td>
              <Td>
                <Badge tone={STATUS_TONE[o.status]}>{STATUS_LABEL[o.status]}</Badge>
              </Td>
              <Td>{o.fulfillmentStatus}</Td>
              <Td>{o.grandTotal}</Td>
              <Td className="whitespace-nowrap text-slate-600">{formatDate(o.placedAt)}</Td>
            </tr>
          ))}
        </Table>
        {loading ? <Loading /> : null}
      </Card>
      {createOpen ? (
        <CreateOrderModal
          warehouses={warehouses ?? []}
          onClose={() => setCreateOpen(false)}
          onCreated={load}
        />
      ) : null}
    </>
  );
}

interface LineRow {
  sku: string;
  quantity: string;
}

function CreateOrderModal({
  warehouses,
  onClose,
  onCreated,
}: {
  warehouses: Warehouse[];
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const [warehouseId, setWarehouseId] = useState(warehouses[0]?.id ?? '');
  const [paid, setPaid] = useState(false);
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<LineRow[]>([{ sku: '', quantity: '1' }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const resolved = await Promise.all(
        lines
          .filter((l) => l.sku && l.quantity)
          .map(async (l) => ({
            variantId: (await api<{ id: string }>(`/variants/lookup?sku=${encodeURIComponent(l.sku)}`)).id,
            quantity: l.quantity,
          })),
      );
      await api('/orders', {
        method: 'POST',
        headers: { 'idempotency-key': crypto.randomUUID() },
        body: { channelCode: 'API', warehouseId, paid, lines: resolved, ...(note ? { note } : {}) },
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
    <Modal open title="สร้างออเดอร์" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="คลัง">
          <Select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} required>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </Select>
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={paid} onChange={(e) => setPaid(e.target.checked)} />
          ชำระเงินแล้ว (เช่น โอนเงินมาก่อนสร้างออเดอร์)
        </label>
        <Field label="หมายเหตุ">
          <Input value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <div className="space-y-2">
          <p className="text-sm font-medium text-slate-700">รายการสินค้า</p>
          {lines.map((row, i) => (
            <div key={i} className="flex gap-2">
              <Input
                placeholder="SKU"
                value={row.sku}
                onChange={(e) =>
                  setLines(
                    lines.map((r, idx) => (idx === i ? { ...r, sku: e.target.value.toUpperCase() } : r)),
                  )
                }
              />
              <Input
                className="w-24"
                placeholder="จำนวน"
                value={row.quantity}
                onChange={(e) =>
                  setLines(lines.map((r, idx) => (idx === i ? { ...r, quantity: e.target.value } : r)))
                }
              />
            </div>
          ))}
          <Button
            type="button"
            variant="secondary"
            onClick={() => setLines([...lines, { sku: '', quantity: '1' }])}
          >
            เพิ่มแถว
          </Button>
        </div>
        <ErrorBox error={error} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            ยกเลิก
          </Button>
          <Button type="submit" busy={busy}>
            สร้างออเดอร์
          </Button>
        </div>
      </form>
    </Modal>
  );
}
