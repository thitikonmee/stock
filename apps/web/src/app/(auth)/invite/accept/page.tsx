'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Button, ErrorBox, Field, Input, Notice } from '@/components/ui';
import { session } from '@/lib/client/api';

export default function AcceptInvitePage() {
  const [token, setToken] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [existing, setExisting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  useEffect(() => {
    setToken(new URLSearchParams(window.location.search).get('token') ?? '');
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await session('accept-invite', { token, password, ...(existing ? {} : { displayName }) });
      // Drop the token from history before moving on.
      window.history.replaceState(null, '', '/invite/accept');
      window.location.assign('/');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (!token) return <Notice tone="warning">ลิงก์คำเชิญไม่ถูกต้อง กรุณาเปิดจากอีเมลอีกครั้ง</Notice>;

  return (
    <form onSubmit={submit} className="space-y-4">
      <h1 className="text-lg font-semibold">ตอบรับคำเชิญ</h1>
      <div className="flex gap-2 text-sm">
        <Button variant={existing ? 'secondary' : 'primary'} onClick={() => setExisting(false)}>
          ฉันยังไม่มีบัญชี
        </Button>
        <Button variant={existing ? 'primary' : 'secondary'} onClick={() => setExisting(true)}>
          ฉันมีบัญชีอยู่แล้ว
        </Button>
      </div>
      {existing ? null : (
        <Field label="ชื่อของคุณ">
          <Input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            autoComplete="name"
            required
          />
        </Field>
      )}
      <Field
        label={existing ? 'รหัสผ่านเดิมของคุณ' : 'ตั้งรหัสผ่าน'}
        hint={existing ? undefined : 'อย่างน้อย 10 ตัวอักษร'}
      >
        <Input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={existing ? 'current-password' : 'new-password'}
          minLength={existing ? undefined : 10}
          required
        />
      </Field>
      <ErrorBox error={error} />
      <Button type="submit" busy={busy} className="w-full">
        เข้าร่วม
      </Button>
    </form>
  );
}
