'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { Plus, Trash2 } from 'lucide-react';
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
import type { Purchase, Supplier, Warehouse } from '@/lib/client/types';
import { can } from '@/lib/client/types';
import { useResource } from '@/lib/client/use-resource';
import { PURCHASE_STATUS, baht } from '@/lib/client/warehouse-labels';

export default function PurchasesPage() {
  const { me } = useMe();
  const [status, setStatus] = useState('');
  const purchases = useResource<Purchase[]>(`/purchases${status ? `?status=${status}` : ''}`);
  const [open, setOpen] = useState(false);

  return (
    <>
      <PageHeader
        breadcrumb={[{ label: 'คลังสินค้า', href: '/inventory/stock' }, { label: 'ใบสั่งซื้อ' }]}
        title="ใบสั่งซื้อ (PO)"
        description="สั่งซื้อจากผู้จัดจำหน่าย → อนุมัติ → รับของ (รับบางส่วนได้) ต้นทุนเฉลี่ยอัปเดตอัตโนมัติ"
        actions={
          can(me, 'purchase.create') ? (
            <Button onClick={() => setOpen(true)}>
              <Plus className="size-4" aria-hidden />
              สร้างใบสั่งซื้อ
            </Button>
          ) : undefined
        }
      />
      <ErrorBox error={purchases.error} />
      <Card
        actions={
          <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-48">
            <option value="">ทุกสถานะ</option>
            {Object.entries(PURCHASE_STATUS).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </Select>
        }
        title="รายการใบสั่งซื้อ"
      >
        <Table
          head={['เลขที่', 'ผู้จัดจำหน่าย', 'กำหนดส่ง', 'รายการ', 'ยอดรวม', 'สถานะ', 'สร้างเมื่อ']}
          empty={purchases.data?.length === 0}
        >
          {purchases.data?.map((p) => (
            <tr key={p.id} className="hover:bg-slate-50">
              <Td className="font-mono">
                <Link href={`/inventory/purchases/${p.id}`} className="text-brand-700 hover:underline">
                  {p.docNo}
                </Link>
              </Td>
              <Td>{p.supplierName}</Td>
              <Td>{p.expectedAt ?? '—'}</Td>
              <Td>{p.items.length}</Td>
              <Td className="tabular-nums">{baht(p.grandTotal)}</Td>
              <Td>
                <Badge tone={PURCHASE_STATUS[p.status].tone}>{PURCHASE_STATUS[p.status].label}</Badge>
              </Td>
              <Td className="text-slate-600">{formatDate(p.createdAt)}</Td>
            </tr>
          ))}
        </Table>
      </Card>
      {open ? <CreatePurchaseModal onClose={() => setOpen(false)} onCreated={purchases.reload} /> : null}
    </>
  );
}

interface Line {
  sku: string;
  orderedQty: string;
  unitCost: string;
}

function CreatePurchaseModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const { data: suppliers } = useResource<Supplier[]>('/suppliers');
  const { data: warehouses } = useResource<Warehouse[]>('/warehouses');
  const [supplierId, setSupplierId] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [expectedAt, setExpectedAt] = useState('');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<Line[]>([{ sku: '', orderedQty: '', unitCost: '' }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  const activeSuppliers = suppliers?.filter((s) => s.isActive) ?? [];
  const setLine = (i: number, patch: Partial<Line>) =>
    setLines(lines.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const items = await Promise.all(
        lines
          .filter((l) => l.sku && l.orderedQty)
          .map(async (l) => ({
            variantId: (await api<{ id: string }>(`/variants/lookup?sku=${encodeURIComponent(l.sku)}`)).id,
            orderedQty: l.orderedQty,
            unitCost: l.unitCost || '0',
          })),
      );
      await api('/purchases', {
        method: 'POST',
        body: {
          supplierId: supplierId || activeSuppliers[0]?.id,
          warehouseId: warehouseId || warehouses?.[0]?.id,
          ...(expectedAt ? { expectedAt } : {}),
          ...(note ? { note } : {}),
          items,
        },
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
    <Modal open title="สร้างใบสั่งซื้อ" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="ผู้จัดจำหน่าย *">
            <Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} required>
              <option value="">— เลือก —</option>
              {activeSuppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="รับเข้าคลัง *">
            <Select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} required>
              <option value="">— เลือก —</option>
              {warehouses?.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="กำหนดส่ง">
            <Input type="date" value={expectedAt} onChange={(e) => setExpectedAt(e.target.value)} />
          </Field>
          <Field label="หมายเหตุ">
            <Input value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </div>
        <div className="space-y-2">
          <p className="text-sm font-medium text-slate-700">รายการสินค้า (ราคาต่อหน่วย ก่อน VAT)</p>
          {lines.map((l, i) => (
            <div key={i} className="flex gap-2">
              <Input
                placeholder="SKU"
                value={l.sku}
                onChange={(e) => setLine(i, { sku: e.target.value.toUpperCase() })}
              />
              <Input
                placeholder="จำนวน"
                inputMode="decimal"
                value={l.orderedQty}
                onChange={(e) => setLine(i, { orderedQty: e.target.value })}
                className="w-28"
              />
              <Input
                placeholder="ราคา/หน่วย"
                inputMode="decimal"
                value={l.unitCost}
                onChange={(e) => setLine(i, { unitCost: e.target.value })}
                className="w-32"
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
          <Button
            variant="secondary"
            onClick={() => setLines([...lines, { sku: '', orderedQty: '', unitCost: '' }])}
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
            บันทึกแบบร่าง
          </Button>
        </div>
      </form>
    </Modal>
  );
}
