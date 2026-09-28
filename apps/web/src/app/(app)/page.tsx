'use client';

import Link from 'next/link';
import { Badge, Card, PageHeader } from '@/components/ui';
import { useMe } from '@/components/shell';
import type { Member, PlanSummary, PosDevice } from '@/lib/client/types';
import { can } from '@/lib/client/types';
import { useResource } from '@/lib/client/use-resource';
import { UsageBars } from '@/components/usage-bars';

export default function HomePage() {
  const { me } = useMe();
  const { data: plan } = useResource<PlanSummary>('/billing/usage');
  const { data: members } = useResource<Member[]>(can(me, 'user.read') ? '/users' : null);
  const { data: devices } = useResource<PosDevice[]>(can(me, 'device.manage') ? '/pos-devices' : null);

  const steps = [
    {
      done: !!me?.mfaEnabled,
      label: 'เปิดการยืนยันตัวตน 2 ขั้นตอน (2FA)',
      href: '/settings/security',
      show: true,
    },
    {
      done: (members?.length ?? 0) > 1,
      label: 'เชิญทีมงานเข้าร่วม',
      href: '/settings/users',
      show: can(me, 'user.manage'),
    },
    {
      done: (devices?.length ?? 0) > 0,
      label: 'ลงทะเบียนเครื่อง POS เครื่องแรก',
      href: '/settings/devices',
      show: can(me, 'device.manage'),
    },
  ].filter((s) => s.show);

  return (
    <>
      <PageHeader title={`สวัสดี ${me?.displayName ?? ''}`} description={me?.tenant.name} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="เริ่มต้นใช้งาน">
          <ul className="space-y-3">
            {steps.map((s) => (
              <li key={s.label} className="flex items-center justify-between gap-4">
                <Link href={s.href} className="text-sm text-slate-800 hover:text-brand-700">
                  {s.label}
                </Link>
                {s.done ? <Badge tone="green">เสร็จแล้ว</Badge> : <Badge tone="amber">ยังไม่ได้ทำ</Badge>}
              </li>
            ))}
          </ul>
        </Card>
        <Card title="แพ็กเกจ" actions={plan ? <Badge tone="teal">{plan.planName}</Badge> : null}>
          {plan ? <UsageBars plan={plan} /> : null}
        </Card>
      </div>
    </>
  );
}
