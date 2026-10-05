'use client';

import { useRef, useState, type DragEvent } from 'react';
import { AlertTriangle, Download, Info, PackageOpen, UploadCloud, X } from 'lucide-react';
import { Badge, Button, Card, ErrorBox, Loading, Notice, PageHeader, Table, Td } from '@/components/ui';
import { apiDownload, apiUpload } from '@/lib/client/api';
import type { ImportJob } from '@/lib/client/types';

const MAX_PREVIEW_ROWS = 1000;
const ACCEPTED_EXTENSIONS = ['.xlsx', '.csv'];

function isAcceptedFile(file: File): boolean {
  const name = file.name.toLowerCase();
  return ACCEPTED_EXTENSIONS.some((ext) => name.endsWith(ext));
}

export default function ImportProductsPage() {
  const [file, setFile] = useState<File | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [committed, setCommitted] = useState(false);
  const [error, setError] = useState<unknown>();
  const [job, setJob] = useState<ImportJob | null>(null);
  const [showSuccess, setShowSuccess] = useState(true);
  const [showErrors, setShowErrors] = useState(true);
  const [showHelp, setShowHelp] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function selectFile(picked: File) {
    setError(undefined);
    setJob(null);
    setCommitted(false);
    if (!isAcceptedFile(picked)) {
      setFile(null);
      setError(new Error('รองรับเฉพาะไฟล์ .xlsx หรือ .csv เท่านั้น'));
      return;
    }
    setFile(picked);
    setPreviewing(true);
    try {
      const data = await picked.arrayBuffer();
      const result = await apiUpload<ImportJob>('/products/import/preview', data, picked.name);
      setJob(result);
    } catch (err) {
      setError(err);
    } finally {
      setPreviewing(false);
    }
  }

  async function commitImport() {
    if (!file) return;
    setCommitting(true);
    setError(undefined);
    try {
      const data = await file.arrayBuffer();
      const result = await apiUpload<ImportJob>('/products/import', data, file.name);
      setJob(result);
      setCommitted(true);
    } catch (err) {
      setError(err);
    } finally {
      setCommitting(false);
    }
  }

  function reset() {
    setFile(null);
    setJob(null);
    setCommitted(false);
    setError(undefined);
  }

  const rows = job?.rows ?? [];
  const successCount = rows.filter((r) => r.status === 'success').length;
  const errorCount = rows.filter((r) => r.status === 'error').length;
  const visibleRows = rows.filter((r) => (r.status === 'success' ? showSuccess : showErrors));
  const busy = previewing || committing;

  return (
    <>
      <PageHeader
        breadcrumb={[
          { label: 'สินค้า', href: '/catalog/products' },
          { label: 'รายการสินค้า', href: '/catalog/products' },
          { label: 'นำเข้าสินค้า' },
        ]}
        title={
          <span className="inline-flex items-center gap-2">
            นำเข้าข้อมูลสินค้า
            <button
              type="button"
              onClick={() => setShowHelp((v) => !v)}
              className="inline-flex size-5 items-center justify-center rounded-full bg-brand-100 text-brand-700 hover:bg-brand-200"
              aria-label="วิธีใช้งาน"
              aria-expanded={showHelp}
            >
              <Info className="size-3.5" aria-hidden />
            </button>
          </span>
        }
        actions={
          <Button
            variant="secondary"
            onClick={() => void apiDownload('/products/import/template', 'product-import-template.xlsx')}
          >
            <Download className="size-4" aria-hidden />
            ดาวน์โหลดไฟล์ตัวอย่าง
          </Button>
        }
      />
      <div className="space-y-6">
        {showHelp ? (
          <Notice tone="info">
            ดาวน์โหลดเทมเพลตด้านบนแล้วกรอกข้อมูล 1 แถวต่อ 1 SKU — productCode/productName ซ้ำกันได้ในหลายแถว
            (สินค้าเดียวกัน หลาย SKU) จากนั้นอัปโหลดไฟล์เพื่อดูตัวอย่างข้อมูลก่อนนำเข้าจริง
          </Notice>
        ) : null}

        <Card>
          <div
            role="button"
            tabIndex={0}
            onClick={() => !busy && inputRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click();
            }}
            onDragOver={(e: DragEvent<HTMLDivElement>) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e: DragEvent<HTMLDivElement>) => {
              e.preventDefault();
              setDragOver(false);
              const dropped = e.dataTransfer.files[0];
              if (dropped) void selectFile(dropped);
            }}
            className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-14 text-center transition ${
              dragOver ? 'border-brand-400 bg-brand-50' : 'border-slate-300 bg-slate-50 hover:bg-slate-100'
            }`}
          >
            <span className="flex size-10 items-center justify-center rounded-full bg-brand-100 text-brand-700">
              <UploadCloud className="size-5" aria-hidden />
            </span>
            <p className="text-sm font-medium text-slate-700">อัปโหลดไฟล์</p>
            <p className="text-xs text-slate-500">คลิกเพื่ออัปโหลดไฟล์ หรือ ลากไฟล์มาวางที่นี่</p>
          </div>
          <input
            ref={inputRef}
            type="file"
            accept=".xlsx,.csv"
            className="hidden"
            onChange={(e) => {
              const picked = e.target.files?.[0];
              if (picked) void selectFile(picked);
              e.target.value = '';
            }}
          />
          {file ? (
            <div className="mt-3 flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2 text-sm">
              <span className="truncate text-slate-700">
                {file.name}
                {previewing ? ' — กำลังอ่านไฟล์…' : ''}
              </span>
              <button
                type="button"
                onClick={reset}
                className="text-slate-400 hover:text-slate-600"
                aria-label="ลบไฟล์"
              >
                <X className="size-4" aria-hidden />
              </button>
            </div>
          ) : null}
          <ul className="mt-3 list-inside list-disc space-y-1 text-xs text-slate-500">
            <li>รองรับไฟล์ XLSX, CSV</li>
            <li>รองรับข้อมูลไม่เกิน {MAX_PREVIEW_ROWS.toLocaleString('th-TH')} แถว (ไม่รวมแถวหัวตาราง)</li>
          </ul>
        </Card>

        <ErrorBox error={error} />

        {committed && job ? (
          <Notice tone={job.status === 'COMPLETED' ? 'success' : 'warning'}>
            นำเข้าสำเร็จ — สร้างสินค้าใหม่ {job.createdProducts} รายการ, SKU ใหม่ {job.createdVariants}{' '}
            รายการ, อัปเดต {job.updatedVariants} รายการ
          </Notice>
        ) : null}

        <Card
          title="ตารางข้อมูลนำเข้า"
          actions={
            job && rows.length > 0 ? (
              <div className="flex items-center gap-4 text-sm text-slate-600">
                <label className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={showSuccess}
                    onChange={(e) => setShowSuccess(e.target.checked)}
                  />
                  สำเร็จ ({successCount})
                </label>
                <label className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={showErrors}
                    onChange={(e) => setShowErrors(e.target.checked)}
                  />
                  ข้อผิดพลาด ({errorCount})
                </label>
              </div>
            ) : undefined
          }
        >
          {previewing ? (
            <Loading />
          ) : rows.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-16 text-center">
              <PackageOpen className="size-10 text-slate-300" aria-hidden />
              <p className="text-sm text-slate-500">ยังไม่มีข้อมูลในตาราง</p>
            </div>
          ) : (
            <Table
              head={['แถวที่', 'สถานะ', 'หมายเหตุ', 'SKU', 'สินค้า', 'Alias Name', 'รายละเอียด', 'คุณสมบัติ']}
            >
              {visibleRows.map((r) => (
                <tr key={r.row} className={r.status === 'error' ? 'bg-red-50/60' : undefined}>
                  <Td>{r.row}</Td>
                  <Td>
                    <Badge tone={r.status === 'success' ? 'green' : 'red'}>
                      {r.status === 'success' ? 'สำเร็จ' : 'ข้อผิดพลาด'}
                    </Badge>
                  </Td>
                  <Td className={r.status === 'error' ? 'text-red-700' : 'text-slate-600'}>{r.note}</Td>
                  <Td className="font-mono">{r.sku || '—'}</Td>
                  <Td>{r.productName || '—'}</Td>
                  <Td>{r.aliasName || '—'}</Td>
                  <Td>{r.description || '—'}</Td>
                  <Td>{r.properties || '—'}</Td>
                </tr>
              ))}
            </Table>
          )}
          <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-4">
            <div className="text-sm text-slate-600">
              {(job?.totalRows ?? 0).toLocaleString('th-TH')} รายการ
              {errorCount > 0 ? (
                <p className="mt-0.5 flex items-center gap-1 text-xs text-red-600">
                  <AlertTriangle className="size-3.5" aria-hidden />
                  มีข้อมูลที่ไม่สามารถนำเข้าได้
                </p>
              ) : null}
            </div>
            <Button
              onClick={() => void commitImport()}
              disabled={!job || rows.length === 0 || committed || busy}
              busy={committing}
            >
              {committed ? 'นำเข้าสำเร็จแล้ว' : 'นำเข้าสินค้าทั้งหมด'}
            </Button>
          </div>
        </Card>
      </div>
    </>
  );
}
