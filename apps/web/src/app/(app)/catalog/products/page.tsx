'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  ErrorBox,
  Input,
  Loading,
  PageHeader,
  Table,
  Td,
} from '@/components/ui';
import { api, apiDownload } from '@/lib/client/api';
import type { Brand, Category, Product, ProductPage } from '@/lib/client/types';

const STATUS_LABEL = { DRAFT: 'ฉบับร่าง', ACTIVE: 'เปิดขาย', ARCHIVED: 'ปิดขาย' } as const;
const STATUS_TONE = { DRAFT: 'amber', ACTIVE: 'green', ARCHIVED: 'slate' } as const;

function priceLabel(product: Product): string {
  const prices = [...new Set(product.variants.map((v) => v.sellingPrice))];
  if (prices.length === 0) return '—';
  if (prices.length === 1) return `฿${Number(prices[0]).toLocaleString('th-TH')}`;
  const nums = prices.map(Number).sort((a, b) => a - b);
  return `฿${nums[0]!.toLocaleString('th-TH')} - ${nums[nums.length - 1]!.toLocaleString('th-TH')}`;
}

type BulkAction = { kind: 'archive' | 'activate' | 'delete'; ids: string[] } | null;

export default function ProductsPage() {
  const [q, setQ] = useState('');
  const [products, setProducts] = useState<Product[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>();
  const [exporting, setExporting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState<BulkAction>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (query: string, cursor?: string) => {
    setLoading(true);
    setError(undefined);
    try {
      const params = new URLSearchParams();
      if (query) params.set('q', query);
      if (cursor) params.set('cursor', cursor);
      const res = await api<ProductPage>(`/products?${params.toString()}`);
      setProducts((prev) => (cursor ? [...prev, ...res.data] : res.data));
      setNextCursor(res.page.nextCursor);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void Promise.all([api<Brand[]>('/brands'), api<Category[]>('/categories')]).then(([b, c]) => {
      setBrands(b);
      setCategories(c);
    });
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => void load(q), 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // `load` is stable (useCallback with no deps beyond setState setters); only `q` should re-trigger.
  }, [q]);

  const brandName = (id: string | null) => brands.find((b) => b.id === id)?.name ?? '—';
  const categoryName = (id: string | null) => categories.find((c) => c.id === id)?.name ?? '—';

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) => (prev.size === products.length ? new Set() : new Set(products.map((p) => p.id))));
  }

  async function runBulk() {
    if (!bulk) return;
    setBulkBusy(true);
    setError(undefined);
    try {
      for (const id of bulk.ids) {
        const product = products.find((p) => p.id === id);
        if (!product) continue;
        if (bulk.kind === 'delete') {
          await api(`/products/${id}`, { method: 'DELETE' });
        } else {
          await api(`/products/${id}`, {
            method: 'PATCH',
            headers: { 'if-match': `"v${product.version}"` },
            body: { status: bulk.kind === 'archive' ? 'ARCHIVED' : 'ACTIVE' },
          });
        }
      }
      setSelected(new Set());
      setBulk(null);
      await load(q);
    } catch (err) {
      setError(err);
    } finally {
      setBulkBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="สินค้า"
        description="ค้นหา จัดการ SKU สร้างบาร์โค้ด และพิมพ์ป้ายราคา"
        actions={
          <div className="flex gap-2">
            <Button
              variant="secondary"
              busy={exporting}
              onClick={() =>
                void (async () => {
                  setExporting(true);
                  try {
                    await apiDownload('/products/export', 'products.xlsx');
                  } catch (err) {
                    setError(err);
                  } finally {
                    setExporting(false);
                  }
                })()
              }
            >
              ส่งออก Excel
            </Button>
            <Link href="/catalog/products/import">
              <Button variant="secondary">นำเข้า Excel</Button>
            </Link>
            <Link href="/catalog/products/new">
              <Button>เพิ่มสินค้า</Button>
            </Link>
          </div>
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="max-w-sm flex-1">
          <Input
            icon={<Search className="size-4" />}
            placeholder="ค้นหาชื่อสินค้า, รหัส, SKU…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        {selected.size > 0 ? (
          <div className="flex items-center gap-2 rounded-lg border border-brand-200 bg-brand-50 px-3 py-1.5 text-sm text-brand-800">
            <span>เลือก {selected.size} รายการ</span>
            <Button
              variant="dark"
              className="h-8 px-3 text-xs"
              onClick={() => setBulk({ kind: 'archive', ids: [...selected] })}
            >
              ปิดขาย
            </Button>
            <Button
              variant="success"
              className="h-8 px-3 text-xs"
              onClick={() => setBulk({ kind: 'activate', ids: [...selected] })}
            >
              เปิดขาย
            </Button>
            <Button
              variant="danger"
              className="h-8 px-3 text-xs"
              onClick={() => setBulk({ kind: 'delete', ids: [...selected] })}
            >
              ลบสินค้า
            </Button>
          </div>
        ) : null}
      </div>
      <ErrorBox error={error} />
      <Card>
        <Table
          head={[
            products.length > 0 ? (
              <input
                type="checkbox"
                checked={selected.size === products.length}
                onChange={toggleAll}
                aria-label="เลือกทั้งหมด"
              />
            ) : (
              ''
            ),
            'รหัส',
            'ชื่อสินค้า',
            'แบรนด์',
            'หมวดหมู่',
            'จำนวน SKU',
            'ราคาขาย',
            'สถานะ',
          ]}
          empty={!loading && products.length === 0}
        >
          {products.map((p) => (
            <tr key={p.id}>
              <Td>
                <input
                  type="checkbox"
                  checked={selected.has(p.id)}
                  onChange={() => toggle(p.id)}
                  aria-label={`เลือก ${p.name}`}
                />
              </Td>
              <Td className="font-mono">{p.code}</Td>
              <Td>
                <Link href={`/catalog/products/${p.id}`} className="text-brand-700 hover:underline">
                  {p.name}
                </Link>
              </Td>
              <Td className="text-slate-600">{brandName(p.brandId)}</Td>
              <Td className="text-slate-600">{categoryName(p.categoryId)}</Td>
              <Td>{p.variants.length}</Td>
              <Td>{priceLabel(p)}</Td>
              <Td>
                <Badge tone={STATUS_TONE[p.status]}>{STATUS_LABEL[p.status]}</Badge>
              </Td>
            </tr>
          ))}
        </Table>
        {loading ? <Loading /> : null}
        {!loading && nextCursor ? (
          <div className="border-t border-slate-100 p-4 text-center">
            <Button variant="secondary" onClick={() => void load(q, nextCursor)}>
              โหลดเพิ่ม
            </Button>
          </div>
        ) : null}
      </Card>

      <ConfirmDialog
        open={bulk !== null}
        onClose={() => setBulk(null)}
        onConfirm={() => void runBulk()}
        busy={bulkBusy}
        tone={bulk?.kind === 'delete' ? 'danger' : bulk?.kind === 'activate' ? 'success' : 'neutral'}
        title={
          bulk?.kind === 'delete'
            ? 'คุณกำลังจะลบสินค้าที่เลือก'
            : bulk?.kind === 'activate'
              ? 'คุณกำลังจะเปิดขายสินค้าที่เลือก'
              : 'คุณกำลังจะปิดขายสินค้าที่เลือก'
        }
        description={
          bulk?.kind === 'delete'
            ? 'สินค้าจะไม่สามารถแสดงหรือขายได้อีก และไม่สามารถกู้คืนได้ กรุณาตรวจสอบก่อนยืนยัน'
            : bulk?.kind === 'activate'
              ? 'สินค้าจะสามารถแสดงและขายได้ทันทีหลังยืนยัน'
              : 'สินค้าจะไม่สามารถขายได้จนกว่าจะเปิดขายอีกครั้ง'
        }
        confirmWord={bulk?.kind === 'delete' ? 'ลบสินค้าที่เลือก' : undefined}
        actionLabel={bulk?.kind === 'delete' ? 'ลบสินค้า' : bulk?.kind === 'activate' ? 'เปิดขาย' : 'ปิดขาย'}
      />
    </>
  );
}
