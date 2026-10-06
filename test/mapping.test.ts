import { describe, expect, it } from 'vitest';
import { categoryFor, PATH_RULES } from '../src/mapping';

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
});
