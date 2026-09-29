'use client';

import { useParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
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
  Table,
  Td,
  formatDate,
} from '@/components/ui';
import { api } from '@/lib/client/api';
import type { Order, OrderFulfillment, OrderReturn, OrderStatus, ReturnCondition } from '@/lib/client/types';
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

export default function OrderDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { me } = useMe();
  const order = useResource<Order>(`/orders/${id}`);
  const fulfillments = useResource<OrderFulfillment[]>(`/orders/${id}/fulfillments`);
  const returns = useResource<OrderReturn[]>(`/orders/${id}/returns`);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>();
  const [createFulfillmentOpen, setCreateFulfillmentOpen] = useState(false);
  const [returnOpen, setReturnOpen] = useState(false);
  const [refundOpen, setRefundOpen] = useState(false);
  const [receiveReturn, setReceiveReturn] = useState<OrderReturn | null>(null);

  async function act(action: string, body: Record<string, unknown> = {}) {
    setBusy(action);
    setError(undefined);
    try {
      await api(`/orders/${id}/${action}`, { method: 'POST', body });
      await order.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  async function shipFulfillment(fid: string) {
    setBusy(fid);
    setError(undefined);
    try {
      await api(`/fulfillments/${fid}/ship`, { method: 'POST', body: {} });
      await Promise.all([order.reload(), fulfillments.reload()]);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  async function packFulfillment(fid: string) {
    setBusy(fid);
    setError(undefined);
    try {
      await api(`/fulfillments/${fid}/pack`, { method: 'POST', body: {} });
      await fulfillments.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  if (!order.data) {
    return (
      <>
        <ErrorBox error={order.error} />
        {order.loading ? <Loading /> : null}
      </>
    );
  }
  const o = order.data;

  return (
    <>
      <PageHeader
        title={`ออเดอร์ ${o.orderNo}`}
        description={`${o.channelCode} · วางเมื่อ ${formatDate(o.placedAt)}`}
        actions={
          <div className="flex flex-wrap gap-2">
            {o.status === 'PENDING' && can(me, 'order.update') ? (
              <Button busy={busy === 'pay'} onClick={() => void act('pay')}>
                บันทึกว่าชำระแล้ว
              </Button>
            ) : null}
            {(o.status === 'PAID' || o.status === 'ON_HOLD') && can(me, 'order.update') ? (
              <Button
                busy={busy === (o.status === 'ON_HOLD' ? 'release-hold' : 'confirm')}
                onClick={() => void act(o.status === 'ON_HOLD' ? 'release-hold' : 'confirm')}
              >
                {o.status === 'ON_HOLD' ? 'ปลดพัก' : 'ยืนยันออเดอร์'}
              </Button>
            ) : null}
            {o.status === 'PAID' && can(me, 'order.update') ? (
              <Button
                variant="secondary"
                busy={busy === 'hold'}
                onClick={() => void act('hold', { reason: 'ตรวจสอบเพิ่มเติม' })}
              >
                พักออเดอร์
              </Button>
            ) : null}
            {!['CANCELLED', 'COMPLETED', 'REFUNDED', 'SHIPPED', 'DELIVERED', 'RETURNED'].includes(o.status) &&
            can(me, 'order.cancel') ? (
              <Button
                variant="danger"
                busy={busy === 'cancel'}
                onClick={() => void act('cancel', { reason: 'ยกเลิกโดยพนักงาน' })}
              >
                ยกเลิกออเดอร์
              </Button>
            ) : null}
            {['CONFIRMED', 'PROCESSING', 'PACKED'].includes(o.status) && can(me, 'order.fulfill') ? (
              <Button onClick={() => setCreateFulfillmentOpen(true)}>สร้างใบจัดส่ง</Button>
            ) : null}
            {['SHIPPED', 'DELIVERED', 'COMPLETED'].includes(o.status) && can(me, 'order.update') ? (
              <Button variant="secondary" onClick={() => setReturnOpen(true)}>
                ขอรับคืนสินค้า
              </Button>
            ) : null}
            {can(me, 'order.refund') ? (
              <Button variant="secondary" onClick={() => setRefundOpen(true)}>
                คืนเงิน
              </Button>
            ) : null}
          </div>
        }
      />
      <ErrorBox error={error} />

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <Badge tone="teal">{STATUS_LABEL[o.status]}</Badge>
        <span className="text-sm text-slate-500">การชำระเงิน: {o.paymentStatus}</span>
        <span className="text-sm text-slate-500">การจัดส่ง: {o.fulfillmentStatus}</span>
        {o.holdReason ? <span className="text-sm text-amber-700">เหตุผลพัก: {o.holdReason}</span> : null}
      </div>

      <Card title="รายการสินค้า" className="mb-6">
        <Table head={['SKU', 'ชื่อ', 'จำนวน', 'ราคา/หน่วย', 'ส่วนลด', 'VAT', 'รวม', 'จัดส่งแล้ว/คืนแล้ว']}>
          {o.lines.map((l) => (
            <tr key={l.id}>
              <Td className="font-mono">{l.sku}</Td>
              <Td>{l.name}</Td>
              <Td>{l.quantity}</Td>
              <Td>{l.unitPrice}</Td>
              <Td>{l.discountAmount}</Td>
              <Td>{l.taxAmount}</Td>
              <Td>{l.lineTotal}</Td>
              <Td className="text-slate-500">
                {l.fulfilledQty} / {l.returnedQty}
              </Td>
            </tr>
          ))}
        </Table>
        <div className="mt-4 flex justify-end">
          <div className="w-64 space-y-1 text-sm">
            <div className="flex justify-between text-slate-500">
              <span>ยอดก่อนภาษี</span>
              <span>{o.subtotal}</span>
            </div>
            <div className="flex justify-between text-slate-500">
              <span>ส่วนลด</span>
              <span>{o.discountTotal}</span>
            </div>
            <div className="flex justify-between text-slate-500">
              <span>VAT</span>
              <span>{o.taxTotal}</span>
            </div>
            <div className="flex justify-between text-base font-semibold">
              <span>ยอดสุทธิ</span>
              <span>{o.grandTotal}</span>
            </div>
            {Number(o.refundedTotal) > 0 ? (
              <div className="flex justify-between text-red-600">
                <span>คืนเงินแล้ว</span>
                <span>{o.refundedTotal}</span>
              </div>
            ) : null}
          </div>
        </div>
      </Card>

      <Card title="ใบจัดส่ง (Fulfillments)" className="mb-6">
        <Table
          head={['สถานะ', 'ขนส่ง', 'เลขพัสดุ', 'จัดส่งเมื่อ', '']}
          empty={(fulfillments.data ?? []).length === 0}
        >
          {fulfillments.data?.map((f) => (
            <tr key={f.id}>
              <Td>
                <Badge tone={f.status === 'SHIPPED' ? 'green' : 'amber'}>{f.status}</Badge>
              </Td>
              <Td>{f.carrier ?? '—'}</Td>
              <Td className="font-mono">{f.trackingNo ?? '—'}</Td>
              <Td className="text-slate-600">{f.shippedAt ? formatDate(f.shippedAt) : '—'}</Td>
              <Td className="text-right">
                {f.status === 'PICKING' && can(me, 'order.fulfill') ? (
                  <Button variant="secondary" busy={busy === f.id} onClick={() => void packFulfillment(f.id)}>
                    แพ็กแล้ว
                  </Button>
                ) : null}
                {(f.status === 'PICKING' || f.status === 'PACKED') && can(me, 'order.fulfill') ? (
                  <Button className="ml-2" busy={busy === f.id} onClick={() => void shipFulfillment(f.id)}>
                    จัดส่ง
                  </Button>
                ) : null}
              </Td>
            </tr>
          ))}
        </Table>
      </Card>

      <ReturnsPanel returns={returns.data ?? []} onReceive={setReceiveReturn} />

      {createFulfillmentOpen ? (
        <CreateFulfillmentModal
          order={o}
          onClose={() => setCreateFulfillmentOpen(false)}
          onCreated={async () => {
            await Promise.all([order.reload(), fulfillments.reload()]);
          }}
        />
      ) : null}
      {returnOpen ? (
        <RequestReturnModal
          order={o}
          onClose={() => setReturnOpen(false)}
          onCreated={async () => {
            await Promise.all([order.reload(), returns.reload()]);
          }}
        />
      ) : null}
      {refundOpen ? (
        <RefundModal
          order={o}
          onClose={() => setRefundOpen(false)}
          onCreated={async () => {
            await order.reload();
          }}
        />
      ) : null}
      {receiveReturn ? (
        <ReceiveReturnModal
          orderReturn={receiveReturn}
          lines={o.lines}
          onClose={() => setReceiveReturn(null)}
          onReceived={async () => {
            setReceiveReturn(null);
            await Promise.all([order.reload(), returns.reload()]);
          }}
        />
      ) : null}
    </>
  );
}

function ReturnsPanel({
  returns,
  onReceive,
}: {
  returns: OrderReturn[];
  onReceive: (r: OrderReturn) => void;
}) {
  if (returns.length === 0) return null;
  return (
    <Card title="รายการคืนสินค้า" className="mb-6">
      <Table head={['สถานะ', 'เหตุผล', '']}>
        {returns.map((r) => (
          <tr key={r.id}>
            <Td>{r.status}</Td>
            <Td>{r.reason ?? '—'}</Td>
            <Td className="text-right">
              {r.status === 'REQUESTED' ? (
                <Button variant="secondary" onClick={() => onReceive(r)}>
                  รับของ + QC
                </Button>
              ) : null}
            </Td>
          </tr>
        ))}
      </Table>
    </Card>
  );
}

function CreateFulfillmentModal({
  order,
  onClose,
  onCreated,
}: {
  order: Order;
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const eligible = order.lines.filter(
    (l) => Number(l.quantity) - Number(l.fulfilledQty) - Number(l.cancelledQty) > 0,
  );
  const [qty, setQty] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const lines = eligible
        .filter((l) => Number(qty[l.id] || '0') > 0)
        .map((l) => ({ orderItemId: l.id, quantity: qty[l.id]! }));
      if (lines.length === 0) throw new Error('ระบุจำนวนอย่างน้อย 1 รายการ');
      await api(`/orders/${order.id}/fulfillments`, {
        method: 'POST',
        headers: { 'idempotency-key': crypto.randomUUID() },
        body: { lines },
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
    <Modal open title="สร้างใบจัดส่ง" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {eligible.map((l) => {
          const remaining = Number(l.quantity) - Number(l.fulfilledQty) - Number(l.cancelledQty);
          return (
            <div key={l.id} className="flex items-center gap-2">
              <span className="flex-1 text-sm">
                {l.name} <span className="text-slate-400">(เหลือ {remaining})</span>
              </span>
              <Input
                className="w-24"
                placeholder="0"
                value={qty[l.id] ?? ''}
                onChange={(e) => setQty({ ...qty, [l.id]: e.target.value })}
              />
            </div>
          );
        })}
        <ErrorBox error={error} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            ยกเลิก
          </Button>
          <Button type="submit" busy={busy}>
            สร้างใบจัดส่ง
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function RequestReturnModal({
  order,
  onClose,
  onCreated,
}: {
  order: Order;
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const eligible = order.lines.filter((l) => Number(l.fulfilledQty) - Number(l.returnedQty) > 0);
  const [qty, setQty] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const lines = eligible
        .filter((l) => Number(qty[l.id] || '0') > 0)
        .map((l) => ({ orderItemId: l.id, quantity: qty[l.id]! }));
      if (lines.length === 0) throw new Error('ระบุจำนวนอย่างน้อย 1 รายการ');
      await api(`/orders/${order.id}/returns`, {
        method: 'POST',
        headers: { 'idempotency-key': crypto.randomUUID() },
        body: { lines, ...(reason ? { reason } : {}) },
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
    <Modal open title="ขอรับคืนสินค้า" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {eligible.map((l) => {
          const remaining = Number(l.fulfilledQty) - Number(l.returnedQty);
          return (
            <div key={l.id} className="flex items-center gap-2">
              <span className="flex-1 text-sm">
                {l.name} <span className="text-slate-400">(คืนได้สูงสุด {remaining})</span>
              </span>
              <Input
                className="w-24"
                placeholder="0"
                value={qty[l.id] ?? ''}
                onChange={(e) => setQty({ ...qty, [l.id]: e.target.value })}
              />
            </div>
          );
        })}
        <Field label="เหตุผล">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <ErrorBox error={error} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            ยกเลิก
          </Button>
          <Button type="submit" busy={busy}>
            ส่งคำขอ
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function ReceiveReturnModal({
  orderReturn,
  lines,
  onClose,
  onReceived,
}: {
  orderReturn: OrderReturn;
  lines: Order['lines'];
  onClose: () => void;
  onReceived: () => Promise<void>;
}) {
  const [condition, setCondition] = useState<Record<string, ReturnCondition>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const body = {
        lines: orderReturn.items.map((i) => ({
          orderItemId: i.orderItemId,
          condition: condition[i.orderItemId] ?? 'SELLABLE',
        })),
      };
      await api(`/returns/${orderReturn.id}/receive`, { method: 'POST', body });
      await onReceived();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open title="รับของคืน + ตรวจสภาพ (QC)" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {orderReturn.items.map((i) => {
          const line = lines.find((l) => l.id === i.orderItemId);
          return (
            <div key={i.orderItemId} className="flex items-center gap-2">
              <span className="flex-1 text-sm">
                {line?.name ?? i.orderItemId} × {i.quantity}
              </span>
              <select
                className="h-10 rounded-md border border-slate-300 px-2 text-sm"
                value={condition[i.orderItemId] ?? 'SELLABLE'}
                onChange={(e) =>
                  setCondition({ ...condition, [i.orderItemId]: e.target.value as ReturnCondition })
                }
              >
                <option value="SELLABLE">สภาพดี — คืนสต็อก</option>
                <option value="DAMAGED">ชำรุด — เข้าคลังชำรุด</option>
                <option value="MISSING">ของหาย — ไม่คืนสต็อก</option>
              </select>
            </div>
          );
        })}
        <ErrorBox error={error} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            ยกเลิก
          </Button>
          <Button type="submit" busy={busy}>
            ยืนยันรับของ
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function RefundModal({
  order,
  onClose,
  onCreated,
}: {
  order: Order;
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const eligible = order.lines.filter((l) => Number(l.lineTotal) - Number(l.refundedAmount) > 0);
  const [qty, setQty] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const lines = eligible
        .filter((l) => Number(qty[l.id] || '0') > 0)
        .map((l) => ({ orderItemId: l.id, quantity: qty[l.id]! }));
      if (lines.length === 0) throw new Error('ระบุจำนวนอย่างน้อย 1 รายการ');
      if (!reason.trim()) throw new Error('ระบุเหตุผล');
      await api(`/orders/${order.id}/refunds`, {
        method: 'POST',
        headers: { 'idempotency-key': crypto.randomUUID() },
        body: { lines, reason },
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
    <Modal open title="คืนเงิน" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {eligible.map((l) => (
          <div key={l.id} className="flex items-center gap-2">
            <span className="flex-1 text-sm">{l.name}</span>
            <Input
              className="w-24"
              placeholder="0"
              value={qty[l.id] ?? ''}
              onChange={(e) => setQty({ ...qty, [l.id]: e.target.value })}
            />
          </div>
        ))}
        <Field label="เหตุผล">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} required />
        </Field>
        <ErrorBox error={error} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            ยกเลิก
          </Button>
          <Button type="submit" busy={busy}>
            ยืนยันคืนเงิน
          </Button>
        </div>
      </form>
    </Modal>
  );
}
