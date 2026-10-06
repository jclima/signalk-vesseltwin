import { randomBytes } from 'node:crypto';

/** RFC 9562 UUIDv7: 48-bit ms timestamp + random. Sortable, used as clientReadingId. */
export function uuidv7(now: number = Date.now()): string {
  const b = randomBytes(16);
  b.writeUIntBE(now, 0, 6);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x70;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
