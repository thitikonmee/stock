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
  Select,
  Table,
  Td,
  formatDate,
} from '@/components/ui';
import { api } from '@/lib/client/api';
import type {
  ChannelAccount,
  ChannelAccountStatus,
  ChannelProductVariantRow,
  MappingStatus,
  ReconciliationItemRow,
  ReconciliationRunRow,
  StockPolicyRow,
  SyncJobRow,
  Warehouse,
  WebhookEventRow,
} from '@/lib/client/types';
import { can } from '@/lib/client/types';
import { useResource } from '@/lib/client/use-resource';

const STATUS_LABEL: Record<ChannelAccountStatus, string> = {
  CONNECTING: 'กำลังเชื่อมต่อ',
  CONNECTED: 'เชื่อมต่ออยู่',
  TOKEN_EXPIRED: 'โทเคนหมดอายุ',
  ERROR: 'มีข้อผิดพลาด',
  PAUSED: 'พักไว้',
  DISCONNECTED: 'ยกเลิกการเชื่อมต่อแล้ว',
};
const STATUS_TONE: Record<ChannelAccountStatus, 'slate' | 'amber' | 'green' | 'red' | 'teal'> = {
  CONNECTING: 'amber',
  CONNECTED: 'green',
  TOKEN_EXPIRED: 'amber',
  ERROR: 'red',
  PAUSED: 'amber',
  DISCONNECTED: 'slate',
};
const MAPPING_LABEL: Record<MappingStatus, string> = {
  UNMAPPED: 'ยังไม่ผูก SKU',
  AUTO_MAPPED: 'ผูกอัตโนมัติ',
  CONFIRMED: 'ยืนยันแล้ว',
  CONFLICT: 'ขัดแย้ง',
  BROKEN: 'เสีย',
};
const MAPPING_TONE: Record<MappingStatus, 'slate' | 'amber' | 'green' | 'red' | 'teal'> = {
  UNMAPPED: 'amber',
  AUTO_MAPPED: 'teal',
  CONFIRMED: 'green',
  CONFLICT: 'red',
  BROKEN: 'red',
};
const JOB_TYPE_LABEL: Record<SyncJobRow['jobType'], string> = {
  ORDER_PULL: 'ดึงออเดอร์',
  ORDER_DETAIL: 'รายละเอียดออเดอร์',
  PRODUCT_IMPORT: 'นำเข้าสินค้า',
  STOCK_PUSH: 'ส่งสต็อก',
  PRICE_PUSH: 'ส่งราคา',
  STATUS_PUSH: 'ส่งสถานะ',
  RECONCILE: 'ตรวจสอบสต็อก',
  TOKEN_REFRESH: 'ต่ออายุโทเคน',
};
const JOB_STATUS_LABEL: Record<SyncJobRow['status'], string> = {
  QUEUED: 'รอคิว',
  RUNNING: 'กำลังทำงาน',
  SUCCEEDED: 'สำเร็จ',
  FAILED: 'ล้มเหลว',
  DEAD: 'หยุดถาวร',
  CANCELLED: 'ยกเลิก',
};
const JOB_STATUS_TONE: Record<SyncJobRow['status'], 'slate' | 'amber' | 'green' | 'red' | 'teal'> = {
  QUEUED: 'slate',
  RUNNING: 'amber',
  SUCCEEDED: 'green',
  FAILED: 'red',
  DEAD: 'red',
  CANCELLED: 'slate',
};
const WEBHOOK_STATUS_LABEL: Record<WebhookEventRow['status'], string> = {
  RECEIVED: 'รับแล้ว',
  PROCESSING: 'กำลังประมวลผล',
  PROCESSED: 'ประมวลผลแล้ว',
  IGNORED: 'ข้าม',
  FAILED: 'ล้มเหลว',
  DEAD: 'หยุดถาวร',
};
const WEBHOOK_STATUS_TONE: Record<WebhookEventRow['status'], 'slate' | 'amber' | 'green' | 'red' | 'teal'> = {
  RECEIVED: 'slate',
  PROCESSING: 'amber',
  PROCESSED: 'green',
  IGNORED: 'slate',
  FAILED: 'red',
  DEAD: 'red',
};
const RECON_STATUS_LABEL: Record<ReconciliationRunRow['status'], string> = {
  RUNNING: 'กำลังตรวจสอบ',
  COMPLETED: 'เสร็จสิ้น',
  FAILED: 'ล้มเหลว',
};
const RECON_STATUS_TONE: Record<
  ReconciliationRunRow['status'],
  'slate' | 'amber' | 'green' | 'red' | 'teal'
> = {
  RUNNING: 'amber',
  COMPLETED: 'green',
  FAILED: 'red',
};

export default function ChannelAccountDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { me } = useMe();
  const account = useResource<ChannelAccount>(`/channel-accounts/${id}`);
  const mappings = useResource<ChannelProductVariantRow[]>(`/channel-accounts/${id}/mappings`);
  const syncJobs = useResource<SyncJobRow[]>(`/channel-accounts/${id}/sync-jobs`);
  const webhookEvents = useResource<WebhookEventRow[]>(`/channel-accounts/${id}/webhook-events`);
  const reconciliationRuns = useResource<ReconciliationRunRow[]>(
    `/channel-accounts/${id}/reconciliation-runs`,
  );
  const { data: warehouses } = useResource<Warehouse[]>('/warehouses');

  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<unknown>();
  const [syncResult, setSyncResult] = useState<string | null>(null);
  const canManage = can(me, 'channel.manage');
  const canSync = can(me, 'channel.sync');

  async function runAction(name: string, path: string, body?: unknown, method: 'POST' | 'PUT' = 'POST') {
    setBusy(name);
    setActionError(undefined);
    setSyncResult(null);
    try {
      const res = await api<Record<string, unknown>>(`/channel-accounts/${id}${path}`, {
        method,
        ...(body ? { body: body as Record<string, unknown> } : {}),
      });
      if (name === 'sync-stock')
        setSyncResult(`push สต็อกสำเร็จ ${res.pushed} รายการ (ล้มเหลว ${res.failed})`);
      if (name === 'sync-orders') {
        const out = res.output as { pulled?: number; ingested?: number; failed?: number } | undefined;
        setSyncResult(
          `ดึงออเดอร์ ${out?.pulled ?? 0} รายการ, ประมวลผล ${out?.ingested ?? 0}, ล้มเหลว ${out?.failed ?? 0}`,
        );
      }
      await Promise.all([
        account.reload(),
        mappings.reload(),
        syncJobs.reload(),
        webhookEvents.reload(),
        reconciliationRuns.reload(),
      ]);
    } catch (err) {
      setActionError(err);
    } finally {
      setBusy(null);
    }
  }

  if (account.loading && !account.data) return <Loading />;
  if (account.error) return <ErrorBox error={account.error} />;
  const acc = account.data;
  if (!acc) return null;

  return (
    <>
      <PageHeader
        breadcrumb={[
          { label: 'ช่องทางขาย', href: '/channels' },
          { label: acc.shopName ?? acc.externalShopId },
        ]}
        title={acc.shopName ?? acc.externalShopId}
        description={`${acc.channelCode} · ${acc.externalShopId}`}
        actions={
          canManage ? (
            <div className="flex gap-2">
              {acc.status === 'CONNECTED' || acc.status === 'ERROR' || acc.status === 'TOKEN_EXPIRED' ? (
                <Button
                  variant="secondary"
                  busy={busy === 'pause'}
                  onClick={() => runAction('pause', '/pause')}
                >
                  พักการเชื่อมต่อ
                </Button>
              ) : null}
              {acc.status === 'PAUSED' ? (
                <Button
                  variant="secondary"
                  busy={busy === 'resume'}
                  onClick={() => runAction('resume', '/resume')}
                >
                  เปิดใช้งานอีกครั้ง
                </Button>
              ) : null}
              {acc.status !== 'DISCONNECTED' ? (
                <Button
                  variant="danger"
                  busy={busy === 'disconnect'}
                  onClick={() => {
                    if (window.confirm('ยกเลิกการเชื่อมต่อร้านนี้?'))
                      void runAction('disconnect', '/disconnect');
                  }}
                >
                  ยกเลิกการเชื่อมต่อ
                </Button>
              ) : null}
            </div>
          ) : undefined
        }
      />
      <ErrorBox error={actionError} />
      {syncResult ? (
        <div className="mb-4 rounded-md border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
          {syncResult}
        </div>
      ) : null}

      <Card>
        <div className="flex flex-wrap items-center gap-4">
          <Badge tone={STATUS_TONE[acc.status]}>{STATUS_LABEL[acc.status]}</Badge>
          <span className="text-sm text-slate-600">
            sync ออเดอร์ล่าสุด: {formatDate(acc.lastOrderSyncAt)}
          </span>
          {acc.lastError ? (
            <span className="text-sm text-red-700">ข้อผิดพลาดล่าสุด: {acc.lastError}</span>
          ) : null}
        </div>
        {canManage ? (
          <form
            className="mt-4 flex items-end gap-2"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              const form = e.currentTarget as HTMLFormElement;
              const select = form.elements.namedItem('warehouseId') as HTMLSelectElement;
              void runAction('warehouse', '/default-warehouse', { warehouseId: select.value }, 'PUT');
            }}
          >
            <Field label="คลังที่ใช้จัดส่งของช่องทางนี้">
              <Select name="warehouseId" defaultValue={acc.defaultWarehouseId ?? ''} required>
                <option value="" disabled>
                  เลือกคลัง
                </option>
                {(warehouses ?? []).map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Button type="submit" variant="secondary" busy={busy === 'warehouse'}>
              บันทึก
            </Button>
          </form>
        ) : null}
      </Card>

      {canSync ? (
        <Card>
          <div className="flex flex-wrap gap-2">
            <Button busy={busy === 'sync-stock'} onClick={() => runAction('sync-stock', '/sync/stock')}>
              Sync สต็อกตอนนี้
            </Button>
            <Button busy={busy === 'sync-orders'} onClick={() => runAction('sync-orders', '/sync/orders')}>
              ดึงออเดอร์ตอนนี้
            </Button>
            <Button
              busy={busy === 'reconcile'}
              variant="secondary"
              onClick={() => runAction('reconcile', '/reconciliation-runs')}
            >
              ตรวจสอบสต็อกกับช่องทาง
            </Button>
          </div>
        </Card>
      ) : null}

      <MappingsPanel
        accountId={id}
        mappings={mappings.data ?? []}
        loading={mappings.loading}
        error={mappings.error}
        canManage={canManage}
        onImport={() => runAction('import', '/mappings/import')}
        importBusy={busy === 'import'}
        onReload={mappings.reload}
      />

      <StockPolicyPanel accountId={id} canManage={canManage} />

      <Card>
        <h2 className="mb-3 text-sm font-semibold text-slate-700">ประวัติ sync</h2>
        <Table
          head={['ประเภท', 'สถานะ', 'ผลลัพธ์', 'เมื่อ']}
          empty={!syncJobs.loading && (syncJobs.data?.length ?? 0) === 0}
        >
          {(syncJobs.data ?? []).map((j) => (
            <tr key={j.id}>
              <Td>{JOB_TYPE_LABEL[j.jobType]}</Td>
              <Td>
                <Badge tone={JOB_STATUS_TONE[j.status]}>{JOB_STATUS_LABEL[j.status]}</Badge>
              </Td>
              <Td className="text-xs text-slate-600">
                {j.output ? JSON.stringify(j.output) : (j.lastError ?? '—')}
              </Td>
              <Td className="whitespace-nowrap text-slate-600">{formatDate(j.scheduledAt)}</Td>
            </tr>
          ))}
        </Table>
        {syncJobs.loading ? <Loading /> : null}
      </Card>

      <Card>
        <h2 className="mb-3 text-sm font-semibold text-slate-700">Webhook ที่ได้รับ</h2>
        <Table
          head={['ประเภท', 'อ้างอิง', 'ลายเซ็น', 'สถานะ', 'เมื่อ']}
          empty={!webhookEvents.loading && (webhookEvents.data?.length ?? 0) === 0}
        >
          {(webhookEvents.data ?? []).map((w) => (
            <tr key={w.id}>
              <Td>{w.eventType}</Td>
              <Td className="font-mono text-xs">{w.externalRef ?? '—'}</Td>
              <Td>
                <Badge tone={w.signatureValid ? 'green' : 'red'}>
                  {w.signatureValid ? 'ถูกต้อง' : 'ไม่ถูกต้อง'}
                </Badge>
              </Td>
              <Td>
                <Badge tone={WEBHOOK_STATUS_TONE[w.status]}>{WEBHOOK_STATUS_LABEL[w.status]}</Badge>
              </Td>
              <Td className="whitespace-nowrap text-slate-600">{formatDate(w.receivedAt)}</Td>
            </tr>
          ))}
        </Table>
        {webhookEvents.loading ? <Loading /> : null}
      </Card>

      <ReconciliationPanel runs={reconciliationRuns.data ?? []} loading={reconciliationRuns.loading} />
    </>
  );
}

function MappingsPanel({
  accountId,
  mappings,
  loading,
  error,
  canManage,
  onImport,
  importBusy,
  onReload,
}: {
  accountId: string;
  mappings: ChannelProductVariantRow[];
  loading: boolean;
  error: unknown;
  canManage: boolean;
  onImport: () => void;
  importBusy: boolean;
  onReload: () => Promise<void>;
}) {
  const [editing, setEditing] = useState<ChannelProductVariantRow | null>(null);
  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-700">การผูก SKU</h2>
        {canManage ? (
          <Button variant="secondary" busy={importBusy} onClick={onImport}>
            นำเข้าสินค้าจากช่องทาง
          </Button>
        ) : null}
      </div>
      <ErrorBox error={error} />
      <Table
        head={['สินค้าบนช่องทาง', 'SKU บนช่องทาง', 'สถานะ', 'SKU ภายใน', '']}
        empty={!loading && mappings.length === 0}
      >
        {mappings.map((m) => (
          <tr key={m.id}>
            <Td>{m.productTitle ?? m.externalItemId}</Td>
            <Td className="font-mono text-xs">{m.externalSku ?? '—'}</Td>
            <Td>
              <Badge tone={MAPPING_TONE[m.mappingStatus]}>{MAPPING_LABEL[m.mappingStatus]}</Badge>
            </Td>
            <Td className="font-mono text-xs">{m.sku ?? '—'}</Td>
            <Td>
              {canManage ? (
                <button className="text-brand-700 underline" onClick={() => setEditing(m)}>
                  แก้ไขการผูก
                </button>
              ) : null}
            </Td>
          </tr>
        ))}
      </Table>
      {loading ? <Loading /> : null}
      {editing ? (
        <ConfirmMappingModal
          accountId={accountId}
          row={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await onReload();
          }}
        />
      ) : null}
    </Card>
  );
}

function ConfirmMappingModal({
  accountId: _accountId,
  row,
  onClose,
  onSaved,
}: {
  accountId: string;
  row: ChannelProductVariantRow;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [sku, setSku] = useState(row.sku ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      let variantId: string | null = null;
      if (sku.trim()) {
        const found = await api<{ id: string }>(`/variants/lookup?sku=${encodeURIComponent(sku.trim())}`);
        variantId = found.id;
      }
      await api(`/channel-mappings/${row.id}`, { method: 'PUT', body: { variantId } });
      await onSaved();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open title={`ผูก SKU: ${row.productTitle ?? row.externalItemId}`} onClose={onClose}>
      <form onSubmit={save} className="space-y-4">
        <p className="text-sm text-slate-600">
          SKU บนช่องทาง: <span className="font-mono">{row.externalSku ?? '—'}</span>
        </p>
        <Field label="SKU ภายในที่จะผูก (เว้นว่างเพื่อยกเลิกการผูก)">
          <Input value={sku} onChange={(e) => setSku(e.target.value.toUpperCase())} />
        </Field>
        <ErrorBox error={error} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            ยกเลิก
          </Button>
          <Button type="submit" busy={busy}>
            บันทึก
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function StockPolicyPanel({ accountId, canManage }: { accountId: string; canManage: boolean }) {
  const { data, error, loading, reload } = useResource<StockPolicyRow[]>(
    `/channel-stock-policies?channelAccountId=${accountId}`,
  );
  const accountLevel = (data ?? []).find((p) => p.channelAccountId === accountId && p.variantId === null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<unknown>();

  async function save(e: FormEvent) {
    e.preventDefault();
    const form = new FormData(e.currentTarget as HTMLFormElement);
    setBusy(true);
    setSaveError(undefined);
    try {
      await api('/channel-stock-policies', {
        method: 'PUT',
        body: {
          channelAccountId: accountId,
          safetyStock: String(form.get('safetyStock') || '0'),
          bufferPercent: String(form.get('bufferPercent') || '0'),
          maxPushQty: form.get('maxPushQty') ? String(form.get('maxPushQty')) : null,
          pushZeroBelow: String(form.get('pushZeroBelow') || '0'),
        },
      });
      await reload();
    } catch (err) {
      setSaveError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <h2 className="mb-3 text-sm font-semibold text-slate-700">นโยบายสต็อกที่ส่งให้ช่องทาง</h2>
      <ErrorBox error={error} />
      {loading ? (
        <Loading />
      ) : (
        <form onSubmit={save} className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Field label="กันสต็อกไว้ (safety stock)">
            <Input name="safetyStock" defaultValue={accountLevel?.safetyStock ?? '0'} disabled={!canManage} />
          </Field>
          <Field label="กันเผื่อ (%)">
            <Input
              name="bufferPercent"
              defaultValue={accountLevel?.bufferPercent ?? '0'}
              disabled={!canManage}
            />
          </Field>
          <Field label="ส่งได้สูงสุด (เว้นว่าง = ไม่จำกัด)">
            <Input name="maxPushQty" defaultValue={accountLevel?.maxPushQty ?? ''} disabled={!canManage} />
          </Field>
          <Field label="ต่ำกว่านี้ให้ส่ง 0">
            <Input
              name="pushZeroBelow"
              defaultValue={accountLevel?.pushZeroBelow ?? '0'}
              disabled={!canManage}
            />
          </Field>
          {canManage ? (
            <div className="col-span-2 sm:col-span-4">
              <Button type="submit" busy={busy}>
                บันทึกนโยบาย
              </Button>
            </div>
          ) : null}
        </form>
      )}
      <ErrorBox error={saveError} />
    </Card>
  );
}

function ReconciliationPanel({ runs, loading }: { runs: ReconciliationRunRow[]; loading: boolean }) {
  const [openRun, setOpenRun] = useState<string | null>(null);
  return (
    <Card>
      <h2 className="mb-3 text-sm font-semibold text-slate-700">ผลการตรวจสอบสต็อกกับช่องทาง</h2>
      <Table head={['สถานะ', 'ตรวจแล้ว', 'ไม่ตรง', 'เริ่ม', '']} empty={!loading && runs.length === 0}>
        {runs.map((r) => (
          <tr key={r.id}>
            <Td>
              <Badge tone={RECON_STATUS_TONE[r.status]}>{RECON_STATUS_LABEL[r.status]}</Badge>
            </Td>
            <Td>{r.checkedCount}</Td>
            <Td>{r.mismatchCount}</Td>
            <Td className="whitespace-nowrap text-slate-600">{formatDate(r.startedAt)}</Td>
            <Td>
              <button className="text-brand-700 underline" onClick={() => setOpenRun(r.id)}>
                ดูรายละเอียด
              </button>
            </Td>
          </tr>
        ))}
      </Table>
      {loading ? <Loading /> : null}
      {openRun ? <ReconciliationItemsModal runId={openRun} onClose={() => setOpenRun(null)} /> : null}
    </Card>
  );
}

function ReconciliationItemsModal({ runId, onClose }: { runId: string; onClose: () => void }) {
  const { data, error, loading } = useResource<ReconciliationItemRow[]>(
    `/reconciliation-runs/${runId}/items`,
  );
  return (
    <Modal open title="รายละเอียดการตรวจสอบ" onClose={onClose}>
      <ErrorBox error={error} />
      {loading ? (
        <Loading />
      ) : (
        <Table head={['คาดว่าจะมี', 'มีจริงบนช่องทาง', 'ผลต่าง', 'สรุป']} empty={(data?.length ?? 0) === 0}>
          {(data ?? []).map((i) => (
            <tr key={i.id}>
              <Td>{i.expectedQty ?? '—'}</Td>
              <Td>{i.actualQty ?? '—'}</Td>
              <Td className={i.diff && i.diff !== '0.000' ? 'text-red-700' : ''}>{i.diff ?? '—'}</Td>
              <Td>{i.classification ?? '—'}</Td>
            </tr>
          ))}
        </Table>
      )}
      <div className="mt-4 flex justify-end">
        <Button variant="secondary" onClick={onClose}>
          ปิด
        </Button>
      </div>
    </Modal>
  );
}
