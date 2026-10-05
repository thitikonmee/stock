'use client';

import { useParams } from 'next/navigation';
import { useMemo, useRef, useState, type FormEvent } from 'react';
import { ScanLine } from 'lucide-react';
import { useMe } from '@/components/shell';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  ErrorBox,
  Input,
  Loading,
  Notice,
  PageHeader,
  Select,
  Table,
  Td,
  formatDate,
} from '@/components/ui';
import { api } from '@/lib/client/api';
import type { CountItem, StockCount, Warehouse } from '@/lib/client/types';
import { can } from '@/lib/client/types';
import { useResource } from '@/lib/client/use-resource';
import { COUNT_STATUS, COUNT_TYPE, ifMatch, qty } from '@/lib/client/warehouse-labels';

type Filter = 'all' | 'uncounted' | 'counted' | 'variance';
const PAGE = 200;

export default function CountDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { me } = useMe();
  const count = useResource<StockCount>(`/inventory/counts/${id}`);
  const { data: warehouses } = useResource<Warehouse[]>('/warehouses');
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [scan, setScan] = useState('');
  const [log, setLog] = useState<string[]>([]);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'approve' | 'cancel' | null>(null);
  const [error, setError] = useState<unknown>();
  const scanRef = useRef<HTMLInputElement>(null);

  const items = useMemo(() => count.data?.items ?? [], [count.data]);
  const visible = useMemo(() => {
    const q = search.trim().toUpperCase();
    return items.filter((i) => {
      if (q && !i.sku.includes(q) && !i.variantName.toUpperCase().includes(q)) return false;
      if (filter === 'uncounted') return i.countedQty === null;
      if (filter === 'counted') return i.countedQty !== null;
      if (filter === 'variance') return i.variance !== null && Number(i.variance) !== 0;
      return true;
    });
  }, [items, filter, search]);

  if (!count.data) return count.error ? <ErrorBox error={count.error} /> : <Loading />;
  const c = count.data;
  const counting = c.status === 'IN_PROGRESS' && can(me, 'inventory.count');
  const st = COUNT_STATUS[c.status];

  async function record(lines: { variantId: string; quantity: string }[], mode: 'SET' | 'ADD') {
    await api(`/inventory/counts/${c.id}/lines`, { method: 'POST', body: { mode, lines } });
  }

  async function onScan(e: FormEvent) {
    e.preventDefault();
    const code = scan.trim();
    setScan('');
    scanRef.current?.focus();
    if (!code) return;
    try {
      const v = await api<{ id: string; sku: string }>(
        `/variants/lookup?barcode=${encodeURIComponent(code)}`,
      ).catch(() =>
        api<{ id: string; sku: string }>(`/variants/lookup?sku=${encodeURIComponent(code.toUpperCase())}`),
      );
      await record([{ variantId: v.id, quantity: '1' }], 'ADD');
      setLog((l) => [`+1 ${v.sku}`, ...l].slice(0, 6));
      await count.reload();
    } catch (err) {
      setLog((l) => [`✕ ${code}: ${err instanceof Error ? err.message : 'ไม่พบ'}`, ...l].slice(0, 6));
    }
  }

  async function saveEdits() {
    setBusy('save');
    setError(undefined);
    try {
      const lines = Object.entries(edits)
        .filter(([, q]) => q !== '')
        .map(([variantId, quantity]) => ({ variantId, quantity }));
      if (lines.length) await record(lines, 'SET');
      setEdits({});
      await count.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  async function act(action: 'submit' | 'approve' | 'recount' | 'cancel') {
    setBusy(action);
    setError(undefined);
    try {
      await api(`/inventory/counts/${c.id}/${action}`, {
        method: 'POST',
        headers: ifMatch(c.version),
        body: {},
      });
      setConfirm(null);
      await count.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  const dirty = Object.keys(edits).length > 0;
  const hidden = c.items?.some((i) => i.snapshotQty === null) ?? false;

  return (
    <>
      <PageHeader
        breadcrumb={[
          { label: 'คลังสินค้า', href: '/inventory/stock' },
          { label: 'นับสต็อก', href: '/inventory/counts' },
          { label: c.docNo },
        ]}
        title={
          <span className="flex items-center gap-3">
            {c.docNo}
            <Badge tone={st.tone}>{st.label}</Badge>
          </span>
        }
        description={`${warehouses?.find((w) => w.id === c.warehouseId)?.name ?? ''} · ${COUNT_TYPE[c.countType]} · เริ่ม ${formatDate(c.startedAt)}`}
        actions={
          <div className="flex flex-wrap gap-2">
            {counting ? (
              <Button
                busy={busy === 'submit'}
                disabled={dirty || c.totals.counted === 0}
                onClick={() => void act('submit')}
              >
                ส่งผลการนับ
              </Button>
            ) : null}
            {c.status === 'PENDING_APPROVAL' && can(me, 'inventory.count.approve') ? (
              <>
                {c.totals.recountRequired > 0 ? (
                  <Button variant="secondary" busy={busy === 'recount'} onClick={() => void act('recount')}>
                    ให้นับซ้ำ ({c.totals.recountRequired})
                  </Button>
                ) : null}
                {c.createdBy !== me?.membershipId ? (
                  <Button variant="success" onClick={() => setConfirm('approve')}>
                    อนุมัติและปรับสต็อก
                  </Button>
                ) : null}
              </>
            ) : null}
            {['IN_PROGRESS', 'PENDING_APPROVAL'].includes(c.status) && can(me, 'inventory.count') ? (
              <Button variant="danger" onClick={() => setConfirm('cancel')}>
                ยกเลิก
              </Button>
            ) : null}
          </div>
        }
      />
      <div className="space-y-6">
        <div className="grid gap-3 sm:grid-cols-4">
          <Stat label="รายการทั้งหมด" value={c.totals.items} />
          <Stat label="นับแล้ว" value={c.totals.counted} />
          <Stat
            label="มีส่วนต่าง"
            value={c.totals.withVariance}
            tone={c.totals.withVariance ? 'amber' : undefined}
          />
          <Stat
            label="ต้องนับซ้ำ"
            value={c.totals.recountRequired}
            tone={c.totals.recountRequired ? 'red' : undefined}
          />
        </div>
        <ErrorBox error={error} />
        {hidden ? <Notice tone="info">การนับแบบไม่เห็นยอด: ไม่แสดงยอดในระบบระหว่างนับ</Notice> : null}

        {counting ? (
          <Card title="สแกนนับ" tint>
            <form onSubmit={onScan} className="flex gap-2">
              <Input
                ref={scanRef}
                icon={<ScanLine className="size-4" />}
                placeholder="สแกนบาร์โค้ด (ทีละชิ้น +1) หรือพิมพ์ SKU แล้วกด Enter"
                value={scan}
                onChange={(e) => setScan(e.target.value)}
                autoFocus
                autoComplete="off"
              />
              <Button type="submit">+1</Button>
            </form>
            {log.length ? (
              <ul className="mt-3 space-y-0.5 font-mono text-xs text-slate-600">
                {log.map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ul>
            ) : null}
          </Card>
        ) : null}

        <Card
          title="รายการนับ"
          actions={
            <div className="flex gap-2">
              <Input
                placeholder="ค้นหา SKU/ชื่อ"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-44"
              />
              <Select value={filter} onChange={(e) => setFilter(e.target.value as Filter)} className="w-36">
                <option value="all">ทั้งหมด</option>
                <option value="uncounted">ยังไม่นับ</option>
                <option value="counted">นับแล้ว</option>
                <option value="variance">มีส่วนต่าง</option>
              </Select>
            </div>
          }
        >
          <Table head={['SKU', 'สินค้า', 'ยอดตอนเริ่ม', 'เคลื่อนไหวระหว่างนับ', 'นับได้', 'ส่วนต่าง', '']}>
            {visible.slice(0, PAGE).map((i) => (
              <Row
                key={i.id}
                item={i}
                editable={counting}
                value={edits[i.variantId]}
                onChange={(v) => setEdits({ ...edits, [i.variantId]: v })}
              />
            ))}
          </Table>
          {visible.length > PAGE ? (
            <p className="mt-3 text-sm text-slate-500">
              แสดง {PAGE} จาก {visible.length} รายการ — ใช้ช่องค้นหาเพื่อหารายการอื่น
            </p>
          ) : null}
          {counting && dirty ? (
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setEdits({})}>
                ล้าง
              </Button>
              <Button busy={busy === 'save'} onClick={() => void saveEdits()}>
                บันทึกยอดนับ ({Object.keys(edits).length})
              </Button>
            </div>
          ) : null}
        </Card>
      </div>
      {confirm ? (
        <ConfirmDialog
          open
          onClose={() => setConfirm(null)}
          onConfirm={() => void act(confirm)}
          tone={confirm === 'cancel' ? 'danger' : 'success'}
          title={confirm === 'cancel' ? 'ยกเลิกรอบนับ?' : 'อนุมัติผลการนับ?'}
          description={
            confirm === 'cancel'
              ? 'ผลการนับจะไม่ถูกนำไปปรับสต็อก'
              : `ส่วนต่าง ${c.totals.withVariance} รายการจะถูกปรับเข้าสต็อก (บันทึกเป็นใบปรับสต็อก)`
          }
          actionLabel="ยืนยัน"
          busy={busy === confirm}
        />
      ) : null}
    </>
  );
}

function Row({
  item: i,
  editable,
  value,
  onChange,
}: {
  item: CountItem;
  editable: boolean;
  value: string | undefined;
  onChange: (v: string) => void;
}) {
  const variance = i.variance === null ? null : Number(i.variance);
  return (
    <tr className={i.recountRequired ? 'bg-red-50/60' : undefined}>
      <Td className="font-mono">{i.sku}</Td>
      <Td>{i.variantName}</Td>
      <Td className="tabular-nums">{qty(i.snapshotQty)}</Td>
      <Td className="tabular-nums text-slate-500">
        {i.movementSinceSnapshot === null ? '—' : qty(i.movementSinceSnapshot)}
      </Td>
      <Td>
        {editable ? (
          <Input
            inputMode="decimal"
            className="w-24"
            placeholder={i.countedQty === null ? '—' : undefined}
            value={value ?? (i.countedQty === null ? '' : String(Number(i.countedQty)))}
            onChange={(e) => onChange(e.target.value)}
          />
        ) : (
          <span className="tabular-nums">{qty(i.countedQty)}</span>
        )}
      </Td>
      <Td
        className={`tabular-nums font-medium ${
          variance === null || variance === 0
            ? 'text-slate-500'
            : variance < 0
              ? 'text-red-700'
              : 'text-emerald-700'
        }`}
      >
        {variance === null ? '—' : variance > 0 ? `+${qty(i.variance)}` : qty(i.variance)}
      </Td>
      <Td>{i.recountRequired ? <Badge tone="red">นับซ้ำ</Badge> : null}</Td>
    </tr>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'amber' | 'red' }) {
  const color = tone === 'red' ? 'text-red-700' : tone === 'amber' ? 'text-amber-700' : 'text-slate-900';
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
      <p className="text-xs text-slate-500">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${color}`}>{value.toLocaleString('th-TH')}</p>
    </div>
  );
}
