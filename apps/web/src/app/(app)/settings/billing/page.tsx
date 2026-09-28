'use client';

import { Badge, Card, ErrorBox, Loading, PageHeader, formatDate } from '@/components/ui';
import { UsageBars } from '@/components/usage-bars';
import type { PlanSummary } from '@/lib/client/types';
import { useResource } from '@/lib/client/use-resource';

export default function BillingPage() {
  const { data: plan, error, loading } = useResource<PlanSummary>('/billing/usage');
  return (
    <>
      <PageHeader title="แพ็กเกจและการใช้งาน" />
      <ErrorBox error={error} />
      {loading && !plan ? <Loading /> : null}
      {plan ? (
        <Card
          title={plan.planName}
          actions={
            <Badge tone={plan.status === 'TRIALING' ? 'amber' : 'green'}>
              {plan.status === 'TRIALING' ? 'ช่วงทดลองใช้' : plan.status}
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
