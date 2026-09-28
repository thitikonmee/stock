'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { Button, ErrorBox, Field, Input } from '@/components/ui';
import { ApiError, session } from '@/lib/client/api';

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
