import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Reading } from './contract';

export const MAX_AGE_MS = 7 * 24 * 3600_000;
export const MAX_READINGS = 50_000;
const SEGMENT_RECORDS = 1_000;
const STATS_FILE = 'stats.json';
const STATS_DEBOUNCE_MS = 1_000;
/** How often (by the injected clock) appends re-run the age sweep over existing segments. */
const AGE_SWEEP_MS = 5 * 60_000;

export interface QueueOptions {
  dir: string;
  maxAgeMs?: number;
  /** Hard cap on queued readings, enforced on every append (default 50,000). */
  maxReadings?: number;
  segmentRecords?: number;
  now?: () => number;
  /** Delay before dirty counters are persisted to `stats.json` (default 1000 ms). */
  statsDebounceMs?: number;
}

export interface QueueStats {
  /** Readings currently held. */
  queued: number;
  /** Readings dropped by the age or count cap (persisted across restarts). */
  dropped: number;
  /** Readings discarded at send time as invalid (persisted across restarts). */
  invalid: number;
}

const SEG = /^seg-(\d{10})\.ndjson$/;

function isReading(r: unknown): r is Reading {
  if (typeof r !== 'object' || r === null) return false;
  const o = r as Record<string, unknown>;
  return (
    typeof o.clientReadingId === 'string' &&
    typeof o.recordedAt === 'string' &&
    typeof o.path === 'string' &&
    typeof o.value === 'number'
  );
}

/**
 * Append-only NDJSON store-and-forward queue. Plain files (no native modules,
 * so it installs on a Raspberry Pi). Segments rotate at `segmentRecords`.
 *
 * - Single writer: every public operation runs through one promise-chain mutex, so concurrent
 *   append/ack/clear calls never interleave. One process per directory.
 * - Crash safety: rewrites and `stats.json` go through a uniquely named temp file that is
 *   fsynced, renamed over the target, and followed by a directory fsync. Stale `*.tmp` files are
 *   swept at init. A torn final line is skipped on read and repaired at init. Plain appends are
 *   not fsynced (a power cut can lose the last few readings, never corrupt older ones).
 * - Caps: the 7-day age cap (by `recordedAt`) and the count cap (`maxReadings`) hold after every
 *   append; oldest are dropped first and counted. At the cap each append rewrites the oldest
 *   segment (at most `segmentRecords` lines), which is acceptable at sensor rates.
 */
export class ReadingQueue {
  private readonly maxAge: number;
  private readonly maxReadings: number;
  private readonly segmentRecords: number;
  private readonly now: () => number;
  private readonly statsDebounce: number;
  private activeSeq = -1;
  private activeCount = 0;
  private total = 0;
  private droppedCount = 0;
  private invalidCount = 0;
  private statsDirty = false;
  private statsTimer: NodeJS.Timeout | undefined;
  private lastAgeSweep = Number.NEGATIVE_INFINITY;
  private ready = false;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: QueueOptions) {
    this.maxAge = opts.maxAgeMs ?? MAX_AGE_MS;
    this.maxReadings = Math.max(1, Math.floor(opts.maxReadings ?? MAX_READINGS));
    this.segmentRecords = opts.segmentRecords ?? SEGMENT_RECORDS;
    this.now = opts.now ?? Date.now;
    this.statsDebounce = opts.statsDebounceMs ?? STATS_DEBOUNCE_MS;
  }

  /** Readings dropped by the caps (persisted; surfaced in status). Valid after the first operation. */
  get dropped(): number {
    return this.droppedCount;
  }

  /** Readings discarded at send time as invalid. Valid after the first operation. */
  get invalid(): number {
    return this.invalidCount;
  }

  /** Serializes `fn` after every previously queued operation; a failure does not poison the chain. */
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      await this.init();
      return fn();
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  private segPath(seq: number): string {
    return path.join(this.opts.dir, `seg-${String(seq).padStart(10, '0')}.ndjson`);
  }

  private async segments(): Promise<number[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.opts.dir);
    } catch {
      return [];
    }
    return names
      .map((n) => SEG.exec(n)?.[1])
      .filter((v): v is string => v !== undefined)
      .map(Number)
      .sort((a, b) => a - b);
  }

  private async readSegment(seq: number): Promise<Reading[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.segPath(seq), 'utf8');
    } catch {
      return [];
    }
    const out: Reading[] = [];
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        const r: unknown = JSON.parse(line);
        if (isReading(r)) out.push(r);
      } catch {
        // torn write from a crash: skip
      }
    }
    return out;
  }

  /** Writes `data` to `file` atomically: unique temp, fsync, rename, fsync the directory. */
  private async writeAtomic(file: string, data: string): Promise<void> {
    const tmp = path.join(
      this.opts.dir,
      `.${path.basename(file)}.${randomBytes(6).toString('hex')}.tmp`,
    );
    try {
      const fh = await fs.open(tmp, 'wx', 0o600);
      try {
        await fh.writeFile(data);
        await fh.sync();
      } finally {
        await fh.close();
      }
      await fs.rename(tmp, file);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
    await this.syncDir();
  }

  /** Best effort: some platforms cannot open or fsync a directory. */
  private async syncDir(): Promise<void> {
    try {
      const dh = await fs.open(this.opts.dir, 'r');
      try {
        await dh.sync();
      } finally {
        await dh.close();
      }
    } catch {
      // not supported here (e.g. Windows); the rename itself already happened
    }
  }

  private async rewrite(seq: number, items: Reading[]): Promise<void> {
    if (items.length === 0) {
      await fs.rm(this.segPath(seq), { force: true });
      await this.syncDir();
      return;
    }
    await this.writeAtomic(
      this.segPath(seq),
      items.map((r) => JSON.stringify(r)).join('\n') + '\n',
    );
  }

  private async init(): Promise<void> {
    if (this.ready) return;
    await fs.mkdir(this.opts.dir, { recursive: true, mode: 0o700 });
    // Sweep temp files left by a crash between write and rename (the old target is intact).
    for (const name of await fs.readdir(this.opts.dir)) {
      if (name.endsWith('.tmp')) await fs.rm(path.join(this.opts.dir, name), { force: true });
    }
    await this.loadStats();
    // Apply the age and count caps to whatever a previous run left behind.
    await this.applyCaps();
    const segs = await this.segments();
    const last = segs[segs.length - 1];
    if (last === undefined) {
      this.activeSeq = 0;
      this.activeCount = 0;
    } else {
      this.activeSeq = last;
      const items = await this.readSegment(last);
      this.activeCount = items.length;
      // Repair a torn final line (crash mid-append) so the next append starts on a fresh line.
      const raw = await fs.readFile(this.segPath(last), 'utf8').catch(() => '');
      if (raw.length > 0 && !raw.endsWith('\n')) await this.rewrite(last, items);
    }
    this.ready = true;
  }

  private async loadStats(): Promise<void> {
    try {
      const j: unknown = JSON.parse(
        await fs.readFile(path.join(this.opts.dir, STATS_FILE), 'utf8'),
      );
      const o = (typeof j === 'object' && j !== null ? j : {}) as Record<string, unknown>;
      const num = (v: unknown): number =>
        typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
      this.droppedCount = num(o.dropped);
      this.invalidCount = num(o.invalid);
    } catch {
      this.droppedCount = 0;
      this.invalidCount = 0;
    }
  }

  private markStats(): void {
    this.statsDirty = true;
    if (this.statsTimer || this.statsDebounce < 0) return;
    this.statsTimer = setTimeout(() => {
      this.statsTimer = undefined;
      void this.flush().catch(() => undefined);
    }, this.statsDebounce);
    this.statsTimer.unref();
  }

  private async persistStats(): Promise<void> {
    if (!this.statsDirty) return;
    this.statsDirty = false;
    try {
      await this.writeAtomic(
        path.join(this.opts.dir, STATS_FILE),
        JSON.stringify({ dropped: this.droppedCount, invalid: this.invalidCount }),
      );
    } catch (err) {
      this.statsDirty = true;
      throw err;
    }
  }

  /** Persists pending counters now (also cancels the debounce timer). */
  flush(): Promise<void> {
    return this.locked(async () => {
      if (this.statsTimer) clearTimeout(this.statsTimer);
      this.statsTimer = undefined;
      await this.persistStats();
    });
  }

  /** Flushes counters; call on plugin stop. The queue stays usable afterwards. */
  close(): Promise<void> {
    return this.flush();
  }

  /**
   * Appends one reading. A reading already older than the age cap is dropped (and counted)
   * instead of stored. Afterwards the count cap holds: oldest readings go first.
   */
  append(reading: Reading): Promise<void> {
    return this.locked(async () => {
      const t = this.now();
      if (!(Date.parse(reading.recordedAt) >= t - this.maxAge)) {
        this.droppedCount += 1;
        this.markStats();
        return;
      }
      if (this.activeCount >= this.segmentRecords) {
        this.activeSeq += 1;
        this.activeCount = 0;
        await this.ageSweep(t);
      } else if (t - this.lastAgeSweep >= AGE_SWEEP_MS) {
        await this.ageSweep(t);
      }
      await fs.appendFile(this.segPath(this.activeSeq), JSON.stringify(reading) + '\n');
      this.activeCount += 1;
      this.total += 1;
      if (this.total > this.maxReadings) await this.dropOldest(this.total - this.maxReadings);
    });
  }

  /** Oldest-first batch of up to `limit` readings. */
  peek(limit: number): Promise<Reading[]> {
    return this.locked(async () => {
      const out: Reading[] = [];
      for (const seq of await this.segments()) {
        out.push(...(await this.readSegment(seq)));
        if (out.length >= limit) break;
      }
      return out.slice(0, limit);
    });
  }

  /** Removes acknowledged readings (accepted/duplicate/rejected: anything not to be retried). */
  ack(ids: Iterable<string>): Promise<void> {
    const set = new Set(ids);
    return this.locked(async () => {
      if (set.size === 0) return;
      for (const seq of await this.segments()) {
        const items = await this.readSegment(seq);
        const kept = items.filter((r) => !set.has(r.clientReadingId));
        if (kept.length === items.length) continue;
        await this.rewrite(seq, kept);
        this.total -= items.length - kept.length;
        if (seq === this.activeSeq) this.activeCount = kept.length;
      }
    });
  }

  /** Number of queued readings. */
  size(): Promise<number> {
    return this.locked(() => Promise.resolve(this.total));
  }

  /** Counters for status: queued now, dropped by caps, discarded as invalid at send time. */
  stats(): Promise<QueueStats> {
    return this.locked(() =>
      Promise.resolve({
        queued: this.total,
        dropped: this.droppedCount,
        invalid: this.invalidCount,
      }),
    );
  }

  /** Records `n` readings the sender discarded as invalid (they must be `ack`ed separately). */
  noteInvalid(n = 1): Promise<void> {
    return this.locked(() => {
      if (n > 0) {
        this.invalidCount += Math.floor(n);
        this.markStats();
      }
      return Promise.resolve();
    });
  }

  /**
   * Removes every segment and temp file and resets queued, dropped and invalid to zero (use on
   * unpair: nothing from the old pairing should be uploaded under a new one).
   */
  clear(): Promise<void> {
    return this.locked(async () => {
      if (this.statsTimer) clearTimeout(this.statsTimer);
      this.statsTimer = undefined;
      this.statsDirty = false;
      await fs.mkdir(this.opts.dir, { recursive: true, mode: 0o700 });
      for (const name of await fs.readdir(this.opts.dir)) {
        if (SEG.test(name) || name.endsWith('.tmp') || name === STATS_FILE) {
          await fs.rm(path.join(this.opts.dir, name), { force: true });
        }
      }
      await this.syncDir();
      this.activeSeq = 0;
      this.activeCount = 0;
      this.total = 0;
      this.droppedCount = 0;
      this.invalidCount = 0;
    });
  }

  /** Drops readings older than the age cap, then oldest-first beyond the count cap. */
  enforceCaps(): Promise<void> {
    return this.locked(() => this.applyCaps());
  }

  private async ageSweep(t: number): Promise<void> {
    this.lastAgeSweep = t;
    await this.applyCaps();
    const segs = await this.segments();
    if (segs.length === 0) this.activeCount = 0;
    else if (segs.includes(this.activeSeq))
      this.activeCount = (await this.readSegment(this.activeSeq)).length;
  }

  /** Drops the `n` oldest readings across segments. */
  private async dropOldest(n: number): Promise<void> {
    let left = n;
    for (const seq of await this.segments()) {
      if (left <= 0) break;
      const items = await this.readSegment(seq);
      const drop = Math.min(left, items.length);
      if (drop === 0) {
        await this.rewrite(seq, items); // empty/garbage-only segment: remove it
        continue;
      }
      const kept = items.slice(drop);
      await this.rewrite(seq, kept);
      if (seq === this.activeSeq) this.activeCount = kept.length;
      this.droppedCount += drop;
      this.total -= drop;
      left -= drop;
    }
    this.markStats();
  }

  /** Recomputes `total` from disk while applying the age cap then the count cap. */
  private async applyCaps(): Promise<void> {
    const cutoff = this.now() - this.maxAge;
    this.lastAgeSweep = this.now();
    let total = 0;
    let dropped = 0;
    for (const seq of await this.segments()) {
      const items = await this.readSegment(seq);
      const fresh = items.filter((r) => Date.parse(r.recordedAt) >= cutoff);
      dropped += items.length - fresh.length;
      if (fresh.length !== items.length) await this.rewrite(seq, fresh);
      total += fresh.length;
    }
    this.total = total;
    this.droppedCount += dropped;
    if (total > this.maxReadings) await this.dropOldest(total - this.maxReadings);
    else if (dropped > 0) this.markStats();
  }
}
