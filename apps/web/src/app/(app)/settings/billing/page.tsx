'use client';

import { Badge, Card, ErrorBox, Loading, PageHeader, formatDate } from '@/components/ui';
import { UsageBars } from '@/components/usage-bars';
import type { PlanSummary } from '@/lib/client/types';
import { useResource } from '@/lib/client/use-resource';

// billing.PlanService returns `status` as a plain string (TRIALING/ACTIVE/PAST_DUE from
// tenant_subscriptions, or 'NONE' when a tenant has no subscription row at all) — not a literal
// union, so this stays a lookup with a raw-string fallback rather than an exhaustive Record.
const STATUS_LABEL: Record<string, string> = {
  TRIALING: 'ช่วงทดลองใช้',
  ACTIVE: 'ใช้งานอยู่',
  PAST_DUE: 'ค้างชำระ',
  NONE: 'ไม่มีแพ็กเกจ',
};
const STATUS_TONE: Record<string, 'slate' | 'amber' | 'green' | 'red' | 'teal'> = {
  TRIALING: 'amber',
  ACTIVE: 'green',
  PAST_DUE: 'red',
  NONE: 'slate',
};

export default function BillingPage() {
  const { data: plan, error, loading } = useResource<PlanSummary>('/billing/usage');
  return (
    <>
      <PageHeader
        breadcrumb={[{ label: 'การตั้งค่า', href: '/settings/branches' }, { label: 'แพ็กเกจ' }]}
        title="แพ็กเกจและการใช้งาน"
      />
      <ErrorBox error={error} />
      {loading && !plan ? <Loading /> : null}
      {plan ? (
        <Card
          title={plan.planName}
          actions={
            <Badge tone={STATUS_TONE[plan.status] ?? 'slate'}>
              {STATUS_LABEL[plan.status] ?? plan.status}
            </Badge>
          }
        >
          <p className="mb-4 text-sm text-slate-600">
            รอบปัจจุบันสิ้นสุด {formatDate(plan.currentPeriodEnd)}
          </p>
          <UsageBars plan={plan} />
          <p className="mt-6 text-xs text-slate-500">การชำระเงินและการอัปเกรดแพ็กเกจจะเปิดใช้ใน Phase 11</p>
        </Card>
      ) : null}
    </>
  );
}
