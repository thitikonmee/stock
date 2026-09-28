import { describe, expect, it } from 'vitest';
import { ValidationError } from '@stockos/shared';
import {
  BUCKETS,
  LEDGER_TRANSACTION_TYPES,
  OPERATIONS,
  computeLineEffect,
  type Operation,
} from './operations';

const ops = Object.keys(OPERATIONS) as Operation[];

const deltasOf = (op: Operation, qty: string) =>
  Object.fromEntries(Object.entries(computeLineEffect(op, qty).deltas).map(([k, v]) => [k, v.toFixed(3)]));

describe('effect matrix', () => {
  it('maps every operation to a ledger type allowed by the database', () => {
    for (const op of ops) expect(LEDGER_TRANSACTION_TYPES).toContain(OPERATIONS[op].ledgerType);
  });

  it('only touches known buckets', () => {
    for (const op of ops) {
      for (const bucket of Object.keys(OPERATIONS[op].effects)) expect(BUCKETS).toContain(bucket);
    }
  });

  it.each<[Operation, Record<string, string>]>([
    ['RESERVE', { RESERVED: '2.000' }],
    ['RELEASE', { RESERVED: '-2.000' }],
    ['COMMIT', { RESERVED: '-2.000', COMMITTED: '2.000' }],
    ['COMMIT_DIRECT', { COMMITTED: '2.000' }],
    ['UNCOMMIT', { COMMITTED: '-2.000' }],
    ['SHIP', { ON_HAND: '-2.000', COMMITTED: '-2.000' }],
    ['SELL_DIRECT', { ON_HAND: '-2.000' }],
    ['RECEIVE_PURCHASE', { ON_HAND: '2.000', INCOMING: '-2.000' }],
    ['TRANSFER_OUT', { ON_HAND: '-2.000', COMMITTED: '-2.000' }],
    ['TRANSFER_IN', { ON_HAND: '2.000', INCOMING: '-2.000' }],
    ['MARK_DAMAGED', { ON_HAND: '-2.000', DAMAGED: '2.000' }],
  ])('%s moves the right buckets', (op, expected) => {
    expect(deltasOf(op, '2')).toEqual(expected);
  });

  it('keeps available unchanged when committing a reservation', () => {
    const { deltas } = computeLineEffect('COMMIT', '5');
    const available =
      (deltas.ON_HAND?.toNumber() ?? 0) -
      (deltas.RESERVED?.toNumber() ?? 0) -
      (deltas.COMMITTED?.toNumber() ?? 0);
    expect(available).toBe(0);
  });

  it('guards outbound operations and leaves inbound ones unguarded', () => {
    expect(computeLineEffect('RESERVE', '1').guard).toEqual({ kind: 'AVAILABLE' });
    expect(computeLineEffect('SELL_DIRECT', '1').guard).toEqual({ kind: 'AVAILABLE' });
    expect(computeLineEffect('SHIP', '1').guard).toEqual({ kind: 'BUCKET', bucket: 'COMMITTED' });
    expect(computeLineEffect('LOSS', '1').guard).toEqual({ kind: 'BUCKET', bucket: 'ON_HAND' });
    expect(computeLineEffect('FOUND', '1').guard).toEqual({ kind: 'NONE' });
  });

  it('turns a negative signed adjustment into a guarded outbound movement', () => {
    const effect = computeLineEffect('COUNT_VARIANCE', '-3');
    expect(effect.guard).toEqual({ kind: 'BUCKET', bucket: 'ON_HAND' });
    expect(effect.guardQuantity.toFixed(3)).toBe('3.000');
    expect(effect.deltas.ON_HAND?.toFixed(3)).toBe('-3.000');
    expect(computeLineEffect('ADJUST', '4').guard).toEqual({ kind: 'NONE' });
  });

  it('rejects negative quantities for unsigned operations and zero everywhere', () => {
    expect(() => computeLineEffect('RESERVE', '-1')).toThrow(ValidationError);
    expect(() => computeLineEffect('ADJUST', '0')).toThrow(ValidationError);
  });
});
