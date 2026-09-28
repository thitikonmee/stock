'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge, Button, Card, ErrorBox, Input, Loading, PageHeader, Table, Td } from '@/components/ui';
import { api, apiDownload } from '@/lib/client/api';
import type { Brand, Category, Product, ProductPage } from '@/lib/client/types';

const STATUS_TONE = { DRAFT: 'amber', ACTIVE: 'green', ARCHIVED: 'slate' } as const;

export default function ProductsPage() {
  const [q, setQ] = useState('');
  const [products, setProducts] = useState<Product[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>();
  const [exporting, setExporting] = useState(false);
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
      <div className="mb-4 max-w-sm">
        <Input placeholder="ค้นหาชื่อสินค้า, รหัส, SKU…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <ErrorBox error={error} />
      <Card>
        <Table
          head={['รหัส', 'ชื่อสินค้า', 'แบรนด์', 'หมวดหมู่', 'จำนวน SKU', 'สถานะ']}
          empty={!loading && products.length === 0}
        >
          {products.map((p) => (
            <tr key={p.id}>
              <Td className="font-mono">{p.code}</Td>
              <Td>
                <Link href={`/catalog/products/${p.id}`} className="text-brand-700 hover:underline">
                  {p.name}
                </Link>
              </Td>
              <Td className="text-slate-600">{brandName(p.brandId)}</Td>
              <Td className="text-slate-600">{categoryName(p.categoryId)}</Td>
              <Td>{p.variants.length}</Td>
              <Td>
                <Badge tone={STATUS_TONE[p.status]}>{p.status}</Badge>
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
    </>
  );
}
