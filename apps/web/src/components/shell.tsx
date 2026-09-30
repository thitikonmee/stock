'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, ErrorBox, Field, Input, Modal, Notice } from '@/components/ui';
import { registerStepUpHandler, session } from '@/lib/client/api';
import type { AppNotification, Me } from '@/lib/client/types';
import { can } from '@/lib/client/types';
import { useResource } from '@/lib/client/use-resource';

const MeContext = createContext<{ me: Me | undefined; reloadMe: () => Promise<void> }>({
  me: undefined,
  reloadMe: async () => {},
});
export const useMe = () => useContext(MeContext);

const NAV: { href: string; label: string; permission?: string }[] = [
  { href: '/', label: 'หน้าหลัก' },
  { href: '/catalog/products', label: 'สินค้า', permission: 'product.read' },
  { href: '/catalog/categories', label: 'หมวดหมู่/แบรนด์/หน่วย', permission: 'product.read' },
  { href: '/catalog/suppliers', label: 'ผู้จัดจำหน่าย', permission: 'supplier.read' },
  { href: '/inventory/stock', label: 'สต็อกสินค้า', permission: 'inventory.read' },
  { href: '/inventory/adjustments', label: 'ปรับสต็อก', permission: 'inventory.read' },
  { href: '/orders', label: 'ออเดอร์', permission: 'order.read' },
  { href: '/channels', label: 'ช่องทางขาย', permission: 'channel.read' },
  { href: '/settings/branches', label: 'สาขาและคลัง' },
  { href: '/settings/devices', label: 'เครื่อง POS', permission: 'device.manage' },
  { href: '/settings/users', label: 'ผู้ใช้งาน', permission: 'user.read' },
  { href: '/settings/roles', label: 'บทบาทและสิทธิ์', permission: 'user.read' },
  { href: '/settings/api-keys', label: 'API keys', permission: 'api_key.manage' },
  { href: '/settings/security', label: 'ความปลอดภัย' },
  { href: '/settings/billing', label: 'แพ็กเกจ' },
];

/** Mirrors the API's checks so users see a clear message instead of empty pages. The API still enforces. */
function allowedPath(me: Me, pathname: string): boolean {
  const item = NAV.filter((n) => n.href !== '/' && pathname.startsWith(n.href)).sort(
    (a, b) => b.href.length - a.href.length,
  )[0];
  return !item?.permission || can(me, item.permission);
}

export function Shell({ children }: { children: ReactNode }) {
  const { data: me, reload } = useResource<Me>('/me');
  const { data: unread } = useResource<AppNotification[]>('/notifications?unread=true');
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (me?.mfaEnrollmentRequired && !pathname.startsWith('/settings/security'))
      router.replace('/settings/security?required=1');
  }, [me, pathname, router]);

  return (
    <MeContext.Provider value={{ me, reloadMe: reload }}>
      <StepUpProvider />
      <div className="flex min-h-screen">
        <aside className="hidden w-60 shrink-0 border-r border-slate-200 bg-white md:block">
          <div className="px-5 py-5 text-xl font-bold text-brand-700">StockOS</div>
          <nav className="space-y-0.5 px-3" aria-label="เมนูหลัก">
            {NAV.filter((item) => !item.permission || can(me, item.permission)).map((item) => {
              const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`block rounded-md px-3 py-2 text-sm ${active ? 'bg-brand-50 font-medium text-brand-800' : 'text-slate-700 hover:bg-slate-50'}`}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-14 items-center justify-between border-b border-slate-200 bg-white px-6">
            <div className="text-sm font-medium text-slate-700">{me?.tenant.name ?? ''}</div>
            <div className="flex items-center gap-4 text-sm">
              <Link
                href="/notifications"
                className="relative text-slate-700 hover:text-brand-700"
                aria-label="การแจ้งเตือน"
              >
                การแจ้งเตือน
                {unread && unread.length > 0 ? (
                  <span className="ml-1 rounded-full bg-red-600 px-1.5 py-0.5 text-xs text-white">
                    {unread.length}
                  </span>
                ) : null}
              </Link>
              <span className="text-slate-500">{me?.displayName}</span>
              <Button
                variant="ghost"
                onClick={async () => {
                  await session('logout').catch(() => undefined);
                  window.location.assign('/login');
                }}
              >
                ออกจากระบบ
              </Button>
            </div>
          </header>
          <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">
            {me && !allowedPath(me, pathname) ? (
              <Notice tone="warning">
                คุณไม่มีสิทธิ์เข้าหน้านี้ ติดต่อผู้ดูแลระบบของบริษัทหากต้องการใช้งาน
              </Notice>
            ) : (
              children
            )}
          </main>
        </div>
      </div>
    </MeContext.Provider>
  );
}

/** Asks for a 2FA code when the API answers STEP_UP_REQUIRED, then lets the request retry. */
function StepUpProvider() {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const finish = useCallback((ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = null;
    setOpen(false);
    setCode('');
    setError(undefined);
  }, []);

  useEffect(() => {
    registerStepUpHandler(
      () =>
        new Promise<boolean>((resolve) => {
          resolver.current = resolve;
          setOpen(true);
        }),
    );
    return () => registerStepUpHandler(null);
  }, []);

  return (
    <Modal open={open} title="ยืนยันด้วยรหัส 2FA" onClose={() => finish(false)}>
      <p className="text-sm text-slate-600">
        รายการนี้มีความเสี่ยงสูง กรุณาใส่รหัส 6 หลักจากแอป Authenticator
      </p>
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await session('step-up', { code });
            finish(true);
          } catch (err) {
            setError(err);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="รหัสยืนยัน">
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            inputMode="numeric"
            maxLength={6}
            autoFocus
            required
          />
        </Field>
        <ErrorBox error={error} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => finish(false)}>
            ยกเลิก
          </Button>
          <Button type="submit" busy={busy}>
            ยืนยัน
          </Button>
        </div>
      </form>
    </Modal>
  );
}
