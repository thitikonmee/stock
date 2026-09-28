'use client';

import { useRef, useState } from 'react';
import { Button, Card, ErrorBox, Notice, PageHeader, Table, Td } from '@/components/ui';
import { apiDownload, apiUpload } from '@/lib/client/api';
import type { ImportJob } from '@/lib/client/types';

export default function ImportProductsPage() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [job, setJob] = useState<ImportJob | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function upload(file: File) {
    setBusy(true);
    setError(undefined);
    setJob(null);
    try {
      const data = await file.arrayBuffer();
      const result = await apiUpload<ImportJob>('/products/import', data);
      setJob(result);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="นำเข้าสินค้าจาก Excel"
        description="อัปโหลดไฟล์ .xlsx ตามเทมเพลต — สร้างสินค้า/SKU ใหม่ หรืออัปเดตราคาของ SKU ที่มีอยู่แล้ว"
      />
      <div className="space-y-6">
        <Card title="ขั้นตอน">
          <ol className="list-inside list-decimal space-y-2 text-sm text-slate-700">
            <li>
              ดาวน์โหลด
              <button
                type="button"
                className="ml-1 text-brand-700 hover:underline"
                onClick={() => void apiDownload('/products/import/template', 'product-import-template.xlsx')}
              >
                เทมเพลตนำเข้าสินค้า
              </button>
            </li>
            <li>
              กรอกข้อมูล 1 แถวต่อ 1 SKU — productCode/productName ซ้ำกันได้ในหลายแถว (สินค้าเดียวกัน หลาย SKU)
            </li>
            <li>อัปโหลดไฟล์ที่กรอกแล้ว</li>
          </ol>
          <div className="mt-4">
            <input
              ref={inputRef}
              type="file"
              accept=".xlsx"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void upload(file);
                e.target.value = '';
              }}
            />
            <Button busy={busy} onClick={() => inputRef.current?.click()}>
              เลือกไฟล์และนำเข้า
            </Button>
          </div>
        </Card>

        <ErrorBox error={error} />

        {job ? (
          <Card title="ผลการนำเข้า">
            <Notice tone={job.status === 'COMPLETED' ? 'success' : 'warning'}>
              สถานะ: {job.status} — ทั้งหมด {job.totalRows} แถว, สร้างสินค้าใหม่ {job.createdProducts}, SKU
              ใหม่ {job.createdVariants}, อัปเดต {job.updatedVariants}
            </Notice>
            {job.errors.length > 0 ? (
              <div className="mt-4">
                <p className="mb-2 text-sm font-medium text-slate-700">แถวที่ผิดพลาด ({job.errors.length})</p>
                <Table head={['แถว', 'ข้อความ']}>
                  {job.errors.map((e, i) => (
                    <tr key={i}>
                      <Td>{e.row}</Td>
                      <Td className="text-red-700">{e.message}</Td>
                    </tr>
                  ))}
                </Table>
              </div>
            ) : null}
          </Card>
        ) : null}
      </div>
    </>
  );
}
