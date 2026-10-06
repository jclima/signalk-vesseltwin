import type { Category } from './mapping';

/**
 * Permitted-path registry for the upload pipeline (the paths the plugin may read and send).
 *
 * `src/mapping.ts` keeps its own, intentionally empty registry for the released
 * behaviour; this list is only consulted by the pipeline, which is itself off unless
 * the developer upload switch is set. When upload ships the two registries should be
 * merged (see docs/TESTING.md).
 *
 * Path conventions, from the SignalK specification (schemas/groups, v1.7):
 *   propulsion.<id>.runTime                              seconds (engine run time)
 *   electrical.batteries.<id>.voltage                    volts
 *   electrical.batteries.<id>.capacity.stateOfCharge     ratio 0..1
 *   tanks.<type>.<id>.currentLevel                       ratio 0..1
 *   tanks.<type>.<id>.currentVolume                      cubic metres
 * <type> is one of the tank group keys in the spec: fuel, freshWater, wasteWater, blackWater,
 * lubrication, liveWell, baitWell, gas, ballast.
 * UNVERIFIED: `electrical.generators.<id>.runTime` is not defined by spec 1.7; it is included
 * because the platform plan lists it (some gateways publish generator hours there).
 * <id> is a free instance key such as `port`, `0` or `house`; it is restricted to
 * [A-Za-z0-9_-]{1,40} so names with spaces or punctuation are never forwarded.
 *
 * NEVER permitted: navigation.*, position, mmsi, callsign, ais, name or any identifying data.
 */

export const QUANTITIES = [
  'engine_hours',
  'generator_hours',
  'battery_voltage',
  'battery_state_of_charge',
  'tank_level',
  'tank_volume',
] as const;
export type Quantity = (typeof QUANTITIES)[number];

export const TANK_TYPES = [
  'fuel',
  'freshWater',
  'wasteWater',
  'blackWater',
  'lubrication',
  'liveWell',
  'baitWell',
  'gas',
  'ballast',
] as const;

const ID = '[A-Za-z0-9_-]{1,40}';
const TYPES = TANK_TYPES.join('|');

export interface V1PathRule {
  /** Glob-ish pattern (also what the collector subscribes to). */
  pattern: string;
  category: Category;
  quantity: Quantity;
  re: RegExp;
  /** Stable, name-free channel key built from the matched path. */
  channel: (m: RegExpExecArray) => string;
  /** SI value (as published by SignalK) to the canonical unit: hours, volts, percent, litres. */
  toCanonical: (si: number) => number;
  /** SI values are valid only inside this range; anything else is dropped locally. */
  valid: (si: number) => boolean;
}

const nonNeg = (v: number) => v >= 0;
const ratio = (v: number) => v >= 0 && v <= 1;

export const V1_PATH_RULES: readonly V1PathRule[] = [
  {
    pattern: 'propulsion.*.runTime',
    category: 'engineHours',
    quantity: 'engine_hours',
    re: new RegExp(`^propulsion\\.(${ID})\\.runTime$`),
    channel: (m) => `propulsion.${m[1] ?? ''}`,
    toCanonical: (s) => s / 3600,
    valid: nonNeg,
  },
  {
    pattern: 'electrical.generators.*.runTime',
    category: 'engineHours',
    quantity: 'generator_hours',
    re: new RegExp(`^electrical\\.generators\\.(${ID})\\.runTime$`),
    channel: (m) => `electrical.generators.${m[1] ?? ''}`,
    toCanonical: (s) => s / 3600,
    valid: nonNeg,
  },
  {
    pattern: 'electrical.batteries.*.voltage',
    category: 'batteries',
    quantity: 'battery_voltage',
    re: new RegExp(`^electrical\\.batteries\\.(${ID})\\.voltage$`),
    channel: (m) => `electrical.batteries.${m[1] ?? ''}`,
    toCanonical: (v) => v,
    valid: (v) => v >= 0 && v <= 1000,
  },
  {
    pattern: 'electrical.batteries.*.capacity.stateOfCharge',
    category: 'batteries',
    quantity: 'battery_state_of_charge',
    re: new RegExp(`^electrical\\.batteries\\.(${ID})\\.capacity\\.stateOfCharge$`),
    channel: (m) => `electrical.batteries.${m[1] ?? ''}`,
    toCanonical: (r) => r * 100,
    valid: ratio,
  },
  {
    pattern: 'tanks.*.*.currentLevel',
    category: 'tanks',
    quantity: 'tank_level',
    re: new RegExp(`^tanks\\.(${TYPES})\\.(${ID})\\.currentLevel$`),
    channel: (m) => `tanks.${m[1] ?? ''}.${m[2] ?? ''}`,
    toCanonical: (r) => r * 100,
    valid: ratio,
  },
  {
    pattern: 'tanks.*.*.currentVolume',
    category: 'tanks',
    quantity: 'tank_volume',
    re: new RegExp(`^tanks\\.(${TYPES})\\.(${ID})\\.currentVolume$`),
    channel: (m) => `tanks.${m[1] ?? ''}.${m[2] ?? ''}`,
    toCanonical: (m3) => m3 * 1000,
    valid: nonNeg,
  },
];

export interface ParsedPath {
  rule: V1PathRule;
  channel: string;
}

/** Returns the matching rule and channel key, or null when the path is not permitted. */
export function parsePath(path: string): ParsedPath | null {
  for (const rule of V1_PATH_RULES) {
    const m = rule.re.exec(path);
    if (m) return { rule, channel: rule.channel(m) };
  }
  return null;
}
