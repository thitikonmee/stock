'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { Button, ErrorBox, Field, Input } from '@/components/ui';
import { session } from '@/lib/client/api';

const slugify = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

export default function SignupPage() {
  const [form, setForm] = useState({ companyName: '', slug: '', ownerName: '', email: '', password: '' });
  const [slugTouched, setSlugTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const set = (key: keyof typeof form) => (value: string) => setForm((f) => ({ ...f, [key]: value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await session('signup', form);
      window.location.assign('/');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <h1 className="text-lg font-semibold">เปิดร้านใหม่ (ทดลองใช้ฟรี 14 วัน)</h1>
      <Field label="ชื่อร้าน / บริษัท">
        <Input
          value={form.companyName}
          onChange={(e) => {
            set('companyName')(e.target.value);
            if (!slugTouched) set('slug')(slugify(e.target.value));
          }}
          required
          autoFocus
        />
      </Field>
      <Field
        label="ชื่อร้านสำหรับเข้าสู่ระบบ"
        hint="ภาษาอังกฤษตัวเล็ก ตัวเลข และ - เช่น my-shop (ใช้ตอนลงทะเบียนเครื่อง POS)"
      >
        <Input
          value={form.slug}
          onChange={(e) => {
            setSlugTouched(true);
            set('slug')(e.target.value.toLowerCase());
          }}
          pattern="[a-z0-9][a-z0-9-]{1,38}[a-z0-9]"
          required
        />
      </Field>
      <Field label="ชื่อของคุณ">
        <Input
          value={form.ownerName}
          onChange={(e) => set('ownerName')(e.target.value)}
          autoComplete="name"
          required
        />
      </Field>
      <Field label="อีเมล">
        <Input
          type="email"
          value={form.email}
          onChange={(e) => set('email')(e.target.value)}
          autoComplete="email"
          required
        />
      </Field>
      <Field label="รหัสผ่าน" hint="อย่างน้อย 10 ตัวอักษร">
        <Input
          type="password"
          value={form.password}
          onChange={(e) => set('password')(e.target.value)}
          autoComplete="new-password"
          minLength={10}
          required
        />
      </Field>
      <ErrorBox error={error} />
      <Button type="submit" busy={busy} className="w-full">
        สร้างร้าน
      </Button>
      <p className="text-center text-sm text-slate-600">
        มีบัญชีแล้ว?{' '}
        <Link href="/login" className="font-medium text-brand-700 hover:underline">
          เข้าสู่ระบบ
        </Link>
      </p>
    </form>
  );
}
