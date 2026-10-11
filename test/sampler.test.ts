import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseOptions } from '../src/config';
import type { PathRule } from '../src/mapping';
import { PATH_RULES } from '../src/mapping';
import { ReadingQueue } from '../src/queue';
import { createSampler, NullSink, QueueSink, type SampledReading } from '../src/sampler';

const RULES: PathRule[] = [
  { pattern: 'test.alpha.*.run', category: 'engineHours', unit: 's' },
  { pattern: 'test.beta.*.volts', category: 'batteries', unit: 'V' },
  { pattern: 'test.beta.*.charge', category: 'batteries', unit: 'ratio' },
  { pattern: 'test.gamma.*.*.level', category: 'tanks', unit: 'ratio' },
  { pattern: 'test.gamma.*.*.volume', category: 'tanks', unit: 'm3' },
];

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

/** Upload categories default to off; the policy tests turn them on unless a test says otherwise. */
function enableAll(settings: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...settings };
  const legacy = { engineHours: 'sendEngineHours', batteries: 'sendBatteries', tanks: 'sendTanks' };
  for (const [k, toggle] of Object.entries(legacy)) {
    if (toggle in settings) continue; // the legacy toggle decides
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
    rules: RULES,
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

describe('delta adapter', () => {
  it('keeps only self-context numeric values that match the rules', async () => {
    const { sink, send, sampler } = setup(allHourly);
    expect(await send('test.alpha.a.run', 3600, T0, 'vessels.urn:other')).toBe(0);
    expect(await send('test.alpha.a.run', 3600, T0, null)).toBe(0);
    for (const bad of ['3600', NaN, Infinity, -Infinity, null, {}, [1], true]) {
      expect(await send('test.alpha.a.run', bad, T0)).toBe(0);
    }
    expect(await send('test.unlisted.a.run', 1, T0)).toBe(0);
    expect(
      await sampler.handleDelta({
        context: 'vessels.self',
        updates: [
          { timestamp: iso(T0), meta: [{ path: 'test.alpha.a.run', value: { units: 's' } }] },
          { values: [{ path: 'test.alpha.a.run', value: 1 }] },
          { timestamp: 'nope', values: [{ path: 'test.alpha.a.run', value: 1 }] },
          null,
        ],
      }),
    ).toBe(0);
    expect(await sampler.handleDelta('x')).toBe(0);
    expect(await sampler.handleDelta({ context: 'vessels.self', updates: 5 })).toBe(0);
    expect(sink.readings).toEqual([]);
    expect(await send('test.alpha.a.run', 3600, T0)).toBe(1);
  });

  it('accepts a configured own-vessel context name', async () => {
    const sink = new MemSink();
    const s = createSampler({
      options: parseOptions(enableAll({})).upload,
      sink,
      now: () => T0 + 1,
      rules: RULES,
      selfContext: 'vessels.urn:test:own',
    });
    const d = (context: string) => ({
      context,
      updates: [{ timestamp: iso(T0), values: [{ path: 'test.alpha.a.run', value: 3600 }] }],
    });
    expect(await s.handleDelta(d('vessels.urn:test:own'))).toBe(1);
    expect(await s.handleDelta(d('vessels.urn:test:else'))).toBe(0);
  });

  it('queues raw SI values and records the SignalK timestamp', async () => {
    const { sink, send } = setup(allHourly);
    await send('test.alpha.main.run', 7200, T0);
    await send('test.beta.house.charge', 0.5, T0);
    await send('test.beta.house.volts', 12.5, T0);
    await send('test.gamma.fuel.0.level', 0.25, T0);
    await send('test.gamma.fuel.0.volume', 0.2, T0);
    expect(sink.readings).toEqual([
      { path: 'test.alpha.main.run', value: 7200, recordedAt: iso(T0) },
      { path: 'test.beta.house.charge', value: 0.5, recordedAt: iso(T0) },
      { path: 'test.beta.house.volts', value: 12.5, recordedAt: iso(T0) },
      { path: 'test.gamma.fuel.0.level', value: 0.25, recordedAt: iso(T0) },
      { path: 'test.gamma.fuel.0.volume', value: 0.2, recordedAt: iso(T0) },
    ]);
  });

  it.each([
    ['test.alpha.a.run', [0, 1, 3599.5, 7200, 1e9]],
    ['test.beta.a.volts', [0, 11.9, 12.5, 14.4]],
    ['test.beta.a.charge', [0, 0.01, 0.5, 1]],
    ['test.gamma.fuel.0.level', [0, 0.333, 0.25, 1]],
    ['test.gamma.fuel.0.volume', [0, 0.0005, 0.2, 1.5]],
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
    expect(await send('test.alpha.a.run', 1, T0 + 10 * MIN)).toBe(0);
    expect(await send('test.alpha.a.run', 1, T0 + 4 * MIN)).toBe(1);
  });
});

describe('record policy', () => {
  it('enforces the record interval floor', async () => {
    const { send } = setup({ engineHours: { recordIntervalMinutes: 120, minChangeHours: 0.1 } });
    expect(await send('test.alpha.a.run', 0, T0)).toBe(1);
    expect(await send('test.alpha.a.run', 3600 * 5, T0 + 119 * MIN)).toBe(0);
    expect(await send('test.alpha.a.run', 3600 * 5, T0 + 120 * MIN)).toBe(1);
  });

  it('defaults to once a day', async () => {
    const { send } = setup({});
    expect(await send('test.alpha.a.run', 0, T0)).toBe(1);
    expect(await send('test.alpha.a.run', 36_000, T0 + 23 * 60 * MIN)).toBe(0);
    expect(await send('test.alpha.a.run', 36_000, T0 + 24 * 60 * MIN)).toBe(1);
  });

  it('needs the minimum change unless the threshold is 0 or 24 h passed', async () => {
    const { send } = setup({
      engineHours: { recordIntervalMinutes: 60, minChangeHours: 1 },
      batteries: { recordIntervalMinutes: 60, minChangeVolts: 0.5, minChangePercent: 10 },
      tanks: { recordIntervalMinutes: 60 },
    });
    expect(await send('test.alpha.a.run', 0, T0)).toBe(1);
    expect(await send('test.alpha.a.run', 3599, T0 + 60 * MIN)).toBe(0); // 0.9997 h < 1 h
    expect(await send('test.alpha.a.run', 3600, T0 + 120 * MIN)).toBe(1); // exactly 1 h
    expect(await send('test.alpha.a.run', 3600, T0 + 27 * 60 * MIN)).toBe(1); // heartbeat

    expect(await send('test.beta.h.volts', 12, T0)).toBe(1);
    expect(await send('test.beta.h.volts', 12.4, T0 + 60 * MIN)).toBe(0);
    expect(await send('test.beta.h.volts', 12.5, T0 + 120 * MIN)).toBe(1);
    expect(await send('test.beta.h.charge', 0.5, T0)).toBe(1);
    expect(await send('test.beta.h.charge', 0.55, T0 + 60 * MIN)).toBe(0);
    expect(await send('test.beta.h.charge', 0.6, T0 + 120 * MIN)).toBe(1);

    // tank thresholds default to 0: every interval passes
    expect(await send('test.gamma.fuel.0.level', 0.5, T0)).toBe(1);
    expect(await send('test.gamma.fuel.0.level', 0.5, T0 + 60 * MIN)).toBe(1);
  });

  it('uses litres for volume and percent for level', async () => {
    const { send } = setup({
      tanks: { recordIntervalMinutes: 60, minChangePercent: 50, minChangeLiters: 10 },
    });
    expect(await send('test.gamma.fuel.0.volume', 0.1, T0)).toBe(1);
    expect(await send('test.gamma.fuel.0.volume', 0.105, T0 + 60 * MIN)).toBe(0); // +5 L
    expect(await send('test.gamma.fuel.0.volume', 0.12, T0 + 120 * MIN)).toBe(1); // +20 L
  });

  it('drops a repeated, stale or out-of-order SignalK timestamp', async () => {
    const { send } = setup(allHourly);
    expect(await send('test.alpha.a.run', 1, T0 + 120 * MIN)).toBe(1);
    expect(await send('test.alpha.a.run', 99999, T0 + 120 * MIN)).toBe(0);
    expect(await send('test.alpha.a.run', 99999, T0 + 60 * MIN)).toBe(0);
    expect(await send('test.alpha.a.run', 99999, T0)).toBe(0);
    expect(await send('test.alpha.a.run', 99999, T0 + 180 * MIN)).toBe(1);
  });

  it('keeps at most 24 per channel per UTC day and resets across midnight', async () => {
    const { send, sink } = setup(allHourly);
    const midnight = Date.parse('2030-03-02T00:00:00Z');
    let kept = 0;
    for (let i = 0; i < 24; i++)
      kept += await send('test.alpha.a.run', i * 3600, midnight + i * 60 * MIN);
    expect(kept).toBe(24);
    // next day 00:00 is allowed again, day 1 never exceeded 24
    expect(await send('test.alpha.a.run', 99_999, midnight + 24 * 60 * MIN)).toBe(1);
    expect(sink.readings).toHaveLength(25);
    // Shift so a day spans 24 hourly slots starting mid-day: 12:30 -> next 12:30 crosses midnight.
    const other = setup(allHourly);
    const start = Date.parse('2030-03-02T12:30:00Z');
    let n = 0;
    for (let i = 0; i < 48; i++)
      n += await other.send('test.alpha.b.run', i * 3600, start + i * 60 * MIN);
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
    expect(await sel.send('test.alpha.main.run', 1, T0)).toBe(1);
    expect(await sel.send('test.alpha.aux.run', 1, T0)).toBe(0);
    expect(await sel.send('test.gamma.fuel.0.level', 0.5, T0)).toBe(0);
    expect(await sel.send('test.beta.house.volts', 12, T0)).toBe(0);
    const tank = setup({ tanks: { instances: { mode: 'selected', ids: ['fuel.0'] } } });
    expect(await tank.send('test.gamma.fuel.0.level', 0.5, T0)).toBe(1);
    expect(await tank.send('test.gamma.fuel.1.level', 0.5, T0)).toBe(0);
    expect(await tank.send('test.gamma.water.0.level', 0.5, T0)).toBe(0);
  });

  it('honours the legacy toggle', async () => {
    const { send } = setup({ sendEngineHours: false });
    expect(await send('test.alpha.a.run', 1, T0)).toBe(0);
  });

  it('allows only the first 64 channels and reports the rest', async () => {
    const { send, sampler } = setup(allHourly);
    for (let i = 0; i < 70; i++) await send(`test.alpha.e${String(i)}.run`, 1, T0);
    expect(sampler.stats()).toEqual({ kept: 64, channels: 64, overflowChannels: 6 });
    // an admitted channel keeps working; an overflow one stays refused
    expect(await send('test.alpha.e0.run', 3600, T0 + 60 * MIN)).toBe(1);
    expect(await send('test.alpha.e69.run', 1, T0 + 60 * MIN)).toBe(0);
    // filtered-out samples do not take a channel slot
    const f = setup({ engineHours: { instances: { mode: 'selected', ids: ['ok'] } } });
    for (let i = 0; i < 100; i++) await f.send(`test.alpha.x${String(i)}.run`, 1, T0);
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
          ch === 0 ? 'test.alpha.m.run' : ch === 1 ? 'test.beta.h.volts' : 'test.beta.h.charge',
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
  it('a sampler built from PATH_RULES keeps nothing, including position', async () => {
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
    expect(n).toBe(0);
    expect(PATH_RULES).toHaveLength(0);
    expect(sink.readings).toEqual([]);
    expect(s.stats()).toEqual({ kept: 0, channels: 0, overflowChannels: 0 });
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
      rules: RULES,
    });
    await sampler.handleDelta({
      context: 'vessels.self',
      updates: [{ timestamp: iso(T0), values: [{ path: 'test.alpha.a.run', value: 3600 }] }],
    });
    const [r] = await queue.peek(5);
    expect(r).toMatchObject({ path: 'test.alpha.a.run', value: 3600, recordedAt: iso(T0) });
    expect(r?.clientReadingId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-/);
  });
});
