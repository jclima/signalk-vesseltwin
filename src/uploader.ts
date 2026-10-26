import type { Reading } from './contract';
import { CONTRACT_VERSION } from './contract';
import { HttpClient, MAX_TIMER_MS, type FetchLike, type HttpResult } from './http';
import type { ReadingQueue } from './queue';
import { redactError } from './redact';
import { classifyFailure, offlineDelay, type PauseReason, type Scheduler } from './status';
import {
  MAX_BATCH,
  parseReadingsResponse,
  READING_REASONS,
  READING_STATUSES,
  validateReadingItem,
  type ReadingItem,
  type ReadingReason,
  type ReadingStatus,
} from './wire';

/**
 * Store-and-forward uploader: sends queued readings to the readings route of the configured API,
 * one batch at a time. This is the only module that knows the ingest route. The credential goes
 * only to its issuing origin (HttpClient enforces that). Replays are idempotent because every
 * reading keeps its `clientReadingId`, so aborting a request or restarting is always safe.
 */

export const READINGS_PATH = '/v1/integrations/signalk/readings';
export const MAX_BATCH_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;
/** First attempt after start: 1 to 5 minutes. */
const FIRST_ATTEMPT_MIN_MS = 60_000;
const FIRST_ATTEMPT_SPAN_MS = 4 * 60_000;
/** Gap between batches while a backlog or a bisection remains (30 requests a minute at most). */
export const PACE_MS = 2_000;
/** `{"readings":[]}` */
const ENVELOPE_BYTES = 15;

const defaultScheduler: Scheduler = {
  set: (fn, ms) => {
    const h = setTimeout(fn, ms);
    if (typeof h === 'object' && typeof h.unref === 'function') h.unref();
    return h;
  },
  clear: (h) => {
    clearTimeout(h as ReturnType<typeof setTimeout>);
  },
};

/**
 * The oldest-first prefix of `rs` that fits `maxItems` and whose JSON request envelope is at most
 * `maxBytes`. Never empty for a non-empty input: one reading always goes out alone if need be.
 * Only the four wire fields are copied.
 */
export function buildBatch(
  rs: readonly Reading[],
  maxItems: number = MAX_BATCH,
  maxBytes: number = MAX_BATCH_BYTES,
): ReadingItem[] {
  const out: ReadingItem[] = [];
  let bytes = ENVELOPE_BYTES;
  const cap = Math.max(1, Math.min(maxItems, MAX_BATCH));
  for (const r of rs) {
    if (out.length >= cap) break;
    const item: ReadingItem = {
      clientReadingId: r.clientReadingId,
      path: r.path,
      value: r.value,
      recordedAt: r.recordedAt,
    };
    const add = Buffer.byteLength(JSON.stringify(item)) + (out.length > 0 ? 1 : 0);
    if (out.length > 0 && bytes + add > maxBytes) break;
    bytes += add;
    out.push(item);
  }
  return out;
}

export interface AppliedResults {
  /** Every id of the batch: all statuses are terminal, nothing is retried. */
  ack: string[];
  byStatus: Partial<Record<ReadingStatus, number>>;
  byReason: Partial<Record<ReadingReason, number>>;
}

/** Null when the reply is unusable (then nothing may be acknowledged). */
export function applyResults(
  batch: readonly { clientReadingId: string }[],
  json: unknown,
): AppliedResults | null {
  const ids = batch.map((b) => b.clientReadingId);
  const parsed = parseReadingsResponse(json, ids);
  if (!parsed) return null;
  const byStatus: AppliedResults['byStatus'] = {};
  const byReason: AppliedResults['byReason'] = {};
  for (const r of parsed.results) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    if (r.status === 'rejected' && r.reason) byReason[r.reason] = (byReason[r.reason] ?? 0) + 1;
  }
  return { ack: ids, byStatus, byReason };
}

export type UploaderState =
  | 'idle'
  | 'sending'
  | 'backoff'
  | 'paused'
  | 'held'
  | 'update_required'
  | 'reauth_required'
  | 'stopped';

export interface UploadSnapshot {
  state: UploaderState;
  pausedReason: PauseReason | null;
  /** Counters refreshed after each ack and on `refreshStats()`. */
  queued: number;
  dropped: number;
  invalid: number;
  /** Epoch ms of the last fully valid server reply. */
  lastSentAt: number | null;
  /** Consecutive failed attempts (reset by an accepted batch or an empty queue). */
  failures: number;
  /** Epoch ms of the first failure in the current run of failures (null when none). */
  failingSince: number | null;
  /** Reading results reported by the server since start, by status. */
  results: Record<ReadingStatus, number>;
  /** Reasons given for `rejected` results since start. */
  rejectedReasons: Partial<Record<ReadingReason, number>>;
}

export type UploaderEvent =
  /** 401. `tombstone` only for the platform's own "credential is bad" answer. */
  | { kind: 'reauth'; tombstone: boolean }
  | { kind: 'paused'; reason: PauseReason }
  | { kind: 'update_required' }
  | { kind: 'changed' };

export interface UploaderOptions {
  queue: ReadingQueue;
  baseUrl: string;
  credential: string;
  /** Origin the credential was issued for (the only origin it may be sent to). */
  credentialOrigin: string;
  fetch: FetchLike;
  userAgent: string;
  /** Time between batches while the queue is empty (the settings' upload interval). */
  intervalMs: number;
  /** Whether a queued reading still matches an active category and instance. */
  isActive: (path: string) => boolean;
  onEvent?: (e: UploaderEvent) => void;
  log?: (msg: string) => void;
  now?: () => number;
  rng?: () => number;
  scheduler?: Scheduler;
}

interface Bisect {
  halves: [ReadingItem[], ReadingItem[]];
  res: [('ok' | 'bad') | null, ('ok' | 'bad') | null];
}

function split(items: ReadingItem[]): [ReadingItem[], ReadingItem[]] {
  const mid = Math.ceil(items.length / 2);
  return [items.slice(0, mid), items.slice(mid)];
}

const zeroResults = (): Record<ReadingStatus, number> =>
  Object.fromEntries(READING_STATUSES.map((s) => [s, 0])) as Record<ReadingStatus, number>;

export class Uploader {
  private readonly http: HttpClient;
  private readonly sched: Scheduler;
  private readonly now: () => number;
  private readonly rng: () => number;
  private state: UploaderState = 'idle';
  private pausedReason: PauseReason | null = null;
  private running = false;
  private held = false;
  private sticky: 'update_required' | 'reauth_required' | null = null;
  private timer: unknown = null;
  private ctl: AbortController | null = null;
  private inflight: Promise<void> | null = null;
  private attempt = 0;
  private failures = 0;
  private failingSince: number | null = null;
  /** The server told us to wait (Retry-After, pause): kick() and resume() never go earlier. */
  private notBefore = 0;
  private limit = MAX_BATCH;
  /** Full batches accepted since the limit last shrank; the limit regrows slowly, never at once. */
  private okStreak = 0;
  private work: Bisect | null = null;
  private queued = 0;
  private dropped = 0;
  private invalid = 0;
  private lastSentAt: number | null = null;
  private results = zeroResults();
  private reasons: Partial<Record<ReadingReason, number>> = {};

  constructor(private readonly o: UploaderOptions) {
    this.http = new HttpClient({
      baseUrl: o.baseUrl,
      fetch: o.fetch,
      userAgent: o.userAgent,
      timeoutMs: REQUEST_TIMEOUT_MS,
      contractVersion: CONTRACT_VERSION,
    });
    this.sched = o.scheduler ?? defaultScheduler;
    this.now = o.now ?? Date.now;
    this.rng = o.rng ?? Math.random;
  }

  snapshot(): UploadSnapshot {
    return {
      state: this.state,
      pausedReason: this.pausedReason,
      queued: this.queued,
      dropped: this.dropped,
      invalid: this.invalid,
      lastSentAt: this.lastSentAt,
      failures: this.failures,
      failingSince: this.failingSince,
      results: { ...this.results },
      rejectedReasons: { ...this.reasons },
    };
  }

  /** Re-reads the queue counters (call after appends so the snapshot stays current). */
  async refreshStats(): Promise<void> {
    try {
      const s = await this.o.queue.stats();
      this.queued = s.queued;
      this.dropped = s.dropped;
      this.invalid = s.invalid;
    } catch (err) {
      this.o.log?.(`could not read queue counters: ${redactError(err)}`);
    }
  }

  /** First attempt after 1 to 5 minutes. */
  start(): void {
    if (this.running || this.sticky) return;
    this.running = true;
    void this.refreshStats();
    this.schedule(FIRST_ATTEMPT_MIN_MS + Math.round(this.rng() * FIRST_ATTEMPT_SPAN_MS));
  }

  /** Aborts an in-flight request (safe: replays are idempotent). Resolves when it has settled. */
  stop(): Promise<void> {
    this.running = false;
    this.clearTimer();
    this.ctl?.abort();
    this.ctl = null;
    if (this.sticky === null) this.state = 'stopped';
    return this.inflight ?? Promise.resolve();
  }

  /** The status monitor says uploads cannot work now (paused or unsupported): send nothing. */
  hold(): void {
    if (!this.running || this.sticky) return;
    this.held = true;
    this.clearTimer();
    if (this.inflight === null) this.setState('held');
  }

  /** The monitor says the connection works: leave the hold and retry a waiting upload now. */
  resume(): void {
    if (!this.running || this.sticky) return;
    if (this.held) {
      this.held = false;
      this.pausedReason = null;
      if (this.inflight === null) this.schedule(this.untilAllowed());
      return;
    }
    this.kick();
  }

  /** Retries now, but only an upload that is waiting after a failure or a pause. */
  kick(): void {
    if (!this.running || this.sticky || this.held || this.inflight) return;
    if (this.state === 'backoff' || this.state === 'paused') this.schedule(this.untilAllowed());
  }

  /** Time left on a wait the server imposed (0 when none): an early retry must not undercut it. */
  private untilAllowed(): number {
    return Math.max(0, this.notBefore - this.now());
  }

  private clearTimer(): void {
    if (this.timer !== null) this.sched.clear(this.timer);
    this.timer = null;
  }

  private schedule(ms: number): void {
    this.clearTimer();
    if (!this.running || this.held || this.sticky) return;
    this.timer = this.sched.set(
      () => {
        this.timer = null;
        void this.run();
      },
      Math.min(Math.max(0, ms), MAX_TIMER_MS),
    );
  }

  private setState(s: UploaderState): void {
    if (this.state === s) return;
    this.state = s;
    this.o.onEvent?.({ kind: 'changed' });
  }

  private interval(): number {
    return Math.round(this.o.intervalMs * (0.9 + 0.2 * this.rng()));
  }

  private run(): Promise<void> {
    if (!this.running || this.held || this.sticky) return Promise.resolve();
    if (this.inflight) return this.inflight;
    const ctl = new AbortController();
    this.ctl = ctl;
    this.setState('sending');
    const p: Promise<void> = this.cycle(ctl)
      .catch((err: unknown) => {
        this.o.log?.(`upload attempt failed: ${redactError(err)}`);
        if (this.ctl === ctl) this.backoff(null);
      })
      .finally(() => {
        if (this.inflight === p) this.inflight = null;
        if (this.ctl === ctl) this.ctl = null;
        // A hold that arrived mid-flight takes effect now.
        if (this.held && this.state === 'sending') this.setState('held');
        // A resume() that arrived mid-flight found `inflight` set and scheduled nothing: if no
        // timer is armed now, the uploader would stall until the next external kick.
        if (this.running && !this.held && this.sticky === null && this.timer === null) {
          this.schedule(
            this.state === 'backoff' || this.state === 'paused' ? this.untilAllowed() : PACE_MS,
          );
        }
      });
    this.inflight = p;
    return p;
  }

  private live(ctl: AbortController): boolean {
    return this.ctl === ctl && !ctl.signal.aborted;
  }

  /** Next batch: the current bisection half, else the queue head (invalid readings are dropped). */
  private async pick(
    ctl: AbortController,
  ): Promise<{ items: ReadingItem[]; slot: 0 | 1 | null } | 'more' | null> {
    if (this.work) {
      const slot = this.work.res[0] === null ? 0 : 1;
      return { items: this.work.halves[slot], slot };
    }
    for (let round = 0; round < 10; round++) {
      const raw = await this.o.queue.peek(this.limit);
      if (!this.live(ctl)) return null;
      if (raw.length === 0) return null;
      const good: Reading[] = [];
      const bad: string[] = [];
      for (const r of raw) {
        if (validateReadingItem(r) && this.o.isActive(r.path)) good.push(r);
        else bad.push(r.clientReadingId);
      }
      if (bad.length > 0) {
        // Not for upload any more (settings changed, or malformed on disk): drop and count.
        await this.o.queue.noteInvalid(bad.length);
        await this.o.queue.ack(bad);
        await this.refreshStats();
        if (!this.live(ctl)) return null;
      }
      if (good.length > 0) return { items: buildBatch(good, this.limit), slot: null };
    }
    // Rounds used up on invalid readings that were drained: more may follow, so come back soon
    // (not after the full interval, which is not an empty queue).
    return 'more';
  }

  private async cycle(ctl: AbortController): Promise<void> {
    const picked = await this.pick(ctl);
    if (!this.live(ctl)) return;
    if (picked === 'more') {
      this.setState('idle');
      this.schedule(PACE_MS);
      return;
    }
    if (!picked) {
      this.attempt = 0;
      this.notBefore = 0;
      this.setState('idle');
      this.schedule(this.interval());
      return;
    }
    const { items, slot } = picked;

    let res: HttpResult | null = null;
    try {
      res = await this.http.post(
        READINGS_PATH,
        { readings: items },
        {
          credential: this.o.credential,
          credentialOrigin: this.o.credentialOrigin,
          signal: ctl.signal,
        },
      );
    } catch (err) {
      if (!this.live(ctl)) return; // stopped meanwhile: no ack, no state change
      this.o.log?.(`readings request failed: ${redactError(err)}`);
    }
    if (!this.live(ctl)) return;

    if (res && res.status === 200) {
      const applied = applyResults(items, res.json);
      if (applied) {
        await this.onAccepted(ctl, items, slot, applied);
        return;
      }
      this.o.log?.('readings reply unusable');
      this.backoff(null);
      return;
    }

    const cls = classifyFailure(res, this.now());
    switch (cls.kind) {
      case 'reauth':
        this.stopFor('reauth_required');
        this.o.onEvent?.({ kind: 'reauth', tombstone: cls.tombstone });
        return;
      case 'update_required':
        this.stopFor('update_required');
        this.o.onEvent?.({ kind: 'update_required' });
        return;
      case 'paused':
        this.pausedReason = cls.reason;
        this.setState('paused');
        // Binding wait: Retry-After only. The ~1 h floor is just the timer, so a resume() or kick()
        // after the monitor reports connected sends without waiting it out.
        this.notBefore = this.now() + (cls.retryAfterMs ?? 0);
        this.o.onEvent?.({ kind: 'paused', reason: cls.reason });
        this.schedule(cls.delayMs);
        return;
      case 'too_large':
        if (items.length > 1) {
          this.limit = Math.max(1, Math.floor(items.length / 2));
          this.okStreak = 0;
          this.work = null; // sizes changed: start again from the queue head
          this.setState('idle');
          this.schedule(PACE_MS);
        } else {
          this.backoff(null); // nothing smaller exists: keep the reading, wait
        }
        return;
      case 'bad_request':
        await this.onBadRequest(ctl, items, slot);
        return;
      case 'retry':
        this.backoff(cls.retryAfterMs);
        return;
    }
  }

  private backoff(retryAfter: number | null): void {
    const delay = offlineDelay(this.attempt, retryAfter, this.rng);
    this.attempt += 1;
    this.failures += 1;
    this.failingSince ??= this.now();
    // Only a wait the server asked for is binding; plain backoff may be cut short by a kick.
    if (retryAfter !== null) this.notBefore = this.now() + delay;
    this.setState('backoff');
    this.o.onEvent?.({ kind: 'changed' }); // the failure count feeds the status line
    this.schedule(delay);
  }

  private stopFor(s: 'update_required' | 'reauth_required'): void {
    this.sticky = s;
    this.running = false;
    this.clearTimer();
    this.setState(s);
  }

  private async onAccepted(
    ctl: AbortController,
    items: ReadingItem[],
    slot: 0 | 1 | null,
    applied: AppliedResults,
  ): Promise<void> {
    await this.o.queue.ack(applied.ack);
    for (const [k, n] of Object.entries(applied.byStatus)) this.results[k as ReadingStatus] += n;
    for (const [k, n] of Object.entries(applied.byReason)) {
      if ((READING_REASONS as readonly string[]).includes(k)) {
        this.reasons[k as ReadingReason] = (this.reasons[k as ReadingReason] ?? 0) + n;
      }
    }
    this.lastSentAt = this.now();
    this.attempt = 0;
    this.failures = 0;
    this.failingSince = null;
    this.notBefore = 0;
    this.pausedReason = null;
    if (this.work && slot !== null) {
      this.work.res[slot] = 'ok';
      await this.resolveBisect();
    } else if (items.length >= this.limit && this.limit < MAX_BATCH && ++this.okStreak >= 10) {
      this.limit = Math.min(MAX_BATCH, this.limit * 2);
      this.okStreak = 0;
    }
    await this.refreshStats();
    if (!this.live(ctl) || this.sticky) return;
    const more = this.work !== null || this.queued > 0;
    this.setState('idle');
    this.schedule(more ? PACE_MS : this.interval());
  }

  private async onBadRequest(
    ctl: AbortController,
    items: ReadingItem[],
    slot: 0 | 1 | null,
  ): Promise<void> {
    if (this.work && slot !== null) {
      this.work.res[slot] = 'bad';
      await this.resolveBisect();
    } else if (items.length > 1) {
      this.work = { halves: split(items), res: [null, null] };
    } else {
      // A lone reading with no sibling to compare against: the plugin and server disagree. This
      // (and the both-halves-refused case in resolveBisect) is deliberately treated as systemic:
      // update_required is sticky until the plugin restarts, rather than guessing which reading
      // is at fault or retrying a request the server keeps refusing.
      this.stopFor('update_required');
      this.o.onEvent?.({ kind: 'update_required' });
      return;
    }
    await this.refreshStats();
    if (!this.live(ctl) || this.sticky) return;
    this.setState('idle');
    this.schedule(PACE_MS);
  }

  /** Decides what a finished pair of halves means. A reading is dropped only if its sibling passed. */
  private async resolveBisect(): Promise<void> {
    const w = this.work;
    if (!w) return;
    const [a, b] = w.res;
    if (a === null || b === null) return;
    if (a === 'ok' && b === 'ok') {
      this.work = null;
    } else if (a === 'bad' && b === 'bad') {
      this.work = null;
      this.stopFor('update_required'); // both halves refused: systemic, not a bad reading
      this.o.onEvent?.({ kind: 'update_required' });
    } else {
      const half = w.halves[a === 'bad' ? 0 : 1];
      const only = half[0];
      if (half.length === 1 && only) {
        this.work = null;
        await this.o.queue.noteInvalid(1);
        await this.o.queue.ack([only.clientReadingId]);
      } else {
        this.work = { halves: split(half), res: [null, null] };
      }
    }
  }
}
