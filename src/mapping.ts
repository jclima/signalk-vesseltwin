/**
 * SignalK path allowlist: a closed list of the six path shapes the VesselTwin contract v2
 * accepts (mirrors `path.pattern` in contracts/signalk/v2/reading-item.schema.json; a test
 * compares the two). Values are raw SI as SignalK delivers them; conversion happens server-side.
 *
 * NEVER added: navigation.position*, mmsi, communication.callsign*, design.*, anything
 * location-like or identifying. The server rejects them too.
 */

export type Category = 'engineHours' | 'batteries' | 'tanks';

/** Unit of the raw SignalK value (SI). */
export type Unit = 's' | 'V' | 'ratio' | 'm3';

export interface PathRule {
  kind: string;
  category: Category;
  unit: Unit;
  /** Anchored; capture groups are the instance parts (tank type, then id; or just id). */
  re: RegExp;
  /** SignalK subscription path for this rule. */
  subscribe: string;
}

export interface PathMatch {
  category: Category;
  unit: Unit;
  /** Instance parts joined by `.` (`house`, or `fuel.0` for tanks). */
  instance: string;
}

const ID = '([A-Za-z0-9_-]{1,40})';
const TANK = '(fuel|freshWater|wasteWater|blackWater|lubrication|liveWell|baitWell|gas|ballast)';

export const PATH_RULES: readonly PathRule[] = [
  {
    kind: 'engineRunTime',
    category: 'engineHours',
    unit: 's',
    re: new RegExp(`^propulsion\\.${ID}\\.runTime$`),
    subscribe: 'propulsion.*.runTime',
  },
  {
    kind: 'generatorRunTime',
    category: 'engineHours',
    unit: 's',
    re: new RegExp(`^electrical\\.generators\\.${ID}\\.runTime$`),
    subscribe: 'electrical.generators.*.runTime',
  },
  {
    kind: 'batteryVoltage',
    category: 'batteries',
    unit: 'V',
    re: new RegExp(`^electrical\\.batteries\\.${ID}\\.voltage$`),
    subscribe: 'electrical.batteries.*.voltage',
  },
  {
    kind: 'batteryStateOfCharge',
    category: 'batteries',
    unit: 'ratio',
    re: new RegExp(`^electrical\\.batteries\\.${ID}\\.capacity\\.stateOfCharge$`),
    subscribe: 'electrical.batteries.*.capacity.stateOfCharge',
  },
  {
    kind: 'tankLevel',
    category: 'tanks',
    unit: 'ratio',
    re: new RegExp(`^tanks\\.${TANK}\\.${ID}\\.currentLevel$`),
    subscribe: 'tanks.*.*.currentLevel',
  },
  {
    kind: 'tankVolume',
    category: 'tanks',
    unit: 'm3',
    re: new RegExp(`^tanks\\.${TANK}\\.${ID}\\.currentVolume$`),
    subscribe: 'tanks.*.*.currentVolume',
  },
];

export function matchPath(path: string): PathMatch | null {
  if (path.length > 200) return null;
  for (const r of PATH_RULES) {
    const m = r.re.exec(path);
    if (m) return { category: r.category, unit: r.unit, instance: m.slice(1).join('.') };
  }
  return null;
}

export function isPermittedPath(path: unknown): path is string {
  return typeof path === 'string' && matchPath(path) !== null;
}

export function categoryFor(path: string): Category | null {
  return matchPath(path)?.category ?? null;
}
