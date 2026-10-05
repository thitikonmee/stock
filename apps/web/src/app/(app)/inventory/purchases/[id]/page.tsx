'use client';

import { useParams } from 'next/navigation';
import { useMemo, useState, type FormEvent } from 'react';
import { ScanLine } from 'lucide-react';
import { useMe } from '@/components/shell';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  ErrorBox,
  Field,
  Input,
  Loading,
  Notice,
  PageHeader,
  Table,
  Td,
  formatDate,
} from '@/components/ui';
import { api } from '@/lib/client/api';
import type { Purchase, Warehouse } from '@/lib/client/types';
import { can } from '@/lib/client/types';
import { useResource } from '@/lib/client/use-resource';
import { PURCHASE_STATUS, baht, ifMatch, newKey, qty } from '@/lib/client/warehouse-labels';

type Action = 'submit' | 'approve' | 'reject' | 'send' | 'cancel' | 'close';

const CONFIRM: Partial<Record<Action, { title: string; description: string; tone: 'danger' | 'warning' }>> = {
  cancel: { title: 'ยกเลิกใบสั่งซื้อ?', description: 'ยอดที่รอรับ (incoming) จะถูกคืน', tone: 'danger' },
  close: {
    title: 'ปิดใบสั่งซื้อ?',
    description: 'จำนวนที่ยังไม่ได้รับจะถูกตัดทิ้ง และรับของเพิ่มไม่ได้อีก',
    tone: 'warning',
  },
};

export default function PurchaseDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { me } = useMe();
  const po = useResource<Purchase>(`/purchases/${id}`);
  const { data: warehouses } = useResource<Warehouse[]>('/warehouses');
  const [busy, setBusy] = useState<Action | null>(null);
  const [confirm, setConfirm] = useState<Action | null>(null);
  const [error, setError] = useState<unknown>();

  async function run(action: Action) {
    if (!po.data) return;
    setBusy(action);
    setError(undefined);
    try {
      await api(`/purchases/${po.data.id}/${action}`, {
        method: 'POST',
        headers: ifMatch(po.data.version),
        body: {},
      });
      setConfirm(null);
      await po.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  if (!po.data) return po.error ? <ErrorBox error={po.error} /> : <Loading />;
  const p = po.data;
  const status = PURCHASE_STATUS[p.status];
  const receivable = ['APPROVED', 'SENT', 'PARTIALLY_RECEIVED'].includes(p.status);
  const warehouseName = warehouses?.find((w) => w.id === p.warehouseId)?.name ?? '—';

  const buttons: {
    action: Action;
    label: string;
    variant?: 'secondary' | 'danger' | 'success';
    show: boolean;
  }[] = [
    { action: 'submit', label: 'ส่งขออนุมัติ', show: p.status === 'DRAFT' && can(me, 'purchase.create') },
    {
      action: 'reject',
      label: 'ตีกลับ',
      variant: 'secondary',
      show: p.status === 'PENDING_APPROVAL' && can(me, 'purchase.approve'),
    },
    {
      action: 'approve',
      label: 'อนุมัติ',
      variant: 'success',
      // Segregation of duties: the server refuses self-approval, so don't offer it.
      show:
        p.status === 'PENDING_APPROVAL' && can(me, 'purchase.approve') && p.createdBy !== me?.membershipId,
    },
    {
      action: 'send',
      label: 'ส่งให้ผู้ขายแล้ว',
      variant: 'secondary',
      show: p.status === 'APPROVED' && can(me, 'purchase.create'),
    },
    {
      action: 'close',
      label: 'ปิดใบสั่งซื้อ',
      variant: 'secondary',
      show: ['PARTIALLY_RECEIVED', 'RECEIVED'].includes(p.status) && can(me, 'purchase.approve'),
    },
    {
      action: 'cancel',
      label: 'ยกเลิก',
      variant: 'danger',
      show:
        ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT'].includes(p.status) && can(me, 'purchase.create'),
    },
  ];

  return (
    <>
      <PageHeader
        breadcrumb={[
          { label: 'คลังสินค้า', href: '/inventory/stock' },
          { label: 'ใบสั่งซื้อ', href: '/inventory/purchases' },
          { label: p.docNo },
        ]}
        title={
          <span className="flex items-center gap-3">
            {p.docNo}
            <Badge tone={status.tone}>{status.label}</Badge>
          </span>
        }
        description={`${p.supplierName} · รับเข้า ${warehouseName}${p.expectedAt ? ` · กำหนดส่ง ${p.expectedAt}` : ''}`}
        actions={
          <div className="flex flex-wrap gap-2">
            {buttons
              .filter((b) => b.show)
              .map((b) => (
                <Button
                  key={b.action}
                  variant={b.variant ?? 'primary'}
                  busy={busy === b.action}
                  onClick={() => (CONFIRM[b.action] ? setConfirm(b.action) : void run(b.action))}
                >
                  {b.label}
                </Button>
              ))}
          </div>
        }
      />
      <div className="space-y-6">
        <ErrorBox error={error} />
        {p.status === 'PENDING_APPROVAL' && p.createdBy === me?.membershipId ? (
          <Notice tone="info">ใบสั่งซื้อนี้ต้องให้คนอื่น (ไม่ใช่ผู้สร้าง) เป็นผู้อนุมัติ</Notice>
        ) : null}

        <Card title="รายการสินค้า">
          <Table head={['SKU', 'สินค้า', 'สั่ง', 'หน่วย', 'ราคา/หน่วย', 'รับแล้ว', 'ค้างรับ', 'รวม']}>
            {p.items.map((i) => (
              <tr key={i.id}>
                <Td className="font-mono">{i.sku}</Td>
                <Td>{i.variantName}</Td>
                <Td className="tabular-nums">{qty(i.orderedQty)}</Td>
                <Td>
                  {i.unitCode}
                  {Number(i.unitFactor) !== 1 ? (
                    <span className="text-xs text-slate-500"> (×{qty(i.unitFactor)})</span>
                  ) : null}
                </Td>
                <Td className="tabular-nums">{baht(i.unitCost)}</Td>
                <Td className="tabular-nums">{qty(i.receivedQty)}</Td>
                <Td
                  className={`tabular-nums ${Number(i.outstandingQty) > 0 ? 'text-amber-700' : 'text-slate-500'}`}
                >
                  {qty(i.outstandingQty)}
                </Td>
                <Td className="tabular-nums">{baht(i.lineTotal)}</Td>
              </tr>
            ))}
          </Table>
          <dl className="mt-4 ml-auto grid max-w-xs grid-cols-2 gap-y-1 text-sm">
            <dt className="text-slate-500">ยอดก่อนส่วนลด</dt>
            <dd className="text-right tabular-nums">{baht(p.subtotal)}</dd>
            <dt className="text-slate-500">ส่วนลด</dt>
            <dd className="text-right tabular-nums">−{baht(p.discountTotal)}</dd>
            <dt className="text-slate-500">VAT</dt>
            <dd className="text-right tabular-nums">{baht(p.taxTotal)}</dd>
            <dt className="font-semibold">ยอดรวม</dt>
            <dd className="text-right font-semibold tabular-nums">{baht(p.grandTotal)}</dd>
          </dl>
        </Card>

        {receivable && can(me, 'purchase.receive') ? <ReceivePanel po={p} onReceived={po.reload} /> : null}

        <Card title="ประวัติการรับของ">
          <Table
            head={['เลขที่', 'ใบกำกับผู้ขาย', 'จำนวนรายการ', 'รับเมื่อ']}
            empty={p.receipts.length === 0}
          >
            {p.receipts.map((r) => (
              <tr key={r.id}>
                <Td className="font-mono">{r.docNo}</Td>
                <Td>{r.supplierInvoiceNo ?? '—'}</Td>
                <Td>{r.lines}</Td>
                <Td className="text-slate-600">{formatDate(r.receivedAt)}</Td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>

      {confirm && CONFIRM[confirm] ? (
        <ConfirmDialog
          open
          onClose={() => setConfirm(null)}
          onConfirm={() => void run(confirm)}
          tone={CONFIRM[confirm]!.tone}
          title={CONFIRM[confirm]!.title}
          description={CONFIRM[confirm]!.description}
          actionLabel="ยืนยัน"
          busy={busy === confirm}
        />
      ) : null}
    </>
  );
}

/** Goods receipt: type quantities, or scan barcodes — each scan adds 1 to the matching line. */
function ReceivePanel({ po, onReceived }: { po: Purchase; onReceived: () => Promise<void> }) {
  const open = po.items.filter((i) => Number(i.outstandingQty) > 0);
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [invoiceNo, setInvoiceNo] = useState('');
  const [scan, setScan] = useState('');
  const [scanMsg, setScanMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  // One key per receipt attempt: a double-click or network retry replays instead of receiving twice.
  const key = useMemo(() => newKey(), [po.version]);

  async function onScan(e: FormEvent) {
    e.preventDefault();
    const code = scan.trim();
    setScan('');
    if (!code) return;
    try {
      const v = await api<{ id: string; sku: string }>(
        `/variants/lookup?barcode=${encodeURIComponent(code)}`,
      ).catch(() =>
        api<{ id: string; sku: string }>(`/variants/lookup?sku=${encodeURIComponent(code.toUpperCase())}`),
      );
      const line = open.find((i) => i.variantId === v.id);
      if (!line) {
        setScanMsg(`${v.sku} ไม่อยู่ในใบสั่งซื้อนี้ (หรือรับครบแล้ว)`);
        return;
      }
      const next = Number(quantities[line.id] ?? 0) + 1;
      setQuantities({ ...quantities, [line.id]: String(next) });
      setScanMsg(`${line.sku} → ${next}`);
    } catch {
      setScanMsg(`ไม่พบสินค้า: ${code}`);
    }
  }

  async function submit() {
    setBusy(true);
    setError(undefined);
    try {
      const lines = Object.entries(quantities)
        .filter(([, q]) => Number(q) > 0)
        .map(([purchaseItemId, quantity]) => ({ purchaseItemId, quantity }));
      await api(`/purchases/${po.id}/receipts`, {
        method: 'POST',
        headers: { 'idempotency-key': key },
        body: { ...(invoiceNo ? { supplierInvoiceNo: invoiceNo } : {}), lines },
      });
      setQuantities({});
      setInvoiceNo('');
      setScanMsg(null);
      await onReceived();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const total = Object.values(quantities).reduce((s, q) => s + Number(q || 0), 0);

  return (
    <Card title="รับของเข้าคลัง" tint>
      <div className="space-y-4">
        <form onSubmit={onScan} className="flex gap-2">
          <Input
            icon={<ScanLine className="size-4" />}
            placeholder="สแกนบาร์โค้ด หรือพิมพ์ SKU แล้วกด Enter"
            value={scan}
            onChange={(e) => setScan(e.target.value)}
            autoComplete="off"
          />
          <Button type="submit" variant="secondary">
            เพิ่ม
          </Button>
        </form>
        {scanMsg ? <p className="text-sm text-slate-600">{scanMsg}</p> : null}
        <Table head={['SKU', 'สินค้า', 'ค้างรับ (หน่วยฐาน)', 'รับครั้งนี้', '']}>
          {open.map((i) => (
            <tr key={i.id}>
              <Td className="font-mono">{i.sku}</Td>
              <Td>{i.variantName}</Td>
              <Td className="tabular-nums">{qty(i.outstandingQty)}</Td>
              <Td>
                <Input
                  inputMode="decimal"
                  className="w-28"
                  value={quantities[i.id] ?? ''}
                  onChange={(e) => setQuantities({ ...quantities, [i.id]: e.target.value })}
                />
              </Td>
              <Td>
                <Button
                  variant="ghost"
                  onClick={() => setQuantities({ ...quantities, [i.id]: i.outstandingQty })}
                >
                  รับครบ
                </Button>
              </Td>
            </tr>
          ))}
        </Table>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <Field label="เลขที่ใบกำกับ/ใบส่งของของผู้ขาย">
            <Input value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} className="w-64" />
          </Field>
          <Button variant="success" busy={busy} disabled={total <= 0} onClick={() => void submit()}>
            บันทึกรับของ ({qty(String(total))})
          </Button>
        </div>
        <ErrorBox error={error} />
      </div>
    </Card>
  );
}
