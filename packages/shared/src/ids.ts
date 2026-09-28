import { randomBytes, randomInt } from 'node:crypto';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_COUNTER = 0xfff;

let lastTimestamp = -1;
let counter = 0;

/**
 * RFC 9562 UUIDv7, monotonic within a process: the 12-bit rand_a field is used as a
 * counter when several ids are generated in the same millisecond, so ids sort by creation order.
 */
export function uuidv7(now: number = Date.now()): string {
  let timestamp = now;
  if (timestamp <= lastTimestamp) {
    timestamp = lastTimestamp;
    counter += 1;
    if (counter > MAX_COUNTER) {
      timestamp = lastTimestamp + 1;
      counter = 0;
    }
  } else {
    // Start in the lower half so a burst in the same millisecond rarely overflows.
    counter = randomInt(0, 0x800);
  }
  lastTimestamp = timestamp;

  const bytes = randomBytes(16);
  bytes.writeUIntBE(timestamp, 0, 6);
  bytes[6] = 0x70 | (counter >> 8);
  bytes[7] = counter & 0xff;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}
