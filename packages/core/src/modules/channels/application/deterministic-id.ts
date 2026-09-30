import { createHash } from 'node:crypto';

/**
 * A stable, valid-looking UUID derived from `seed` — always the same output for the same input.
 * Used where a channel order needs an internal primary key that concurrent retries/webhook+polling
 * races agree on without a round-trip (the same "derive the id, don't generate a fresh one" rule
 * as `orders.OrderService.create()`'s `orderId = idempotencyKey`, just for inputs that aren't
 * already a UUID — an external order_sn or a per-order fulfillment slot). Not a real RFC 4122 v5
 * (no XOR with a namespace UUID) — nothing outside this process ever needs to reproduce it.
 */
export function deterministicUuid(seed: string): string {
  const bytes = createHash('sha256').update(seed).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
