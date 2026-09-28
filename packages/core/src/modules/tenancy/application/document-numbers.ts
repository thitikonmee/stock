import { sql } from 'kysely';
import type { Tx } from '@stockos/database';
import { ValidationError } from '@stockos/shared';

export type DocType = 'SO' | 'PO' | 'GR' | 'TR' | 'ADJ' | 'CNT' | 'RCPT' | 'CN';

export interface DocumentNumberOptions {
  /** Separate counters per branch/device, e.g. receipts per POS device. */
  scopeKey?: string;
  /** Reset the counter each period; yyMM in the tenant's timezone by default. Use '' for never. */
  period?: string;
  /** Minimum digits of the running number. */
  pad?: number;
}

/**
 * Gap-free document numbers (SO-2610-000123). The counter row stays locked until the caller's
 * transaction ends: a rollback gives the number back, so committed documents never skip a value —
 * required for tax documents in Thailand. The price is that numbering serialises per
 * (tenant, type, scope, period); use a scopeKey per branch/device where volume is high.
 */
export async function nextDocumentNumber(
  tx: Tx,
  tenantId: string,
  docType: DocType,
  options: DocumentNumberOptions = {},
): Promise<string> {
  const scopeKey = options.scopeKey ?? '';
  if (!/^[A-Z0-9_-]{0,40}$/.test(scopeKey)) throw new ValidationError('Invalid document number scope');
  const period = options.period ?? (await currentPeriod(tx));
  const { rows } = await sql<{ value: string }>`
    insert into document_sequences (tenant_id, doc_type, scope_key, period, next_value)
    values (${tenantId}, ${docType}, ${scopeKey}, ${period}, 2)
    on conflict (tenant_id, doc_type, scope_key, period)
      do update set next_value = document_sequences.next_value + 1
    returning next_value - 1 as value`.execute(tx);
  const running = String(rows[0]!.value).padStart(options.pad ?? 6, '0');
  return [docType, scopeKey, period, running].filter(Boolean).join('-');
}

async function currentPeriod(tx: Tx): Promise<string> {
  const { rows } = await sql<{ period: string }>`
    select to_char(now() at time zone t.timezone, 'YYMM') as period
      from tenants t where t.id = current_tenant_id()`.execute(tx);
  return rows[0]?.period ?? '';
}
