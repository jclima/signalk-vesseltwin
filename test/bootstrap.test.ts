import { describe, expect, it } from 'vitest';
import { snapshotSelf } from '../src/bootstrap';
import { MAX_CHANNELS } from '../src/config';
import { isPermittedPath, PATH_RULES } from '../src/mapping';

const TS = '2030-03-01T00:00:00.000Z';
const leaf = (value: unknown, timestamp: unknown = TS) => ({ value, timestamp, $source: 'a.b' });

function getter(tree: Record<string, unknown>) {
  const asked: string[] = [];
  return {
    asked,
    get: (p: string) => {
      asked.push(p);
      return tree[p];
    },
  };
}

const paths = (ds: ReturnType<typeof snapshotSelf>) =>
  ds.map((d) => (d.updates as { values: { path: string }[] }[])[0]?.values[0]?.path);

describe('snapshotSelf', () => {
  it('builds the exact leaf paths for every rule and reads value and timestamp only', () => {
    const g = getter({
      propulsion: { port: { runTime: leaf(3600) } },
      'electrical.generators': { gen1: { runTime: leaf(7200) } },
      'electrical.batteries': {
        house: { voltage: leaf(12.6), capacity: { stateOfCharge: leaf(0.8) } },
      },
      tanks: { fuel: { '0': { currentLevel: leaf(0.5), currentVolume: leaf(0.1) } } },
    });
    const out = snapshotSelf(g.get, PATH_RULES);
    expect(paths(out).sort()).toEqual(
      [
        'propulsion.port.runTime',
        'electrical.generators.gen1.runTime',
        'electrical.batteries.house.voltage',
        'electrical.batteries.house.capacity.stateOfCharge',
        'tanks.fuel.0.currentLevel',
        'tanks.fuel.0.currentVolume',
      ].sort(),
    );
    expect(out[0]).toEqual({
      updates: [
        { timestamp: TS, values: [{ path: out.length ? paths(out)[0] : '', value: 3600 }] },
      ],
    });
    expect(new Set(g.asked)).toEqual(
      new Set(['propulsion', 'electrical.generators', 'electrical.batteries', 'tanks']),
    );
  });

  it('only asks for the prefixes of the active rules', () => {
    const g = getter({});
    snapshotSelf(
      g.get,
      PATH_RULES.filter((r) => r.category === 'batteries'),
    );
    expect(new Set(g.asked)).toEqual(new Set(['electrical.batteries']));
    expect(snapshotSelf(g.get, [])).toEqual([]);
  });

  it('ignores multi-source values, meta, $source, non-permitted siblings and garbage', () => {
    const g = getter({
      propulsion: {
        main: {
          temperature: leaf(300),
          runTime: { values: { 'x.y': { value: 5, timestamp: TS } }, meta: { units: 's' } },
        },
        bad: { runTime: leaf('1') },
        nots: { runTime: leaf(1, 'nope') },
        inf: { runTime: leaf(Infinity) },
        str: 'x',
        'bad id!': { runTime: leaf(1) },
      },
      'electrical.batteries': 'oops',
      tanks: null,
    });
    expect(snapshotSelf(g.get, PATH_RULES)).toEqual([]);
  });

  it('survives a throwing getter and non-object roots', () => {
    expect(
      snapshotSelf(() => {
        throw new Error('boom');
      }, PATH_RULES),
    ).toEqual([]);
    expect(snapshotSelf(() => 42, PATH_RULES)).toEqual([]);
  });

  it('caps the number of channels', () => {
    const batteries: Record<string, unknown> = {};
    for (let i = 0; i < MAX_CHANNELS * 2; i += 1)
      batteries[`b${String(i)}`] = { voltage: leaf(12) };
    const out = snapshotSelf(
      (p) => (p === 'electrical.batteries' ? batteries : undefined),
      PATH_RULES,
    );
    expect(out).toHaveLength(MAX_CHANNELS);
  });

  it('every emitted path is permitted, whatever the tree holds (property-style)', () => {
    const keys = [
      'a',
      'main',
      'house',
      'fuel',
      'bad id',
      '__proto__',
      'runTime',
      'voltage',
      'x.y',
      'meta',
    ];
    let seed = 7;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const gen = (depth: number): unknown => {
      if (depth === 0 || rnd(5) === 0) return rnd(2) ? leaf(rnd(100) / 7) : rnd(3) ? 'x' : null;
      const o: Record<string, unknown> = {};
      for (let i = 0; i < 1 + rnd(4); i += 1) o[keys[rnd(keys.length)] as string] = gen(depth - 1);
      return o;
    };
    for (let n = 0; n < 300; n += 1) {
      const tree: Record<string, unknown> = {};
      for (const p of ['propulsion', 'electrical.generators', 'electrical.batteries', 'tanks']) {
        tree[p] = gen(5);
      }
      for (const p of paths(snapshotSelf((k) => tree[k], PATH_RULES))) {
        expect(isPermittedPath(p)).toBe(true);
      }
    }
  });
});
