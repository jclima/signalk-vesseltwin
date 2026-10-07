// Page controller: polling, actions and the two-step unpair. No DOM, no logging.
// Everything environmental is injected (fetch, timers, visibility, clock) so tests run offline.

import {
  PLUGIN_BASE,
  actionsFor,
  describeProblem,
  parseStatus,
  type Problem,
  type StatusModel,
} from './view.js';

/** The slice of `Response` the controller reads. */
export interface FetchResponseLike {
  status: number;
  json(): Promise<unknown>;
}
export interface FetchInitLike {
  method?: string;
  credentials: 'same-origin';
  cache: 'no-store';
  redirect: 'error';
}
export type FetchFn = (url: string, init: FetchInitLike) => Promise<FetchResponseLike>;

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface Snapshot {
  /** The last good status, or null before the first one. */
  status: StatusModel | null;
  /** The page-level problem (sign in, cannot reach); null while status polls succeed. */
  problem: Problem | null;
  /** `now()` when `status` arrived, for the countdown. */
  receivedAt: number;
  /** A button request is in flight. */
  busy: boolean;
  /** Pairing was requested and the plugin has not shown a code yet. */
  starting: boolean;
  /** The first click on Unpair; a second, explicit click performs it. */
  confirmingUnpair: boolean;
  /** Result of the last button press that failed; cleared by the next one. */
  notice: string | null;
}

export interface ControllerDeps {
  fetch: FetchFn;
  timers: Timers;
  isHidden: () => boolean;
  now: () => number;
  onChange: (s: Snapshot) => void;
}

export const FAST_POLL_MS = 2000;
export const SLOW_POLL_MS = 15_000;
export const BACKOFF_MIN_MS = 2000;
export const BACKOFF_MAX_MS = 30_000;
/** Give up waiting for a requested pairing to show a code after this long. */
export const STARTING_TIMEOUT_MS = 15_000;

const FAST_STATES: ReadonlySet<string> = new Set(['pairing', 'checking']);
const STARTED_STATES: ReadonlySet<string> = new Set([
  'pairing',
  'pairing_failed',
  'checking',
  'connected',
  'paused',
  'offline',
  'update_required',
  'config_error',
]);

export const NOTICE_PAIR_FAILED = 'Could not start pairing.';
export const NOTICE_CANCEL_FAILED = 'Could not cancel pairing.';
export const NOTICE_UNPAIR_FAILED = 'Could not remove the connection. Try again.';

/** Backoff after `failures` consecutive failed polls: 2 s, 4 s, ... capped at 30 s. */
export function errorBackoffMs(failures: number): number {
  const n = Number.isFinite(failures) ? Math.max(1, Math.floor(failures)) : 1;
  return Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.min(n - 1, 10));
}

const REQUEST_INIT = { credentials: 'same-origin', cache: 'no-store', redirect: 'error' } as const;

async function readJson(res: FetchResponseLike): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export class PairingController {
  private readonly d: ControllerDeps;
  private snap: Snapshot = {
    status: null,
    problem: null,
    receivedAt: 0,
    busy: false,
    starting: false,
    confirmingUnpair: false,
    notice: null,
  };
  private timer: unknown = null;
  private running = false;
  private inFlight = false;
  private rerun = false;
  private failures = 0;
  private startingSince = 0;
  /** Bumped by stop(); results from an older run are ignored. */
  private generation = 0;

  constructor(deps: ControllerDeps) {
    this.d = deps;
  }

  snapshot(): Snapshot {
    return this.snap;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.generation += 1;
    // One initial fetch even when the tab starts hidden; schedule() then pauses while hidden.
    void this.poll();
  }

  stop(): void {
    this.running = false;
    this.generation += 1;
    this.clearTimer();
  }

  /** Call when the tab becomes visible or hidden. */
  visibilityChanged(): void {
    if (!this.running) return;
    if (this.d.isHidden()) {
      this.clearTimer();
    } else {
      this.clearTimer();
      void this.poll();
    }
  }

  refresh(): Promise<void> {
    return this.poll();
  }

  async pair(): Promise<void> {
    if (this.snap.busy || this.snap.starting) return;
    this.set({ busy: true, notice: null, confirmingUnpair: false });
    const res = await this.send('/pair');
    if (res === null || (res.status !== 202 && res.status !== 409)) {
      this.set({ busy: false, notice: this.failureNotice(res, NOTICE_PAIR_FAILED) });
      return;
    }
    if (res.status === 202) {
      this.startingSince = this.d.now();
      this.set({ busy: false, starting: true });
    } else {
      this.set({ busy: false });
    }
    await this.poll();
  }

  async cancel(): Promise<void> {
    if (this.snap.busy) return;
    this.set({ busy: true, notice: null });
    const res = await this.send('/pair/cancel');
    if (res === null || (res.status !== 200 && res.status !== 409)) {
      this.set({ busy: false, notice: this.failureNotice(res, NOTICE_CANCEL_FAILED) });
      return;
    }
    this.set({ busy: false, starting: false });
    await this.poll();
  }

  /** First step: ask for confirmation. Nothing is sent. */
  requestUnpair(): void {
    const s = this.snap.status;
    if (this.snap.busy || !s || !actionsFor(s).some((a) => a.id === 'unpair')) return;
    this.set({ confirmingUnpair: true, notice: null });
  }

  dismissUnpair(): void {
    this.set({ confirmingUnpair: false });
  }

  /** Second step: only acts after `requestUnpair`. */
  async confirmUnpair(): Promise<void> {
    if (!this.snap.confirmingUnpair || this.snap.busy) return;
    this.set({ busy: true, notice: null });
    const res = await this.send('/unpair');
    if (res === null || res.status !== 200) {
      this.set({
        busy: false,
        confirmingUnpair: false,
        notice: this.failureNotice(res, NOTICE_UNPAIR_FAILED),
      });
      return;
    }
    this.set({ busy: false, confirmingUnpair: false, starting: false });
    await this.poll();
  }

  private failureNotice(res: FetchResponseLike | null, fallback: string): string {
    if (res === null) return describeProblem(null, null).message;
    if (res.status === 401 || res.status === 403) return describeProblem(res.status, null).message;
    return fallback;
  }

  private async send(path: string): Promise<FetchResponseLike | null> {
    try {
      return await this.d.fetch(`${PLUGIN_BASE}${path}`, { method: 'POST', ...REQUEST_INIT });
    } catch {
      return null;
    }
  }

  private clearTimer(): void {
    if (this.timer !== null) this.d.timers.clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(ms: number): void {
    this.clearTimer();
    if (!this.running || this.d.isHidden()) return;
    this.timer = this.d.timers.setTimeout(() => {
      this.timer = null;
      void this.poll();
    }, ms);
  }

  private async poll(): Promise<void> {
    if (this.inFlight) {
      this.rerun = true;
      return;
    }
    this.inFlight = true;
    const gen = this.generation;
    let next = SLOW_POLL_MS;
    try {
      let status: number | null = null;
      let body: unknown = null;
      try {
        const res = await this.d.fetch(`${PLUGIN_BASE}/status`, REQUEST_INIT);
        body = await readJson(res);
        status = res.status;
        if (res.status === 200 && body === null) status = null; // 200 but not JSON
      } catch {
        status = null;
      }
      if (gen !== this.generation) return;
      if (status === 200) {
        this.failures = 0;
        const model = parseStatus(body);
        const patch: Partial<Snapshot> = {
          status: model,
          problem: null,
          receivedAt: this.d.now(),
        };
        if (this.snap.starting) {
          const timedOut = this.d.now() - this.startingSince >= STARTING_TIMEOUT_MS;
          if (STARTED_STATES.has(model.state) || timedOut) patch.starting = false;
        }
        if (this.snap.confirmingUnpair && !actionsFor(model).some((a) => a.id === 'unpair')) {
          patch.confirmingUnpair = false;
        }
        this.set(patch);
        next = FAST_STATES.has(model.state) || this.snap.starting ? FAST_POLL_MS : SLOW_POLL_MS;
      } else {
        this.failures += 1;
        this.set({ problem: describeProblem(status, body), confirmingUnpair: false });
        next = status === 503 ? SLOW_POLL_MS : errorBackoffMs(this.failures);
      }
    } finally {
      this.inFlight = false;
    }
    if (gen !== this.generation) return;
    if (this.rerun) {
      this.rerun = false;
      void this.poll();
      return;
    }
    this.schedule(next);
  }

  private set(patch: Partial<Snapshot>): void {
    this.snap = { ...this.snap, ...patch };
    this.d.onChange(this.snap);
  }
}
