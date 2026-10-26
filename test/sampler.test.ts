import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseOptions } from '../src/config';
import { isPermittedPath } from '../src/mapping';
import { ReadingQueue } from '../src/queue';
import { createSampler, NullSink, QueueSink, type SampledReading } from '../src/sampler';

const T0 = Date.parse('2030-03-01T00:00:00Z');
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

class MemSink {
  readings: SampledReading[] = [];
  write(r: SampledReading): Promise<void> {
    this.readings.push(r);
    return Promise.resolve();
  }
}

/** Upload is off by default; the policy tests switch it and every category on unless a test says otherwise. */
function enableAll(settings: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { uploadEnabled: true, ...settings };
  for (const k of ['engineHours', 'batteries', 'tanks']) {
    const c = settings[k];
    out[k] = { enabled: true, ...(typeof c === 'object' && c !== null ? c : {}) };
  }
  return out;
}

function setup(settings: Record<string, unknown> = {}, now = T0 + 400 * 24 * 60 * MIN) {
  const sink = new MemSink();
  const sampler = createSampler({
    options: parseOptions(enableAll(settings)).upload,
    sink,
    now: () => now,
  });
  const send = (path: string, value: unknown, at: number, context: unknown = 'vessels.self') =>
    sampler.handleDelta({
      context,
      updates: [{ timestamp: iso(at), values: [{ path, value }] }],
    });
  return { sink, sampler, send };
}

const hourly = { recordIntervalMinutes: 60 };
const allHourly = { engineHours: hourly, batteries: hourly, tanks: hourly };

describe('failed writes', () => {
  it('a reading the sink could not write does not count as kept: the next sample is still taken', async () => {
    let fail = true;
    const kept: SampledReading[] = [];
    const sampler = createSampler({
      options: parseOptions(enableAll(allHourly)).upload,
      sink: {
        write: (r) => {
          if (fail) return Promise.reject(new Error('disk full'));
          kept.push(r);
          return Promise.resolve();
        },
      },
      now: () => T0 + 400 * 24 * 60 * MIN,
    });
    const send = (at: number) =>
      sampler.handleDelta({
        context: 'vessels.self',
        updates: [{ timestamp: iso(at), values: [{ path: 'propulsion.a.runTime', value: 3600 }] }],
      });
    await expect(send(T0)).rejects.toThrow('disk full');
    expect(sampler.stats().kept).toBe(0);
    fail = false;
    // Same timestamp again (a replay of the cached value) is accepted because nothing was kept.
    expect(await send(T0)).toBe(1);
    expect(kept).toHaveLength(1);
    expect(sampler.stats().kept).toBe(1);
  });
});

describe('delta adapter', () => {
  it('keeps only numeric values on permitted paths', async () => {
    const { sink, send, sampler } = setup(allHourly);
    for (const bad of ['3600', NaN, Infinity, -Infinity, null, {}, [1], true]) {
      expect(await send('propulsion.a.runTime', bad, T0)).toBe(0);
    }
    expect(await send('foo.unlisted.a.run', 1, T0)).toBe(0);
    expect(
      await sampler.handleDelta({
        context: 'vessels.self',
        updates: [
          { timestamp: iso(T0), meta: [{ path: 'propulsion.a.runTime', value: { units: 's' } }] },
          { values: [{ path: 'propulsion.a.runTime', value: 1 }] },
          { timestamp: 'nope', values: [{ path: 'propulsion.a.runTime', value: 1 }] },
          null,
        ],
      }),
    ).toBe(0);
    expect(await sampler.handleDelta('x')).toBe(0);
    expect(await sampler.handleDelta({ context: 'vessels.self', updates: 5 })).toBe(0);
    expect(sink.readings).toEqual([]);
    expect(await send('propulsion.a.runTime', 3600, T0)).toBe(1);
  });

  it('accepts a real-shaped delta under the full self URN and emits UTC Z timestamps', async () => {
    const sink = new MemSink();
    const s = createSampler({
      options: parseOptions(enableAll({})).upload,
      sink,
      now: () => T0 + 24 * 60 * MIN,
    });
    const n = await s.handleDelta({
      context: 'vessels.urn:mrn:signalk:uuid:00000000-0000-4000-8000-000000000000',
      updates: [
        {
          $source: 'fake.source',
          timestamp: '2030-03-01T02:00:00.5+02:00',
          values: [{ path: 'propulsion.main.runTime', value: 3600 }],
        },
      ],
    });
    expect(n).toBe(1);
    expect(sink.readings).toEqual([
      { path: 'propulsion.main.runTime', value: 3600, recordedAt: '2030-03-01T00:00:00.500Z' },
    ]);
  });

  it('only ever emits permitted paths', async () => {
    const { sink, send } = setup(allHourly);
    await send('propulsion.main.runTime', 1, T0);
    await send('propulsion.a.b.runTime', 1, T0);
    for (const r of sink.readings) expect(isPermittedPath(r.path)).toBe(true);
    expect(sink.readings).toHaveLength(1);
  });

  it('queues raw SI values and records the SignalK timestamp', async () => {
    const { sink, send } = setup(allHourly);
    await send('propulsion.main.runTime', 7200, T0);
    await send('electrical.batteries.house.capacity.stateOfCharge', 0.5, T0);
    await send('electrical.batteries.house.voltage', 12.5, T0);
    await send('tanks.fuel.0.currentLevel', 0.25, T0);
    await send('tanks.fuel.0.currentVolume', 0.2, T0);
    expect(sink.readings).toEqual([
      { path: 'propulsion.main.runTime', value: 7200, recordedAt: iso(T0) },
      {
        path: 'electrical.batteries.house.capacity.stateOfCharge',
        value: 0.5,
        recordedAt: iso(T0),
      },
      { path: 'electrical.batteries.house.voltage', value: 12.5, recordedAt: iso(T0) },
      { path: 'tanks.fuel.0.currentLevel', value: 0.25, recordedAt: iso(T0) },
      { path: 'tanks.fuel.0.currentVolume', value: 0.2, recordedAt: iso(T0) },
    ]);
  });

  it.each([
    ['propulsion.a.runTime', [0, 1, 3599.5, 7200, 1e9]],
    ['electrical.batteries.a.voltage', [0, 11.9, 12.5, 14.4]],
    ['electrical.batteries.a.capacity.stateOfCharge', [0, 0.01, 0.5, 1]],
    ['tanks.fuel.0.currentLevel', [0, 0.333, 0.25, 1]],
    ['tanks.fuel.0.currentVolume', [0, 0.0005, 0.2, 1.5]],
  ] as const)('emits the input value unchanged for %s', async (p, values) => {
    // threshold 0 so every sample at a new interval passes; the value must never be converted
    const { sink, send } = setup({
      engineHours: { recordIntervalMinutes: 60, minChangeHours: 0.1 },
      batteries: hourly,
      tanks: hourly,
    });
    let t = T0;
    for (const v of values) {
      // jump a day so the owner-unit change threshold never blocks
      t += 24 * 60 * MIN;
      await send(p, v, t);
    }
    expect(sink.readings.map((r) => r.value)).toEqual([...values]);
  });

  it('ignores timestamps far in the future', async () => {
    const { send } = setup(allHourly, T0);
    expect(await send('propulsion.a.runTime', 1, T0 + 10 * MIN)).toBe(0);
    expect(await send('propulsion.a.runTime', 1, T0 + 4 * MIN)).toBe(1);
  });
});

describe('record policy', () => {
  it('enforces the record interval floor', async () => {
    const { send } = setup({ engineHours: { recordIntervalMinutes: 120, minChangeHours: 0.1 } });
    expect(await send('propulsion.a.runTime', 0, T0)).toBe(1);
    expect(await send('propulsion.a.runTime', 3600 * 5, T0 + 119 * MIN)).toBe(0);
    expect(await send('propulsion.a.runTime', 3600 * 5, T0 + 120 * MIN)).toBe(1);
  });

  it('defaults to once a day', async () => {
    const { send } = setup({});
    expect(await send('propulsion.a.runTime', 0, T0)).toBe(1);
    expect(await send('propulsion.a.runTime', 36_000, T0 + 23 * 60 * MIN)).toBe(0);
    expect(await send('propulsion.a.runTime', 36_000, T0 + 24 * 60 * MIN)).toBe(1);
  });

  it('needs the minimum change unless the threshold is 0 or 24 h passed', async () => {
    const { send } = setup({
      engineHours: { recordIntervalMinutes: 60, minChangeHours: 1 },
      batteries: { recordIntervalMinutes: 60, minChangeVolts: 0.5, minChangePercent: 10 },
      tanks: { recordIntervalMinutes: 60 },
    });
    expect(await send('propulsion.a.runTime', 0, T0)).toBe(1);
    expect(await send('propulsion.a.runTime', 3599, T0 + 60 * MIN)).toBe(0); // 0.9997 h < 1 h
    expect(await send('propulsion.a.runTime', 3600, T0 + 120 * MIN)).toBe(1); // exactly 1 h
    expect(await send('propulsion.a.runTime', 3600, T0 + 27 * 60 * MIN)).toBe(1); // heartbeat

    expect(await send('electrical.batteries.h.voltage', 12, T0)).toBe(1);
    expect(await send('electrical.batteries.h.voltage', 12.4, T0 + 60 * MIN)).toBe(0);
    expect(await send('electrical.batteries.h.voltage', 12.5, T0 + 120 * MIN)).toBe(1);
    expect(await send('electrical.batteries.h.capacity.stateOfCharge', 0.5, T0)).toBe(1);
    expect(await send('electrical.batteries.h.capacity.stateOfCharge', 0.55, T0 + 60 * MIN)).toBe(
      0,
    );
    expect(await send('electrical.batteries.h.capacity.stateOfCharge', 0.6, T0 + 120 * MIN)).toBe(
      1,
    );

    // tank thresholds default to 0: every interval passes
    expect(await send('tanks.fuel.0.currentLevel', 0.5, T0)).toBe(1);
    expect(await send('tanks.fuel.0.currentLevel', 0.5, T0 + 60 * MIN)).toBe(1);
  });

  it('uses litres for volume and percent for level', async () => {
    const { send } = setup({
      tanks: { recordIntervalMinutes: 60, minChangePercent: 50, minChangeLiters: 10 },
    });
    expect(await send('tanks.fuel.0.currentVolume', 0.1, T0)).toBe(1);
    expect(await send('tanks.fuel.0.currentVolume', 0.105, T0 + 60 * MIN)).toBe(0); // +5 L
    expect(await send('tanks.fuel.0.currentVolume', 0.12, T0 + 120 * MIN)).toBe(1); // +20 L
  });

  it('drops a repeated, stale or out-of-order SignalK timestamp', async () => {
    const { send } = setup(allHourly);
    expect(await send('propulsion.a.runTime', 1, T0 + 120 * MIN)).toBe(1);
    expect(await send('propulsion.a.runTime', 99999, T0 + 120 * MIN)).toBe(0);
    expect(await send('propulsion.a.runTime', 99999, T0 + 60 * MIN)).toBe(0);
    expect(await send('propulsion.a.runTime', 99999, T0)).toBe(0);
    expect(await send('propulsion.a.runTime', 99999, T0 + 180 * MIN)).toBe(1);
  });

  it('a source clock that steps far back starts the channel over instead of silencing it', async () => {
    const { send, sink } = setup(allHourly);
    const H = 60 * MIN;
    expect(await send('propulsion.a.runTime', 36000, T0 + 10 * H)).toBe(1);
    expect(await send('propulsion.a.runTime', 18000, T0 + 5 * H)).toBe(0); // 5 h back: just out of order
    expect(await send('propulsion.a.runTime', 10800, T0 + 3 * H)).toBe(1); // 7 h back: the clock was reset
    expect(await send('propulsion.a.runTime', 12600, T0 + 3 * H + 30 * MIN)).toBe(0); // interval holds
    expect(await send('propulsion.a.runTime', 14400, T0 + 4 * H)).toBe(1);
    expect(sink.readings.map((r) => r.value)).toEqual([36000, 10800, 14400]);
  });

  it('remembers a bounded number of refused channels', async () => {
    const { send, sampler } = setup(allHourly);
    for (let i = 0; i < 1_500; i++) await send(`propulsion.n${String(i)}.runTime`, 1, T0);
    expect(sampler.stats().channels).toBeGreaterThan(0);
    expect(sampler.stats().overflowChannels).toBeLessThanOrEqual(1_000);
    expect(sampler.stats().overflowChannels).toBeGreaterThan(0);
  });

  it('keeps at most 24 per channel per UTC day and resets across midnight', async () => {
    const { send, sink } = setup(allHourly);
    const midnight = Date.parse('2030-03-02T00:00:00Z');
    let kept = 0;
    for (let i = 0; i < 24; i++)
      kept += await send('propulsion.a.runTime', i * 3600, midnight + i * 60 * MIN);
    expect(kept).toBe(24);
    // next day 00:00 is allowed again, day 1 never exceeded 24
    expect(await send('propulsion.a.runTime', 99_999, midnight + 24 * 60 * MIN)).toBe(1);
    expect(sink.readings).toHaveLength(25);
    // Shift so a day spans 24 hourly slots starting mid-day: 12:30 -> next 12:30 crosses midnight.
    const other = setup(allHourly);
    const start = Date.parse('2030-03-02T12:30:00Z');
    let n = 0;
    for (let i = 0; i < 48; i++)
      n += await other.send('propulsion.b.runTime', i * 3600, start + i * 60 * MIN);
    expect(n).toBe(48);
    const perDay = new Map<string, number>();
    for (const r of other.sink.readings) {
      const d = r.recordedAt.slice(0, 10);
      perDay.set(d, (perDay.get(d) ?? 0) + 1);
    }
    for (const c of perDay.values()) expect(c).toBeLessThanOrEqual(24);
  });

  it('applies the instance filter, the enabled flag, and selected-without-ids', async () => {
    const sel = setup({
      engineHours: { instances: { mode: 'selected', ids: ['main'] } },
      tanks: { enabled: false },
      batteries: { instances: { mode: 'selected', ids: [] } },
    });
    expect(await sel.send('propulsion.main.runTime', 1, T0)).toBe(1);
    expect(await sel.send('propulsion.aux.runTime', 1, T0)).toBe(0);
    expect(await sel.send('tanks.fuel.0.currentLevel', 0.5, T0)).toBe(0);
    expect(await sel.send('electrical.batteries.house.voltage', 12, T0)).toBe(0);
    const tank = setup({ tanks: { instances: { mode: 'selected', ids: ['fuel.0'] } } });
    expect(await tank.send('tanks.fuel.0.currentLevel', 0.5, T0)).toBe(1);
    expect(await tank.send('tanks.fuel.1.currentLevel', 0.5, T0)).toBe(0);
    expect(await tank.send('tanks.freshWater.0.currentLevel', 0.5, T0)).toBe(0);
  });

  it('records nothing while the master switch is off, and ignores legacy send* toggles', async () => {
    const { send } = setup({ uploadEnabled: false });
    expect(await send('propulsion.a.runTime', 1, T0)).toBe(0);
    const legacy = setup({
      uploadEnabled: true,
      engineHours: { enabled: false },
      sendEngineHours: true,
    });
    expect(await legacy.send('propulsion.a.runTime', 1, T0)).toBe(0);
  });

  it('allows only the first 64 channels and reports the rest', async () => {
    const { send, sampler } = setup(allHourly);
    for (let i = 0; i < 70; i++) await send(`propulsion.e${String(i)}.runTime`, 1, T0);
    expect(sampler.stats()).toEqual({ kept: 64, channels: 64, overflowChannels: 6 });
    // an admitted channel keeps working; an overflow one stays refused
    expect(await send('propulsion.e0.runTime', 3600, T0 + 60 * MIN)).toBe(1);
    expect(await send('propulsion.e69.runTime', 1, T0 + 60 * MIN)).toBe(0);
    // filtered-out samples do not take a channel slot
    const f = setup({ engineHours: { instances: { mode: 'selected', ids: ['ok'] } } });
    for (let i = 0; i < 100; i++) await f.send(`propulsion.x${String(i)}.runTime`, 1, T0);
    expect(f.sampler.stats().channels).toBe(0);
  });
});

describe('sampler properties', () => {
  it('never keeps more than 24 per channel per UTC day', async () => {
    let s = 7;
    const r = () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 2 ** 32;
    };
    for (let round = 0; round < 20; round++) {
      const { send, sink } = setup({
        engineHours: { recordIntervalMinutes: 60 },
        batteries: { recordIntervalMinutes: 60 + Math.floor(r() * 120) },
      });
      let t = Date.parse('2030-03-02T00:00:00Z');
      for (let i = 0; i < 400; i++) {
        t += Math.floor(r() * 90) * MIN - (r() < 0.1 ? 30 * MIN : 0);
        const ch = Math.floor(r() * 3);
        await send(
          ch === 0
            ? 'propulsion.m.runTime'
            : ch === 1
              ? 'electrical.batteries.h.voltage'
              : 'electrical.batteries.h.capacity.stateOfCharge',
          r() * 100_000,
          t,
        );
      }
      const per = new Map<string, number>();
      for (const k of sink.readings) {
        const key = `${k.path}|${k.recordedAt.slice(0, 10)}`;
        per.set(key, (per.get(key) ?? 0) + 1);
      }
      for (const c of per.values()) expect(c).toBeLessThanOrEqual(24);
      // per channel, kept times strictly increase and respect the interval floor
      const last = new Map<string, number>();
      for (const k of sink.readings) {
        const at = Date.parse(k.recordedAt);
        const prev = last.get(k.path);
        if (prev !== undefined) expect(at - prev).toBeGreaterThanOrEqual(60 * MIN);
        last.set(k.path, at);
      }
    }
  });
});

describe('production rules', () => {
  it('keeps only the allowlisted paths and never position', async () => {
    const sink = new MemSink();
    const s = createSampler({
      options: parseOptions(enableAll({})).upload,
      sink,
      now: () => T0 + 1,
    });
    const paths = [
      'navigation.position',
      'navigation.speedOverGround',
      'propulsion.main.runTime',
      'electrical.batteries.house.voltage',
      'electrical.batteries.house.capacity.stateOfCharge',
      'tanks.fuel.0.currentLevel',
      'tanks.fuel.0.currentVolume',
      'name',
      'mmsi',
    ];
    const n = await s.handleDelta({
      context: 'vessels.self',
      updates: [
        {
          timestamp: iso(T0),
          values: paths.map((p) => ({ path: p, value: 1 })),
        },
      ],
    });
    expect(n).toBe(5);
    expect(sink.readings.map((r) => r.path)).toEqual(paths.filter(isPermittedPath));
    expect(s.stats().kept).toBe(5);
  });
});

describe('sinks', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'vt-s-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('NullSink discards', async () => {
    await expect(new NullSink().write()).resolves.toBeUndefined();
  });

  it('QueueSink appends readings with a UUIDv7 id', async () => {
    const queue = new ReadingQueue({ dir, now: () => T0 + 1 });
    const sampler = createSampler({
      options: parseOptions(enableAll({})).upload,
      sink: new QueueSink(queue, () => T0 + 1),
      now: () => T0 + 1,
    });
    await sampler.handleDelta({
      context: 'vessels.self',
      updates: [{ timestamp: iso(T0), values: [{ path: 'propulsion.a.runTime', value: 3600 }] }],
    });
    const [r] = await queue.peek(5);
    expect(r).toMatchObject({ path: 'propulsion.a.runTime', value: 3600, recordedAt: iso(T0) });
    expect(r?.clientReadingId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-/);
  });
});

describe('sampler restart state', () => {
  const BAT = 'electrical.batteries.house.voltage';
  const opts = () => parseOptions(enableAll({ batteries: { recordIntervalMinutes: 60 } })).upload;
  const d = (ms: number, value: number) => ({
    updates: [{ timestamp: iso(ms), values: [{ path: BAT, value }] }],
  });

  it('snapshot lists kept channels; a new sampler seeded with it skips the same and older values', async () => {
    const a = new MemSink();
    const s1 = createSampler({ options: opts(), sink: a, now: () => T0 + 5 * MIN });
    await s1.handleDelta(d(T0, 12.6));
    const snap = s1.snapshot();
    expect(Object.keys(snap)).toEqual([BAT]);
    const b = new MemSink();
    const s2 = createSampler({
      options: opts(),
      sink: b,
      now: () => T0 + 5 * MIN,
      initial: JSON.parse(JSON.stringify(snap)),
    });
    await s2.handleDelta(d(T0, 12.6));
    await s2.handleDelta(d(T0 - MIN, 12.6));
    expect(b.readings).toHaveLength(0);
    // Interval carries over: too soon is skipped, after the interval it records.
    const s3 = createSampler({ options: opts(), sink: b, now: () => T0 + 90 * MIN, initial: snap });
    await s3.handleDelta(d(T0 + 30 * MIN, 13));
    expect(b.readings).toHaveLength(0);
    await s3.handleDelta(d(T0 + 61 * MIN, 13));
    expect(b.readings).toHaveLength(1);
  });

  it('ignores a malformed or non-permitted initial state', () => {
    const bad = {
      'navigation.position': { lastKeptMs: 1, lastKeptValue: 1, day: 'x', dayCount: 0 },
      [BAT]: { lastKeptMs: 'x', lastKeptValue: 1, day: 'x', dayCount: 0 },
    };
    expect(
      createSampler({ options: opts(), sink: new MemSink(), now: Date.now, initial: bad }).stats()
        .channels,
    ).toBe(0);
    for (const initial of [null, 5, 'x', []]) {
      expect(() =>
        createSampler({ options: opts(), sink: new MemSink(), now: Date.now, initial }),
      ).not.toThrow();
    }
  });
});

describe('seeded state sanity', () => {
  it('drops future entries and clamps dayCount', () => {
    const now = T0 + 400 * 24 * 60 * MIN;
    const A = 'electrical.batteries.a.voltage';
    const B = 'electrical.batteries.b.voltage';
    const C = 'electrical.batteries.c.voltage';
    const D = 'electrical.batteries.d.voltage';
    const st = (lastKeptMs: number, dayCount: number) => ({
      lastKeptMs,
      lastKeptValue: 12,
      day: '2031-04-05',
      dayCount,
    });
    const s = createSampler({
      options: parseOptions(enableAll({})).upload,
      sink: new MemSink(),
      now: () => now,
      initial: {
        [A]: st(now + 10 * MIN, 1),
        [B]: st(now - MIN, 1e9),
        [C]: st(now - MIN, -5),
        [D]: st(now - MIN, 2.7),
      },
    });
    const snap = s.snapshot() as Record<string, { dayCount: number }>;
    expect(snap[A]).toBeUndefined();
    expect(snap[B]?.dayCount).toBe(24);
    expect(snap[C]?.dayCount).toBe(0);
    expect(snap[D]?.dayCount).toBe(2);
  });
});
