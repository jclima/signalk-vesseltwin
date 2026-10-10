import { describe, expect, it } from 'vitest';
import { categoryFor, matchPath, PATH_RULES, type PathRule } from '../src/mapping';

describe('mapping registry', () => {
  it('is empty until upload ships', () => {
    expect(PATH_RULES).toHaveLength(0);
  });

  it('categorizes nothing today', () => {
    for (const p of [
      'navigation.position',
      'propulsion.main.runTime',
      'electrical.batteries.house.voltage',
      'tanks.fuel.0.currentLevel',
      'name',
      '',
    ]) {
      expect(categoryFor(p)).toBeNull();
    }
  });

  it('never permits location-like or identifying paths', () => {
    const banned = ['position', 'mmsi', 'callsign', 'ais', 'course', 'heading', 'track', 'name'];
    for (const rule of PATH_RULES) {
      const pat = rule.pattern.toLowerCase();
      expect(pat.startsWith('navigation.')).toBe(false);
      for (const word of banned) expect(pat).not.toContain(word);
    }
  });

  it('matchPath matches nothing against the production rules', () => {
    for (const p of [
      'navigation.position',
      'propulsion.main.runTime',
      'tanks.fuel.0.currentLevel',
      '',
    ]) {
      expect(matchPath(p)).toBeNull();
    }
  });

  it('matchPath returns category, unit and the joined wildcard captures', () => {
    const rules: PathRule[] = [
      { pattern: 'test.alpha.*.value', category: 'engineHours', unit: 's' },
      { pattern: 'test.gamma.*.*.level', category: 'tanks', unit: 'ratio' },
      { pattern: 'test.delta.fixed', category: 'batteries', unit: 'V' },
    ];
    expect(matchPath('test.alpha.main.value', rules)).toEqual({
      category: 'engineHours',
      unit: 's',
      instance: 'main',
    });
    expect(matchPath('test.gamma.fuel.0.level', rules)?.instance).toBe('fuel.0');
    expect(matchPath('test.delta.fixed', rules)).toEqual({
      category: 'batteries',
      unit: 'V',
      instance: '',
    });
    expect(matchPath('test.alpha.a.b.value', rules)).toBeNull();
    expect(matchPath('xtest.alpha.main.value', rules)).toBeNull();
  });
});
