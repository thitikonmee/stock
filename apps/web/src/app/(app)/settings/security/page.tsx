'use client';

import QRCode from 'qrcode';
import { useEffect, useState, type FormEvent } from 'react';
import { useMe } from '@/components/shell';
import { Badge, Button, Card, ErrorBox, Field, Input, Notice, PageHeader } from '@/components/ui';
import { api } from '@/lib/client/api';

export default function SecurityPage() {
  const { me, reloadMe } = useMe();
  const [required, setRequired] = useState(false);
  const [enrolment, setEnrolment] = useState<{ secret: string; otpauthUri: string; qr: string } | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [done, setDone] = useState(false);

  useEffect(() => setRequired(new URLSearchParams(window.location.search).has('required')), []);

  async function start() {
    setBusy(true);
    setError(undefined);
    try {
      const res = await api<{ secret: string; otpauthUri: string }>('/auth/mfa/setup', { method: 'POST' });
      setEnrolment({ ...res, qr: await QRCode.toDataURL(res.otpauthUri, { margin: 1, width: 200 }) });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function confirm(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api('/auth/mfa/confirm', { method: 'POST', body: { code } });
      setEnrolment(null);
      setDone(true);
      await reloadMe();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="ความปลอดภัย"
        description="การยืนยันตัวตน 2 ขั้นตอนช่วยป้องกันบัญชีแม้รหัสผ่านรั่วไหล"
      />
      {required && !me?.mfaEnabled ? (
        <div className="mb-6">
          <Notice tone="warning">บริษัทของคุณกำหนดให้ผู้ที่มีสิทธิ์สำคัญต้องเปิด 2FA ก่อนใช้งานต่อ</Notice>
        </div>
      ) : null}
      {done ? (
        <div className="mb-6">
          <Notice tone="success">เปิดการยืนยันตัวตน 2 ขั้นตอนเรียบร้อยแล้ว</Notice>
        </div>
      ) : null}
      <Card
        title="แอป Authenticator (TOTP)"
        actions={
          me?.mfaEnabled ? <Badge tone="green">เปิดใช้งานแล้ว</Badge> : <Badge tone="amber">ยังไม่เปิด</Badge>
        }
      >
        {me?.mfaEnabled ? (
          <p className="text-sm text-slate-600">
            ทุกครั้งที่เข้าสู่ระบบ และก่อนทำรายการสำคัญ (เช่น เชิญผู้ใช้ แก้บทบาท) ระบบจะขอรหัส 6 หลักจากแอป
          </p>
        ) : enrolment ? (
          <form onSubmit={confirm} className="grid gap-6 md:grid-cols-[200px_1fr]">
            <img
              src={enrolment.qr}
              alt="QR code สำหรับแอป Authenticator"
              width={200}
              height={200}
              className="rounded border border-slate-200"
            />
            <div className="space-y-4">
              <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-700">
                <li>เปิดแอป Google Authenticator, Microsoft Authenticator หรือ 1Password</li>
                <li>สแกน QR code (หรือพิมพ์รหัสด้านล่าง)</li>
                <li>ใส่รหัส 6 หลักที่แอปแสดง</li>
              </ol>
              <code className="block break-all rounded bg-slate-100 px-3 py-2 text-xs">
                {enrolment.secret}
              </code>
              <Field label="รหัสยืนยัน">
                <Input
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  inputMode="numeric"
                  maxLength={6}
                  autoComplete="one-time-code"
                  required
                />
              </Field>
              <ErrorBox error={error} />
              <Button type="submit" busy={busy}>
                ยืนยันและเปิดใช้งาน
              </Button>
            </div>
          </form>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-slate-600">ใช้แอปบนมือถือสร้างรหัสยืนยันที่เปลี่ยนทุก 30 วินาที</p>
            <ErrorBox error={error} />
            <Button onClick={() => void start()} busy={busy}>
              ตั้งค่า 2FA
            </Button>
          </div>
        )}
      </Card>
    </>
  );
}
