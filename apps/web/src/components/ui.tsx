'use client';

import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';
import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Info, Loader2, PackageCheck, PackageX, Trash2 } from 'lucide-react';
import { messageFor } from '@/lib/client/messages';

const cx = (...classes: (string | false | null | undefined)[]) => classes.filter(Boolean).join(' ');

type Variant = 'primary' | 'secondary' | 'danger' | 'success' | 'dark' | 'ghost';

export function Button({
  variant = 'primary',
  busy,
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; busy?: boolean }) {
  const styles: Record<Variant, string> = {
    primary: 'bg-brand-600 text-white hover:bg-brand-700 disabled:bg-slate-300',
    secondary: 'border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 disabled:text-slate-400',
    danger: 'bg-red-600 text-white hover:bg-red-700 disabled:bg-slate-300',
    success: 'bg-emerald-600 text-white hover:bg-emerald-700 disabled:bg-slate-300',
    dark: 'bg-slate-900 text-white hover:bg-slate-800 disabled:bg-slate-300',
    ghost: 'text-slate-700 hover:bg-slate-100',
  };
  return (
    <button
      type="button"
      {...props}
      disabled={props.disabled || busy}
      className={cx(
        'inline-flex h-10 items-center justify-center gap-2 rounded-lg px-4 text-sm font-medium transition',
        styles[variant],
        className,
      )}
    >
      {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
      {busy ? 'กำลังดำเนินการ…' : children}
    </button>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  const required = label.trim().endsWith('*');
  const text = required ? label.trim().slice(0, -1).trim() : label;
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium text-slate-700">
        {text}
        {required ? <span className="ml-0.5 text-red-500">*</span> : null}
      </span>
      {children}
      {hint ? <span className="block text-xs text-slate-500">{hint}</span> : null}
    </label>
  );
}

export function Input({
  className,
  icon,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { icon?: ReactNode }) {
  if (icon) {
    return (
      <div className="relative">
        <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-slate-400">
          {icon}
        </span>
        <input
          {...props}
          className={cx(
            'h-10 w-full rounded-lg border border-slate-300 bg-white pl-9 pr-3 text-sm placeholder:text-slate-400 focus:border-brand-500',
            className,
          )}
        />
      </div>
    );
  }
  return (
    <input
      {...props}
      className={cx(
        'h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm placeholder:text-slate-400 focus:border-brand-500',
        className,
      )}
    />
  );
}

export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={cx('h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm', className)}
    >
      {children}
    </select>
  );
}

export function Card({
  title,
  actions,
  children,
  className,
  tint,
}: {
  title?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Light-blue-tinted panel background, for highlight/info groupings (safety-stock options,
   *  product-attributes panel) — matches the reference's soft-blue callout cards. */
  tint?: boolean;
}) {
  return (
    <section
      className={cx(
        'rounded-xl border shadow-sm',
        tint ? 'border-brand-100 bg-brand-50/60' : 'border-slate-200 bg-white',
        className,
      )}
    >
      {title || actions ? (
        <header className="flex items-center justify-between gap-4 border-b border-slate-100 px-5 py-3">
          {title ? <h2 className="font-semibold">{title}</h2> : <span />}
          {actions}
        </header>
      ) : null}
      <div className="p-5">{children}</div>
    </section>
  );
}

export interface Crumb {
  label: string;
  href?: string;
}

export function PageHeader({
  title,
  description,
  actions,
  breadcrumb,
}: {
  title: ReactNode;
  description?: string;
  actions?: ReactNode;
  breadcrumb?: Crumb[];
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        {breadcrumb && breadcrumb.length > 0 ? (
          <nav
            aria-label="breadcrumb"
            className="mb-1 flex flex-wrap items-center gap-1 text-xs text-slate-500"
          >
            {breadcrumb.map((c, i) => (
              <span key={i} className="flex items-center gap-1">
                {i > 0 ? <span className="text-slate-300">/</span> : null}
                {c.href ? (
                  <a href={c.href} className="hover:text-brand-700">
                    {c.label}
                  </a>
                ) : (
                  <span>{c.label}</span>
                )}
              </span>
            ))}
          </nav>
        ) : null}
        <h1 className="text-2xl font-semibold">{title}</h1>
        {description ? <p className="mt-1 text-sm text-slate-600">{description}</p> : null}
      </div>
      {actions}
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
      {messageFor(error)}
    </div>
  );
}

export function Notice({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'success' | 'warning';
  children: ReactNode;
}) {
  const styles = {
    info: 'border-sky-200 bg-sky-50 text-sky-900',
    success: 'border-emerald-200 bg-emerald-50 text-emerald-900',
    warning: 'border-amber-200 bg-amber-50 text-amber-900',
  };
  return <div className={cx('rounded-lg border px-4 py-3 text-sm', styles[tone])}>{children}</div>;
}

export function Badge({
  tone = 'slate',
  children,
}: {
  tone?: 'slate' | 'green' | 'amber' | 'red' | 'teal';
  children: ReactNode;
}) {
  const styles = {
    slate: 'bg-slate-100 text-slate-700',
    green: 'bg-emerald-100 text-emerald-800',
    amber: 'bg-amber-100 text-amber-800',
    red: 'bg-red-100 text-red-800',
    teal: 'bg-brand-100 text-brand-800',
  };
  return (
    <span className={cx('inline-flex rounded-full px-2 py-0.5 text-xs font-medium', styles[tone])}>
      {children}
    </span>
  );
}

export function Table({
  head,
  children,
  empty,
}: {
  /** Plain strings for text headers; pass a `ReactNode` (e.g. a select-all checkbox) for a column
   *  that needs interactive header content. */
  head: (string | ReactNode)[];
  children: ReactNode;
  empty?: boolean;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
          <tr>
            {head.map((h, i) => (
              // Index, not label: `head` is a static, order-stable array and some tables repeat an
              // empty '' header for a leading checkbox column and a trailing actions column.
              <th key={i} className="px-3 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">{children}</tbody>
      </table>
      {empty ? <p className="px-3 py-6 text-center text-sm text-slate-500">ยังไม่มีข้อมูล</p> : null}
    </div>
  );
}

export function Td({ children, className }: { children: ReactNode; className?: string }) {
  return <td className={cx('px-3 py-2 align-middle', className)}>{children}</td>;
}

export function Modal({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      aria-label={title}
      className="m-auto w-full max-w-lg rounded-2xl p-0 shadow-xl backdrop:bg-slate-900/40"
    >
      <div className="border-b border-slate-100 px-5 py-3 font-semibold">{title}</div>
      <div className="space-y-4 p-5">{children}</div>
    </dialog>
  );
}

type DialogTone = 'danger' | 'warning' | 'success' | 'neutral' | 'info';

const DIALOG_TONE_STYLES: Record<DialogTone, { bg: string; fg: string; Icon: typeof Trash2 }> = {
  danger: { bg: 'bg-red-100', fg: 'text-red-600', Icon: Trash2 },
  warning: { bg: 'bg-amber-100', fg: 'text-amber-600', Icon: AlertTriangle },
  success: { bg: 'bg-emerald-100', fg: 'text-emerald-600', Icon: PackageCheck },
  neutral: { bg: 'bg-slate-100', fg: 'text-slate-500', Icon: PackageX },
  info: { bg: 'bg-brand-100', fg: 'text-brand-700', Icon: Info },
};

/** Pastel circular icon badge used by `ConfirmDialog` — matches the reference's confirm-dialog
 *  icon treatment (soft-tinted circle, solid icon). Exported in case a page needs the same badge
 *  outside a dialog (e.g. next to a status label). */
export function IconCircle({ tone, className }: { tone: DialogTone; className?: string }) {
  const { bg, fg, Icon } = DIALOG_TONE_STYLES[tone];
  return (
    <span className={cx('inline-flex size-14 items-center justify-center rounded-full', bg, fg, className)}>
      <Icon className="size-6" aria-hidden />
    </span>
  );
}

/**
 * Icon-circle confirmation dialog (reference's "Dialog Confirm Remove/Off/On Product" family).
 * For a destructive action, pass `confirmWord` (e.g. "ลบสินค้า") to require the user type it
 * back before the action button enables — matches the reference's type-to-confirm delete dialogs.
 */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  tone,
  title,
  description,
  confirmWord,
  actionLabel,
  actionVariant,
  busy,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  tone: DialogTone;
  title: string;
  description?: string;
  /** If set, the action button stays disabled until the user types this exact text. */
  confirmWord?: string;
  actionLabel: string;
  actionVariant?: Variant;
  busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [typed, setTyped] = useState('');
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
    if (open) setTyped('');
  }, [open]);
  const locked = Boolean(confirmWord) && typed !== confirmWord;
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      aria-label={title}
      className="m-auto w-full max-w-sm rounded-2xl p-0 shadow-xl backdrop:bg-slate-900/40"
    >
      <div className="flex flex-col items-center gap-4 px-6 py-8 text-center">
        <IconCircle tone={tone} />
        <div>
          <h2 className="font-semibold">{title}</h2>
          {description ? <p className="mt-1 text-sm text-slate-600">{description}</p> : null}
        </div>
        {confirmWord ? (
          <div className="w-full text-left">
            <p className="mb-1 flex items-center gap-1 text-xs text-red-600">
              <AlertTriangle className="size-3.5" aria-hidden />
              พิมพ์คำว่า “{confirmWord}” เพื่อยืนยัน
            </p>
            <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={confirmWord} />
          </div>
        ) : null}
        <div className="flex w-full justify-center gap-2">
          <Button variant="secondary" className="flex-1" onClick={onClose}>
            ยกเลิก
          </Button>
          <Button
            variant={
              actionVariant ?? (tone === 'danger' ? 'danger' : tone === 'success' ? 'success' : 'dark')
            }
            className="flex-1"
            onClick={onConfirm}
            disabled={locked}
            busy={busy}
          >
            {actionLabel}
          </Button>
        </div>
      </div>
    </dialog>
  );
}

export function Loading() {
  return (
    <p className="flex items-center gap-2 py-6 text-sm text-slate-500">
      <Loader2 className="size-4 animate-spin" aria-hidden />
      กำลังโหลด…
    </p>
  );
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  return new Date(value).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' });
}
