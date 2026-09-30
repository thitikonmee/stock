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
  PageHeader,
  Select,
  Table,
  Td,
} from '@/components/ui';
import { api } from '@/lib/client/api';
import type { Adjustment, AdjustmentStatus, Warehouse } from '@/lib/client/types';
import { can } from '@/lib/client/types';
import { useResource } from '@/lib/client/use-resource';

const STATUS_TONE: Record<AdjustmentStatus, 'amber' | 'green' | 'red' | 'slate'> = {
  DRAFT: 'slate',
  PENDING_APPROVAL: 'amber',
  APPROVED: 'green',
  POSTED: 'green',
  REJECTED: 'red',
  CANCELLED: 'slate',
};
const STATUS_LABEL: Record<AdjustmentStatus, string> = {
  DRAFT: 'แบบร่าง',
  PENDING_APPROVAL: 'รออนุมัติ',
  APPROVED: 'อนุมัติแล้ว',
  POSTED: 'บันทึกแล้ว',
  REJECTED: 'ปฏิเสธ',
  CANCELLED: 'ยกเลิก',
};
const REASON_LABEL: Record<string, string> = {
  DAMAGE: 'ชำรุด',
  LOST: 'สูญหาย',
  FOUND: 'พบเพิ่ม',
  COUNT_ERROR: 'นับผิด',
  EXPIRED: 'หมดอายุ',
  OPENING: 'ยอดยกมา',
  OTHER: 'อื่นๆ',
};

export default function AdjustmentsPage() {
  const { me } = useMe();
  const adjustments = useResource<Adjustment[]>('/inventory/adjustments');
  const { data: warehouses } = useResource<Warehouse[]>('/warehouses');
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<unknown>();
  const [busyId, setBusyId] = useState<string | null>(null);

  async function act(id: string, action: 'approve' | 'reject') {
    setBusyId(id);
    setError(undefined);
    try {
      await api(`/inventory/adjustments/${id}/${action}`, { method: 'POST', body: {} });
      await adjustments.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusyId(null);
    }
  }

  const warehouseName = (id: string) => warehouses?.find((w) => w.id === id)?.name ?? id;

  return (
    <>
      <PageHeader
        breadcrumb={[{ label: 'คลังสินค้า', href: '/inventory/stock' }, { label: 'ปรับสต็อก' }]}
        title="ปรับสต็อก"
        description="ทุกรายการปรับสต็อกต้องได้รับอนุมัติจากคนอื่น (ไม่ใช่ผู้ขอ) ก่อนจึงจะมีผล"
        actions={
          can(me, 'inventory.adjust') ? <Button onClick={() => setOpen(true)}>ขอปรับสต็อก</Button> : undefined
        }
      />
      <ErrorBox error={error ?? adjustments.error} />
      <Card>
        <Table
          head={['เลขที่', 'คลัง', 'เหตุผล', 'จำนวนรายการ', 'สถานะ', 'หมายเหตุ', '']}
          empty={adjustments.data?.length === 0}
        >
          {adjustments.data?.map((a) => (
            <tr key={a.id}>
              <Td className="font-mono">{a.docNo}</Td>
              <Td>{warehouseName(a.warehouseId)}</Td>
              <Td>{REASON_LABEL[a.reasonCode] ?? a.reasonCode}</Td>
              <Td>{a.items.length}</Td>
              <Td>
                <Badge tone={STATUS_TONE[a.status]}>{STATUS_LABEL[a.status]}</Badge>
              </Td>
              <Td className="max-w-xs truncate text-slate-600">{a.note ?? '—'}</Td>
              <Td className="text-right">
                {a.status === 'PENDING_APPROVAL' && can(me, 'inventory.adjust.approve') ? (
                  <div className="flex justify-end gap-2">
                    <Button variant="danger" busy={busyId === a.id} onClick={() => void act(a.id, 'reject')}>
                      ปฏิเสธ
                    </Button>
                    <Button
                      variant="success"
                      busy={busyId === a.id}
                      onClick={() => void act(a.id, 'approve')}
                    >
                      อนุมัติ
                    </Button>
                  </div>
                ) : null}
              </Td>
            </tr>
          ))}
        </Table>
      </Card>

      {open ? (
        <CreateAdjustmentModal
          warehouses={warehouses ?? []}
          onClose={() => setOpen(false)}
          onCreated={adjustments.reload}
        />
      ) : null}
    </>
  );
}

interface ItemRow {
  sku: string;
  quantityDelta: string;
}

function CreateAdjustmentModal({
  warehouses,
  onClose,
  onCreated,
}: {
  warehouses: Warehouse[];
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const [warehouseId, setWarehouseId] = useState(warehouses[0]?.id ?? '');
  const [reasonCode, setReasonCode] = useState('FOUND');
  const [note, setNote] = useState('');
  const [items, setItems] = useState<ItemRow[]>([{ sku: '', quantityDelta: '' }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const resolved = await Promise.all(
        items
          .filter((i) => i.sku && i.quantityDelta)
          .map(async (i) => ({
            variantId: (await api<{ id: string }>(`/variants/lookup?sku=${encodeURIComponent(i.sku)}`)).id,
            quantityDelta: i.quantityDelta,
          })),
      );
      await api('/inventory/adjustments', {
        method: 'POST',
        body: { warehouseId, reasonCode, ...(note ? { note } : {}), items: resolved },
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
    <Modal open title="ขอปรับสต็อก" onClose={onClose}>
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
        <Field label="เหตุผล">
          <Select value={reasonCode} onChange={(e) => setReasonCode(e.target.value)}>
            {Object.entries(REASON_LABEL).map(([code, label]) => (
              <option key={code} value={code}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="หมายเหตุ">
          <Input value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <div className="space-y-2">
          <p className="text-sm font-medium text-slate-700">รายการ (จำนวน: ติดลบ = ลด, บวก = เพิ่ม)</p>
          {items.map((row, i) => (
            <div key={i} className="flex gap-2">
              <Input
                placeholder="SKU"
                value={row.sku}
                onChange={(e) =>
                  setItems(
                    items.map((r, idx) => (idx === i ? { ...r, sku: e.target.value.toUpperCase() } : r)),
                  )
                }
              />
              <Input
                placeholder="จำนวน เช่น -1 หรือ 5"
                value={row.quantityDelta}
                onChange={(e) =>
                  setItems(items.map((r, idx) => (idx === i ? { ...r, quantityDelta: e.target.value } : r)))
                }
              />
            </div>
          ))}
          <Button
            type="button"
            variant="secondary"
            onClick={() => setItems([...items, { sku: '', quantityDelta: '' }])}
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
            ส่งขออนุมัติ
          </Button>
        </div>
      </form>
    </Modal>
  );
}
