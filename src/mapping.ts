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
 *   TODO name, design.length.overall, design.beam, design.draft.maximum,
 *        design.airHeight                                 (vessel-info suggestions)
 *
 * NEVER added: navigation.position*, mmsi, communication.callsign*, anything
 * location-like. The server rejects them too.
 */

export type Category = 'engineHours' | 'batteries' | 'tanks' | 'vesselInfo';

export interface PathRule {
  /** Glob-ish SignalK path, e.g. `propulsion.*.runTime`. */
  pattern: string;
  category: Category;
}

export const PATH_RULES: readonly PathRule[] = [];

function matches(pattern: string, path: string): boolean {
  const re = new RegExp(
    '^' +
      pattern
        .split('*')
        .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('[^.]+') +
      '$',
  );
  return re.test(path);
}

export function categoryFor(path: string): Category | null {
  return PATH_RULES.find((r) => matches(r.pattern, path))?.category ?? null;
}
