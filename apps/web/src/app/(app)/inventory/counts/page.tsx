'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Plus } from 'lucide-react';
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
import type { CountType, StockCount, Warehouse } from '@/lib/client/types';
import { can } from '@/lib/client/types';
import { useResource } from '@/lib/client/use-resource';
import { COUNT_STATUS, COUNT_TYPE } from '@/lib/client/warehouse-labels';

export default function CountsPage() {
  const { me } = useMe();
  const counts = useResource<StockCount[]>('/inventory/counts');
  const { data: warehouses } = useResource<Warehouse[]>('/warehouses');
  const [open, setOpen] = useState(false);
  const name = (id: string) => warehouses?.find((w) => w.id === id)?.name ?? '—';

  return (
    <>
      <PageHeader
        breadcrumb={[{ label: 'คลังสินค้า', href: '/inventory/stock' }, { label: 'นับสต็อก' }]}
        title="นับสต็อก"
        description="นับได้ระหว่างเปิดขาย — ระบบหักยอดที่ขาย/รับเข้าระหว่างนับให้เอง หลายเครื่องสแกนพร้อมกันได้"
        actions={
          can(me, 'inventory.count') ? (
            <Button onClick={() => setOpen(true)}>
              <Plus className="size-4" aria-hidden />
              เริ่มรอบนับ
            </Button>
          ) : undefined
        }
      />
      <ErrorBox error={counts.error} />
      <Card title="รอบนับ">
        <Table
          head={['เลขที่', 'คลัง', 'ประเภท', 'ความคืบหน้า', 'มีส่วนต่าง', 'สถานะ', 'เริ่มเมื่อ']}
          empty={counts.data?.length === 0}
        >
          {counts.data?.map((c) => (
            <tr key={c.id} className="hover:bg-slate-50">
              <Td className="font-mono">
                <Link href={`/inventory/counts/${c.id}`} className="text-brand-700 hover:underline">
                  {c.docNo}
                </Link>
              </Td>
              <Td>{name(c.warehouseId)}</Td>
              <Td>{COUNT_TYPE[c.countType]}</Td>
              <Td className="tabular-nums">
                {c.totals.counted}/{c.totals.items}
              </Td>
              <Td className="tabular-nums">{c.totals.withVariance || '—'}</Td>
              <Td>
                <Badge tone={COUNT_STATUS[c.status].tone}>{COUNT_STATUS[c.status].label}</Badge>
              </Td>
              <Td className="text-slate-600">{formatDate(c.createdAt)}</Td>
            </tr>
          ))}
        </Table>
      </Card>
      {open ? <CreateCountModal warehouses={warehouses ?? []} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function CreateCountModal({ warehouses, onClose }: { warehouses: Warehouse[]; onClose: () => void }) {
  const router = useRouter();
  const [warehouseId, setWarehouseId] = useState(warehouses[0]?.id ?? '');
  const [countType, setCountType] = useState<CountType>('FULL');
  const [skus, setSkus] = useState('');
  const [tolerance, setTolerance] = useState('0');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const needsScope = countType === 'CYCLE' || countType === 'SPOT';

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const list = skus
        .split(/[\s,]+/)
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);
      const variantIds = await Promise.all(
        list.map(
          async (sku) => (await api<{ id: string }>(`/variants/lookup?sku=${encodeURIComponent(sku)}`)).id,
        ),
      );
      const created = await api<StockCount>('/inventory/counts', {
        method: 'POST',
        body: {
          warehouseId,
          countType,
          varianceTolerance: tolerance || '0',
          ...(variantIds.length ? { variantIds } : {}),
        },
      });
      router.push(`/inventory/counts/${created.id}`);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal open title="เริ่มรอบนับสต็อก" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="คลัง">
          <Select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="ประเภทการนับ">
          <Select value={countType} onChange={(e) => setCountType(e.target.value as CountType)}>
            {Object.entries(COUNT_TYPE).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label={needsScope ? 'SKU ที่จะนับ *' : 'SKU ที่จะนับ (เว้นว่าง = ทุกรายการ)'}
          hint="คั่นด้วยเว้นวรรค ขึ้นบรรทัด หรือจุลภาค"
        >
          <textarea
            className="min-h-20 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            value={skus}
            onChange={(e) => setSkus(e.target.value)}
            required={needsScope}
          />
        </Field>
        <Field label="ส่วนต่างที่ยอมรับได้ (ชิ้น)" hint="เกินจากนี้ระบบจะให้นับซ้ำ">
          <Input inputMode="decimal" value={tolerance} onChange={(e) => setTolerance(e.target.value)} />
        </Field>
        <ErrorBox error={error} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            ยกเลิก
          </Button>
          <Button type="submit" busy={busy}>
            เริ่มนับ
          </Button>
        </div>
      </form>
    </Modal>
  );
}
