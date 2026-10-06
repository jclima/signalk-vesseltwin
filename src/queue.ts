import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Reading } from './contract';

export const MAX_AGE_MS = 7 * 24 * 3600_000;
export const MAX_READINGS = 50_000;
const SEGMENT_RECORDS = 1_000;

export interface QueueOptions {
  dir: string;
  maxAgeMs?: number;
  maxReadings?: number;
  segmentRecords?: number;
  now?: () => number;
}

const SEG = /^seg-(\d{10})\.ndjson$/;

/**
 * Append-only NDJSON store-and-forward queue. Plain files (no native modules,
 * so it installs on a Raspberry Pi). Segments rotate at `segmentRecords`.
 * Acks rewrite a segment through a temp file + rename; a torn final line from
 * a crash is skipped on read. Single process, not safe for concurrent writers.
 */
export class ReadingQueue {
  private readonly maxAge: number;
  private readonly maxReadings: number;
  private readonly segmentRecords: number;
  private readonly now: () => number;
  private activeSeq = -1;
  private activeCount = 0;
  private ready = false;
  /** Readings dropped by the caps since start (surfaced in status). */
  dropped = 0;

  constructor(private readonly opts: QueueOptions) {
    this.maxAge = opts.maxAgeMs ?? MAX_AGE_MS;
    this.maxReadings = opts.maxReadings ?? MAX_READINGS;
    this.segmentRecords = opts.segmentRecords ?? SEGMENT_RECORDS;
    this.now = opts.now ?? Date.now;
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
        const r = JSON.parse(line) as Reading;
        if (typeof r.clientReadingId === 'string' && typeof r.recordedAt === 'string') out.push(r);
      } catch {
        // torn write from a crash: skip
      }
    }
    return out;
  }

  private async rewrite(seq: number, items: Reading[]): Promise<void> {
    if (items.length === 0) {
      await fs.rm(this.segPath(seq), { force: true });
      return;
    }
    const tmp = `${this.segPath(seq)}.tmp`;
    await fs.writeFile(tmp, items.map((r) => JSON.stringify(r)).join('\n') + '\n');
    await fs.rename(tmp, this.segPath(seq));
  }

  private async init(): Promise<void> {
    if (this.ready) return;
    await fs.mkdir(this.opts.dir, { recursive: true, mode: 0o700 });
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

  async append(reading: Reading): Promise<void> {
    await this.init();
    if (this.activeCount >= this.segmentRecords) {
      this.activeSeq += 1;
      this.activeCount = 0;
      await this.enforceCaps();
    }
    await fs.appendFile(this.segPath(this.activeSeq), JSON.stringify(reading) + '\n');
    this.activeCount += 1;
  }

  /** Oldest-first batch of up to `limit` readings. */
  async peek(limit: number): Promise<Reading[]> {
    await this.init();
    const out: Reading[] = [];
    for (const seq of await this.segments()) {
      out.push(...(await this.readSegment(seq)));
      if (out.length >= limit) break;
    }
    return out.slice(0, limit);
  }

  /** Removes acknowledged readings (accepted/duplicate/rejected: anything not to be retried). */
  async ack(ids: Iterable<string>): Promise<void> {
    await this.init();
    const set = new Set(ids);
    if (set.size === 0) return;
    for (const seq of await this.segments()) {
      const items = await this.readSegment(seq);
      const kept = items.filter((r) => !set.has(r.clientReadingId));
      if (kept.length !== items.length) await this.rewrite(seq, kept);
    }
  }

  async size(): Promise<number> {
    await this.init();
    let n = 0;
    for (const seq of await this.segments()) n += (await this.readSegment(seq)).length;
    return n;
  }

  /** Drops readings older than the age cap, then oldest-first beyond the count cap. */
  async enforceCaps(): Promise<void> {
    await this.init();
    const cutoff = this.now() - this.maxAge;
    const segs = await this.segments();
    const loaded: { seq: number; items: Reading[] }[] = [];
    for (const seq of segs) {
      const items = await this.readSegment(seq);
      const fresh = items.filter((r) => Date.parse(r.recordedAt) >= cutoff);
      this.dropped += items.length - fresh.length;
      if (fresh.length !== items.length) await this.rewrite(seq, fresh);
      loaded.push({ seq, items: fresh });
    }
    let total = loaded.reduce((n, s) => n + s.items.length, 0);
    for (const s of loaded) {
      if (total <= this.maxReadings) break;
      const excess = total - this.maxReadings;
      const drop = Math.min(excess, s.items.length);
      await this.rewrite(s.seq, s.items.slice(drop));
      this.dropped += drop;
      total -= drop;
    }
  }
}
