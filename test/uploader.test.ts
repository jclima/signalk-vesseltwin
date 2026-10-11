import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Reading } from '../src/contract';
import { uuidv7 } from '../src/ids';
import { matchPath } from '../src/mapping';
import { ReadingQueue } from '../src/queue';
import type { Scheduler } from '../src/status';
import {
  applyResults,
  buildBatch,
  PACE_MS,
  READINGS_PATH,
  Uploader,
  type UploaderEvent,
} from '../src/uploader';
import { MAX_BATCH } from '../src/wire';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 });
});

const BASE = 'https://api.example.test';
const CRED = `vti_${'Q'.repeat(43)}`;
const HOUR = 3_600_000;

let seq = 0;
const reading = (over: Partial<Reading> = {}): Reading => ({
  clientReadingId: uuidv7(Date.now() + seq++),
  path: 'electrical.batteries.house.voltage',
  value: 12.5,
  recordedAt: new Date(Date.now() - 60_000).toISOString(),
  ...over,
});

class FakeScheduler implements Scheduler {
  timers = new Map<number, { fn: () => void; ms: number }>();
  private next = 1;
  set(fn: () => void, ms: number): unknown {
    const id = this.next++;
    this.timers.set(id, { fn, ms });
    return id;
  }
  clear(h: unknown): void {
    this.timers.delete(h as number);
  }
  /** Delay of the single pending timer. */
  get pendingMs(): number | null {
    const all = [...this.timers.values()];
    expect(all.length).toBeLessThanOrEqual(1);
    return all[0]?.ms ?? null;
  }
  fireOnly(): void {
    const e = [...this.timers.entries()];
    expect(e).toHaveLength(1);
    const [id, t] = e[0] as [number, { fn: () => void }];
    this.timers.delete(id);
    t.fn();
  }
}

interface Call {
  url: string;
  headers: Record<string, string>;
  body: { readings: Reading[] };
}
type Responder = (call: Call, signal: AbortSignal | undefined) => Response | Promise<Response>;

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });
const acceptAll = (call: Call, status = 'accepted') =>
  json(200, {
    serverTime: new Date().toISOString(),
    results: call.body.readings.map((r) => ({ clientReadingId: r.clientReadingId, status })),
  });

function setup(
  opts: {
    dir?: string;
    responders?: Responder[];
    fallback?: Responder;
    isActive?: (p: string) => boolean;
    baseUrl?: string;
    credentialOrigin?: string;
    intervalMs?: number;
    rng?: () => number;
  } = {},
) {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), 'vt-up-'));
  if (!opts.dir) dirs.push(dir);
  const queue = new ReadingQueue({ dir: join(dir, 'queue'), statsDebounceMs: -1 });
  const sched = new FakeScheduler();
  const calls: Call[] = [];
  const events: UploaderEvent[] = [];
  const responders = [...(opts.responders ?? [])];
  const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
    const call: Call = {
      url,
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(init?.body as string) as { readings: Reading[] },
    };
    calls.push(call);
    const r = responders.shift() ?? opts.fallback ?? ((c: Call) => acceptAll(c));
    return r(call, init?.signal ?? undefined);
  };
  const up = new Uploader({
    queue,
    baseUrl: opts.baseUrl ?? BASE,
    credential: CRED,
    credentialOrigin: opts.credentialOrigin ?? new URL(opts.baseUrl ?? BASE).origin,
    fetch: fetchFn,
    userAgent: 'test/1',
    intervalMs: opts.intervalMs ?? 24 * HOUR,
    isActive: opts.isActive ?? (() => true),
    onEvent: (e) => events.push(e),
    rng: opts.rng ?? (() => 0.5),
    scheduler: sched,
  });
  /** Fires the pending timer and waits until the attempt it started has finished. */
  const fire = async () => {
    sched.fireOnly();
    await vi.waitFor(() => {
      expect(up.snapshot().state).not.toBe('sending');
    });
  };
  const fill = async (n: number): Promise<Reading[]> => {
    const rs = Array.from({ length: n }, () => reading());
    for (const r of rs) await queue.append(r);
    return rs;
  };
  return { dir, queue, sched, calls, events, up, fire, fill };
}

const ids = (rs: { clientReadingId: string }[]) => rs.map((r) => r.clientReadingId);

describe('buildBatch', () => {
  it('caps the item count and keeps queue order', () => {
    const rs = Array.from({ length: 700 }, () => reading());
    expect(buildBatch(rs)).toHaveLength(MAX_BATCH);
    expect(ids(buildBatch(rs, 3))).toEqual(ids(rs.slice(0, 3)));
    expect(buildBatch(rs, 10_000)).toHaveLength(MAX_BATCH);
    expect(buildBatch(rs, 0)).toHaveLength(1);
    expect(buildBatch([])).toEqual([]);
  });

  it('copies only the four wire fields', () => {
    const r = { ...reading(), extra: 'x', position: [1, 2] } as unknown as Reading;
    expect(Object.keys(buildBatch([r])[0] ?? {}).sort()).toEqual(
      ['clientReadingId', 'path', 'recordedAt', 'value'].sort(),
    );
  });

  it('property: the envelope never exceeds maxBytes (except one oversized item) and is maximal', () => {
    let s = 12345;
    const rand = () => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return s / 0x7fffffff;
    };
    for (let round = 0; round < 200; round++) {
      const rs = Array.from({ length: 1 + Math.floor(rand() * 80) }, () =>
        reading({
          value: rand() * 10 ** Math.floor(rand() * 12),
          path:
            rand() < 0.5
              ? 'electrical.batteries.house.voltage'
              : `tanks.fuel.${'t'.repeat(1 + Math.floor(rand() * 39))}.currentLevel`,
        }),
      );
      const maxBytes = 20 + Math.floor(rand() * 6000);
      const maxItems = 1 + Math.floor(rand() * 100);
      const out = buildBatch(rs, maxItems, maxBytes);
      const size = (n: number) => Buffer.byteLength(JSON.stringify({ readings: rs.slice(0, n) }));
      expect(out.length).toBeGreaterThanOrEqual(1);
      expect(out.length).toBeLessThanOrEqual(Math.min(maxItems, MAX_BATCH));
      expect(ids(out)).toEqual(ids(rs.slice(0, out.length)));
      expect(Buffer.byteLength(JSON.stringify({ readings: out }))).toBe(size(out.length));
      if (out.length > 1) expect(size(out.length)).toBeLessThanOrEqual(maxBytes);
      if (out.length < Math.min(rs.length, maxItems, MAX_BATCH)) {
        expect(size(out.length + 1)).toBeGreaterThan(maxBytes);
      }
    }
  });
});

describe('applyResults', () => {
  const batch = [{ clientReadingId: 'a' }, { clientReadingId: 'b' }, { clientReadingId: 'c' }];
  const res = (rows: unknown[]) => ({ serverTime: '2030-01-01T00:00:00Z', results: rows });

  it('acknowledges every result and counts by status and reason', () => {
    const out = applyResults(
      batch,
      res([
        { clientReadingId: 'a', status: 'accepted' },
        { clientReadingId: 'b', status: 'held_unmapped' },
        { clientReadingId: 'c', status: 'rejected', reason: 'implausible' },
      ]),
    );
    expect(out).toEqual({
      ack: ['a', 'b', 'c'],
      byStatus: { accepted: 1, held_unmapped: 1, rejected: 1 },
      byReason: { implausible: 1 },
    });
  });

  it('returns null unless the reply is well formed and aligned with the batch', () => {
    const ok = (id: string) => ({ clientReadingId: id, status: 'accepted' });
    expect(applyResults(batch, null)).toBeNull();
    expect(applyResults(batch, res([ok('a'), ok('b')]))).toBeNull(); // short
    expect(applyResults(batch, res([ok('a'), ok('b'), ok('c'), ok('d')]))).toBeNull(); // long
    expect(applyResults(batch, res([ok('b'), ok('a'), ok('c')]))).toBeNull(); // misaligned
    expect(
      applyResults(batch, res([ok('a'), ok('b'), { ...ok('c'), status: 'weird' }])),
    ).toBeNull();
    expect(applyResults(batch, { results: [ok('a'), ok('b'), ok('c')] })).toBeNull();
  });
});

describe('Uploader', () => {
  it('first attempt after 1 to 5 minutes, then sends one valid batch with the right request', async () => {
    const t = setup({ rng: () => 0 });
    t.up.start();
    expect(t.sched.pendingMs).toBe(60_000);
    await t.up.stop();
    const t2 = setup({ rng: () => 0.9999 });
    t2.up.start();
    expect(t2.sched.pendingMs).toBeLessThanOrEqual(300_000);
    expect(t2.sched.pendingMs).toBeGreaterThan(290_000);
    await t2.up.stop();

    const t3 = setup();
    const sent = await t3.fill(3);
    t3.up.start();
    await t3.fire();
    expect(t3.calls).toHaveLength(1);
    const c = t3.calls[0] as Call;
    expect(c.url).toBe(`${BASE}${READINGS_PATH}`);
    expect(c.headers).toMatchObject({
      authorization: `Bearer ${CRED}`,
      'user-agent': 'test/1',
      'x-vesseltwin-contract': '2',
    });
    expect(Object.keys(c.body)).toEqual(['readings']);
    expect(ids(c.body.readings)).toEqual(ids(sent));
    for (const r of c.body.readings) {
      expect(Object.keys(r).sort()).toEqual(['clientReadingId', 'path', 'recordedAt', 'value']);
      expect(matchPath(r.path)).not.toBeNull();
    }
    expect(await t3.queue.size()).toBe(0);
    const snap = t3.up.snapshot();
    expect(snap).toMatchObject({ state: 'idle', queued: 0, results: { accepted: 3 } });
    expect(snap.lastSentAt).not.toBeNull();
    // Queue empty: next attempt after the upload interval, +-10%.
    expect(t3.sched.pendingMs).toBe(24 * HOUR);
    await t3.up.stop();
  });

  it('jitters the interval by at most 10 percent', async () => {
    for (const [r, lo, hi] of [
      [0, 0.9, 0.9],
      [1, 1.1, 1.1],
    ] as const) {
      const t = setup({ rng: () => r });
      await t.fill(1);
      t.up.start();
      await t.fire();
      const ms = t.sched.pendingMs ?? 0;
      expect(ms).toBeGreaterThanOrEqual(Math.floor(24 * HOUR * lo));
      expect(ms).toBeLessThanOrEqual(Math.ceil(24 * HOUR * hi));
      await t.up.stop();
    }
  });

  it('paces a backlog at about two seconds per batch', async () => {
    const t = setup();
    await t.fill(MAX_BATCH + 20);
    t.up.start();
    await t.fire();
    expect(t.calls[0]?.body.readings).toHaveLength(MAX_BATCH);
    expect(t.sched.pendingMs).toBe(PACE_MS);
    await t.fire();
    expect(t.calls[1]?.body.readings).toHaveLength(20);
    expect(t.sched.pendingMs).toBe(24 * HOUR);
    await t.up.stop();
  });

  it('counts every terminal status, acknowledges them all and keeps reasons', async () => {
    const t = setup({
      responders: [
        (c) =>
          json(200, {
            serverTime: new Date().toISOString(),
            results: c.body.readings.map((r, i) => ({
              clientReadingId: r.clientReadingId,
              status: ['accepted', 'duplicate', 'held_review', 'rejected'][i],
              ...(i === 3 ? { reason: 'too_old' } : {}),
            })),
          }),
      ],
    });
    await t.fill(4);
    t.up.start();
    await t.fire();
    expect(await t.queue.size()).toBe(0);
    expect(t.up.snapshot().results).toMatchObject({
      accepted: 1,
      duplicate: 1,
      held_review: 1,
      rejected: 1,
    });
    expect(t.up.snapshot().rejectedReasons).toEqual({ too_old: 1 });
    await t.up.stop();
  });

  it('acknowledges nothing and backs off when a 200 reply is unusable', async () => {
    const t = setup({
      responders: [
        (c) =>
          json(200, { serverTime: new Date().toISOString(), results: c.body.readings.slice(1) }),
        () => json(200, { hello: 'captive portal' }),
      ],
    });
    await t.fill(3);
    t.up.start();
    await t.fire();
    expect(await t.queue.size()).toBe(3);
    expect(t.up.snapshot().state).toBe('backoff');
    expect(t.sched.pendingMs).toBeGreaterThanOrEqual(5_000);
    await t.fire();
    expect(await t.queue.size()).toBe(3);
    expect(t.up.snapshot().lastSentAt).toBeNull();
    await t.up.stop();
  });

  describe('error matrix', () => {
    it('401: stops for good, keeps the queue, tombstone only for integration_unauthorized', async () => {
      for (const [body, tombstone] of [
        [{ code: 'integration_unauthorized' }, true],
        [{ error: 'captive' }, false],
        [null, false],
      ] as const) {
        const t = setup({ responders: [() => json(401, body)] });
        await t.fill(2);
        t.up.start();
        await t.fire();
        expect(t.events).toContainEqual({ kind: 'reauth', tombstone });
        expect(t.up.snapshot().state).toBe('reauth_required');
        expect(t.sched.timers.size).toBe(0);
        expect(await t.queue.size()).toBe(2);
        t.up.start(); // sticky for this lifecycle
        t.up.kick();
        t.up.resume();
        expect(t.sched.timers.size).toBe(0);
        expect(t.calls).toHaveLength(1);
        await t.up.stop();
      }
    });

    it('paused (503 feature, 403 plan): keeps the queue, waits at least an hour or Retry-After, kick retries', async () => {
      for (const [status, code, reason] of [
        [503, 'integration_feature_unavailable', 'feature'],
        [403, 'integration_paused_plan', 'plan'],
      ] as const) {
        const t = setup({
          responders: [
            () => json(status, { code }),
            () => json(status, { code }, { 'retry-after': '7200' }),
          ],
        });
        await t.fill(2);
        t.up.start();
        await t.fire();
        expect(t.events).toContainEqual({ kind: 'paused', reason });
        expect(t.up.snapshot()).toMatchObject({ state: 'paused', pausedReason: reason });
        expect(t.sched.pendingMs).toBe(HOUR);
        expect(await t.queue.size()).toBe(2);
        t.up.kick(); // the monitor saw the server come back
        expect(t.sched.pendingMs).toBe(0);
        await t.fire();
        expect(t.sched.pendingMs).toBe(2 * HOUR); // Retry-After wins over the hour
        expect(await t.queue.size()).toBe(2);
        await t.up.stop();
      }
    });

    it('update required (426, contract codes, 403 scope): stops for good and keeps the queue', async () => {
      const cases: [number, unknown][] = [
        [426, { code: 'integration_contract_unsupported' }],
        [400, { code: 'integration_contract_required' }],
        [403, { code: 'integration_scope' }],
      ];
      for (const [status, body] of cases) {
        const t = setup({ responders: [() => json(status, body)] });
        await t.fill(2);
        t.up.start();
        await t.fire();
        expect(t.events).toContainEqual({ kind: 'update_required' });
        expect(t.up.snapshot().state).toBe('update_required');
        expect(t.sched.timers.size).toBe(0);
        expect(await t.queue.size()).toBe(2);
        t.up.start();
        t.up.resume();
        t.up.kick();
        expect(t.sched.timers.size).toBe(0);
        expect(t.calls).toHaveLength(1);
        expect(t.calls[0]?.headers['x-vesseltwin-contract']).toBe('2'); // never guesses another
        await t.up.stop();
      }
    });

    it('retry (429, 5xx, network): backoff grows, never sooner than Retry-After, then recovers', async () => {
      const t = setup({
        rng: () => 1, // full jitter at its ceiling
        responders: [
          () => json(500, {}),
          () => {
            throw new Error('ECONNRESET');
          },
          () => json(429, {}, { 'retry-after': '1800' }),
        ],
      });
      await t.fill(2);
      t.up.start();
      await t.fire();
      expect(t.up.snapshot().state).toBe('backoff');
      expect(t.sched.pendingMs).toBe(5_000); // attempt 0: the 5 s floor
      await t.fire();
      const second = t.sched.pendingMs ?? 0;
      expect(second).toBe(10_000); // attempt 1: ceiling doubles
      await t.fire();
      expect(t.sched.pendingMs).toBeGreaterThanOrEqual(1_800_000);
      expect(await t.queue.size()).toBe(2);
      await t.fire(); // recovered
      expect(await t.queue.size()).toBe(0);
      expect(t.up.snapshot().state).toBe('idle');
      await t.up.stop();
    });

    it('413: halves the batch (down to one) and carries on; a lone 413 keeps the reading', async () => {
      const big: Responder = (c) => (c.body.readings.length > 2 ? json(413, {}) : acceptAll(c));
      const t = setup({ fallback: big });
      await t.fill(5);
      t.up.start();
      await t.fire();
      expect(t.calls[0]?.body.readings).toHaveLength(5);
      expect(t.sched.pendingMs).toBe(PACE_MS);
      await t.fire(); // 2 items fit
      expect(t.calls[1]?.body.readings).toHaveLength(2);
      await t.fire();
      await t.fire();
      expect(await t.queue.size()).toBe(0);
      await t.up.stop();

      const t2 = setup({ fallback: () => json(413, {}) });
      await t2.fill(1);
      t2.up.start();
      await t2.fire();
      expect(t2.up.snapshot().state).toBe('backoff');
      expect(await t2.queue.size()).toBe(1);
      await t2.up.stop();
    });

    describe('400 without a code', () => {
      const poisonOn =
        (bad: Set<string>): Responder =>
        (c) =>
          c.body.readings.some((r) => bad.has(r.clientReadingId)) ? json(400, {}) : acceptAll(c);

      it('bisects at normal pacing and drops only the reading whose sibling half succeeded', async () => {
        const bad = new Set<string>();
        const t = setup({ fallback: poisonOn(bad) });
        const rs = await t.fill(5);
        const poison = rs[2] as Reading;
        bad.add(poison.clientReadingId);
        t.up.start();
        for (let i = 0; i < 10 && (await t.queue.size()) > 0; i++) {
          if (i > 0) expect(t.sched.pendingMs).toBe(PACE_MS);
          await t.fire();
        }
        expect(await t.queue.size()).toBe(0);
        expect(t.calls.map((c) => c.body.readings.length)).toEqual([5, 3, 2, 2, 1]);
        const good = t.calls.filter(
          (c) => !c.body.readings.some((r) => bad.has(r.clientReadingId)),
        );
        expect(new Set(good.flatMap((c) => ids(c.body.readings)))).toEqual(
          new Set(ids(rs.filter((r) => r !== poison))),
        );
        expect(t.up.snapshot().invalid).toBe(1);
        expect(t.up.snapshot().state).toBe('idle');
        await t.up.stop();
      });

      it('both halves refused is systemic: stops, keeps every reading, counts none as invalid', async () => {
        const t = setup({
          fallback: (c) => (c.body.readings.length > 0 ? json(400, {}) : acceptAll(c)),
        });
        await t.fill(4);
        t.up.start();
        for (let i = 0; i < 3; i++) await t.fire();
        expect(t.up.snapshot().state).toBe('update_required');
        expect(t.events).toContainEqual({ kind: 'update_required' });
        expect(await t.queue.size()).toBe(4);
        expect((await t.queue.stats()).invalid).toBe(0);
        expect(t.sched.timers.size).toBe(0);
        await t.up.stop();
      });

      it('a lone refused reading has no sibling to compare with: stops and keeps it', async () => {
        const t = setup({ fallback: () => json(400, {}) });
        await t.fill(1);
        t.up.start();
        await t.fire();
        expect(t.up.snapshot().state).toBe('update_required');
        expect(await t.queue.size()).toBe(1);
        await t.up.stop();
      });
    });
  });

  it('drops readings that are invalid or no longer active before sending, and counts them', async () => {
    const t = setup({ isActive: (p) => p.startsWith('electrical.batteries.') });
    const good = reading();
    await t.queue.append(good);
    await t.queue.append(reading({ path: 'navigation.position' }));
    await t.queue.append(reading({ path: 'tanks.fuel.0.currentLevel', value: 0.5 }));
    await t.queue.append(reading({ recordedAt: new Date().toISOString().replace('Z', '+00:00') }));
    await t.queue.append(reading({ clientReadingId: 'not-a-uuid' }));
    t.up.start();
    await t.fire();
    expect(ids(t.calls[0]?.body.readings ?? [])).toEqual([good.clientReadingId]);
    expect(JSON.stringify(t.calls)).not.toMatch(/navigation|position|tanks/);
    expect(t.up.snapshot().invalid).toBe(4);
    expect(await t.queue.size()).toBe(0);
    await t.up.stop();
  });

  it('hold() sends nothing, resume() retries now; kick() only wakes a waiting upload', async () => {
    const t = setup();
    await t.fill(2);
    t.up.start();
    t.up.kick(); // first attempt is not "waiting after a failure": no effect
    expect(t.sched.pendingMs).toBeGreaterThan(0);
    t.up.hold();
    expect(t.sched.timers.size).toBe(0);
    expect(t.up.snapshot().state).toBe('held');
    t.up.kick();
    expect(t.sched.timers.size).toBe(0);
    t.up.resume();
    expect(t.sched.pendingMs).toBe(0);
    await t.fire();
    expect(await t.queue.size()).toBe(0);
    // A healthy connection does not force an early upload.
    t.up.resume();
    t.up.kick();
    expect(t.sched.pendingMs).toBe(24 * HOUR);
    await t.up.stop();
  });

  it('is single flight: kick() during a request starts no second one', async () => {
    let release: (r: Response) => void = () => undefined;
    const t = setup({
      responders: [
        () =>
          new Promise<Response>((r) => {
            release = r;
          }),
      ],
    });
    await t.fill(1);
    t.up.start();
    t.sched.fireOnly();
    await vi.waitFor(() => {
      expect(t.calls).toHaveLength(1);
    });
    t.up.kick();
    t.up.resume();
    expect(t.calls).toHaveLength(1);
    release(acceptAll(t.calls[0] as Call));
    await vi.waitFor(() => {
      expect(t.up.snapshot().state).toBe('idle');
    });
    expect(t.calls).toHaveLength(1);
    await t.up.stop();
  });

  it('stop() aborts the in-flight request, acknowledges nothing and schedules nothing', async () => {
    let aborted = false;
    const t = setup({
      responders: [
        (_c, signal) =>
          new Promise<Response>((_res, rej) => {
            signal?.addEventListener('abort', () => {
              aborted = true;
              rej(new DOMException('aborted', 'AbortError'));
            });
          }),
      ],
    });
    await t.fill(2);
    t.up.start();
    t.sched.fireOnly();
    await vi.waitFor(() => {
      expect(t.calls).toHaveLength(1);
    });
    await t.up.stop();
    expect(aborted).toBe(true);
    expect(await t.queue.size()).toBe(2);
    expect(t.sched.timers.size).toBe(0);
    expect(t.up.snapshot().state).toBe('stopped');
    expect(t.events.filter((e) => e.kind !== 'changed')).toEqual([]);
  });

  it('a restart with a pending queue replays the same clientReadingIds', async () => {
    const t = setup({ responders: [() => json(502, {})] });
    const rs = await t.fill(3);
    t.up.start();
    await t.fire();
    await t.up.stop();
    await t.queue.close();
    const first = ids(t.calls[0]?.body.readings ?? []);
    expect(first).toEqual(ids(rs));

    const t2 = setup({ dir: t.dir });
    t2.up.start();
    await t2.fire();
    expect(ids(t2.calls[0]?.body.readings ?? [])).toEqual(first);
    expect(await t2.queue.size()).toBe(0);
    await t2.up.stop();
  });

  it('never sends the credential to an origin other than the one it was issued for', async () => {
    const t = setup({
      baseUrl: 'https://api.example.test',
      credentialOrigin: 'https://other.example.test',
    });
    await t.fill(1);
    t.up.start();
    await t.fire();
    expect(t.calls).toHaveLength(0);
    expect(t.up.snapshot().state).toBe('backoff');
    expect(await t.queue.size()).toBe(1);
    await t.up.stop();
  });
});
