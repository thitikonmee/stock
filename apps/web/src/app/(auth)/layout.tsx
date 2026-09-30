import type { ReactNode } from 'react';
import { AlertTriangle, Package, TrendingUp } from 'lucide-react';

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-screen">
      <section className="relative hidden w-1/2 flex-col justify-between overflow-hidden bg-gradient-to-br from-brand-500 via-brand-700 to-brand-900 p-10 text-white lg:flex">
        <div className="flex flex-wrap items-start gap-3">
          <div className="flex items-center gap-2 rounded-xl bg-white/90 px-3 py-2 text-slate-900 shadow-lg">
            <AlertTriangle className="size-4 text-amber-500" aria-hidden />
            <span className="text-xs font-medium">สต็อกใกล้หมด — ต้องเติม 3 รายการ</span>
          </div>
          <div className="flex items-center gap-2 rounded-xl bg-white/90 px-3 py-2 text-slate-900 shadow-lg">
            <Package className="size-4 text-brand-600" aria-hidden />
            <span className="text-xs font-medium">รับสินค้าเข้า 128 ชิ้น วันนี้</span>
          </div>
          <div className="flex items-center gap-2 rounded-xl bg-white/90 px-3 py-2 text-slate-900 shadow-lg">
            <TrendingUp className="size-4 text-emerald-600" aria-hidden />
            <span className="text-xs font-medium">ยอดขาย ฿1.25M เดือนนี้ ↑12%</span>
          </div>
        </div>
        <div>
          <h1 className="text-4xl font-bold leading-tight">
            จัดการสต็อกและ
            <br />
            ขายได้ทุกช่องทาง
          </h1>
          <p className="mt-3 max-w-sm text-sm text-white/80">
            ติดตามสต็อกแบบเรียลไทม์ จัดการ SKU ราคา และรายงาน ครบในที่เดียว
          </p>
        </div>
      </section>
      <section className="flex w-full flex-col items-center justify-center px-4 py-12 lg:w-1/2">
        <div className="w-full max-w-md">
          <div className="mb-8 text-center">
            <p className="text-sm text-slate-500">ยินดีต้อนรับ</p>
            <div className="mt-1 flex items-center justify-center gap-2">
              <span className="flex size-8 items-center justify-center rounded-lg bg-brand-600 text-sm font-bold text-white">
                S
              </span>
              <span className="text-2xl font-bold text-slate-900">StockOS</span>
            </div>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">{children}</div>
        </div>
      </section>
    </main>
  );
}
