'use client';

import { Badge, Button, Card, ErrorBox, Loading, PageHeader, formatDate } from '@/components/ui';
import { api } from '@/lib/client/api';
import type { AppNotification } from '@/lib/client/types';
import { useResource } from '@/lib/client/use-resource';

const TONE = { INFO: 'teal', WARNING: 'amber', CRITICAL: 'red' } as const;
const LABEL = { INFO: 'ทั่วไป', WARNING: 'คำเตือน', CRITICAL: 'สำคัญ' } as const;

export default function NotificationsPage() {
  const list = useResource<AppNotification[]>('/notifications');
  const unread = list.data?.filter((n) => !n.readAt).length ?? 0;

  return (
    <>
      <PageHeader
        title="การแจ้งเตือน"
        actions={
          unread > 0 ? (
            <Button
              variant="secondary"
              onClick={async () => {
                await api('/notifications/read-all', { method: 'POST' });
                await list.reload();
              }}
            >
              อ่านทั้งหมดแล้ว
            </Button>
          ) : null
        }
      />
      <ErrorBox error={list.error} />
      {list.loading && !list.data ? <Loading /> : null}
      <Card>
        {list.data?.length === 0 ? <p className="text-sm text-slate-500">ยังไม่มีการแจ้งเตือน</p> : null}
        <ul className="divide-y divide-slate-100">
          {list.data?.map((n) => (
            <li
              key={n.id}
              className={`flex items-start justify-between gap-4 py-3 ${n.readAt ? 'opacity-60' : ''}`}
            >
              <div>
                <div className="flex items-center gap-2">
                  <Badge tone={TONE[n.severity]}>{LABEL[n.severity]}</Badge>
                  <span className="text-sm font-medium">{n.title}</span>
                </div>
                {n.body ? <p className="mt-1 text-sm text-slate-600">{n.body}</p> : null}
                <p className="mt-1 text-xs text-slate-400">{formatDate(n.createdAt)}</p>
              </div>
              {!n.readAt ? (
                <Button
                  variant="ghost"
                  onClick={async () => {
                    await api(`/notifications/${n.id}/read`, { method: 'POST' });
                    await list.reload();
                  }}
                >
                  อ่านแล้ว
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
