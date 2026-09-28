'use client';

import type { PlanSummary } from '@/lib/client/types';

const METRICS: Record<string, string> = {
  users: 'ผู้ใช้งาน',
  branches: 'สาขา',
  pos_devices: 'เครื่อง POS',
  skus: 'สินค้า (SKU)',
  channels: 'ช่องทางขายออนไลน์',
};

export function UsageBars({ plan }: { plan: PlanSummary }) {
  return (
    <ul className="space-y-3">
      {Object.entries(METRICS).map(([key, label]) => {
        const used = plan.usage[key] ?? 0;
        const limit = plan.limits[key];
        const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
        return (
          <li key={key}>
            <div className="flex justify-between text-sm">
              <span>{label}</span>
              <span className="text-slate-600">
                {used} / {limit === null || limit === undefined ? 'ไม่จำกัด' : limit}
              </span>
            </div>
            {limit ? (
              <div className="mt-1 h-2 rounded-full bg-slate-100">
                <div
                  className={`h-2 rounded-full ${pct >= 100 ? 'bg-red-500' : pct >= 80 ? 'bg-amber-500' : 'bg-brand-600'}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
