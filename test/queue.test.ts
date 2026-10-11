import { appendFile, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

describe('ReadingQueue start-up caps', () => {
  it('applies the age and count caps when it starts, not only on rotation', async () => {
    const old = new ReadingQueue({ dir, now: () => NOW, segmentRecords: 100 });
    await old.append(mk(1, NOW - 8 * 24 * 3600_000));
    for (let i = 2; i <= 6; i++) await old.append(mk(i));
    await old.close();
    const fresh = new ReadingQueue({ dir, now: () => NOW, maxReadings: 3, segmentRecords: 100 });
    expect((await fresh.peek(10)).map((r) => r.value)).toEqual([4, 5, 6]);
    expect(fresh.dropped).toBe(3);
  });

  describe('uuidv7', () => {
    it('has version 7, variant bits and sorts by time', () => {
      const a = uuidv7(1_000);
      const b = uuidv7(2_000);
      expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(a < b).toBe(true);
    });
  });
});

/** Small deterministic PRNG (mulberry32) so failures reproduce. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('ReadingQueue caps (property-style)', () => {
  it('never exceeds maxReadings, drops oldest first and counts drops exactly', async () => {
    for (let seed = 1; seed <= 8; seed++) {
      const rnd = prng(seed);
      const d = await mkdtemp(path.join(tmpdir(), 'vt-qp-'));
      try {
        const max = 1 + Math.floor(rnd() * 8);
        const q = new ReadingQueue({
          dir: d,
          maxReadings: max,
          segmentRecords: 1 + Math.floor(rnd() * 4),
          now: () => NOW,
        });
        const model: number[] = [];
        let expectedDropped = 0;
        let next = 0;
        for (let step = 0; step < 40; step++) {
          if (rnd() < 0.75 || model.length === 0) {
            await q.append(mk(next));
            model.push(next++);
            while (model.length > max) {
              model.shift();
              expectedDropped++;
            }
          } else {
            const victim = model.splice(Math.floor(rnd() * model.length), 1)[0] as number;
            await q.ack([`id-${String(victim)}`]);
          }
          const st = await q.stats();
          expect(st.queued).toBeLessThanOrEqual(max);
          expect(st.queued).toBe(model.length);
          expect(st.dropped).toBe(expectedDropped);
        }
        expect((await q.peek(1000)).map((r) => r.value)).toEqual(model);
        // a restart sees the same contents
        await q.close();
        const again = new ReadingQueue({ dir: d, maxReadings: max, now: () => NOW });
        expect((await again.peek(1000)).map((r) => r.value)).toEqual(model);
        expect((await again.stats()).dropped).toBe(expectedDropped);
      } finally {
        await rm(d, { recursive: true, force: true });
      }
    }
  });

  it('drops a reading that is already past the age cap and counts it', async () => {
    const q = new ReadingQueue({ dir, now: () => NOW });
    await q.append(mk(1, NOW - 8 * 24 * 3600_000));
    await q.append(mk(2));
    expect((await q.peek(10)).map((r) => r.value)).toEqual([2]);
    expect(await q.stats()).toEqual({ queued: 1, dropped: 1, invalid: 0 });
  });

  it('expires stored readings as the clock advances', async () => {
    let now = NOW;
    const q = new ReadingQueue({ dir, now: () => now });
    await q.append(mk(1, NOW));
    now = NOW + 8 * 24 * 3600_000;
    await q.append(mk(2, now));
    expect((await q.peek(10)).map((r) => r.value)).toEqual([2]);
    expect((await q.stats()).dropped).toBe(1);
  });
});

describe('ReadingQueue crash safety', () => {
  it('sweeps stale temp files at init and keeps data consistent', async () => {
    const a = new ReadingQueue({ dir, segmentRecords: 2, now: () => NOW });
    for (let i = 0; i < 3; i++) await a.append(mk(i));
    // crash after the temp write of an ack rewrite but before the rename
    await writeFile(path.join(dir, '.seg-0000000000.ndjson.deadbeef.tmp'), '{"half":');
    await writeFile(path.join(dir, '.stats.json.cafe.tmp'), '{');
    const b = new ReadingQueue({ dir, segmentRecords: 2, now: () => NOW });
    expect((await b.peek(10)).map((r) => r.value)).toEqual([0, 1, 2]);
    expect((await readdir(dir)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    await b.ack(['id-0']);
    expect((await b.peek(10)).map((r) => r.value)).toEqual([1, 2]);
    expect((await readdir(dir)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('repairs a torn final line so the file ends with a newline', async () => {
    const a = new ReadingQueue({ dir, now: () => NOW });
    await a.append(mk(1));
    const seg = path.join(dir, (await readdir(dir)).find((n) => n.startsWith('seg-')) as string);
    await appendFile(seg, '{"clientReadingId":"id-9","pa');
    const b = new ReadingQueue({ dir, now: () => NOW });
    expect(await b.size()).toBe(1);
    expect((await readFile(seg, 'utf8')).endsWith('\n')).toBe(true);
    await b.append(mk(2));
    expect((await b.peek(10)).map((r) => r.value)).toEqual([1, 2]);
  });

  it('uses unique temp names (no fixed .tmp path)', async () => {
    const q = new ReadingQueue({ dir, segmentRecords: 10, now: () => NOW });
    for (let i = 0; i < 4; i++) await q.append(mk(i));
    // a fixed-name leftover from an old version must not block rewrites
    await writeFile(path.join(dir, 'seg-0000000000.ndjson.tmp'), 'junk');
    await q.ack(['id-1']);
    expect((await q.peek(10)).map((r) => r.value)).toEqual([0, 2, 3]);
  });
});

describe('ReadingQueue single writer', () => {
  it('serializes concurrent appends and acks without losing or duplicating readings', async () => {
    const q = new ReadingQueue({ dir, segmentRecords: 3, now: () => NOW });
    const ops: Promise<unknown>[] = [];
    for (let i = 0; i < 30; i++) {
      ops.push(q.append(mk(i)));
      if (i % 3 === 2) ops.push(q.ack([`id-${String(i - 2)}`]));
      if (i % 5 === 0) ops.push(q.peek(4));
    }
    await Promise.all(ops);
    const expected: number[] = [];
    for (let i = 0; i < 30; i++) if (!(i % 3 === 0)) expected.push(i);
    expect((await q.peek(100)).map((r) => r.value)).toEqual(expected);
    expect(await q.size()).toBe(expected.length);
  });

  it('keeps working after an operation fails', async () => {
    const q = new ReadingQueue({ dir, now: () => NOW });
    await q.append(mk(1));
    await rm(dir, { recursive: true, force: true });
    await expect(q.append(mk(2))).rejects.toThrow();
    await q.clear();
    await q.append(mk(3));
    expect((await q.peek(10)).map((r) => r.value)).toEqual([3]);
  });
});

describe('ReadingQueue stats and clear', () => {
  it('persists counters (debounced) and reloads them', async () => {
    vi.useFakeTimers();
    try {
      const q = new ReadingQueue({ dir, maxReadings: 2, now: () => NOW });
      for (let i = 0; i < 5; i++) await q.append(mk(i));
      await q.noteInvalid(2);
      await q.noteInvalid();
      expect((await readdir(dir)).includes('stats.json')).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      await q.stats(); // waits behind the scheduled flush
      expect(JSON.parse(await readFile(path.join(dir, 'stats.json'), 'utf8'))).toEqual({
        dropped: 3,
        invalid: 3,
      });
      const b = new ReadingQueue({ dir, maxReadings: 2, now: () => NOW });
      expect(await b.stats()).toEqual({ queued: 2, dropped: 3, invalid: 3 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('flush writes immediately and a corrupt stats file is ignored', async () => {
    const q = new ReadingQueue({ dir, now: () => NOW });
    await q.noteInvalid(4);
    await q.flush();
    expect(JSON.parse(await readFile(path.join(dir, 'stats.json'), 'utf8'))).toEqual({
      dropped: 0,
      invalid: 4,
    });
    await writeFile(path.join(dir, 'stats.json'), 'not json');
    const b = new ReadingQueue({ dir, now: () => NOW });
    expect(await b.stats()).toEqual({ queued: 0, dropped: 0, invalid: 0 });
  });

  it('clear removes all segments and resets every counter', async () => {
    const q = new ReadingQueue({ dir, maxReadings: 3, segmentRecords: 2, now: () => NOW });
    for (let i = 0; i < 6; i++) await q.append(mk(i));
    await q.noteInvalid(2);
    await q.flush();
    await q.clear();
    expect(await q.stats()).toEqual({ queued: 0, dropped: 0, invalid: 0 });
    expect(await readdir(dir)).toEqual([]);
    await q.append(mk(10));
    expect((await q.peek(10)).map((r) => r.value)).toEqual([10]);
    const b = new ReadingQueue({ dir, now: () => NOW });
    expect(await b.stats()).toEqual({ queued: 1, dropped: 0, invalid: 0 });
  });
});
