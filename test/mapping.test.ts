import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { categoryFor, isPermittedPath, matchPath, PATH_RULES } from '../src/mapping';

describe('mapping registry', () => {
  it('has the six contract v2 path shapes', () => {
    expect(PATH_RULES.map((r) => r.kind)).toEqual([
      'engineRunTime',
      'generatorRunTime',
      'batteryVoltage',
      'batteryStateOfCharge',
      'tankLevel',
      'tankVolume',
    ]);
    for (const r of PATH_RULES) {
      expect(r.re.source.startsWith('^')).toBe(true);
      expect(r.re.source.endsWith('$')).toBe(true);
    }
  });

  it('categorizes the permitted paths', () => {
    expect(categoryFor('propulsion.main.runTime')).toBe('engineHours');
    expect(categoryFor('electrical.generators.gen1.runTime')).toBe('engineHours');
    expect(categoryFor('electrical.batteries.house.voltage')).toBe('batteries');
    expect(categoryFor('electrical.batteries.house.capacity.stateOfCharge')).toBe('batteries');
    expect(categoryFor('tanks.fuel.0.currentLevel')).toBe('tanks');
    expect(categoryFor('tanks.ballast.0.currentVolume')).toBe('tanks');
    for (const p of ['navigation.position', 'name', '', 'tanks.diesel.0.currentLevel']) {
      expect(categoryFor(p)).toBeNull();
    }
  });

  it('returns category, unit and instance parts', () => {
    expect(matchPath('propulsion.port.runTime')).toEqual({
      category: 'engineHours',
      unit: 's',
      instance: 'port',
    });
    expect(matchPath('tanks.freshWater.2.currentVolume')).toEqual({
      category: 'tanks',
      unit: 'm3',
      instance: 'freshWater.2',
    });
    expect(matchPath('electrical.batteries.h.capacity.stateOfCharge')?.unit).toBe('ratio');
    expect(matchPath('electrical.batteries.h.voltage')?.unit).toBe('V');
  });

  it('isPermittedPath rejects non-strings and malformed paths', () => {
    expect(isPermittedPath(5)).toBe(false);
    expect(isPermittedPath(null)).toBe(false);
    expect(isPermittedPath('propulsion..runTime')).toBe(false);
    expect(isPermittedPath('propulsion.a.b.runTime')).toBe(false);
    expect(isPermittedPath('xpropulsion.a.runTime')).toBe(false);
    expect(isPermittedPath('propulsion.a.runTime\n')).toBe(false);
  });

  it('never permits location-like or identifying paths', () => {
    const banned = ['position', 'mmsi', 'callsign', 'ais', 'course', 'heading', 'track', 'name'];
    for (const rule of PATH_RULES) {
      const pat = rule.subscribe.toLowerCase();
      expect(pat.startsWith('navigation.')).toBe(false);
      for (const word of banned) expect(pat).not.toContain(word);
    }
    const src = readFileSync(join(__dirname, '..', 'src', 'mapping.ts'), 'utf8')
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l))
      .join('\n')
      .toLowerCase();
    for (const word of banned) expect(src).not.toContain(word);
  });
});
