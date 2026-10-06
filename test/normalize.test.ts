import { describe, expect, it } from 'vitest';
import { normalize } from '../src/normalize';
import { parsePath, V1_PATH_RULES } from '../src/paths';

const T = '2026-10-05T12:00:00.000Z';
const delta = (values: { path: string; value: unknown }[], timestamp: string | undefined = T) => ({
  context: 'vessels.urn:mrn:imo:mmsi:123456789',
  updates: [{ timestamp, source: { label: 'x' }, values }],
});

describe('normalize', () => {
  it.each([
    ['propulsion.port.runTime', 7200, 'engine_hours', 'propulsion.port', 2],
    ['electrical.generators.0.runTime', 3600, 'generator_hours', 'electrical.generators.0', 1],
    [
      'electrical.batteries.house.voltage',
      12.6,
      'battery_voltage',
      'electrical.batteries.house',
      12.6,
    ],
    [
      'electrical.batteries.house.capacity.stateOfCharge',
      0.85,
      'battery_state_of_charge',
      'electrical.batteries.house',
      85,
    ],
    ['tanks.fuel.0.currentLevel', 0.5, 'tank_level', 'tanks.fuel.0', 50],
    ['tanks.freshWater.main.currentVolume', 0.2, 'tank_volume', 'tanks.freshWater.main', 200],
  ])('maps %s', (path, value, quantity, channel, canonical) => {
    const [r, ...rest] = normalize(delta([{ path, value }]));
    expect(rest).toHaveLength(0);
    expect(r).toEqual({ channel, path, quantity, value, canonical, observedAt: T });
  });

  it('rejects paths outside the registry and never leaks identifying fields', () => {
    const out = normalize(
      delta([
        { path: 'navigation.position', value: { latitude: 1, longitude: 2 } },
        { path: 'navigation.speedOverGround', value: 3 },
        { path: 'name', value: 'Boaty' },
        { path: 'mmsi', value: 123456789 },
        { path: 'propulsion.my engine.runTime', value: 5 },
        { path: 'tanks.petrol.0.currentLevel', value: 0.5 },
        { path: 'propulsion.port.runTime.extra', value: 5 },
        { path: 'propulsion.port.revolutions', value: 5 },
      ]),
    );
    expect(out).toEqual([]);
  });

  it('drops non-numeric, non-finite and out-of-range values', () => {
    const out = normalize(
      delta([
        { path: 'propulsion.a.runTime', value: '12' },
        { path: 'propulsion.b.runTime', value: Number.NaN },
        { path: 'propulsion.c.runTime', value: -1 },
        { path: 'tanks.fuel.0.currentLevel', value: 1.2 },
        { path: 'electrical.batteries.h.capacity.stateOfCharge', value: -0.1 },
        { path: 'propulsion.d.runTime', value: null },
      ]),
    );
    expect(out).toEqual([]);
  });

  it('uses the update timestamp, normalised to UTC, else the injected clock', () => {
    const v = [{ path: 'propulsion.a.runTime', value: 3600 }];
    expect(normalize(delta(v, '2026-10-05T14:00:00+02:00'))[0]?.observedAt).toBe(T);
    const fixed = Date.parse('2030-01-01T00:00:00Z');
    expect(normalize({ updates: [{ values: v }] }, () => fixed)[0]?.observedAt).toBe(
      '2030-01-01T00:00:00.000Z',
    );
    expect(normalize(delta(v, 'garbage'), () => fixed)[0]?.observedAt).toBe(
      '2030-01-01T00:00:00.000Z',
    );
  });

  it('tolerates junk input', () => {
    for (const j of [null, undefined, 5, 'x', {}, { updates: 'x' }, { updates: [null, 1, {}] }]) {
      expect(normalize(j)).toEqual([]);
    }
  });
});

describe('v1 registry', () => {
  it('never permits location-like or identifying paths', () => {
    const banned = ['position', 'mmsi', 'callsign', 'ais', 'course', 'heading', 'track', 'name'];
    for (const rule of V1_PATH_RULES) {
      const pat = rule.pattern.toLowerCase();
      expect(pat.startsWith('navigation.')).toBe(false);
      for (const word of banned) expect(pat).not.toContain(word);
    }
  });

  it('only matches fully-anchored paths', () => {
    expect(parsePath('x.propulsion.a.runTime')).toBeNull();
    expect(parsePath('propulsion.a.runTime\n')).toBeNull();
    expect(parsePath('propulsion..runTime')).toBeNull();
  });
});
