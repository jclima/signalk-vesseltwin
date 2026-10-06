import { appendFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Reading } from '../src/contract';
import { uuidv7 } from '../src/ids';
import { ReadingQueue } from '../src/queue';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'vt-q-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const NOW = Date.parse('2026-10-05T12:00:00Z');
const mk = (n: number, at = NOW): Reading => ({
  clientReadingId: `id-${String(n)}`,
  path: 'propulsion.main.runTime',
  value: n,
  recordedAt: new Date(at).toISOString(),
});

describe('ReadingQueue', () => {
  it('appends, peeks oldest-first and acks', async () => {
    const q = new ReadingQueue({ dir, now: () => NOW });
    for (let i = 0; i < 5; i++) await q.append(mk(i));
    expect((await q.peek(3)).map((r) => r.value)).toEqual([0, 1, 2]);
    await q.ack(['id-0', 'id-2']);
    expect((await q.peek(10)).map((r) => r.value)).toEqual([1, 3, 4]);
    expect(await q.size()).toBe(3);
  });

  it('rotates segments and removes emptied ones', async () => {
    const q = new ReadingQueue({ dir, segmentRecords: 2, now: () => NOW });
    for (let i = 0; i < 5; i++) await q.append(mk(i));
    expect((await readdir(dir)).length).toBe(3);
    await q.ack(['id-0', 'id-1']);
    expect((await readdir(dir)).length).toBe(2);
  });

  it('survives a restart and a torn final line', async () => {
    const a = new ReadingQueue({ dir, now: () => NOW });
    await a.append(mk(1));
    await a.append(mk(2));
    const seg = (await readdir(dir))[0] as string;
    await appendFile(path.join(dir, seg), '{"clientReadingId":"id-3","pa'); // crash mid-write
    const b = new ReadingQueue({ dir, now: () => NOW });
    expect((await b.peek(10)).map((r) => r.value)).toEqual([1, 2]);
    await b.append(mk(4));
    expect((await b.peek(10)).map((r) => r.value)).toEqual([1, 2, 4]);
  });

  it('enforces the count cap by dropping oldest', async () => {
    const q = new ReadingQueue({ dir, maxReadings: 3, segmentRecords: 2, now: () => NOW });
    for (let i = 0; i < 7; i++) await q.append(mk(i));
    await q.enforceCaps();
    const vals = (await q.peek(10)).map((r) => r.value);
    expect(vals).toEqual([4, 5, 6]);
    expect(q.dropped).toBe(4);
  });

  it('enforces the 7-day age cap', async () => {
    const q = new ReadingQueue({ dir, now: () => NOW });
    await q.append(mk(1, NOW - 8 * 24 * 3600_000));
    await q.append(mk(2, NOW - 6 * 24 * 3600_000));
    await q.enforceCaps();
    expect((await q.peek(10)).map((r) => r.value)).toEqual([2]);
  });
});

describe('uuidv7', () => {
  it('has version 7, variant bits and sorts by time', () => {
    const a = uuidv7(1_000);
    const b = uuidv7(2_000);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
  });
});
