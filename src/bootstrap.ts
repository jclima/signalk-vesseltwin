import { MAX_CHANNELS } from './config';
import { matchPath, type PathRule } from './mapping';
import type { Delta } from './sampler';

/**
 * Reads the current value of every permitted channel from the server's own data model, because
 * signalk-server does not replay cached values to plugins when security is on (the replay is
 * filtered per principal and a plugin has none). Without this, a steady value (an engine that is
 * off, a full tank) would never be queued until it changed.
 *
 * Rule-driven, never a generic walk: `get` is only called with the literal prefix of each active
 * rule's subscription path (`propulsion`, `electrical.batteries`, `tanks`, ...). Only the leaf's
 * top-level `value` (finite number) and `timestamp` (string) are read; `$source`, `meta` and
 * `values` (per-source maps) are ignored. Everything else in those subtrees is never inspected.
 */
export function snapshotSelf(get: (p: string) => unknown, rules: readonly PathRule[]): Delta[] {
  const out: Delta[] = [];
  const seen = new Set<string>();
  const prefixes = new Map<string, PathRule[]>();
  for (const r of rules) {
    const parts = r.subscribe.split('.');
    const star = parts.indexOf('*');
    if (star < 1) continue;
    const prefix = parts.slice(0, star).join('.');
    prefixes.set(prefix, [...(prefixes.get(prefix) ?? []), r]);
  }

  const own = (o: unknown, key: string): unknown =>
    typeof o === 'object' && o !== null && Object.prototype.hasOwnProperty.call(o, key)
      ? (o as Record<string, unknown>)[key]
      : undefined;

  for (const [prefix, group] of prefixes) {
    let root: unknown;
    try {
      root = get(prefix);
    } catch {
      continue;
    }
    if (typeof root !== 'object' || root === null) continue;
    for (const rule of group) {
      const parts = rule.subscribe.split('.');
      const star = parts.indexOf('*');
      // Depth-first over the wildcard positions, building the exact leaf path.
      const walk = (node: unknown, i: number, acc: string[]): void => {
        if (out.length >= MAX_CHANNELS) return;
        if (i === parts.length) {
          const path = acc.join('.');
          if (seen.has(path) || !matchPath(path)) return;
          const value = own(node, 'value');
          const timestamp = own(node, 'timestamp');
          if (typeof value !== 'number' || !Number.isFinite(value)) return;
          if (typeof timestamp !== 'string' || !Number.isFinite(Date.parse(timestamp))) return;
          seen.add(path);
          out.push({ updates: [{ timestamp, values: [{ path, value }] }] });
          return;
        }
        if (typeof node !== 'object' || node === null) return;
        const seg = parts[i] as string;
        if (seg === '*') {
          for (const key of Object.keys(node)) walk(own(node, key), i + 1, [...acc, key]);
        } else {
          walk(own(node, seg), i + 1, [...acc, seg]);
        }
      };
      walk(root, star, parts.slice(0, star));
    }
  }
  return out;
}
