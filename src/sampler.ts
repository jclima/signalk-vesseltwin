import type { Reading } from './contract';
import { uuidv7 } from './ids';
import { MAX_CHANNELS, MAX_READINGS_PER_CHANNEL_PER_DAY, type UploadOptions } from './config';
import { isPermittedPath, matchPath, type PathMatch, type Unit } from './mapping';
import type { ReadingQueue } from './queue';

/**
 * Pure record policy for upload: decides which SignalK samples are kept. Nothing here subscribes,
 * schedules or uploads; the plugin feeds it deltas from the collector and gives it a queue sink.
 *
 * Readings are queued in SI, exactly as SignalK delivered them (seconds, volts, ratio, cubic
 * metres); the platform converts server-side. Owner units (hours, percent, litres) are used only
 * to compare against the owner-unit thresholds in the settings.
 */

/** A kept sample; the sink assigns the idempotency id. */
export type SampledReading = Omit<Reading, 'clientReadingId'>;

export interface ReadingSink {
  write(reading: SampledReading): Promise<void>;
}

/** Discards everything. */
export class NullSink implements ReadingSink {
  write(): Promise<void> {
    return Promise.resolve();
  }
}

/** Appends to a local queue file set. */
export class QueueSink implements ReadingSink {
  constructor(
    private readonly queue: ReadingQueue,
    private readonly now: () => number = Date.now,
  ) {}

  write(reading: SampledReading): Promise<void> {
    return this.queue.append({
      clientReadingId: uuidv7(this.now()),
      path: reading.path,
      value: reading.value,
      recordedAt: reading.recordedAt,
    });
  }
}

export interface DeltaValue {
  path?: unknown;
  value?: unknown;
}
export interface DeltaUpdate {
  timestamp?: unknown;
  values?: unknown;
  meta?: unknown;
}
export interface Delta {
  context?: unknown;
  updates?: unknown;
}

export interface SamplerOptions {
  options: UploadOptions;
  sink: ReadingSink;
  now: () => number;
}

export interface SamplerStats {
  kept: number;
  channels: number;
  /** Distinct channels refused because the channel limit was reached. */
  overflowChannels: number;
}

const DAY_MS = 24 * 3600_000;
const FUTURE_SLACK_MS = 5 * 60_000;

interface ChannelState {
  lastSeenMs: number;
  lastKeptMs: number | null;
  lastKeptValue: number;
  day: string;
  dayCount: number;
}

type CategoryKey = 'engineHours' | 'batteries' | 'tanks';

/** Converts a raw SI value to the owner unit, for threshold comparison only. */
function convert(category: CategoryKey, unit: Unit, v: number): number | null {
  if (category === 'engineHours' && unit === 's') return v / 3600;
  if (category === 'batteries' && unit === 'V') return v;
  if (category === 'batteries' && unit === 'ratio') return v * 100;
  if (category === 'tanks' && unit === 'ratio') return v * 100;
  if (category === 'tanks' && unit === 'm3') return v * 1000;
  return null;
}

function thresholdFor(o: UploadOptions, category: CategoryKey, unit: Unit): number {
  if (category === 'engineHours') return o.engineHours.minChangeHours;
  if (category === 'batteries') {
    return unit === 'V' ? o.batteries.minChangeVolts : o.batteries.minChangePercent;
  }
  return unit === 'ratio' ? o.tanks.minChangePercent : o.tanks.minChangeLiters;
}

function isCategoryKey(c: string): c is CategoryKey {
  return c === 'engineHours' || c === 'batteries' || c === 'tanks';
}

export function createSampler(cfg: SamplerOptions) {
  const channels = new Map<string, ChannelState>();
  const overflow = new Set<string>();
  let kept = 0;

  /** Returns the reading to write, or null. All state is updated synchronously. */
  function consider(
    path: string,
    m: PathMatch,
    value: number,
    recordedAtMs: number,
  ): SampledReading | null {
    if (!isCategoryKey(m.category)) return null;
    const cat = cfg.options[m.category];
    if (!cat.active) return null;
    if (cat.instanceMode === 'selected' && !cat.instanceIds.includes(m.instance)) return null;
    const converted = convert(m.category, m.unit, value);
    if (converted === null || !Number.isFinite(converted)) return null;

    let ch = channels.get(path);
    if (!ch) {
      if (channels.size >= MAX_CHANNELS) {
        overflow.add(path);
        return null;
      }
      ch = { lastSeenMs: -Infinity, lastKeptMs: null, lastKeptValue: 0, day: '', dayCount: 0 };
      channels.set(path, ch);
    }

    // The SignalK timestamp must have advanced since the last sample of this channel.
    if (recordedAtMs <= ch.lastSeenMs) return null;
    ch.lastSeenMs = recordedAtMs;

    if (ch.lastKeptMs !== null) {
      if (recordedAtMs <= ch.lastKeptMs) return null;
      const elapsed = recordedAtMs - ch.lastKeptMs;
      if (elapsed < cat.recordIntervalMinutes * 60_000) return null;
      const min = thresholdFor(cfg.options, m.category, m.unit);
      const changed = Math.abs(converted - ch.lastKeptValue) >= min;
      if (!(min === 0 || changed || elapsed >= DAY_MS)) return null;
    }

    // Defense in depth: nothing outside the closed allowlist is ever emitted.
    if (!isPermittedPath(path)) return null;
    // toISOString() is always UTC with a `Z`, whatever offset the delta timestamp used.
    const recordedAt = new Date(recordedAtMs).toISOString();
    const day = recordedAt.slice(0, 10);
    if (ch.day !== day) {
      ch.day = day;
      ch.dayCount = 0;
    }
    if (ch.dayCount >= MAX_READINGS_PER_CHANNEL_PER_DAY) return null;

    ch.dayCount += 1;
    ch.lastKeptMs = recordedAtMs;
    ch.lastKeptValue = converted;
    kept += 1;
    // Emit the raw SI value; `converted` is only kept for change detection.
    return { path, value, recordedAt };
  }

  async function handleDelta(delta: unknown): Promise<number> {
    if (typeof delta !== 'object' || delta === null) return 0;
    const d = delta as Delta;
    // No `context` check: the subscription is self-scoped (`vessels.self`), and SignalK delivers
    // deltas under the full self URN, not the literal `vessels.self`. The collector that subscribes
    // is the trust boundary; the path allowlist below is the privacy boundary.
    if (!Array.isArray(d.updates)) return 0;
    const out: SampledReading[] = [];
    for (const u of d.updates as unknown[]) {
      if (typeof u !== 'object' || u === null) continue;
      const upd = u as DeltaUpdate;
      if (typeof upd.timestamp !== 'string' || !Array.isArray(upd.values)) continue;
      const ts = Date.parse(upd.timestamp);
      if (!Number.isFinite(ts) || ts > cfg.now() + FUTURE_SLACK_MS) continue;
      for (const v of upd.values as unknown[]) {
        if (typeof v !== 'object' || v === null) continue;
        const { path, value } = v as DeltaValue;
        if (typeof path !== 'string' || typeof value !== 'number' || !Number.isFinite(value)) {
          continue;
        }
        const m = matchPath(path);
        if (!m) continue;
        const r = consider(path, m, value, ts);
        if (r) out.push(r);
      }
    }
    for (const r of out) await cfg.sink.write(r);
    return out.length;
  }

  return {
    handleDelta,
    stats: (): SamplerStats => ({
      kept,
      channels: channels.size,
      overflowChannels: overflow.size,
    }),
  };
}
