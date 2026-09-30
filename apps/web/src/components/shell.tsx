'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  Bell,
  Building2,
  ChevronDown,
  HelpCircle,
  LayoutDashboard,
  LogOut,
  Package,
  Search,
  Settings as SettingsIcon,
  Share2,
  ShoppingCart,
  Sparkles,
  Warehouse,
} from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from 'react';
import { Button, ErrorBox, Field, Input, Modal, Notice } from '@/components/ui';
import { registerStepUpHandler, session } from '@/lib/client/api';
import type { AppNotification, Branch, Me } from '@/lib/client/types';
import { can } from '@/lib/client/types';
import { useResource } from '@/lib/client/use-resource';

const MeContext = createContext<{ me: Me | undefined; reloadMe: () => Promise<void> }>({
  me: undefined,
  reloadMe: async () => {},
});
export const useMe = () => useContext(MeContext);

const BRANCH_STORAGE_KEY = 'stockos.branchId';
const BranchContext = createContext<{
  branches: Branch[] | undefined;
  branchId: string | null;
  setBranchId: (id: string | null) => void;
}>({ branches: undefined, branchId: null, setBranchId: () => {} });
/** The globally-selected branch/warehouse (header switcher). Not yet wired to filter any page's
 *  data — pages that want to scope themselves to it opt in individually as a follow-up. */
export const useBranch = () => useContext(BranchContext);

interface NavLeaf {
  href: string;
  label: string;
  permission?: string;
}
interface NavSection {
  key: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  /** A section with no sub-items navigates directly on rail click; one with `items` opens the
   *  secondary panel instead (matches the reference's icon-rail + text-label sub-panel pattern). */
  href?: string;
  permission?: string;
  items?: NavLeaf[];
}

const NAV_SECTIONS: NavSection[] = [
  { key: 'home', label: 'หน้าหลัก', icon: LayoutDashboard, href: '/' },
  {
    key: 'catalog',
    label: 'สินค้า',
    icon: Package,
    items: [
      { href: '/catalog/products', label: 'รายการสินค้า', permission: 'product.read' },
      { href: '/catalog/products/new', label: 'สร้างสินค้า', permission: 'product.read' },
      { href: '/catalog/categories', label: 'หมวดหมู่/แบรนด์/หน่วย', permission: 'product.read' },
      { href: '/catalog/suppliers', label: 'ผู้จัดจำหน่าย', permission: 'supplier.read' },
    ],
  },
  {
    key: 'inventory',
    label: 'คลังสินค้า',
    icon: Warehouse,
    items: [
      { href: '/inventory/stock', label: 'สต็อกสินค้า', permission: 'inventory.read' },
      { href: '/inventory/adjustments', label: 'ปรับสต็อก', permission: 'inventory.read' },
    ],
  },
  { key: 'orders', label: 'ออเดอร์', icon: ShoppingCart, href: '/orders', permission: 'order.read' },
  { key: 'channels', label: 'ช่องทางขาย', icon: Share2, href: '/channels', permission: 'channel.read' },
  {
    key: 'settings',
    label: 'การตั้งค่า',
    icon: SettingsIcon,
    items: [
      { href: '/settings/branches', label: 'สาขาและคลัง' },
      { href: '/settings/devices', label: 'เครื่อง POS', permission: 'device.manage' },
      { href: '/settings/users', label: 'ผู้ใช้งาน', permission: 'user.read' },
      { href: '/settings/roles', label: 'บทบาทและสิทธิ์', permission: 'user.read' },
      { href: '/settings/api-keys', label: 'API keys', permission: 'api_key.manage' },
      { href: '/settings/security', label: 'ความปลอดภัย' },
      { href: '/settings/billing', label: 'แพ็กเกจ' },
    ],
  },
];

function visibleSections(me: Me | undefined): NavSection[] {
  return NAV_SECTIONS.map((s) => ({
    ...s,
    items: s.items?.filter((i) => !i.permission || can(me, i.permission)),
  })).filter((s) => (s.items ? s.items.length > 0 : !s.permission || can(me, s.permission)));
}

function allLeaves(me: Me | undefined): NavLeaf[] {
  const leaves: NavLeaf[] = [];
  for (const s of visibleSections(me)) {
    if (s.href) leaves.push({ href: s.href, label: s.label });
    if (s.items) leaves.push(...s.items);
  }
  return leaves;
}

/** Mirrors the API's checks so users see a clear message instead of empty pages. The API still enforces. */
function allowedPath(me: Me, pathname: string): boolean {
  const item = allLeaves(me)
    .filter((n) => n.href !== '/' && pathname.startsWith(n.href))
    .sort((a, b) => b.href.length - a.href.length)[0];
  return !item?.permission || can(me, item.permission);
}

function activeSectionKey(sections: NavSection[], pathname: string): string | null {
  const matches = sections.filter((s) => {
    if (s.href) return s.href === '/' ? pathname === '/' : pathname.startsWith(s.href);
    return s.items?.some((i) => pathname.startsWith(i.href));
  });
  return (
    matches.sort(
      (a, b) => (b.href ?? b.items?.[0]?.href ?? '').length - (a.href ?? a.items?.[0]?.href ?? '').length,
    )[0]?.key ?? null
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const { data: me, reload } = useResource<Me>('/me');
  const { data: unread } = useResource<AppNotification[]>('/notifications?unread=true');
  const { data: branches } = useResource<Branch[]>('/branches');
  const pathname = usePathname();
  const router = useRouter();

  const [branchId, setBranchIdState] = useState<string | null>(null);
  useEffect(() => {
    setBranchIdState(localStorage.getItem(BRANCH_STORAGE_KEY));
  }, []);
  const setBranchId = useCallback((id: string | null) => {
    setBranchIdState(id);
    if (id) localStorage.setItem(BRANCH_STORAGE_KEY, id);
    else localStorage.removeItem(BRANCH_STORAGE_KEY);
  }, []);

  useEffect(() => {
    if (me?.mfaEnrollmentRequired && !pathname.startsWith('/settings/security'))
      router.replace('/settings/security?required=1');
  }, [me, pathname, router]);

  const sections = useMemo(() => visibleSections(me), [me]);
  const activeKey = activeSectionKey(sections, pathname);
  const activeSection = sections.find((s) => s.key === activeKey);

  return (
    <MeContext.Provider value={{ me, reloadMe: reload }}>
      <BranchContext.Provider value={{ branches, branchId, setBranchId }}>
        <StepUpProvider />
        <div className="flex min-h-screen">
          <NavRail sections={sections} activeKey={activeKey} />
          {activeSection?.items ? <SecondaryPanel section={activeSection} pathname={pathname} /> : null}
          <div className="flex min-w-0 flex-1 flex-col">
            <Header me={me} unreadCount={unread?.length ?? 0} sections={sections} />
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
      </BranchContext.Provider>
    </MeContext.Provider>
  );
}

function NavRail({ sections, activeKey }: { sections: NavSection[]; activeKey: string | null }) {
  return (
    <aside className="hidden w-16 shrink-0 flex-col items-center border-r border-slate-200 bg-white py-4 md:flex">
      <div className="mb-4 flex size-9 items-center justify-center rounded-xl bg-brand-600 text-sm font-bold text-white">
        S
      </div>
      <nav className="flex flex-1 flex-col items-center gap-1" aria-label="เมนูหลัก">
        {sections.map((s) => {
          const active = s.key === activeKey;
          const Icon = s.icon;
          const href = s.href ?? s.items?.[0]?.href ?? '#';
          return (
            <Link
              key={s.key}
              href={href}
              title={s.label}
              aria-current={active ? 'page' : undefined}
              className={`flex size-11 items-center justify-center rounded-xl transition ${
                active ? 'bg-brand-100 text-brand-700' : 'text-slate-500 hover:bg-slate-100'
              }`}
            >
              <Icon className="size-5" />
            </Link>
          );
        })}
      </nav>
      <a
        href="mailto:support@stockos.co"
        title="ศูนย์ช่วยเหลือ"
        className="flex size-11 items-center justify-center rounded-xl text-slate-400 hover:bg-slate-100 hover:text-slate-600"
      >
        <HelpCircle className="size-5" />
      </a>
    </aside>
  );
}

function SecondaryPanel({ section, pathname }: { section: NavSection; pathname: string }) {
  return (
    <aside className="hidden w-56 shrink-0 border-r border-slate-200 bg-white px-3 py-5 md:block">
      <div className="px-2 pb-4 text-lg font-bold text-slate-900">{section.label}</div>
      <nav className="space-y-0.5" aria-label={section.label}>
        {section.items?.map((item) => {
          const active = pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`block rounded-lg px-3 py-2 text-sm ${
                active ? 'bg-brand-50 font-medium text-brand-800' : 'text-slate-700 hover:bg-slate-50'
              }`}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}

function Header({
  me,
  unreadCount,
  sections,
}: {
  me: Me | undefined;
  unreadCount: number;
  sections: NavSection[];
}) {
  return (
    <header className="flex h-16 items-center gap-4 border-b border-slate-200 bg-white px-6">
      <BranchSwitcher />
      <QuickNav sections={sections} />
      <div className="flex items-center gap-2">
        <Link href="/settings/billing">
          <Button className="h-9 px-3 text-sm">
            <Sparkles className="size-4" aria-hidden />
            อัปเกรด
          </Button>
        </Link>
        <Link
          href="/notifications"
          aria-label="การแจ้งเตือน"
          className="relative flex size-9 items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100"
        >
          <Bell className="size-5" />
          {unreadCount > 0 ? (
            <span className="absolute right-1 top-1 flex size-2 rounded-full bg-red-500" />
          ) : null}
        </Link>
        <AvatarMenu me={me} />
      </div>
    </header>
  );
}

function BranchSwitcher() {
  const { branches, branchId, setBranchId } = useBranch();
  const current = branches?.find((b) => b.id === branchId);
  const pathname = usePathname();
  return (
    // Remounted per route so the native <details> disclosure resets to closed after navigating
    // away via the rail/quick-nav (which don't go through this component's own close handlers).
    <details key={pathname} className="group relative">
      <summary className="flex h-9 cursor-pointer list-none items-center gap-2 rounded-lg border border-slate-200 px-3 text-sm text-slate-700 hover:bg-slate-50">
        <Building2 className="size-4 text-slate-400" />
        <span className="max-w-32 truncate">{current?.name ?? 'ทุกสาขา'}</span>
        <ChevronDown className="size-3.5 text-slate-400" />
      </summary>
      <div className="absolute left-0 top-full z-20 mt-1 w-48 rounded-lg border border-slate-200 bg-white py-1 shadow-lg">
        <button
          type="button"
          onClick={(e) => {
            setBranchId(null);
            e.currentTarget.closest('details')?.removeAttribute('open');
          }}
          className={`block w-full px-3 py-1.5 text-left text-sm hover:bg-slate-50 ${!branchId ? 'font-medium text-brand-700' : 'text-slate-700'}`}
        >
          ทุกสาขา
        </button>
        {(branches ?? []).map((b) => (
          <button
            key={b.id}
            type="button"
            onClick={(e) => {
              setBranchId(b.id);
              e.currentTarget.closest('details')?.removeAttribute('open');
            }}
            className={`block w-full truncate px-3 py-1.5 text-left text-sm hover:bg-slate-50 ${
              branchId === b.id ? 'font-medium text-brand-700' : 'text-slate-700'
            }`}
          >
            {b.name}
          </button>
        ))}
      </div>
    </details>
  );
}

function QuickNav({ sections }: { sections: NavSection[] }) {
  const [query, setQuery] = useState('');
  const leaves = useMemo(() => {
    const out: NavLeaf[] = [];
    for (const s of sections) {
      if (s.href) out.push({ href: s.href, label: s.label });
      if (s.items) out.push(...s.items);
    }
    return out;
  }, [sections]);
  const matches =
    query.trim().length > 0
      ? leaves.filter((l) => l.label.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 8)
      : [];
  return (
    <div className="relative max-w-md flex-1">
      <Input
        icon={<Search className="size-4" />}
        placeholder="ค้นหาหรือไปยังเมนู…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && matches[0]) {
            window.location.assign(matches[0].href);
          }
        }}
      />
      {matches.length > 0 ? (
        <div className="absolute left-0 top-full z-20 mt-1 w-full rounded-lg border border-slate-200 bg-white py-1 shadow-lg">
          {matches.map((m) => (
            <Link
              key={m.href}
              href={m.href}
              onClick={() => setQuery('')}
              className="block px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
            >
              {m.label}
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function AvatarMenu({ me }: { me: Me | undefined }) {
  const initial = (me?.displayName ?? '?').trim().charAt(0).toUpperCase();
  return (
    <details className="group relative">
      <summary className="flex size-9 cursor-pointer list-none items-center justify-center rounded-full bg-brand-100 text-sm font-semibold text-brand-800">
        {initial}
      </summary>
      <div className="absolute right-0 top-full z-20 mt-1 w-44 rounded-lg border border-slate-200 bg-white py-1 shadow-lg">
        <div className="truncate border-b border-slate-100 px-3 py-2 text-sm text-slate-700">
          {me?.displayName}
        </div>
        <button
          type="button"
          onClick={async () => {
            await session('logout').catch(() => undefined);
            window.location.assign('/login');
          }}
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50"
        >
          <LogOut className="size-4" />
          ออกจากระบบ
        </button>
      </div>
    </details>
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
