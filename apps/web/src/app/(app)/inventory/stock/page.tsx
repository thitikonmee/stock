'use client';

import { useEffect, useState, type FormEvent } from 'react';
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
import type { LedgerLine, StockBalancePage, Warehouse } from '@/lib/client/types';
import { useResource } from '@/lib/client/use-resource';

export default function StockOverviewPage() {
  const { data: warehouses } = useResource<Warehouse[]>('/warehouses');
  const [warehouseId, setWarehouseId] = useState('');
  const [lowStockOnly, setLowStockOnly] = useState(false);
  const [balances, setBalances] = useState<StockBalancePage['data']>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>();
  const [cardVariant, setCardVariant] = useState<{ variantId: string; sku: string } | null>(null);
  const [receiveOpen, setReceiveOpen] = useState(false);

  useEffect(() => {
    if (warehouses && warehouses.length > 0 && !warehouseId) setWarehouseId(warehouses[0]!.id);
  }, [warehouses, warehouseId]);

  async function load() {
    setLoading(true);
    setError(undefined);
    try {
      const params = new URLSearchParams({ limit: '100' });
      if (warehouseId) params.set('warehouseId', warehouseId);
      if (lowStockOnly) params.set('lowStock', 'true');
      const res = await api<StockBalancePage>(`/inventory/balances?${params.toString()}`);
      setBalances(res.data);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (warehouseId) void load();
    // `load` reads warehouseId/lowStockOnly from closure; both are already in the dep array.
  }, [warehouseId, lowStockOnly]);

  return (
    <>
      <PageHeader
        title="สต็อกสินค้า"
        description="ยอดคงเหลือแยกตามคลัง — คลิกแถวเพื่อดูการ์ดสต็อก (stock card)"
        actions={<Button onClick={() => setReceiveOpen(true)}>รับสต็อกเข้า</Button>}
      />
      <div className="mb-4 flex flex-wrap items-end gap-4">
        <Field label="คลัง">
          <Select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
            {warehouses?.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </Select>
        </Field>
        <label className="flex items-center gap-2 pb-2 text-sm">
          <input type="checkbox" checked={lowStockOnly} onChange={(e) => setLowStockOnly(e.target.checked)} />
          แสดงเฉพาะสต็อกต่ำ
        </label>
      </div>
      <ErrorBox error={error} />
      <Card>
        <Table
          head={['SKU', 'ชื่อ', 'คงเหลือ', 'จอง', 'ยืนยันแล้ว', 'ชำรุด', 'พร้อมขาย', '']}
          empty={!loading && balances.length === 0}
        >
          {balances.map((b) => {
            const low = b.lowStockThreshold != null && Number(b.available) <= Number(b.lowStockThreshold);
            return (
              <tr key={`${b.warehouseId}:${b.variantId}`}>
                <Td className="font-mono">{b.sku}</Td>
                <Td>{b.variantName}</Td>
                <Td>{b.onHand}</Td>
                <Td>{b.reserved}</Td>
                <Td>{b.committed}</Td>
                <Td>{b.damaged}</Td>
                <Td>
                  <span className="mr-2">{b.available}</span>
                  {low ? <Badge tone="red">สต็อกต่ำ</Badge> : null}
                </Td>
                <Td className="text-right">
                  <Button
                    variant="secondary"
                    onClick={() => setCardVariant({ variantId: b.variantId, sku: b.sku })}
                  >
                    การ์ดสต็อก
                  </Button>
                </Td>
              </tr>
            );
          })}
        </Table>
        {loading ? <Loading /> : null}
      </Card>

      {cardVariant ? (
        <StockCardModal
          variantId={cardVariant.variantId}
          sku={cardVariant.sku}
          warehouseId={warehouseId}
          onClose={() => setCardVariant(null)}
        />
      ) : null}
      {receiveOpen ? (
        <ReceiveModal
          warehouses={warehouses ?? []}
          defaultWarehouseId={warehouseId}
          onClose={() => setReceiveOpen(false)}
          onReceived={load}
        />
      ) : null}
    </>
  );
}

function StockCardModal({
  variantId,
  sku,
  warehouseId,
  onClose,
}: {
  variantId: string;
  sku: string;
  warehouseId: string;
  onClose: () => void;
}) {
  const [lines, setLines] = useState<LedgerLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>();

  useEffect(() => {
    void (async () => {
      try {
        const res = await api<{ data: LedgerLine[] }>(
          `/inventory/transactions?variantId=${variantId}&warehouseId=${warehouseId}&limit=100`,
        );
        setLines(res.data);
      } catch (err) {
        setError(err);
      } finally {
        setLoading(false);
      }
    })();
  }, [variantId, warehouseId]);

  return (
    <Modal open title={`การ์ดสต็อก — ${sku}`} onClose={onClose}>
      <ErrorBox error={error} />
      {loading ? (
        <Loading />
      ) : (
        <div className="max-h-96 overflow-y-auto">
          <Table
            head={['เวลา', 'ประเภท', 'บัคเก็ต', 'จำนวน', 'ก่อน → หลัง', 'อ้างอิง']}
            empty={lines.length === 0}
          >
            {lines.map((l) => (
              <tr key={l.id}>
                <Td className="whitespace-nowrap text-slate-600">{formatDate(l.occurredAt)}</Td>
                <Td>{l.transactionType}</Td>
                <Td>{l.bucket}</Td>
                <Td className={Number(l.quantity) < 0 ? 'text-red-700' : 'text-emerald-700'}>{l.quantity}</Td>
                <Td className="text-slate-600">
                  {l.beforeQuantity} → {l.afterQuantity}
                </Td>
                <Td className="text-slate-500">{l.referenceType}</Td>
              </tr>
            ))}
          </Table>
        </div>
      )}
    </Modal>
  );
}

function ReceiveModal({
  warehouses,
  defaultWarehouseId,
  onClose,
  onReceived,
}: {
  warehouses: Warehouse[];
  defaultWarehouseId: string;
  onClose: () => void;
  onReceived: () => Promise<void>;
}) {
  const [form, setForm] = useState({ sku: '', warehouseId: defaultWarehouseId, quantity: '', unitCost: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const variant = await api<{ id: string }>(`/variants/lookup?sku=${encodeURIComponent(form.sku)}`);
      await api('/inventory/receive', {
        method: 'POST',
        headers: { 'idempotency-key': `web:receive:${variant.id}:${Date.now()}` },
        body: {
          lines: [
            {
              warehouseId: form.warehouseId,
              variantId: variant.id,
              quantity: form.quantity,
              ...(form.unitCost ? { unitCost: form.unitCost } : {}),
            },
          ],
        },
      });
      onClose();
      await onReceived();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open title="รับสต็อกเข้า" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="SKU">
          <Input
            value={form.sku}
            onChange={(e) => setForm({ ...form, sku: e.target.value.toUpperCase() })}
            required
          />
        </Field>
        <Field label="คลัง">
          <Select
            value={form.warehouseId}
            onChange={(e) => setForm({ ...form, warehouseId: e.target.value })}
            required
          >
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="จำนวน">
            <Input
              value={form.quantity}
              onChange={(e) => setForm({ ...form, quantity: e.target.value })}
              required
            />
          </Field>
          <Field label="ทุนต่อหน่วย (ถ้ามี)">
            <Input value={form.unitCost} onChange={(e) => setForm({ ...form, unitCost: e.target.value })} />
          </Field>
        </div>
        <ErrorBox error={error} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            ยกเลิก
          </Button>
          <Button type="submit" busy={busy}>
            รับเข้า
          </Button>
        </div>
      </form>
    </Modal>
  );
}
