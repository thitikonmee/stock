'use client';

import { useParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import {
  Badge,
  Button,
  Card,
  ErrorBox,
  Field,
  Input,
  Loading,
  Modal,
  Notice,
  PageHeader,
  Select,
  Table,
  Td,
} from '@/components/ui';
import { api, apiDownload } from '@/lib/client/api';
import type {
  Brand,
  BundleComponent,
  Category,
  Product,
  ProductImage,
  Unit,
  UnitConversion,
  Variant,
} from '@/lib/client/types';
import { useResource } from '@/lib/client/use-resource';

const STATUS_TONE = { DRAFT: 'amber', ACTIVE: 'green', ARCHIVED: 'slate' } as const;

export default function ProductEditorPage() {
  const { id } = useParams<{ id: string }>();
  const product = useResource<Product>(`/products/${id}`);
  const images = useResource<ProductImage[]>(`/products/${id}/images`);
  const units = useResource<Unit[]>('/units');
  const brands = useResource<Brand[]>('/brands');
  const categories = useResource<Category[]>('/categories');
  const unitConversions = useResource<UnitConversion[]>(`/products/${id}/units`);

  if (!product.data) return product.error ? <ErrorBox error={product.error} /> : <Loading />;
  const p = product.data;

  return (
    <>
      <PageHeader
        title={p.name}
        description={`รหัสสินค้า ${p.code}`}
        actions={<Badge tone={STATUS_TONE[p.status]}>{p.status}</Badge>}
      />
      <div className="space-y-6">
        <ProductDetailsCard
          product={p}
          brands={brands.data ?? []}
          categories={categories.data ?? []}
          onSaved={product.reload}
        />
        <VariantsCard product={p} onChanged={product.reload} />
        {p.type === 'BUNDLE' ? <BundleCard product={p} /> : null}
        <UnitConversionCard
          productId={p.id}
          baseUnitId={p.baseUnitId}
          units={units.data ?? []}
          conversions={unitConversions.data ?? []}
          onChanged={unitConversions.reload}
        />
        <ImagesCard productId={p.id} images={images.data ?? []} onChanged={images.reload} />
      </div>
    </>
  );
}

function ProductDetailsCard({
  product,
  brands,
  categories,
  onSaved,
}: {
  product: Product;
  brands: Brand[];
  categories: Category[];
  onSaved: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    name: product.name,
    brandId: product.brandId ?? '',
    categoryId: product.categoryId ?? '',
    status: product.status,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api(`/products/${product.id}`, {
        method: 'PATCH',
        headers: { 'if-match': `"v${product.version}"` },
        body: {
          name: form.name,
          brandId: form.brandId || null,
          categoryId: form.categoryId || null,
          status: form.status,
        },
      });
      setOpen(false);
      await onSaved();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="รายละเอียดสินค้า"
      actions={
        <Button variant="secondary" onClick={() => setOpen(true)}>
          แก้ไข
        </Button>
      }
    >
      <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-slate-500">แบรนด์</dt>
          <dd>{brands.find((b) => b.id === product.brandId)?.name ?? '—'}</dd>
        </div>
        <div>
          <dt className="text-slate-500">หมวดหมู่</dt>
          <dd>{categories.find((c) => c.id === product.categoryId)?.path ?? '—'}</dd>
        </div>
        <div>
          <dt className="text-slate-500">ประเภท</dt>
          <dd>{product.type}</dd>
        </div>
        <div>
          <dt className="text-slate-500">ภาษี</dt>
          <dd>{product.taxClass}</dd>
        </div>
      </dl>
      <Modal open={open} title="แก้ไขสินค้า" onClose={() => setOpen(false)}>
        <form onSubmit={save} className="space-y-4">
          <Field label="ชื่อสินค้า">
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
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
          <Field label="สถานะ">
            <Select
              value={form.status}
              onChange={(e) => setForm({ ...form, status: e.target.value as Product['status'] })}
            >
              <option value="DRAFT">แบบร่าง</option>
              <option value="ACTIVE">ใช้งาน</option>
              <option value="ARCHIVED">เลิกใช้</option>
            </Select>
          </Field>
          <ErrorBox error={error} />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              ยกเลิก
            </Button>
            <Button type="submit" busy={busy}>
              บันทึก
            </Button>
          </div>
        </form>
      </Modal>
    </Card>
  );
}

function VariantsCard({ product, onChanged }: { product: Product; onChanged: () => Promise<void> }) {
  const [editing, setEditing] = useState<Variant | null>(null);
  const [addingBarcodeFor, setAddingBarcodeFor] = useState<Variant | null>(null);
  const [selected, setSelected] = useState<Record<string, number>>({});
  const [printing, setPrinting] = useState(false);
  const [error, setError] = useState<unknown>();

  async function generateBarcode(variantId: string) {
    setError(undefined);
    try {
      await api('/barcodes/generate', { method: 'POST', body: { variantId, symbology: 'EAN13' } });
      await onChanged();
    } catch (err) {
      setError(err);
    }
  }

  async function printLabels() {
    const items = Object.entries(selected)
      .filter(([, qty]) => qty > 0)
      .map(([variantId, quantity]) => ({ variantId, quantity }));
    if (items.length === 0) return;
    setPrinting(true);
    setError(undefined);
    try {
      await apiDownload('/barcodes/labels', 'labels.pdf', { method: 'POST', body: { items } });
    } catch (err) {
      setError(err);
    } finally {
      setPrinting(false);
    }
  }

  return (
    <Card
      title={`SKU (${product.variants.length})`}
      actions={
        <Button
          busy={printing}
          onClick={() => void printLabels()}
          disabled={Object.values(selected).every((n) => !n)}
        >
          พิมพ์ป้ายที่เลือก
        </Button>
      }
    >
      <ErrorBox error={error} />
      <Table head={['', 'SKU', 'ชื่อ', 'บาร์โค้ด', 'ทุน', 'ราคาขาย', 'สถานะ', 'จำนวนป้าย', '']}>
        {product.variants.map((v) => (
          <tr key={v.id}>
            <Td>
              <input
                type="checkbox"
                checked={!!selected[v.id]}
                onChange={(e) => setSelected({ ...selected, [v.id]: e.target.checked ? 1 : 0 })}
              />
            </Td>
            <Td className="font-mono">{v.sku}</Td>
            <Td>{v.name}</Td>
            <Td className="space-x-1">
              {v.barcodes.length === 0 ? <span className="text-slate-400">—</span> : null}
              {v.barcodes.map((b) => (
                <span key={b} className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs">
                  {b}
                </span>
              ))}
              <button
                type="button"
                className="text-xs text-brand-700 hover:underline"
                onClick={() => void generateBarcode(v.id)}
              >
                สร้าง EAN-13
              </button>
              <button
                type="button"
                className="text-xs text-brand-700 hover:underline"
                onClick={() => setAddingBarcodeFor(v)}
              >
                เพิ่มเอง
              </button>
            </Td>
            <Td>{v.costPrice}</Td>
            <Td>{v.sellingPrice}</Td>
            <Td>
              <Badge tone={v.status === 'ACTIVE' ? 'green' : 'slate'}>{v.status}</Badge>
            </Td>
            <Td>
              <Input
                type="number"
                min={0}
                className="w-20"
                value={selected[v.id] ?? 0}
                onChange={(e) => setSelected({ ...selected, [v.id]: Number(e.target.value) })}
              />
            </Td>
            <Td className="text-right">
              <Button variant="secondary" onClick={() => setEditing(v)}>
                แก้ไข
              </Button>
            </Td>
          </tr>
        ))}
      </Table>

      {editing ? (
        <EditVariantModal variant={editing} onClose={() => setEditing(null)} onSaved={onChanged} />
      ) : null}
      {addingBarcodeFor ? (
        <AddBarcodeModal
          variant={addingBarcodeFor}
          onClose={() => setAddingBarcodeFor(null)}
          onSaved={onChanged}
        />
      ) : null}
    </Card>
  );
}

function EditVariantModal({
  variant,
  onClose,
  onSaved,
}: {
  variant: Variant;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [form, setForm] = useState({
    name: variant.name,
    costPrice: variant.costPrice,
    sellingPrice: variant.sellingPrice,
    status: variant.status,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api(`/variants/${variant.id}`, {
        method: 'PATCH',
        headers: { 'if-match': `"v${variant.version}"` },
        body: form,
      });
      onClose();
      await onSaved();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open title={`แก้ไข ${variant.sku}`} onClose={onClose}>
      <form onSubmit={save} className="space-y-4">
        <Field label="ชื่อ">
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="ทุน">
            <Input value={form.costPrice} onChange={(e) => setForm({ ...form, costPrice: e.target.value })} />
          </Field>
          <Field label="ราคาขาย">
            <Input
              value={form.sellingPrice}
              onChange={(e) => setForm({ ...form, sellingPrice: e.target.value })}
            />
          </Field>
        </div>
        <Field label="สถานะ">
          <Select
            value={form.status}
            onChange={(e) => setForm({ ...form, status: e.target.value as Variant['status'] })}
          >
            <option value="ACTIVE">ใช้งาน</option>
            <option value="INACTIVE">ปิดใช้งานชั่วคราว</option>
            <option value="ARCHIVED">เลิกใช้</option>
          </Select>
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

function AddBarcodeModal({
  variant,
  onClose,
  onSaved,
}: {
  variant: Variant;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [barcode, setBarcode] = useState('');
  const [symbology, setSymbology] = useState<'EAN13' | 'CODE128'>('EAN13');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api(`/variants/${variant.id}/barcodes`, { method: 'POST', body: { barcode, symbology } });
      onClose();
      await onSaved();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open title={`เพิ่มบาร์โค้ด — ${variant.sku}`} onClose={onClose}>
      <form onSubmit={save} className="space-y-4">
        <Field label="บาร์โค้ด">
          <Input value={barcode} onChange={(e) => setBarcode(e.target.value)} required />
        </Field>
        <Field label="ชนิด">
          <Select value={symbology} onChange={(e) => setSymbology(e.target.value as typeof symbology)}>
            <option value="EAN13">EAN-13</option>
            <option value="CODE128">Code 128</option>
          </Select>
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

function BundleCard({ product }: { product: Product }) {
  const bundleVariant = product.variants[0];
  const components = useResource<BundleComponent[]>(
    bundleVariant ? `/variants/${bundleVariant.id}/bundle-components` : null,
  );
  const allProducts = useResource<{ data: Product[] }>('/products?limit=100');
  const [form, setForm] = useState<{ variantId: string; quantity: string }[]>([
    { variantId: '', quantity: '1' },
  ]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  const options = (allProducts.data?.data ?? [])
    .filter((p) => p.id !== product.id)
    .flatMap((p) => p.variants.map((v) => ({ id: v.id, label: `${p.name} — ${v.sku}` })));

  async function save() {
    if (!bundleVariant) return;
    setBusy(true);
    setError(undefined);
    try {
      await api(`/variants/${bundleVariant.id}/bundle-components`, {
        method: 'POST',
        body: { components: form.filter((c) => c.variantId && c.quantity) },
      });
      await components.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (!bundleVariant) return null;

  return (
    <Card title="ส่วนประกอบของชุด (Bundle)">
      <ErrorBox error={error} />
      <Table head={['SKU ส่วนประกอบ', 'ชื่อ', 'จำนวน']} empty={components.data?.length === 0}>
        {components.data?.map((c) => (
          <tr key={c.variantId}>
            <Td className="font-mono">{c.sku}</Td>
            <Td>{c.name}</Td>
            <Td>{c.quantity}</Td>
          </tr>
        ))}
      </Table>
      <div className="mt-4 space-y-2 border-t border-slate-100 pt-4">
        <p className="text-sm font-medium text-slate-700">กำหนดส่วนประกอบใหม่ (แทนที่ทั้งหมด)</p>
        {form.map((row, i) => (
          <div key={i} className="flex gap-2">
            <Select
              value={row.variantId}
              onChange={(e) =>
                setForm(form.map((r, idx) => (idx === i ? { ...r, variantId: e.target.value } : r)))
              }
            >
              <option value="">— เลือก SKU —</option>
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </Select>
            <Input
              type="number"
              min={1}
              className="w-24"
              value={row.quantity}
              onChange={(e) =>
                setForm(form.map((r, idx) => (idx === i ? { ...r, quantity: e.target.value } : r)))
              }
            />
          </div>
        ))}
        <div className="flex gap-2">
          <Button
            type="button"
            variant="secondary"
            onClick={() => setForm([...form, { variantId: '', quantity: '1' }])}
          >
            เพิ่มแถว
          </Button>
          <Button type="button" busy={busy} onClick={() => void save()}>
            บันทึกส่วนประกอบ
          </Button>
        </div>
      </div>
    </Card>
  );
}

function UnitConversionCard({
  productId,
  baseUnitId,
  units,
  conversions,
  onChanged,
}: {
  productId: string;
  baseUnitId: string;
  units: Unit[];
  conversions: UnitConversion[];
  onChanged: () => Promise<void>;
}) {
  const [form, setForm] = useState({
    unitId: '',
    factorToBase: '',
    isPurchaseUnit: false,
    isSalesUnit: true,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const baseUnit = units.find((u) => u.id === baseUnitId);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api(`/products/${productId}/units`, { method: 'POST', body: form });
      setForm({ unitId: '', factorToBase: '', isPurchaseUnit: false, isSalesUnit: true });
      await onChanged();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="หน่วยแปลง (Unit conversion)">
      <p className="mb-3 text-sm text-slate-500">หน่วยหลัก: {baseUnit?.code ?? '—'}</p>
      <ErrorBox error={error} />
      <Table
        head={['หน่วย', `= จำนวนหน่วยหลัก (${baseUnit?.code ?? ''})`, 'ซื้อ', 'ขาย']}
        empty={conversions.length === 0}
      >
        {conversions.map((c) => (
          <tr key={c.unitId}>
            <Td className="font-mono">{c.unitCode}</Td>
            <Td>{c.factorToBase}</Td>
            <Td>{c.isPurchaseUnit ? '✓' : ''}</Td>
            <Td>{c.isSalesUnit ? '✓' : ''}</Td>
          </tr>
        ))}
      </Table>
      <form onSubmit={save} className="mt-4 flex flex-wrap items-end gap-3 border-t border-slate-100 pt-4">
        <Field label="หน่วย">
          <Select value={form.unitId} onChange={(e) => setForm({ ...form, unitId: e.target.value })} required>
            <option value="" disabled>
              — เลือกหน่วย —
            </option>
            {units
              .filter((u) => u.id !== baseUnitId)
              .map((u) => (
                <option key={u.id} value={u.id}>
                  {u.code}
                </option>
              ))}
          </Select>
        </Field>
        <Field label={`1 หน่วยนี้ = กี่ ${baseUnit?.code ?? 'หน่วยหลัก'}`}>
          <Input
            value={form.factorToBase}
            onChange={(e) => setForm({ ...form, factorToBase: e.target.value })}
            required
          />
        </Field>
        <label className="flex items-center gap-2 pb-2 text-sm">
          <input
            type="checkbox"
            checked={form.isPurchaseUnit}
            onChange={(e) => setForm({ ...form, isPurchaseUnit: e.target.checked })}
          />
          ใช้ซื้อ
        </label>
        <label className="flex items-center gap-2 pb-2 text-sm">
          <input
            type="checkbox"
            checked={form.isSalesUnit}
            onChange={(e) => setForm({ ...form, isSalesUnit: e.target.checked })}
          />
          ใช้ขาย
        </label>
        <Button type="submit" busy={busy}>
          บันทึก
        </Button>
      </form>
    </Card>
  );
}

function ImagesCard({
  productId,
  images,
  onChanged,
}: {
  productId: string;
  images: ProductImage[];
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  async function upload(file: File) {
    setBusy(true);
    setError(undefined);
    try {
      const dataBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      await api(`/products/${productId}/images`, {
        method: 'POST',
        body: { contentType: file.type, dataBase64 },
      });
      await onChanged();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    await api(`/images/${id}`, { method: 'DELETE' });
    await onChanged();
  }

  return (
    <Card
      title="รูปสินค้า"
      actions={
        <label>
          <span className="sr-only">อัปโหลดรูป</span>
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            id="image-upload"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void upload(file);
              e.target.value = '';
            }}
          />
          <Button type="button" busy={busy} onClick={() => document.getElementById('image-upload')?.click()}>
            อัปโหลดรูป
          </Button>
        </label>
      }
    >
      <ErrorBox error={error} />
      {images.length === 0 ? (
        <Notice tone="info">ยังไม่มีรูปสินค้า</Notice>
      ) : (
        <div className="flex flex-wrap gap-3">
          {images.map((img) => (
            <div key={img.id} className="relative">
              <img
                src={`/api/proxy/images/${img.id}`}
                alt={img.altText ?? ''}
                className="h-28 w-28 rounded-md border border-slate-200 object-cover"
              />
              <button
                type="button"
                onClick={() => void remove(img.id)}
                className="absolute -right-2 -top-2 rounded-full bg-red-600 px-1.5 text-xs text-white"
                aria-label="ลบรูป"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
