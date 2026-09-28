import { sql } from 'kysely';
import type { Tx } from '@stockos/database';
import { NotFoundError, isUuid, uuidv7 } from '@stockos/shared';
import type { PermissionCode, Principal } from '../iam/public-api';

export type Severity = 'INFO' | 'WARNING' | 'CRITICAL';

export interface NotifyInput {
  tenantId: string;
  eventType: string;
  severity: Severity;
  title: string;
  body?: string;
  data?: Record<string, unknown>;
  /** Explicit recipients (user ids) ... */
  userIds?: readonly string[];
  /** ... and/or every active member holding this permission tenant-wide. */
  toPermission?: PermissionCode;
  /** Same key to the same user within `throttleMinutes` is dropped (alert storms). */
  dedupKey?: string;
  throttleMinutes?: number;
}

export interface Notification {
  id: string;
  eventType: string;
  severity: Severity;
  title: string;
  body: string | null;
  data: Record<string, unknown> | null;
  readAt: Date | null;
  createdAt: Date;
}

/**
 * In-app notifications, written in the caller's transaction. E-mail / LINE / webhook delivery
 * will consume the same rows through the outbox (Phase 10) — this module decides who is told.
 */
export class NotificationService {
  async notify(tx: Tx, input: NotifyInput): Promise<number> {
    const recipients = new Set(input.userIds ?? []);
    if (input.toPermission) {
      const { rows } = await sql<{ user_id: string }>`
        select distinct m.user_id from tenant_memberships m
          join membership_roles mr on mr.tenant_id = m.tenant_id and mr.membership_id = m.id and mr.scope_type = 'TENANT'
          join role_permissions rp on rp.tenant_id = mr.tenant_id and rp.role_id = mr.role_id
         where m.status = 'ACTIVE' and rp.permission_code = ${input.toPermission}`.execute(tx);
      for (const r of rows) recipients.add(r.user_id);
    }
    let created = 0;
    for (const userId of recipients) {
      const { rows } = await sql`
        insert into notifications (tenant_id, id, user_id, event_type, severity, title, body, data, dedup_key)
        select ${input.tenantId}, ${uuidv7()}, ${userId}, ${input.eventType}, ${input.severity}, ${input.title},
               ${input.body ?? null}, ${input.data ? JSON.stringify(input.data) : null}::jsonb, ${input.dedupKey ?? null}
         where ${input.dedupKey ?? null}::text is null or not exists (
               select 1 from notifications
                where user_id = ${userId} and dedup_key = ${input.dedupKey ?? null}
                  and created_at > now() - make_interval(mins => ${input.throttleMinutes ?? 60}))
        returning id`.execute(tx);
      created += rows.length;
    }
    return created;
  }

  async listMine(
    tx: Tx,
    principal: Principal,
    options: { unreadOnly?: boolean; limit?: number } = {},
  ): Promise<Notification[]> {
    const { rows } = await sql<{
      id: string;
      event_type: string;
      severity: Severity;
      title: string;
      body: string | null;
      data: Record<string, unknown> | null;
      read_at: Date | null;
      created_at: Date;
    }>`select id, event_type, severity, title, body, data, read_at, created_at from notifications
        where user_id = ${principal.userId} and (${options.unreadOnly ?? false} = false or read_at is null)
        order by created_at desc limit ${Math.min(options.limit ?? 50, 200)}`.execute(tx);
    return rows.map((r) => ({
      id: r.id,
      eventType: r.event_type,
      severity: r.severity,
      title: r.title,
      body: r.body,
      data: r.data,
      readAt: r.read_at,
      createdAt: r.created_at,
    }));
  }

  async markRead(tx: Tx, principal: Principal, id: string): Promise<void> {
    if (!isUuid(id)) throw new NotFoundError('Notification not found');
    const { rows } = await sql`update notifications set read_at = coalesce(read_at, now())
                                where id = ${id} and user_id = ${principal.userId} returning id`.execute(tx);
    if (rows.length === 0) throw new NotFoundError('Notification not found');
  }

  async markAllRead(tx: Tx, principal: Principal): Promise<number> {
    const result = await sql`update notifications set read_at = now()
                              where user_id = ${principal.userId} and read_at is null`.execute(tx);
    return Number(result.numAffectedRows ?? 0);
  }
}
