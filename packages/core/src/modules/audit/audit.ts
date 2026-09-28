import { sql } from 'kysely';
import type { Tx } from '@stockos/database';
import { currentContext, type ActorType } from '@stockos/shared';

export interface AuditEntry {
  tenantId: string;
  /** Dot-separated verb, e.g. `role.create`, `auth.login.succeeded`. */
  action: string;
  resourceType: string;
  resourceId?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  /** Defaults to the actor of the current request context, else SYSTEM. */
  actor?: { type: ActorType; id?: string | null };
}

/** Keys that must never be written to the audit log, at any nesting level. */
const SECRET_KEYS = /password|secret|token|hash|otp|mfa_?code/i;

/**
 * Append an audit row in the caller's transaction, so the log and the change commit together.
 * Only changed fields should be passed in before/after; secrets are stripped defensively.
 */
export async function recordAudit(tx: Tx, entry: AuditEntry): Promise<void> {
  const ctx = currentContext();
  const actor = entry.actor ?? ctx?.actor ?? { type: 'SYSTEM' as const };
  await sql`
    insert into audit_logs (tenant_id, actor_type, actor_id, action, resource_type, resource_id,
                            before, after, ip, user_agent, request_id, trace_id)
    values (${entry.tenantId}, ${actor.type}, ${actor.id ?? null}, ${entry.action}, ${entry.resourceType},
            ${entry.resourceId ?? null}, ${json(entry.before)}::jsonb, ${json(entry.after)}::jsonb,
            ${ctx?.ip ?? null}::inet, ${ctx?.userAgent?.slice(0, 500) ?? null}, ${ctx?.requestId ?? null},
            ${ctx?.traceId ?? null})`.execute(tx);
}

function json(value: Record<string, unknown> | null | undefined): string | null {
  return value == null ? null : JSON.stringify(redact(value));
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, SECRET_KEYS.test(k) ? '[REDACTED]' : redact(v)]),
    );
  }
  return value;
}
