import { sql } from 'kysely';
import type { Tx } from '@stockos/database';
import { ValidationError, uuidv7 } from '@stockos/shared';
import { buildInternalEan13, INTERNAL_EAN13_PREFIXES } from '../domain/barcode';

const DEFAULT_PREFIX = '20';

/**
 * A fresh, never-reused internal barcode.
 * - EAN13: `document_sequences` (doc_type BARCODE, scoped by prefix) hands out a gap-free running
 *   number under the tenant lock, so two concurrent requests never race onto the same code.
 * - CODE128: a short opaque internal serial (no external meaning, printable ASCII).
 */
export async function nextInternalBarcode(
  tx: Tx,
  tenantId: string,
  symbology: 'EAN13' | 'CODE128',
  prefix?: string,
): Promise<string> {
  if (symbology === 'CODE128') return `IN${uuidv7().replace(/-/g, '').slice(-12).toUpperCase()}`;

  const p = prefix ?? DEFAULT_PREFIX;
  if (!(INTERNAL_EAN13_PREFIXES as readonly string[]).includes(p)) {
    throw new ValidationError('Internal EAN-13 prefix must be 20-29');
  }
  const { rows } = await sql<{ value: string }>`
    insert into document_sequences (tenant_id, doc_type, scope_key, period, next_value)
    values (${tenantId}, 'BARCODE', ${p}, '', 2)
    on conflict (tenant_id, doc_type, scope_key, period)
      do update set next_value = document_sequences.next_value + 1
    returning next_value - 1 as value`.execute(tx);
  const running = Number(rows[0]!.value);
  return buildInternalEan13(p, running);
}
