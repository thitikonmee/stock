'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
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

function cartesian(options: { name: string; values: string[] }[]): Record<string, string>[] {
  if (options.length === 0) return [{}];
  return options.reduce<Record<string, string>[]>(
    (acc, opt) => acc.flatMap((combo) => opt.values.map((v) => ({ ...combo, [opt.name]: v }))),
    [{}],
  );
}

export default function NewProductPage() {
  const router = useRouter();
  const [brands, setBrands] = useState<Brand[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [form, setForm] = useState({
    code: '',
    name: '',
    brandId: '',
    categoryId: '',
    baseUnitId: '',
    type: 'STANDARD' as 'STANDARD' | 'BUNDLE' | 'SERVICE' | 'NON_STOCK',
  });
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
          ...(form.brandId ? { brandId: form.brandId } : {}),
          ...(form.categoryId ? { categoryId: form.categoryId } : {}),
          baseUnitId: form.baseUnitId,
          type: form.type,
          options: options
            .map((o) => ({
              name: o.name.trim(),
              values: o.valuesText
                .split(',')
                .map((v) => v.trim())
                .filter(Boolean),
            }))
            .filter((o) => o.name && o.values.length > 0),
          variants: variants.map((v) => ({
            sku: v.sku,
            optionValues: v.optionValues,
            ...(v.costPrice ? { costPrice: v.costPrice } : {}),
            ...(v.sellingPrice ? { sellingPrice: v.sellingPrice } : {}),
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
      <PageHeader title="เพิ่มสินค้าใหม่" description="สร้างสินค้าพร้อม variant (สี/ไซส์) ในขั้นตอนเดียว" />
      <form onSubmit={submit} className="space-y-6">
        <Card title="ข้อมูลสินค้า">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="รหัสสินค้า">
              <Input
                value={form.code}
                onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
                required
              />
            </Field>
            <Field label="ชื่อสินค้า">
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                required
              />
            </Field>
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
            <Field label="หน่วยนับหลัก">
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
        <div className="flex justify-end gap-2">
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
