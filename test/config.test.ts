import { describe, expect, it } from 'vitest';
import {
  configSchema,
  DEFAULT_API_BASE_URL,
  MAX_CHANNELS,
  MAX_READINGS_PER_CHANNEL_PER_DAY,
  parseOptions,
  LEGACY_SEND_WARNING,
  QUEUE_FLOOR_FOR_FULL_LOAD,
  TANK_TYPES,
  UPLOAD_CATEGORIES,
} from '../src/config';
import { matchPath } from '../src/mapping';

const url = (v: unknown) => parseOptions({ apiBaseUrl: v }).apiBaseUrl;
const err = (v: unknown) => parseOptions({ apiBaseUrl: v }).configError;

describe('parseOptions apiBaseUrl', () => {
  it.each([undefined, null, '', '   ', '\t\n'])(
    'treats blank %j as the production default',
    (v) => {
      const o = parseOptions({ apiBaseUrl: v });
      expect(o.apiBaseUrl).toBe(DEFAULT_API_BASE_URL);
      expect(o.configError).toBeNull();
    },
  );

  it('uses the production default when the key is absent or settings are empty', () => {
    expect(parseOptions({}).apiBaseUrl).toBe(DEFAULT_API_BASE_URL);
    expect(parseOptions(undefined).configError).toBeNull();
  });

  it.each([
    ['https://api.example.test', 'https://api.example.test'],
    ['https://api.example.test/', 'https://api.example.test'],
    ['https://api.example.test/base/path', 'https://api.example.test/base/path'],
    ['HTTPS://API.EXAMPLE.TEST', 'https://api.example.test'],
    ['http://localhost:3001', 'http://localhost:3001'],
    ['http://127.0.0.1:3001', 'http://127.0.0.1:3001'],
    ['http://[::1]:3001', 'http://[::1]:3001'],
  ])('accepts %s', (input, expected) => {
    expect(url(input)).toBe(expected);
    expect(err(input)).toBeNull();
  });

  it.each([
    'http://api.example.test',
    'http://localhost.evil.test',
    'http://localhost@evil.test',
    'https://user:pw@api.example.test',
    'http://127.0.0.1.nip.io',
    'javascript:alert(1)',
    'ftp://localhost',
    'not a url',
    42,
    true,
    {},
    'https://api.example.test/?x=1',
    'https://api.example.test/#f',
  ])('treats a set but invalid %j as a config error, never the production default', (input) => {
    const o = parseOptions({ apiBaseUrl: input });
    expect(o.apiBaseUrl).toBeNull();
    expect(o.configError).toMatch(/API URL .* not valid/);
    expect(o.configError).not.toMatch(/api\.vesseltwin|example|evil|pw/);
  });
});

describe('parseOptions numbers and booleans', () => {
  it('tolerates a saved samplePeriodSeconds, ignores it, and no longer offers it', () => {
    for (const v of [1, 60, 10 ** 9, 'x', null, NaN, {}]) {
      const o = parseOptions({ samplePeriodSeconds: v });
      expect(o).toEqual(parseOptions({}));
      expect(o).not.toHaveProperty('samplePeriodSeconds');
    }
    expect(Object.keys(configSchema.properties)).not.toContain('samplePeriodSeconds');
  });

  it('clamps queueMaxReadings', () => {
    expect(parseOptions({ queueMaxReadings: 5 }).queueMaxReadings).toBe(1_000);
    expect(parseOptions({ queueMaxReadings: 10 ** 9 }).queueMaxReadings).toBe(50_000);
    expect(parseOptions({ queueMaxReadings: 2_000 }).queueMaxReadings).toBe(2_000);
  });

  it.each([NaN, Infinity, -Infinity, '60', null, {}])('falls back to defaults for %j', (v) => {
    const o = parseOptions({ queueMaxReadings: v });
    expect(o.queueMaxReadings).toBe(50_000);
  });

  it('defaults and overrides booleans', () => {
    const d = parseOptions({});
    expect(d.categories).toEqual({
      engineHours: false,
      batteries: false,
      tanks: false,
      vesselInfo: false,
    });
    const o = parseOptions({
      engineHours: { enabled: true },
      batteries: { enabled: 'no' },
      tanks: { enabled: false },
      sendVesselInfo: true,
    });
    expect(o.categories).toEqual({
      engineHours: true,
      batteries: false,
      tanks: false,
      vesselInfo: true,
    });
  });

  it.each([null, undefined, 'str', 7, []])('treats %j raw as empty', (raw) => {
    expect(parseOptions(raw)).toEqual(parseOptions({}));
  });
});

interface Node {
  title?: string;
  description?: string;
  pattern?: string;
  enum?: string[];
  enumNames?: string[];
  properties: Record<string, Node>;
  items: Node;
}
const schemaRoot = (configSchema as unknown as { properties: Record<string, Node> }).properties;
const child = (n: Node | Record<string, Node>, k: string): Node => {
  const rec = ('properties' in n && typeof n.properties === 'object' ? n.properties : n) as Record<
    string,
    Node
  >;
  const v = rec[k];
  if (v === undefined) throw new Error(`missing schema node ${k}`);
  return v;
};
const idsNode = (cat: string): Node => child(child(child(schemaRoot, cat), 'instances'), 'ids');

describe('upload settings defaults', () => {
  it('defaults to the least data', () => {
    const u = parseOptions({}).upload;
    expect(u.uploadIntervalMinutes).toBe(1440);
    for (const c of [u.engineHours, u.batteries, u.tanks]) {
      expect(c.enabled).toBe(false);
      expect(c.active).toBe(false);
      expect(c.recordIntervalMinutes).toBe(1440);
      expect(c.instanceMode).toBe('all');
      expect(c.instanceIds).toEqual([]);
    }
    expect(u.engineHours.minChangeHours).toBe(0.1);
    expect(u.batteries).toMatchObject({ minChangeVolts: 0, minChangePercent: 0 });
    expect(u.tanks).toMatchObject({ minChangePercent: 0, minChangeLiters: 0 });
    expect(parseOptions({}).uploadEnabled).toBe(false);
    expect(parseOptions({}).activeCategories).toEqual([]);
    expect(parseOptions({}).queueMaxReadings).toBe(50_000);
    expect(parseOptions({}).warnings).toEqual([]);
  });

  it('defaults every upload category to off in the schema, and says upload is unavailable', () => {
    for (const cat of UPLOAD_CATEGORIES) {
      const node = child(schemaRoot, cat);
      expect((child(node, 'enabled') as { default?: unknown }).default).toBe(false);
      expect(node.description).toContain('Data upload is not available in this version');
      expect(node.description).toContain('future release');
    }
  });

  it('keeps sendVesselInfo parseable but out of the schema', () => {
    expect(parseOptions({ sendVesselInfo: true }).categories.vesselInfo).toBe(true);
    expect(Object.keys(configSchema.properties)).not.toContain('sendVesselInfo');
  });

  it('says "Not active yet." once per upload section, never on individual fields', () => {
    const hits: string[] = [];
    const walk = (node: Record<string, unknown>, trail: string): void => {
      const d = node.description;
      if (typeof d === 'string') {
        const n = d.split('Not active yet.').length - 1;
        expect(n, trail).toBeLessThanOrEqual(1);
        if (n === 1) hits.push(trail);
      }
      const props = (node.properties ?? {}) as Record<string, Record<string, unknown>>;
      for (const [k, v] of Object.entries(props)) walk(v, trail ? `${trail}.${k}` : k);
    };
    const root = configSchema as unknown as { properties: Record<string, Record<string, unknown>> };
    for (const [k, v] of Object.entries(root.properties)) walk(v, k);
    expect(hits.sort()).toEqual(
      [
        'batteries',
        'engineHours',
        'queueMaxReadings',
        'tanks',
        'uploadEnabled',
        'uploadIntervalMinutes',
      ].sort(),
    );
  });

  it('shows the format hint once on the id items and the list hint in the array title only, with friendly labels', () => {
    for (const cat of UPLOAD_CATEGORIES) {
      const inst = child(child(schemaRoot, cat), 'instances');
      const mode = child(inst, 'mode');
      const ids = child(inst, 'ids');
      expect(inst.title).toBeUndefined();
      expect(mode.title).toBe('Record from');
      expect(mode.description).toBeUndefined();
      expect(mode.enum).toEqual(['all', 'selected']);
      expect(mode.enumNames).toEqual(['All instances', 'Only the ids listed below']);
      expect(ids.title).toBe(
        'Instance ids (only used with "Only the ids listed below"; add at least one, or nothing is recorded)',
      );
      expect(ids.description).toBeUndefined();
      expect(ids.items.title).toBe('Instance id');
      expect(ids.items).not.toHaveProperty('errorMessage');
      expect(ids.items.description).toMatch(/letters/i);
    }
  });

  it('explains what 0 means on thresholds that default to 0', () => {
    for (const [cat, key] of [
      ['batteries', 'minChangeVolts'],
      ['batteries', 'minChangePercent'],
      ['tanks', 'minChangePercent'],
      ['tanks', 'minChangeLiters'],
    ] as const) {
      expect(child(child(schemaRoot, cat), key).description).toBe('0 = no minimum change.');
    }
  });
});

describe('upload master switch and legacy settings', () => {
  it('has a boolean uploadEnabled schema entry, default false, that says nothing is sent until on', () => {
    const n = child(schemaRoot, 'uploadEnabled') as Node & { type?: string; default?: unknown };
    expect(n.type).toBe('boolean');
    expect(n.default).toBe(false);
    expect(n.title).toBe('Send readings to VesselTwin');
    expect(n.description).toContain('Nothing is sent until this is on');
    expect(n.description).toContain('Data upload is not available in this version');
  });

  it('a 0.1.1-shaped object with send* true activates nothing and warns', () => {
    const o = parseOptions({
      sendEngineHours: true,
      sendBatteries: true,
      sendTanks: true,
      sendVesselInfo: false,
      samplePeriodSeconds: 300,
    });
    expect(o.uploadEnabled).toBe(false);
    expect(o.activeCategories).toEqual([]);
    expect(o.categories).toEqual({
      engineHours: false,
      batteries: false,
      tanks: false,
      vesselInfo: false,
    });
    for (const c of [o.upload.engineHours, o.upload.batteries, o.upload.tanks]) {
      expect(c.enabled).toBe(false);
      expect(c.active).toBe(false);
    }
    expect(o.warnings).toEqual([LEGACY_SEND_WARNING]);
    expect(LEGACY_SEND_WARNING).toBe('legacy_send_settings');
  });

  it('even with uploadEnabled, a legacy send* never enables a category', () => {
    const o = parseOptions({ uploadEnabled: true, sendTanks: true });
    expect(o.activeCategories).toEqual([]);
    expect(o.warnings).toContain(LEGACY_SEND_WARNING);
  });

  it('only a literal true counts as a legacy setting', () => {
    expect(parseOptions({ sendTanks: false, sendBatteries: 'yes' }).warnings).toEqual([]);
  });

  it('uploadEnabled off keeps every enabled category inactive', () => {
    const cats = {
      engineHours: { enabled: true },
      batteries: { enabled: true },
      tanks: { enabled: true },
    };
    for (const v of [false, undefined, 'true', 1, null]) {
      const o = parseOptions({ uploadEnabled: v, ...cats });
      expect(o.uploadEnabled).toBe(false);
      expect(o.activeCategories).toEqual([]);
      expect(o.upload.uploadEnabled).toBe(false);
      expect(o.upload.engineHours).toMatchObject({ enabled: true, active: false });
      expect(o.categories).toMatchObject({ engineHours: true, batteries: true, tanks: true });
    }
  });

  it('uploadEnabled with enabled categories activates exactly those', () => {
    const o = parseOptions({
      uploadEnabled: true,
      engineHours: { enabled: true },
      batteries: { enabled: false },
      tanks: { enabled: true, instances: { mode: 'selected', ids: ['fuel.0'] } },
    });
    expect(o.uploadEnabled).toBe(true);
    expect(o.activeCategories).toEqual(['engineHours', 'tanks']);
    expect(o.upload.batteries.active).toBe(false);
    expect(o.warnings).toEqual([]);
  });

  it('uploadEnabled with a selected category that has no valid ids stays inactive and warns', () => {
    const o = parseOptions({
      uploadEnabled: true,
      tanks: { enabled: true, instances: { mode: 'selected', ids: ['fuel'] } },
    });
    expect(o.activeCategories).toEqual([]);
    expect(o.warnings.join(' ')).toMatch(/no valid instances/);
  });
});

describe('upload settings clamping', () => {
  type Case = [
    string,
    (o: ReturnType<typeof parseOptions>) => number,
    string,
    number,
    number,
    number,
  ];
  const mk = (cat: string, key: string, lo: number, hi: number, def: number): Case => [
    `${cat}.${key}`,
    (o) =>
      (
        (o.upload as unknown as Record<string, Record<string, number>>)[cat] as Record<
          string,
          number
        >
      )[key] as number,
    JSON.stringify([cat, key]),
    lo,
    hi,
    def,
  ];
  const cases: Case[] = [
    mk('engineHours', 'recordIntervalMinutes', 60, 1440, 1440),
    mk('batteries', 'recordIntervalMinutes', 60, 1440, 1440),
    mk('tanks', 'recordIntervalMinutes', 60, 1440, 1440),
    mk('engineHours', 'minChangeHours', 0.1, 24, 0.1),
    mk('batteries', 'minChangeVolts', 0, 5, 0),
    mk('batteries', 'minChangePercent', 0, 50, 0),
    mk('tanks', 'minChangePercent', 0, 50, 0),
    mk('tanks', 'minChangeLiters', 0, 1000, 0),
  ];
  it.each(cases)('%s clamps to its range', (_n, read, key, lo, hi, def) => {
    const [cat, k] = JSON.parse(key) as [string, string];
    const set = (v: unknown) => read(parseOptions({ [cat]: { [k]: v } }));
    expect(set(lo - 1000)).toBe(lo);
    expect(set(hi + 1000)).toBe(hi);
    expect(set((lo + hi) / 2)).toBe((lo + hi) / 2);
    for (const bad of ['5', null, NaN, Infinity, {}, true]) expect(set(bad)).toBe(def);
  });

  it('clamps the global upload interval', () => {
    const g = (v: unknown) =>
      parseOptions({ uploadIntervalMinutes: v }).upload.uploadIntervalMinutes;
    expect(g(1)).toBe(5);
    expect(g(10 ** 6)).toBe(1440);
    expect(g(30)).toBe(30);
    expect(g('x')).toBe(1440);
  });
});

describe('instance ids', () => {
  const schemaPattern = (cat: string): RegExp => {
    return new RegExp(idsNode(cat).items.pattern ?? '');
  };

  it('schema patterns and the runtime parser accept exactly the same ids', () => {
    const samples = [
      'main',
      'Port_1',
      'a-b',
      'fuel.0',
      'freshWater.main',
      'a.b',
      'fuel',
      'fuel.',
      '.0',
      '0fuel.1',
      'fuel.0.1',
      'fu_el.0',
      '',
      'a b',
      'é',
      'x'.repeat(40),
      'x'.repeat(41),
      `${'a'.repeat(31)}.1`,
      `${'a'.repeat(32)}.1`,
    ];
    for (const cat of UPLOAD_CATEGORIES) {
      const re = schemaPattern(cat);
      for (const id of samples) {
        const parsed = parseOptions({ [cat]: { instances: { mode: 'selected', ids: [id] } } })
          .upload[cat].instanceIds;
        expect(parsed.includes(id), `${cat} ${JSON.stringify(id)}`).toBe(re.test(id));
      }
    }
  });

  it('schema pattern: tanks take a dot, engines and batteries do not; help examples are valid', () => {
    expect(schemaPattern('tanks').test('fuel.0')).toBe(true);
    expect(schemaPattern('engineHours').test('fuel.0')).toBe(false);
    expect(schemaPattern('batteries').test('fuel.0')).toBe(false);
    const help = (c: string): string => idsNode(c).items.description ?? '';
    expect(help('tanks')).toContain('"fuel.0"');
    expect(help('engineHours')).toContain('"main"');
    expect(schemaPattern('engineHours').test('main')).toBe(true);
    expect(schemaPattern('batteries').test('house')).toBe(true);
  });

  const ids = (cat: 'engineHours' | 'tanks', list: unknown) =>
    parseOptions({ [cat]: { enabled: true, instances: { mode: 'selected', ids: list } } }).upload[
      cat
    ];

  it('accepts and rejects engine/battery ids by pattern', () => {
    const good = ['main', 'Port_1', 'a-b', 'x'.repeat(40)];
    const bad = ['', 'x'.repeat(41), 'a.b', 'a b', 'é', '../x', 5, null, {}];
    const c = ids('engineHours', [...good, ...bad]);
    expect(c.instanceIds).toEqual(good);
    expect(
      parseOptions({ engineHours: { instances: { ids: [...good, ...bad] } } }).warnings.join(' '),
    ).toMatch(/not valid/);
  });

  it('accepts and rejects tank ids by pattern', () => {
    const good = ['fuel.0', 'freshWater.main', 'gas.a_b-c', `ballast.${'b'.repeat(40)}`];
    const bad = [
      'fuel',
      'fuel.',
      '.0',
      '0fuel.1',
      'fuel.0.1',
      'fu_el.0',
      'a.b',
      'Fuel.0',
      'fuels.0',
      'fuelx.0',
      'water.0',
      'freshwater.0',
      'fuel.a b',
      `fuel.${'x'.repeat(41)}`,
    ];
    expect(ids('tanks', [...good, ...bad]).instanceIds).toEqual(good);
  });

  it('accepts every one of the 9 tank types and nothing else as the type', () => {
    expect(TANK_TYPES).toHaveLength(9);
    for (const t of TANK_TYPES) {
      expect(ids('tanks', [`${t}.0`, `${t}.main-1`]).instanceIds).toEqual([
        `${t}.0`,
        `${t}.main-1`,
      ]);
      expect(ids('tanks', [`${t}x.0`, `x${t}.0`, t]).instanceIds).toEqual([]);
    }
  });

  it('stays consistent with the permitted tank paths in mapping', () => {
    for (const t of [...TANK_TYPES, 'fuels', 'water', 'Fuel']) {
      const permitted = matchPath(`tanks.${t}.0.currentLevel`)?.instance === `${t}.0`;
      expect(permitted, t).toBe(TANK_TYPES.includes(t));
    }
  });

  it('dedupes, caps at 64, and treats non-arrays as empty', () => {
    const many = Array.from({ length: 80 }, (_, i) => `e${String(i)}`);
    expect(ids('engineHours', many).instanceIds).toHaveLength(64);
    expect(ids('engineHours', ['a', 'a']).instanceIds).toEqual(['a']);
    for (const v of ['main', 7, {}, null]) expect(ids('engineHours', v).instanceIds).toEqual([]);
  });

  it('selected mode with no valid ids switches the category off and warns', () => {
    const c = ids('engineHours', ['a b']);
    expect(c.enabled).toBe(true);
    expect(c.active).toBe(false);
    const o = parseOptions({
      uploadEnabled: true,
      engineHours: { enabled: true, instances: { mode: 'selected', ids: [] } },
    });
    expect(o.upload.engineHours.active).toBe(false);
    expect(o.warnings.join(' ')).toMatch(/no valid instances/);
    // all mode ignores the list
    expect(
      parseOptions({
        uploadEnabled: true,
        engineHours: { enabled: true, instances: { mode: 'all', ids: [] } },
      }).upload.engineHours.active,
    ).toBe(true);
    // unknown mode falls back to all
    expect(
      parseOptions({ engineHours: { instances: { mode: 'x' } } }).upload.engineHours.instanceMode,
    ).toBe('all');
  });
});

describe('queue cap vs channel load', () => {
  it('a full 64-channel week fits the maximum queue cap', () => {
    expect(MAX_CHANNELS * MAX_READINGS_PER_CHANNEL_PER_DAY * 7).toBeLessThanOrEqual(50_000);
    expect(QUEUE_FLOOR_FOR_FULL_LOAD).toBe(10_752);
  });

  it('warns when the cap is below a full week of readings', () => {
    expect(parseOptions({ queueMaxReadings: 5_000 }).warnings.join(' ')).toMatch(/queue cap/);
    expect(parseOptions({ queueMaxReadings: 20_000 }).warnings).toEqual([]);
  });
});

describe('parseOptions properties', () => {
  function rng(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 2 ** 32;
    };
  }
  function junk(r: () => number, depth = 0): unknown {
    const k = Math.floor(r() * (depth > 2 ? 7 : 10));
    switch (k) {
      case 0:
        return null;
      case 1:
        return r() < 0.5;
      case 2:
        return (r() - 0.5) * 10 ** Math.floor(r() * 12);
      case 3:
        return ['NaN', 'main', 'fuel.0', '', 'a b'][Math.floor(r() * 5)];
      case 4:
        return NaN;
      case 5:
        return r() < 0.5 ? Infinity : -Infinity;
      case 6:
        return undefined;
      case 7:
        return Array.from({ length: Math.floor(r() * 5) }, () => junk(r, depth + 1));
      default: {
        const o: Record<string, unknown> = {};
        const keys = [
          'enabled',
          'recordIntervalMinutes',
          'minChangeHours',
          'minChangeVolts',
          'minChangePercent',
          'minChangeLiters',
          'instances',
          'mode',
          'ids',
          'x',
        ];
        for (let i = 0; i < Math.floor(r() * 6); i++) {
          o[keys[Math.floor(r() * keys.length)] as string] = junk(r, depth + 1);
        }
        return o;
      }
    }
  }

  it('never throws and always yields in-range values', () => {
    const r = rng(42);
    for (let i = 0; i < 500; i++) {
      const raw = {
        engineHours: junk(r),
        batteries: junk(r),
        tanks: junk(r),
        uploadIntervalMinutes: junk(r),
        samplePeriodSeconds: junk(r),
        uploadEnabled: junk(r),
        queueMaxReadings: junk(r),
        instances: junk(r),
      };
      const o = parseOptions(raw);
      const u = o.upload;
      expect(u.uploadIntervalMinutes).toBeGreaterThanOrEqual(5);
      expect(u.uploadIntervalMinutes).toBeLessThanOrEqual(1440);
      expect(o).not.toHaveProperty('samplePeriodSeconds');
      if (!o.uploadEnabled) expect(o.activeCategories).toEqual([]);
      expect(o.queueMaxReadings).toBeGreaterThanOrEqual(1000);
      expect(o.queueMaxReadings).toBeLessThanOrEqual(50_000);
      for (const c of [u.engineHours, u.batteries, u.tanks]) {
        expect(c.recordIntervalMinutes).toBeGreaterThanOrEqual(60);
        expect(c.recordIntervalMinutes).toBeLessThanOrEqual(1440);
        expect(c.instanceIds.length).toBeLessThanOrEqual(64);
        expect(['all', 'selected']).toContain(c.instanceMode);
        if (c.instanceMode === 'selected' && c.instanceIds.length === 0)
          expect(c.active).toBe(false);
      }
      expect(u.engineHours.minChangeHours).toBeGreaterThanOrEqual(0.1);
      expect(u.engineHours.minChangeHours).toBeLessThanOrEqual(24);
      expect(u.batteries.minChangeVolts).toBeLessThanOrEqual(5);
      expect(u.batteries.minChangePercent).toBeLessThanOrEqual(50);
      expect(u.tanks.minChangePercent).toBeLessThanOrEqual(50);
      expect(u.tanks.minChangeLiters).toBeLessThanOrEqual(1000);
      for (const v of [
        u.batteries.minChangeVolts,
        u.batteries.minChangePercent,
        u.tanks.minChangePercent,
        u.tanks.minChangeLiters,
      ]) {
        expect(v).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
