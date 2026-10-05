'use client';

import { useState, type FormEvent } from 'react';
import { useMe } from '@/components/shell';
import { Badge, Button, Card, ErrorBox, Field, Input, PageHeader, Select, Table, Td } from '@/components/ui';
import { api } from '@/lib/client/api';
import type {
  LocationDiscrepancy,
  LocationLevel,
  LocationStock,
  Warehouse,
  WarehouseLocation,
} from '@/lib/client/types';
import { can } from '@/lib/client/types';
import { useResource } from '@/lib/client/use-resource';
import { LOCATION_LEVEL, qty } from '@/lib/client/warehouse-labels';

const CHILD: Record<LocationLevel, LocationLevel | null> = {
  ZONE: 'RACK',
  RACK: 'SHELF',
  SHELF: 'BIN',
  BIN: null,
};
const DEPTH: Record<LocationLevel, number> = { ZONE: 0, RACK: 1, SHELF: 2, BIN: 3 };

export default function LocationsPage() {
  const { me } = useMe();
  const { data: warehouses } = useResource<Warehouse[]>('/warehouses');
  const [warehouseId, setWarehouseId] = useState('');
  const wid = warehouseId || warehouses?.[0]?.id || '';
  const locations = useResource<WarehouseLocation[]>(wid ? `/warehouses/${wid}/locations` : null);
  const stock = useResource<LocationStock[]>(wid ? `/warehouses/${wid}/locations/stock` : null);
  const disc = useResource<LocationDiscrepancy[]>(wid ? `/warehouses/${wid}/locations/discrepancies` : null);
  const reloadAll = async () => {
    await Promise.all([locations.reload(), stock.reload(), disc.reload()]);
  };

  return (
    <>
      <PageHeader
        breadcrumb={[{ label: 'คลังสินค้า', href: '/inventory/stock' }, { label: 'ตำแหน่งจัดเก็บ' }]}
        title="ตำแหน่งจัดเก็บ (Bin)"
        description="โซน → ชั้นวาง → ชั้น → ช่อง: จัดเก็บสินค้าเข้าช่อง ย้ายช่อง และดูว่าควรหยิบจากช่องไหน"
        actions={
          <Select value={wid} onChange={(e) => setWarehouseId(e.target.value)} className="w-56">
            {warehouses?.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </Select>
        }
      />
      <ErrorBox error={locations.error ?? stock.error} />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
        <div className="space-y-6">
          <Card title="โครงสร้างตำแหน่ง">
            {locations.data?.length === 0 ? (
              <p className="py-4 text-sm text-slate-500">ยังไม่มีตำแหน่ง — เริ่มจากสร้างโซน</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {locations.data?.map((l) => (
                  <li
                    key={l.id}
                    className="flex items-center justify-between rounded-lg px-2 py-1 hover:bg-slate-50"
                    style={{ paddingLeft: `${DEPTH[l.level] * 1.25 + 0.5}rem` }}
                  >
                    <span>
                      <span className="font-mono">{l.fullCode}</span>{' '}
                      <span className="text-xs text-slate-500">{LOCATION_LEVEL[l.level]}</span>
                    </span>
                    <span className="flex gap-1">
                      {!l.isPickable ? <Badge tone="slate">ไม่ใช้หยิบ</Badge> : null}
                      {!l.isActive ? <Badge tone="red">ปิดใช้</Badge> : null}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          {can(me, 'warehouse.manage') && wid ? (
            <CreateLocation warehouseId={wid} locations={locations.data ?? []} onCreated={locations.reload} />
          ) : null}
        </div>
        <div className="space-y-6">
          {can(me, 'inventory.transfer') && wid ? (
            <MoveStock warehouseId={wid} locations={locations.data ?? []} onMoved={reloadAll} />
          ) : null}
          <Card title="สต็อกในแต่ละตำแหน่ง">
            <Table head={['ตำแหน่ง', 'SKU', 'สินค้า', 'คงเหลือ']} empty={stock.data?.length === 0}>
              {stock.data?.map((s) => (
                <tr key={`${s.locationId}:${s.variantId}`}>
                  <Td className="font-mono">{s.fullCode}</Td>
                  <Td className="font-mono">{s.sku}</Td>
                  <Td>{s.variantName}</Td>
                  <Td className="tabular-nums">{qty(s.onHand)}</Td>
                </tr>
              ))}
            </Table>
          </Card>
          <Card title="สินค้าที่ยังไม่ได้จัดเก็บเข้าช่อง / ยอดไม่ตรง">
            <Table head={['SKU', 'สต็อกคลัง', 'อยู่ในช่อง', 'ยังไม่จัดเก็บ']} empty={disc.data?.length === 0}>
              {disc.data?.map((d) => (
                <tr key={d.variantId}>
                  <Td className="font-mono">{d.sku}</Td>
                  <Td className="tabular-nums">{qty(d.warehouseOnHand)}</Td>
                  <Td className="tabular-nums">{qty(d.locatedOnHand)}</Td>
                  <Td
                    className={`tabular-nums ${Number(d.unlocated) < 0 ? 'text-red-700' : 'text-amber-700'}`}
                  >
                    {qty(d.unlocated)}
                  </Td>
                </tr>
              ))}
            </Table>
          </Card>
        </div>
      </div>
    </>
  );
}

function CreateLocation({
  warehouseId,
  locations,
  onCreated,
}: {
  warehouseId: string;
  locations: WarehouseLocation[];
  onCreated: () => Promise<void>;
}) {
  const [parentId, setParentId] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const parent = locations.find((l) => l.id === parentId);
  const level: LocationLevel | null = parent ? CHILD[parent.level] : 'ZONE';

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!level) return;
    setBusy(true);
    setError(undefined);
    try {
      await api(`/warehouses/${warehouseId}/locations`, {
        method: 'POST',
        body: { level, code, ...(parentId ? { parentId } : {}) },
      });
      setCode('');
      await onCreated();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="เพิ่มตำแหน่ง">
      <form onSubmit={submit} className="space-y-3">
        <Field label="อยู่ภายใต้">
          <Select value={parentId} onChange={(e) => setParentId(e.target.value)}>
            <option value="">— ระดับบนสุด (โซน) —</option>
            {locations
              .filter((l) => l.level !== 'BIN' && l.isActive)
              .map((l) => (
                <option key={l.id} value={l.id}>
                  {l.fullCode} ({LOCATION_LEVEL[l.level]})
                </option>
              ))}
          </Select>
        </Field>
        <Field label={`รหัส${level ? LOCATION_LEVEL[level] : ''}`} hint="เช่น A, 01, 03">
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            required
            maxLength={20}
          />
        </Field>
        <ErrorBox error={error} />
        <Button type="submit" busy={busy}>
          เพิ่ม{level ? LOCATION_LEVEL[level] : ''}
        </Button>
      </form>
    </Card>
  );
}

function MoveStock({
  warehouseId,
  locations,
  onMoved,
}: {
  warehouseId: string;
  locations: WarehouseLocation[];
  onMoved: () => Promise<void>;
}) {
  const [sku, setSku] = useState('');
  const [quantity, setQuantity] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [suggest, setSuggest] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const active = locations.filter((l) => l.isActive);

  async function variantId() {
    return (await api<{ id: string }>(`/variants/lookup?sku=${encodeURIComponent(sku)}`)).id;
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api(`/warehouses/${warehouseId}/locations/moves`, {
        method: 'POST',
        body: {
          lines: [
            {
              variantId: await variantId(),
              quantity,
              ...(from ? { fromLocationId: from } : {}),
              ...(to ? { toLocationId: to } : {}),
            },
          ],
        },
      });
      setQuantity('');
      setSuggest(null);
      await onMoved();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function pickPlan() {
    setError(undefined);
    try {
      const res = await api<{ suggestions: { fullCode: string; quantity: string }[]; shortfall: string }>(
        `/warehouses/${warehouseId}/locations/pick-suggestions?variantId=${await variantId()}&quantity=${encodeURIComponent(quantity || '1')}`,
      );
      setSuggest(
        res.suggestions.length === 0
          ? 'ไม่มีในช่องใดเลย'
          : res.suggestions.map((s) => `${s.fullCode} × ${qty(s.quantity)}`).join(', ') +
              (Number(res.shortfall) > 0 ? ` (ขาด ${qty(res.shortfall)})` : ''),
      );
    } catch (err) {
      setError(err);
    }
  }

  const mode = from && to ? 'ย้ายช่อง' : to ? 'จัดเก็บเข้าช่อง' : from ? 'หยิบออกจากช่อง' : 'เลือกตำแหน่ง';
  return (
    <Card title="จัดเก็บ / ย้าย / หยิบ" tint>
      <form onSubmit={submit} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="SKU">
            <Input value={sku} onChange={(e) => setSku(e.target.value.toUpperCase())} required />
          </Field>
          <Field label="จำนวน">
            <Input
              inputMode="decimal"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              required
            />
          </Field>
          <Field label="จากช่อง">
            <Select value={from} onChange={(e) => setFrom(e.target.value)}>
              <option value="">— ของที่ยังไม่จัดเก็บ —</option>
              {active.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.fullCode}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="ไปช่อง">
            <Select value={to} onChange={(e) => setTo(e.target.value)}>
              <option value="">— ออกจากคลัง (หยิบ) —</option>
              {active.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.fullCode}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {suggest ? <p className="text-sm text-slate-700">แนะนำให้หยิบจาก: {suggest}</p> : null}
        <ErrorBox error={error} />
        <div className="flex gap-2">
          <Button type="submit" busy={busy} disabled={!from && !to}>
            {mode}
          </Button>
          <Button variant="secondary" disabled={!sku} onClick={() => void pickPlan()}>
            แนะนำช่องที่ควรหยิบ
          </Button>
        </div>
      </form>
    </Card>
  );
}
