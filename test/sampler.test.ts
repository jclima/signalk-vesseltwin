import { describe, expect, it } from 'vitest';
import type { Reading } from '../src/normalize';
import { Sampler } from '../src/sampler';

const t0 = Date.parse('2026-10-05T00:00:00Z');
const mk = (
  quantity: Reading['quantity'],
  canonical: number,
  atMs: number,
  channel = 'c1',
): Reading => ({
  channel,
  path: 'p',
  quantity,
  value: canonical,
  canonical,
  observedAt: new Date(t0 + atMs).toISOString(),
});
const MIN = 60_000;
const H = 3600_000;

describe('Sampler', () => {
  it('engine hours: first, then >= 0.1 h change, or a daily heartbeat', () => {
    const s = new Sampler();
    expect(s.accept(mk('engine_hours', 100, 0))).toBe(true);
    expect(s.accept(mk('engine_hours', 100.05, 5 * MIN))).toBe(false);
    expect(s.accept(mk('engine_hours', 100.1, 6 * MIN))).toBe(true);
    expect(s.accept(mk('engine_hours', 100.1, 23 * H))).toBe(false);
    expect(s.accept(mk('engine_hours', 100.1, 31 * H))).toBe(true); // 24 h since last emit
  });

  it('a backwards counter is reported, not fixed', () => {
    const s = new Sampler();
    s.accept(mk('engine_hours', 100, 0));
    expect(s.accept(mk('engine_hours', 50, MIN))).toBe(true);
  });

  it('levels: hourly, or on a delta with a minimum gap', () => {
    const s = new Sampler();
    expect(s.accept(mk('battery_voltage', 12.6, 0))).toBe(true);
    expect(s.accept(mk('battery_voltage', 12.7, 10 * MIN))).toBe(false);
    expect(s.accept(mk('battery_voltage', 13.0, 10 * MIN + 1))).toBe(true); // +0.4 V
    expect(s.accept(mk('battery_voltage', 12.0, 10 * MIN + 2))).toBe(false); // gap < 60 s
    expect(s.accept(mk('battery_voltage', 13.0, 80 * MIN))).toBe(true); // hourly
    expect(s.accept(mk('tank_level', 50, 0))).toBe(true);
    expect(s.accept(mk('tank_level', 52, 5 * MIN))).toBe(false);
    expect(s.accept(mk('tank_level', 56, 6 * MIN))).toBe(true);
  });

  it('tracks channels and quantities independently and caps channel count', () => {
    const s = new Sampler({ maxChannels: 2 });
    expect(s.accept(mk('engine_hours', 1, 0, 'a'))).toBe(true);
    expect(s.accept(mk('engine_hours', 1, 0, 'b'))).toBe(true);
    expect(s.accept(mk('engine_hours', 1, 0, 'c'))).toBe(false);
    expect(s.accept(mk('engine_hours', 1, 0, 'a'))).toBe(false);
  });
});
