import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { isPermittedPath } from '../src/mapping';
import { parseReadingsResponse, parseStatusSummary, validateReadingItem } from '../src/wire';

const DIR = join(__dirname, '..', 'contracts', 'signalk', 'v2');
const read = (rel: string): string => readFileSync(join(DIR, rel), 'utf8');
const json = (rel: string): unknown => JSON.parse(read(rel));

interface Fixtures {
  valid: unknown[];
  invalid: unknown[];
}
const fixtures = (name: string) => json(`fixtures/${name}.fixtures.json`) as Fixtures;

const ajv = new Ajv({ strict: true, allErrors: true });
addFormats(ajv);
const validators = Object.fromEntries(
  ['reading-item', 'readings-request', 'readings-response', 'status-summary'].map((n) => [
    n,
    ajv.compile(json(`${n}.schema.json`) as object),
  ]),
);
const itemSchema = json('reading-item.schema.json') as {
  properties: { path: { pattern: string } };
};
const PATH_RE = new RegExp(itemSchema.properties.path.pattern);
const itemValid = validators['reading-item'] as (x: unknown) => boolean;

describe('vendored contract v2 files', () => {
  it('match the recorded sha256 values', () => {
    const src = json('SOURCE.json') as { contract: number; files: Record<string, string> };
    expect(src.contract).toBe(2);
    expect(Object.keys(src.files)).toHaveLength(8);
    for (const [name, sha] of Object.entries(src.files)) {
      expect(
        createHash('sha256')
          .update(readFileSync(join(DIR, name)))
          .digest('hex'),
        name,
      ).toBe(sha);
    }
  });

  it('SOURCE.json carries no private provenance', () => {
    expect(Object.keys(json('SOURCE.json') as object).sort()).toEqual([
      'contract',
      'files',
      'vendoredAt',
    ]);
  });
});

describe('fixtures agree with the schemas (ajv)', () => {
  for (const name of ['reading-item', 'readings-request', 'readings-response', 'status-summary']) {
    it(name, () => {
      const v = validators[name] as (x: unknown) => boolean;
      const f = fixtures(name);
      expect(f.valid.length).toBeGreaterThan(0);
      expect(f.invalid.length).toBeGreaterThan(0);
      f.valid.forEach((x, i) => {
        expect(v(x), `valid[${String(i)}]`).toBe(true);
      });
      f.invalid.forEach((x, i) => {
        expect(v(x), `invalid[${String(i)}]`).toBe(false);
      });
    });
  }
});

describe('validateReadingItem', () => {
  const f = fixtures('reading-item');

  it('rejects every invalid fixture', () => {
    for (const x of f.invalid) expect(validateReadingItem(x)).toBe(false);
  });

  it('accepts valid fixtures except non-UTC offsets, which are stricter than the schema', () => {
    for (const x of f.valid) {
      const utc = (x as { recordedAt: string }).recordedAt.endsWith('Z');
      expect(validateReadingItem(x)).toBe(utc);
    }
    expect(f.valid.some((x) => !(x as { recordedAt: string }).recordedAt.endsWith('Z'))).toBe(true);
  });

  it('only accepts what the item schema accepts', () => {
    const id = '3f2b8c1e-6a4d-4e0b-9c55-0a1b2c3d4e5f';
    const base = { clientReadingId: id, path: 'propulsion.a.runTime', value: 1, recordedAt: '' };
    const corpus: unknown[] = [];
    for (const recordedAt of [
      '2026-10-05T12:00:00Z',
      '2026-10-05T12:00:00.123Z',
      '2026-02-30T12:00:00Z',
      '2026-10-05T24:00:00Z',
      '2026-10-05T12:00:00+00:00',
      '2026-10-05T12:00:00',
      '2026-10-05',
      '2026-10-05t12:00:00z',
      '',
    ]) {
      corpus.push({ ...base, recordedAt });
    }
    for (const cid of [
      id,
      id.toUpperCase(),
      id.slice(1),
      `${id} `,
      '',
      '3f2b8c1e6a4d4e0b9c550a1b2c3d4e5f',
    ]) {
      corpus.push({ ...base, recordedAt: '2026-10-05T12:00:00Z', clientReadingId: cid });
    }
    for (const value of [0, -1.5, 1e308, NaN, Infinity, null, '1', true, {}, undefined]) {
      corpus.push({ ...base, recordedAt: '2026-10-05T12:00:00Z', value });
    }
    corpus.push(null, 5, 'x', [], { ...base, recordedAt: '2026-10-05T12:00:00Z', extra: 1 });
    for (const x of corpus) {
      if (validateReadingItem(x)) {
        expect(itemValid(x), JSON.stringify(x)).toBe(true);
      }
    }
    // the valid UTC baseline is accepted by both
    const ok = { ...base, recordedAt: '2026-10-05T12:00:00.123Z' };
    expect(validateReadingItem(ok)).toBe(true);
    expect(validateReadingItem({ ...ok, clientReadingId: id.toUpperCase() })).toBe(false);
  });
});

describe('readings request envelope fixtures', () => {
  it('a schema-valid envelope can hold items validateReadingItem rejects', () => {
    const f = fixtures('readings-request');
    const items = f.valid.flatMap((e) => (e as { readings: unknown[] }).readings);
    expect(items.some((i) => validateReadingItem(i))).toBe(true);
    // The loose envelope accepts a non-UUID id, a location path and a null value (the server
    // reports those per item); the plugin must never produce them.
    const loose = items.filter((i) => !validateReadingItem(i));
    expect(loose.length).toBeGreaterThan(0);
    expect(loose.some((i) => (i as { path: string }).path === 'navigation.position')).toBe(true);
  });
});

describe('isPermittedPath equals the schema pattern', () => {
  const ids = ['', 'a', 'a'.repeat(40), 'a'.repeat(41), 'a_b-C9', 'a.b', 'a b', 'a/b', 'é', '0'];
  const tanks = [
    'fuel',
    'freshWater',
    'wasteWater',
    'blackWater',
    'lubrication',
    'liveWell',
    'baitWell',
    'gas',
    'ballast',
    'diesel',
    'Fuel',
    'fuel2',
    '',
    'water',
  ];
  const corpus = new Set<string>();
  for (const id of ids) {
    corpus.add(`propulsion.${id}.runTime`);
    corpus.add(`electrical.generators.${id}.runTime`);
    corpus.add(`electrical.batteries.${id}.voltage`);
    corpus.add(`electrical.batteries.${id}.capacity.stateOfCharge`);
    for (const t of tanks) {
      corpus.add(`tanks.${t}.${id}.currentLevel`);
      corpus.add(`tanks.${t}.${id}.currentVolume`);
    }
  }
  for (const p of [
    'navigation.position',
    'navigation.speedOverGround',
    'navigation.courseOverGroundTrue',
    'design.length.overall',
    'design.beam',
    'communication.callsignVhf',
    'mmsi',
    'name',
    'propulsion.a.b.runTime',
    'propulsion.a.runTime.x',
    'xpropulsion.a.runTime',
    'propulsion.a.runTime\n',
    'propulsion.a.runtime',
    'electrical.batteries.a.capacity',
    'electrical.batteries.a.capacity.stateOfCharge.x',
    'electrical.generators.a.voltage',
    'tanks.fuel.currentLevel',
    'tanks.fuel.a.b.currentLevel',
    'tanks.fuel.a.currentLevel.',
    'vessels.self.propulsion.a.runTime',
    '',
    '.',
  ]) {
    corpus.add(p);
  }

  it('agrees on every corpus entry', () => {
    expect(corpus.size).toBeGreaterThan(300);
    for (const p of corpus) expect(isPermittedPath(p), JSON.stringify(p)).toBe(PATH_RE.test(p));
  });

  it('permits and denies the expected cases', () => {
    expect(isPermittedPath(`propulsion.${'a'.repeat(40)}.runTime`)).toBe(true);
    expect(isPermittedPath(`propulsion.${'a'.repeat(41)}.runTime`)).toBe(false);
    expect(isPermittedPath('propulsion..runTime')).toBe(false);
    for (const t of tanks.slice(0, 9)) {
      expect(isPermittedPath(`tanks.${t}.x.currentLevel`)).toBe(true);
    }
    expect(isPermittedPath('tanks.diesel.x.currentLevel')).toBe(false);
    expect(isPermittedPath('navigation.position')).toBe(false);
  });
});

describe('parseReadingsResponse', () => {
  const f = fixtures('readings-response');
  const idsOf = (x: unknown) => (x as { results: { clientReadingId: string }[] }).results;

  it('accepts valid fixtures when the batch ids align', () => {
    for (const x of f.valid) {
      const batch = idsOf(x).map((r) => r.clientReadingId);
      const parsed = parseReadingsResponse(x, batch);
      expect(parsed?.results).toEqual(idsOf(x));
    }
  });

  it('rejects misaligned, reordered, short and long batches', () => {
    const x = f.valid[1];
    const batch = idsOf(x).map((r) => r.clientReadingId);
    expect(parseReadingsResponse(x, [...batch].reverse())).toBeNull();
    expect(parseReadingsResponse(x, batch.slice(1))).toBeNull();
    expect(parseReadingsResponse(x, [...batch, 'extra'])).toBeNull();
    expect(parseReadingsResponse(x, ['other', ...batch.slice(1)])).toBeNull();
  });

  it('rejects every invalid fixture, whatever the batch', () => {
    for (const x of f.invalid) {
      const r = (x as { results?: { clientReadingId: string }[] }).results;
      expect(parseReadingsResponse(x, r ? r.map((i) => i.clientReadingId) : [])).toBeNull();
    }
    expect(parseReadingsResponse(null, [])).toBeNull();
    expect(parseReadingsResponse([], [])).toBeNull();
  });
});

describe('parseStatusSummary', () => {
  const f = fixtures('status-summary');
  it('accepts valid and rejects invalid fixtures', () => {
    for (const x of f.valid) expect(parseStatusSummary(x)).toEqual(x);
    for (const x of f.invalid.slice(0, 3)) expect(parseStatusSummary(x)).toBeNull();
  });
  it('tolerates unknown keys, which the strict schema forbids', () => {
    const extra = f.invalid[3];
    expect(parseStatusSummary(extra)).toEqual({ channels: 1, awaitingSetup: 0, held: 0 });
    expect(parseStatusSummary(null)).toBeNull();
    expect(parseStatusSummary({ channels: '1', awaitingSetup: 0, held: 0 })).toBeNull();
  });
});
