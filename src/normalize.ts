import { parsePath, type Quantity } from './paths';

/** Minimal SignalK delta shape (only the fields this plugin reads). */
export interface SignalKDelta {
  context?: string;
  updates?: {
    timestamp?: string;
    values?: { path?: unknown; value?: unknown }[];
  }[];
}

/**
 * Internal, contract-independent reading. Carries no position, MMSI, names or
 * source identifiers. `value` is the raw SI value exactly as SignalK published it
 * (the server converts); `canonical` is the converted figure (hours, volts, percent,
 * litres) used only for sampling thresholds.
 */
export interface Reading {
  /** Stable key, e.g. `propulsion.port`. */
  channel: string;
  path: string;
  quantity: Quantity;
  value: number;
  canonical: number;
  /** ISO-8601 UTC. */
  observedAt: string;
}

/** Pure: delta in, zero or more permitted readings out. Unknown or invalid values are dropped. */
export function normalize(delta: unknown, now: () => number = Date.now): Reading[] {
  const out: Reading[] = [];
  if (typeof delta !== 'object' || delta === null) return out;
  const updates: unknown = (delta as SignalKDelta).updates;
  if (!Array.isArray(updates)) return out;
  for (const raw of updates as unknown[]) {
    if (typeof raw !== 'object' || raw === null) continue;
    const u = raw as NonNullable<SignalKDelta['updates']>[number];
    if (!Array.isArray(u.values)) continue;
    const t = typeof u.timestamp === 'string' ? Date.parse(u.timestamp) : NaN;
    const observedAt = new Date(Number.isNaN(t) ? now() : t).toISOString();
    for (const v of u.values) {
      if (typeof v !== 'object' || typeof v.path !== 'string') continue;
      if (typeof v.value !== 'number' || !Number.isFinite(v.value)) continue;
      const parsed = parsePath(v.path);
      if (!parsed || !parsed.rule.valid(v.value)) continue;
      out.push({
        channel: parsed.channel,
        path: v.path,
        quantity: parsed.rule.quantity,
        value: v.value,
        canonical: parsed.rule.toCanonical(v.value),
        observedAt,
      });
    }
  }
  return out;
}
