'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { ImagePlus, ScanLine, Wand2 } from 'lucide-react';
import { Button, Card, ErrorBox, Field, Input, PageHeader, Select, Table, Td } from '@/components/ui';
import { api } from '@/lib/client/api';
import type { Brand, Category, Unit } from '@/lib/client/types';

interface OptionDef {
  name: string;
  valuesText: string;
}
interface VariantRow {
  sku: string;
  optionValues: Record<string, string>;
  costPrice: string;
  sellingPrice: string;
}

const THRESHOLD_PRESETS = ['5', '10', '15', '20', '25'];

function cartesian(options: { name: string; values: string[] }[]): Record<string, string>[] {
  if (options.length === 0) return [{}];
  return options.reduce<Record<string, string>[]>(
    (acc, opt) => acc.flatMap((combo) => opt.values.map((v) => ({ ...combo, [opt.name]: v }))),
    [{}],
  );
}

/** Client-side only — turns a product name into a plausible SKU/code suggestion. Never calls the
 *  API: there's no barcode/SKU-generation endpoint that works before the product exists. */
function suggestCode(name: string): string {
  return name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/(^-+|-+$)/g, '')
    .slice(0, 20);
}

export default function NewProductPage() {
  const router = useRouter();
  const [brands, setBrands] = useState<Brand[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [form, setForm] = useState({
    code: '',
    name: '',
    description: '',
    brandId: '',
    categoryId: '',
    baseUnitId: '',
    type: 'STANDARD' as 'STANDARD' | 'BUNDLE' | 'SERVICE' | 'NON_STOCK',
    taxClass: 'VAT7' as 'VAT7' | 'VAT0' | 'EXEMPT',
  });
  const [barcode, setBarcode] = useState('');
  const [threshold, setThreshold] = useState('5');
  const [customThreshold, setCustomThreshold] = useState('');
  const [options, setOptions] = useState<OptionDef[]>([]);
  const [variants, setVariants] = useState<VariantRow[]>([
    { sku: '', optionValues: {}, costPrice: '', sellingPrice: '' },
  ]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  useEffect(() => {
    void Promise.all([api<Brand[]>('/brands'), api<Category[]>('/categories'), api<Unit[]>('/units')]).then(
      ([b, c, u]) => {
        setBrands(b);
        setCategories(c);
        setUnits(u);
        if (u[0]) setForm((f) => ({ ...f, baseUnitId: u[0]!.id }));
      },
    );
  }, []);

  function generateMatrix() {
    const parsed = options
      .map((o) => ({
        name: o.name.trim(),
        values: o.valuesText
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean),
      }))
      .filter((o) => o.name && o.values.length > 0);
    const combos = cartesian(parsed);
    setVariants(
      combos.map((optionValues) => {
        const suffix = Object.values(optionValues).join('-');
        return {
          sku: [form.code, suffix].filter(Boolean).join('-').toUpperCase(),
          optionValues,
          costPrice: '',
          sellingPrice: '',
        };
      }),
    );
  }

  function updateVariant(i: number, patch: Partial<VariantRow>) {
    setVariants((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }

  const effectiveThreshold = threshold === 'custom' ? customThreshold : threshold;
  const firstPrice = Number(variants[0]?.sellingPrice || 0);
  const vatRate = form.taxClass === 'VAT7' ? 0.07 : 0;
  // Prices are stored VAT-inclusive throughout the app (see order/POS pricing) — this preview only
  // decomposes what's already entered, it never changes how the price itself gets saved.
  const priceExVat = form.taxClass === 'VAT7' ? firstPrice / (1 + vatRate) : firstPrice;
  const vatAmount = firstPrice - priceExVat;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const product = await api<{ id: string }>('/products', {
        method: 'POST',
        body: {
          code: form.code,
          name: form.name,
          description: form.description || null,
          ...(form.brandId ? { brandId: form.brandId } : {}),
          ...(form.categoryId ? { categoryId: form.categoryId } : {}),
          baseUnitId: form.baseUnitId,
          type: form.type,
          taxClass: form.taxClass,
          options: options
            .map((o) => ({
              name: o.name.trim(),
              values: o.valuesText
                .split(',')
                .map((v) => v.trim())
                .filter(Boolean),
            }))
            .filter((o) => o.name && o.values.length > 0),
          variants: variants.map((v, i) => ({
            sku: v.sku,
            optionValues: v.optionValues,
            ...(v.costPrice ? { costPrice: v.costPrice } : {}),
            ...(v.sellingPrice ? { sellingPrice: v.sellingPrice } : {}),
            ...(effectiveThreshold ? { lowStockThreshold: effectiveThreshold } : {}),
            ...(i === 0 && variants.length === 1 && barcode ? { barcodes: [barcode] } : {}),
          })),
        },
      });
      router.push(`/catalog/products/${product.id}`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        breadcrumb={[
          { label: 'สินค้า', href: '/catalog/products' },
          { label: 'รายการสินค้า', href: '/catalog/products' },
          { label: 'สร้าง' },
        ]}
        title="สร้างสินค้า"
        description="สร้างสินค้าพร้อม variant (สี/ไซส์) ในขั้นตอนเดียว"
      />
      <form onSubmit={submit} className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card title="สินค้า">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="รหัสสินค้า *">
                <div className="flex gap-2">
                  <Input
                    value={form.code}
                    onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
                    required
                    className="flex-1"
                  />
                  <button
                    type="button"
                    title="สร้างรหัสจากชื่อสินค้า"
                    onClick={() => setForm({ ...form, code: suggestCode(form.name) || form.code })}
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-slate-300 text-slate-500 hover:bg-slate-50"
                  >
                    <Wand2 className="size-4" />
                  </button>
                </div>
              </Field>
              <Field
                label="บาร์โค้ดสินค้า"
                hint={variants.length > 1 ? 'ใช้ได้เฉพาะสินค้าที่มี SKU เดียว' : undefined}
              >
                <Input
                  icon={<ScanLine className="size-4" />}
                  value={barcode}
                  onChange={(e) => setBarcode(e.target.value)}
                  disabled={variants.length > 1}
                  placeholder="กรอกหรือสแกนบาร์โค้ด"
                />
              </Field>
              <Field label="ชื่อสินค้า *">
                <Input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  required
                  className="sm:col-span-2"
                />
              </Field>
              <Field label="หน่วยนับหลัก *">
                <Select
                  value={form.baseUnitId}
                  onChange={(e) => setForm({ ...form, baseUnitId: e.target.value })}
                  required
                >
                  <option value="" disabled>
                    — เลือกหน่วย —
                  </option>
                  {units.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.code} — {u.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <div className="sm:col-span-2">
                <Field label="รายละเอียด">
                  <textarea
                    value={form.description}
                    onChange={(e) => setForm({ ...form, description: e.target.value })}
                    rows={3}
                    placeholder="ใส่รายละเอียด"
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm placeholder:text-slate-400 focus:border-brand-500"
                  />
                </Field>
              </div>
              <Field label="แบรนด์">
                <Select value={form.brandId} onChange={(e) => setForm({ ...form, brandId: e.target.value })}>
                  <option value="">— ไม่ระบุ —</option>
                  {brands.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="หมวดหมู่">
                <Select
                  value={form.categoryId}
                  onChange={(e) => setForm({ ...form, categoryId: e.target.value })}
                >
                  <option value="">— ไม่ระบุ —</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.path}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="ประเภท">
                <Select
                  value={form.type}
                  onChange={(e) => setForm({ ...form, type: e.target.value as typeof form.type })}
                >
                  <option value="STANDARD">สินค้าทั่วไป</option>
                  <option value="BUNDLE">ชุด (Bundle)</option>
                  <option value="SERVICE">บริการ</option>
                  <option value="NON_STOCK">ไม่ตัดสต็อก</option>
                </Select>
              </Field>
            </div>

            <div className="mt-5 border-t border-slate-100 pt-5">
              <p className="mb-2 text-sm font-medium text-slate-700">แจ้งเตือนเมื่อสินค้าเหลือน้อยกว่า</p>
              <div className="flex flex-wrap items-center gap-2">
                {THRESHOLD_PRESETS.map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setThreshold(n)}
                    className={`flex h-9 items-center justify-center rounded-lg border px-3 text-sm ${
                      threshold === n
                        ? 'border-brand-500 bg-brand-50 font-medium text-brand-700'
                        : 'border-slate-300 text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    {n}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setThreshold('custom')}
                  className={`flex h-9 items-center justify-center rounded-lg border px-3 text-sm ${
                    threshold === 'custom'
                      ? 'border-brand-500 bg-brand-50 font-medium text-brand-700'
                      : 'border-slate-300 text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  ระบุเอง
                </button>
                <Input
                  type="number"
                  min={0}
                  disabled={threshold !== 'custom'}
                  value={customThreshold}
                  onChange={(e) => setCustomThreshold(e.target.value)}
                  className="w-24"
                />
              </div>
              <p className="mt-1 text-xs text-slate-500">
                ระบบจะแจ้งเตือนเมื่อจำนวนสินค้าคงเหลือน้อยกว่าที่กำหนด
              </p>
            </div>
          </Card>

          <Card
            title="ตัวเลือกสินค้า (variant matrix)"
            actions={
              <Button
                type="button"
                variant="secondary"
                onClick={() => setOptions([...options, { name: '', valuesText: '' }])}
              >
                เพิ่มตัวเลือก
              </Button>
            }
          >
            {options.length === 0 ? (
              <p className="text-sm text-slate-500">ไม่มีตัวเลือก = สินค้ามี SKU เดียว</p>
            ) : (
              <div className="space-y-3">
                {options.map((o, i) => (
                  <div key={i} className="flex gap-2">
                    <Input
                      placeholder="ชื่อตัวเลือก เช่น Color"
                      value={o.name}
                      onChange={(e) =>
                        setOptions(options.map((x, idx) => (idx === i ? { ...x, name: e.target.value } : x)))
                      }
                    />
                    <Input
                      placeholder="ค่า คั่นด้วย , เช่น Black,White"
                      value={o.valuesText}
                      onChange={(e) =>
                        setOptions(
                          options.map((x, idx) => (idx === i ? { ...x, valuesText: e.target.value } : x)),
                        )
                      }
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => setOptions(options.filter((_, idx) => idx !== i))}
                    >
                      ลบ
                    </Button>
                  </div>
                ))}
                <Button type="button" variant="secondary" onClick={generateMatrix}>
                  สร้างตาราง SKU จากตัวเลือก
                </Button>
              </div>
            )}
          </Card>

          <Card title={`SKU (${variants.length})`}>
            <Table head={['SKU', 'ตัวเลือก', 'ทุน', 'ราคาขาย']}>
              {variants.map((v, i) => (
                <tr key={i}>
                  <Td>
                    <Input
                      value={v.sku}
                      onChange={(e) => updateVariant(i, { sku: e.target.value.toUpperCase() })}
                      required
                    />
                  </Td>
                  <Td className="text-slate-600">
                    {Object.entries(v.optionValues)
                      .map(([k, val]) => `${k}: ${val}`)
                      .join(', ') || '—'}
                  </Td>
                  <Td>
                    <Input
                      value={v.costPrice}
                      onChange={(e) => updateVariant(i, { costPrice: e.target.value })}
                    />
                  </Td>
                  <Td>
                    <Input
                      value={v.sellingPrice}
                      onChange={(e) => updateVariant(i, { sellingPrice: e.target.value })}
                    />
                  </Td>
                </tr>
              ))}
            </Table>
          </Card>

          <ErrorBox error={error} />
        </div>

        <div className="space-y-6">
          <Card title="คลังรูปภาพ" tint>
            <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-brand-200 px-4 py-8 text-center">
              <ImagePlus className="size-6 text-brand-500" />
              <p className="text-sm font-medium text-slate-700">เพิ่มรูปได้หลังบันทึกสินค้า</p>
              <p className="text-xs text-slate-500">บันทึกสินค้าก่อน แล้วอัปโหลดรูปในหน้าแก้ไขสินค้า</p>
            </div>
          </Card>

          <Card title="สรุปราคา (SKU แรก)">
            <Field label="ภาษีมูลค่าเพิ่ม (VAT)">
              <Select
                value={form.taxClass}
                onChange={(e) => setForm({ ...form, taxClass: e.target.value as typeof form.taxClass })}
              >
                <option value="VAT7">VAT 7%</option>
                <option value="VAT0">VAT 0%</option>
                <option value="EXEMPT">ไม่มี VAT</option>
              </Select>
            </Field>
            <dl className="mt-4 space-y-2 border-t border-slate-100 pt-4 text-sm">
              <div className="flex justify-between">
                <dt className="text-slate-500">ราคาก่อนบวก VAT</dt>
                <dd>฿{priceExVat.toFixed(2)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500">VAT ({(vatRate * 100).toFixed(0)}%)</dt>
                <dd>฿{vatAmount.toFixed(2)}</dd>
              </div>
              <div className="flex justify-between border-t border-slate-100 pt-2 font-semibold">
                <dt>ราคาสุทธิ</dt>
                <dd>฿{firstPrice.toFixed(2)}</dd>
              </div>
            </dl>
          </Card>
        </div>

        <div className="flex justify-end gap-2 lg:col-span-3">
          <Button type="button" variant="secondary" onClick={() => router.back()}>
            ยกเลิก
          </Button>
          <Button type="submit" busy={busy}>
            สร้างสินค้า
          </Button>
        </div>
      </form>
    </>
  );
}
