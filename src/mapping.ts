/**
 * SignalK path registry. INTENTIONALLY EMPTY in this release: no readings are
 * collected or uploaded until the ingest JSON Schema is vendored into this repo, the
 * owner approves upload work, and the exact path conventions are verified against a live server.
 *
 * Planned allowlist (SI units are sent raw; conversion happens server-side):
 *   TODO propulsion.<id>.runTime                         (s)   engine hours
 *   TODO electrical.generators.<id>.runTime              (s)   generator hours
 *   TODO electrical.batteries.<id>.voltage               (V)
 *   TODO electrical.batteries.<id>.capacity.stateOfCharge (0-1)
 *   TODO tanks.<type>.<id>.currentLevel                  (0-1)
 *   TODO tanks.<type>.<id>.currentVolume                 (m3)
 *   TODO design.length.overall, design.beam, design.draft.maximum,
 *        design.airHeight                                 (vessel-info suggestions)
 *
 * NEVER added: navigation.position*, mmsi, communication.callsign*, anything
 * location-like. The server rejects them too.
 */

export type Category = 'engineHours' | 'batteries' | 'tanks' | 'vesselInfo';

/** Unit of the raw SignalK value (SI). */
export type Unit = 's' | 'V' | 'ratio' | 'm3';

export interface PathRule {
  /** Glob-ish SignalK path, e.g. `propulsion.*.runTime`. */
  pattern: string;
  category: Category;
  unit: Unit;
}

export interface PathMatch {
  category: Category;
  unit: Unit;
  /** Wildcard captures joined by `.`; empty when the pattern has no wildcard. */
  instance: string;
}

export const PATH_RULES: readonly PathRule[] = [];

function matches(pattern: string, path: string): string[] | null {
  const re = new RegExp(
    '^' +
      pattern
        .split('*')
        .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('([^.]+)') +
      '$',
  );
  const m = re.exec(path);
  return m ? m.slice(1) : null;
}

export function categoryFor(path: string): Category | null {
  return matchPath(path)?.category ?? null;
}

export function matchPath(path: string, rules: readonly PathRule[] = PATH_RULES): PathMatch | null {
  for (const r of rules) {
    const caps = matches(r.pattern, path);
    if (caps) return { category: r.category, unit: r.unit, instance: caps.join('.') };
  }
  return null;
}
