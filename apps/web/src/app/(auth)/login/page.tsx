'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { Button, ErrorBox, Field, Input } from '@/components/ui';
import { ApiError, session } from '@/lib/client/api';

function GoogleIcon() {
  return (
    <svg className="size-4" viewBox="0 0 18 18" aria-hidden>
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.91c1.7-1.57 2.69-3.88 2.69-6.62Z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.91-2.26c-.81.54-1.84.86-3.05.86-2.35 0-4.34-1.58-5.05-3.71H.98v2.33A9 9 0 0 0 9 18Z"
      />
      <path fill="#FBBC05" d="M3.95 10.71a5.4 5.4 0 0 1 0-3.42V4.96H.98a9 9 0 0 0 0 8.08l2.97-2.33Z" />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.51.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .98 4.96l2.97 2.33C4.66 5.16 6.65 3.58 9 3.58Z"
      />
    </svg>
  );
}

function FacebookIcon() {
  return (
    <svg className="size-4" viewBox="0 0 18 18" fill="#1877F2" aria-hidden>
      <path d="M18 9a9 9 0 1 0-10.4 8.89v-6.29H5.31V9h2.29V7.02c0-2.26 1.35-3.51 3.41-3.51.99 0 2.02.18 2.02.18v2.22h-1.14c-1.12 0-1.47.7-1.47 1.42V9h2.5l-.4 2.6h-2.1v6.29A9 9 0 0 0 18 9Z" />
    </svg>
  );
}

type Step = 'credentials' | 'tenant' | 'mfa';

/** Only follow same-site relative paths after login (no open redirect). */
function nextPath(): string {
  const next = new URLSearchParams(window.location.search).get('next');
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

export default function LoginPage() {
  const [step, setStep] = useState<Step>('credentials');
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [tenants, setTenants] = useState<{ slug: string; name: string }[]>([]);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  async function signIn(tenantSlug?: string) {
    setBusy(true);
    setError(undefined);
    try {
      const res = await session('login', { identifier, password, ...(tenantSlug ? { tenantSlug } : {}) });
      if (res.status === 'mfa-required') setStep('mfa');
      else window.location.assign(nextPath());
    } catch (err) {
      if (err instanceof ApiError && err.code === 'TENANT_SELECTION_REQUIRED') {
        setTenants((err.meta.tenants as { slug: string; name: string }[]) ?? []);
        setStep('tenant');
      } else setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await session('mfa', { code });
      window.location.assign(nextPath());
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (step === 'mfa') {
    return (
      <form onSubmit={verify} className="space-y-4">
        <h1 className="text-lg font-semibold">ยืนยันตัวตน 2 ขั้นตอน</h1>
        <p className="text-sm text-slate-600">ใส่รหัส 6 หลักจากแอป Authenticator ของคุณ</p>
        <Field label="รหัสยืนยัน">
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            autoFocus
            required
          />
        </Field>
        <ErrorBox error={error} />
        <Button type="submit" busy={busy} className="w-full">
          ยืนยัน
        </Button>
      </form>
    );
  }

  if (step === 'tenant') {
    return (
      <div className="space-y-4">
        <h1 className="text-lg font-semibold">เลือกบริษัท</h1>
        <div className="space-y-2">
          {tenants.map((t) => (
            <Button
              key={t.slug}
              variant="secondary"
              className="w-full justify-between"
              onClick={() => void signIn(t.slug)}
              busy={busy}
            >
              <span>{t.name}</span>
              <span className="text-xs text-slate-500">{t.slug}</span>
            </Button>
          ))}
        </div>
        <ErrorBox error={error} />
      </div>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void signIn();
      }}
      className="space-y-4"
    >
      <h1 className="text-lg font-semibold">เข้าสู่ระบบ</h1>
      <div className="space-y-2">
        <button
          type="button"
          disabled
          title="ยังไม่เปิดให้ใช้งาน"
          className="flex h-10 w-full cursor-not-allowed items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white text-sm text-slate-400"
        >
          <GoogleIcon />
          ดำเนินการต่อด้วย Google
        </button>
        <button
          type="button"
          disabled
          title="ยังไม่เปิดให้ใช้งาน"
          className="flex h-10 w-full cursor-not-allowed items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white text-sm text-slate-400"
        >
          <FacebookIcon />
          ดำเนินการต่อด้วย Facebook
        </button>
      </div>
      <div className="flex items-center gap-3 text-xs text-slate-400">
        <span className="h-px flex-1 bg-slate-200" />
        หรือ
        <span className="h-px flex-1 bg-slate-200" />
      </div>
      <Field label="อีเมล หรือเบอร์โทร">
        <Input
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
          autoComplete="username"
          autoFocus
          required
        />
      </Field>
      <Field label="รหัสผ่าน">
        <Input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
        />
      </Field>
      <ErrorBox error={error} />
      <Button type="submit" busy={busy} className="w-full">
        เข้าสู่ระบบ
      </Button>
      <p className="text-center text-sm text-slate-600">
        ยังไม่มีบัญชี?{' '}
        <Link href="/signup" className="font-medium text-brand-700 hover:underline">
          เปิดร้านใหม่
        </Link>
      </p>
    </form>
  );
}
