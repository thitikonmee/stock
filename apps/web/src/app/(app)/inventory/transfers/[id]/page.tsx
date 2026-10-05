'use client';

import { useParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { useMe } from '@/components/shell';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  ErrorBox,
  Input,
  Loading,
  PageHeader,
  Table,
  Td,
  formatDate,
} from '@/components/ui';
import { api } from '@/lib/client/api';
import type { Transfer, Warehouse } from '@/lib/client/types';
import { can } from '@/lib/client/types';
import { useResource } from '@/lib/client/use-resource';
import { TRANSFER_STATUS, ifMatch, newKey, qty } from '@/lib/client/warehouse-labels';

type Step = 'approve' | 'ship' | 'receive';

export default function TransferDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { me } = useMe();
  const tr = useResource<Transfer>(`/inventory/transfers/${id}`);
  const { data: warehouses } = useResource<Warehouse[]>('/warehouses');
  const [qtys, setQtys] = useState<Record<string, string>>({});
  const [damaged, setDamaged] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'cancel' | 'complete' | null>(null);
  const [error, setError] = useState<unknown>();
  const receiveKey = useMemo(() => newKey(), [tr.data?.version]);

  if (!tr.data) return tr.error ? <ErrorBox error={tr.error} /> : <Loading />;
  const t = tr.data;
  const name = (wid: string) => warehouses?.find((w) => w.id === wid)?.name ?? '—';
  const st = TRANSFER_STATUS[t.status];

  const step: Step | null =
    t.status === 'REQUESTED' && can(me, 'inventory.transfer.approve')
      ? 'approve'
      : (t.status === 'APPROVED' || t.status === 'PICKING') && can(me, 'inventory.transfer')
        ? 'ship'
        : (t.status === 'SHIPPED' || t.status === 'PARTIALLY_RECEIVED') && can(me, 'inventory.transfer')
          ? 'receive'
          : null;

  const defaultQty = (i: Transfer['items'][number]) =>
    String(
      Number(step === 'approve' ? i.requestedQty : step === 'ship' ? (i.approvedQty ?? '0') : i.inTransitQty),
    );

  async function post(path: string, body: Record<string, unknown>, headers: Record<string, string>) {
    setBusy(path);
    setError(undefined);
    try {
      await api(`/inventory/transfers/${t.id}/${path}`, { method: 'POST', headers, body });
      setQtys({});
      setDamaged({});
      setConfirm(null);
      await tr.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  function doStep() {
    if (!step) return;
    if (step === 'receive') {
      const lines = t.items
        .map((i) => ({
          itemId: i.id,
          receivedQty: qtys[i.id] ?? i.inTransitQty,
          damagedQty: damaged[i.id] ?? '0',
        }))
        .filter((l) => Number(l.receivedQty) + Number(l.damagedQty) > 0);
      void post('receive', { lines }, { 'idempotency-key': receiveKey });
    } else {
      const lines = t.items.map((i) => ({ itemId: i.id, quantity: qtys[i.id] ?? defaultQty(i) }));
      void post(step, { lines }, ifMatch(t.version));
    }
  }

  const stepLabel: Record<Step, string> = {
    approve: 'อนุมัติโอน',
    ship: 'ยืนยันส่งของ',
    receive: 'บันทึกรับของ',
  };
  const stepColumn: Record<Step, string> = { approve: 'อนุมัติ', ship: 'ส่งจริง', receive: 'รับดี' };

  return (
    <>
      <PageHeader
        breadcrumb={[
          { label: 'คลังสินค้า', href: '/inventory/stock' },
          { label: 'โอนสต็อก', href: '/inventory/transfers' },
          { label: t.docNo },
        ]}
        title={
          <span className="flex items-center gap-3">
            {t.docNo}
            <Badge tone={st.tone}>{st.label}</Badge>
          </span>
        }
        description={`สร้างเมื่อ ${formatDate(t.createdAt)}${t.note ? ` · ${t.note}` : ''}`}
        actions={
          <div className="flex gap-2">
            {['PARTIALLY_RECEIVED', 'RECEIVED'].includes(t.status) &&
            can(me, 'inventory.transfer.approve') ? (
              <Button variant="secondary" onClick={() => setConfirm('complete')}>
                ปิดงานโอน
              </Button>
            ) : null}
            {['REQUESTED', 'APPROVED', 'PICKING'].includes(t.status) && can(me, 'inventory.transfer') ? (
              <Button variant="danger" onClick={() => setConfirm('cancel')}>
                ยกเลิก
              </Button>
            ) : null}
          </div>
        }
      />
      <div className="space-y-6">
        <Card>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="rounded-lg bg-slate-100 px-3 py-1.5 font-medium">{name(t.fromWarehouseId)}</span>
            <ArrowRight className="size-4 text-slate-400" aria-hidden />
            <span className="rounded-lg bg-brand-50 px-3 py-1.5 font-medium text-brand-800">
              {name(t.toWarehouseId)}
            </span>
            {t.shippedAt ? <span className="text-slate-500">ส่งเมื่อ {formatDate(t.shippedAt)}</span> : null}
            {t.receivedAt ? (
              <span className="text-slate-500">รับล่าสุด {formatDate(t.receivedAt)}</span>
            ) : null}
          </div>
        </Card>
        <ErrorBox error={error} />
        <Card title="รายการ" tint={step !== null}>
          <Table
            head={[
              'SKU',
              'สินค้า',
              'ขอ',
              'อนุมัติ',
              'ส่ง',
              'รับแล้ว',
              'ชำรุด',
              'ระหว่างทาง',
              ...(step ? [stepColumn[step]] : []),
              ...(step === 'receive' ? ['ชำรุด (ครั้งนี้)'] : []),
            ]}
          >
            {t.items.map((i) => (
              <tr key={i.id}>
                <Td className="font-mono">{i.sku}</Td>
                <Td>{i.variantName}</Td>
                <Td className="tabular-nums">{qty(i.requestedQty)}</Td>
                <Td className="tabular-nums">{qty(i.approvedQty)}</Td>
                <Td className="tabular-nums">{qty(i.shippedQty)}</Td>
                <Td className="tabular-nums">{qty(i.receivedQty)}</Td>
                <Td className="tabular-nums">{qty(i.damagedQty)}</Td>
                <Td className={`tabular-nums ${Number(i.inTransitQty) > 0 ? 'text-amber-700' : ''}`}>
                  {qty(i.inTransitQty)}
                </Td>
                {step ? (
                  <Td>
                    <Input
                      inputMode="decimal"
                      className="w-24"
                      value={qtys[i.id] ?? defaultQty(i)}
                      onChange={(e) => setQtys({ ...qtys, [i.id]: e.target.value })}
                    />
                  </Td>
                ) : null}
                {step === 'receive' ? (
                  <Td>
                    <Input
                      inputMode="decimal"
                      className="w-24"
                      value={damaged[i.id] ?? '0'}
                      onChange={(e) => setDamaged({ ...damaged, [i.id]: e.target.value })}
                    />
                  </Td>
                ) : null}
              </tr>
            ))}
          </Table>
          {step ? (
            <div className="mt-4 flex justify-end">
              <Button variant="success" busy={busy !== null} onClick={doStep}>
                {stepLabel[step]}
              </Button>
            </div>
          ) : null}
        </Card>
      </div>
      {confirm ? (
        <ConfirmDialog
          open
          onClose={() => setConfirm(null)}
          onConfirm={() => void post(confirm, {}, ifMatch(t.version))}
          tone={confirm === 'cancel' ? 'danger' : 'warning'}
          title={confirm === 'cancel' ? 'ยกเลิกการโอน?' : 'ปิดงานโอน?'}
          description={
            confirm === 'cancel'
              ? 'สต็อกที่กันไว้ที่คลังต้นทางจะถูกคืน'
              : 'ของที่ยังอยู่ระหว่างทาง (ไม่ได้รับ) จะถูกบันทึกเป็นสูญหายระหว่างขนส่ง'
          }
          actionLabel="ยืนยัน"
          busy={busy !== null}
        />
      ) : null}
    </>
  );
}
