import { sql } from 'kysely';
import type { Tx } from '@stockos/database';

export interface PosSettings {
  /** Bill-level rounding increment, e.g. "1.00" baht. "0" disables rounding. */
  roundingIncrement: string;
  /** Above this percent of the subtotal, a line/cart discount needs a manager override. */
  maxDiscountPercent: number;
  priceListCode: string;
}

const DEFAULTS: PosSettings = { roundingIncrement: '1.00', maxDiscountPercent: 10, priceListCode: 'RETAIL' };

/** Reads `tenants.settings.pos` (docs/05-pos.md §15 "ปัดเศษระดับบิล"), falling back to sane defaults. */
export async function loadPosSettings(tx: Tx, tenantId: string): Promise<PosSettings> {
  const { rows } = await sql<{ settings: { pos?: Partial<PosSettings> } }>`
    select settings from tenants where id = ${tenantId}`.execute(tx);
  const pos = rows[0]?.settings?.pos ?? {};
  return {
    roundingIncrement: pos.roundingIncrement ?? DEFAULTS.roundingIncrement,
    maxDiscountPercent: pos.maxDiscountPercent ?? DEFAULTS.maxDiscountPercent,
    priceListCode: pos.priceListCode ?? DEFAULTS.priceListCode,
  };
}
