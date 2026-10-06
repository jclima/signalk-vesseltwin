import { CONTRACT_VERSION, PROVIDER } from './contract';
import {
  backoffDelay,
  errorCode,
  HttpClient,
  MAX_TIMER_MS,
  retryAfterMs,
  type HttpResult,
} from './http';
import { redactError } from './redact';

/** Probe cadence while healthy, and the slow probe for a paused integration. */
export const PROBE_INTERVAL_MS = 60 * 60_000;
export const PAUSED_PROBE_MS = 60 * 60_000;
/** Warn when the server clock and ours differ by more than this. */
export const CLOCK_SKEW_LIMIT_MS = 5 * 60_000;

/** Tolerantly parsed `GET /v1/integrations/status` body. Unknown fields are ignored. */
export interface StatusInfo {
  minContract: number;
  latestContract: number;
  pluginUpdateRecommended: boolean;
  /** Epoch ms, or null when absent or unparsable. */
  serverTime: number | null;
  summary: Record<string, unknown> | null;
}

export type PauseReason = 'feature' | 'plan';

export type StatusOutcome =
  | { kind: 'connected'; updateRecommended: boolean; clockSkewWarning: boolean; info: StatusInfo }
  /** `stop`: false for a client older than the server's minContract (probe hourly, it may update). */
  | { kind: 'update_required'; stop: boolean; info: StatusInfo | null }
  | { kind: 'reauth_required' }
  | { kind: 'paused'; reason: PauseReason; retryAfterMs: number | null }
  | { kind: 'offline'; retryAfterMs: number | null }
  /** 403 integration_scope: the plugin asked for something it has no scope for. A bug; stop. */
  | { kind: 'stopped' };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function int(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) ? v : null;
}

/**
 * Null (treated as offline) unless the body is recognisably this provider's status: `provider` is
 * `signalk` and both contract numbers are integers. A captive portal or wrong server that answers
 * 200 with other JSON must not count as connected.
 */
export function parseStatusBody(json: unknown): StatusInfo | null {
  if (!isObject(json) || json.provider !== PROVIDER) return null;
  const minContract = int(json.minContract);
  const latestContract = int(json.latestContract);
  if (minContract === null || latestContract === null) return null;
  const t = typeof json.serverTime === 'string' ? Date.parse(json.serverTime) : NaN;
  return {
    minContract,
    latestContract,
    pluginUpdateRecommended: json.pluginUpdateRecommended === true,
    serverTime: Number.isNaN(t) ? null : t,
    summary: isObject(json.summary) ? json.summary : null,
  };
}

/** Pure mapping of a status response to an outcome. `now` is epoch ms. */
export function classify(
  res: HttpResult,
  now: number,
  contract: number = CONTRACT_VERSION,
): StatusOutcome {
  const code = errorCode(res.json);
  const ra = retryAfterMs(res.headers, now);
  const { status } = res;

  if (status === 200) {
    const info = parseStatusBody(res.json);
    if (!info) return { kind: 'offline', retryAfterMs: ra }; // cannot verify; treat as transient
    if (contract < info.minContract) {
      return { kind: 'update_required', stop: false, info };
    }
    return {
      kind: 'connected',
      updateRecommended: info.pluginUpdateRecommended || info.latestContract > contract,
      clockSkewWarning:
        info.serverTime !== null && Math.abs(info.serverTime - now) > CLOCK_SKEW_LIMIT_MS,
      info,
    };
  }
  if (status === 401) return { kind: 'reauth_required' };
  if (status === 426 || (status === 400 && code?.startsWith('integration_contract_'))) {
    return { kind: 'update_required', stop: true, info: null };
  }
  if (status === 503 && code === 'integration_feature_unavailable') {
    return { kind: 'paused', reason: 'feature', retryAfterMs: ra };
  }
  if (status === 403 && code === 'integration_paused_plan') {
    return { kind: 'paused', reason: 'plan', retryAfterMs: ra };
  }
  if (status === 403 && code === 'integration_scope') return { kind: 'stopped' };
  // 429, 5xx and anything unexpected: transient, back off.
  return { kind: 'offline', retryAfterMs: ra };
}

/** One authenticated status probe. Network errors and timeouts are `offline`. */
export async function checkStatus(
  http: HttpClient,
  cred: { credential: string; credentialOrigin: string },
  opts: { signal?: AbortSignal; now?: () => number } = {},
): Promise<StatusOutcome> {
  const now = opts.now ?? Date.now;
  let res: HttpResult;
  try {
    res = await http.get('/v1/integrations/status', {
      credential: cred.credential,
      credentialOrigin: cred.credentialOrigin,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    return { kind: 'offline', retryAfterMs: null };
  }
  return classify(res, now());
}

/** What the plugin shows. `checking` until the first probe returns. */
export type MonitorState =
  | 'checking'
  | 'connected'
  | 'paused'
  | 'offline'
  | 'update_required'
  | 'reauth_required'
  | 'stopped';

export interface MonitorSnapshot {
  state: MonitorState;
  pausedReason: PauseReason | null;
  updateRecommended: boolean;
  clockSkewWarning: boolean;
  /** Epoch ms of the last completed probe. */
  lastCheckedAt: number | null;
}

export interface Scheduler {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

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

export interface StatusMonitorOptions {
  http: HttpClient;
  credential: string;
  /** Origin recorded in credential.json. Null or different from `apiOrigin` means re-pair, no calls. */
  credentialOrigin: string | null;
  /** Origin of the configured API URL. */
  apiOrigin: string;
  onUpdate: (s: MonitorSnapshot) => void;
  /** Called once when the server answered 401 (not for an origin mismatch, which makes no call). */
  onUnauthorized?: () => void;
  /** Debug logging; always receives redacted text. */
  log?: (msg: string) => void;
  now?: () => number;
  rng?: () => number;
  scheduler?: Scheduler;
}

/** Delay before the next probe after a transient failure: backoff, never sooner than Retry-After. */
export function offlineDelay(attempt: number, ra: number | null, rng: () => number): number {
  return Math.max(backoffDelay(attempt, rng), ra ?? 0);
}

/** Healthy cadence: 60 min with +-10% jitter. */
export function healthyDelay(rng: () => number): number {
  return Math.round(PROBE_INTERVAL_MS * (0.9 + 0.2 * rng()));
}

/**
 * Probes `GET /v1/integrations/status` on start, then about hourly. Single-flight; a generation
 * counter makes late results of a stopped or restarted monitor harmless. A 401 (or an origin
 * mismatch) ends all authenticated calls for this monitor.
 */
export class StatusMonitor {
  private gen = 0;
  private running = false;
  private inflight: Promise<void> | null = null;
  private timer: unknown = null;
  private ctl: AbortController | null = null;
  private attempt = 0;
  private snap: MonitorSnapshot = {
    state: 'checking',
    pausedReason: null,
    updateRecommended: false,
    clockSkewWarning: false,
    lastCheckedAt: null,
  };
  private readonly now: () => number;
  private readonly rng: () => number;
  private readonly sched: Scheduler;

  constructor(private readonly o: StatusMonitorOptions) {
    this.now = o.now ?? Date.now;
    this.rng = o.rng ?? Math.random;
    this.sched = o.scheduler ?? defaultScheduler;
  }

  snapshot(): MonitorSnapshot {
    return this.snap;
  }

  /** Probes now (no network call on an origin mismatch), then keeps the cadence. */
  start(): void {
    this.stop();
    this.running = true;
    this.gen += 1;
    this.attempt = 0;
    if (this.o.credentialOrigin === null || this.o.credentialOrigin !== this.o.apiOrigin) {
      this.running = false;
      this.set({ state: 'reauth_required' });
      return;
    }
    this.set({ state: 'checking' });
    void this.probe();
  }

  stop(): void {
    this.running = false;
    this.gen += 1;
    if (this.timer !== null) this.sched.clear(this.timer);
    this.timer = null;
    this.ctl?.abort();
    this.ctl = null;
    this.inflight = null;
  }

  /** Single-flight: a probe already in flight is returned instead of starting another. */
  probe(): Promise<void> {
    if (!this.running) return Promise.resolve();
    if (this.inflight) return this.inflight;
    const gen = this.gen;
    const ctl = new AbortController();
    this.ctl = ctl;
    const p = this.run(gen, ctl).finally(() => {
      if (this.gen === gen) this.inflight = null;
    });
    this.inflight = p;
    return p;
  }

  private async run(gen: number, ctl: AbortController): Promise<void> {
    if (this.timer !== null) this.sched.clear(this.timer);
    this.timer = null;
    let out: StatusOutcome;
    try {
      out = await checkStatus(
        this.o.http,
        // start() guarantees credentialOrigin is non-null here.
        { credential: this.o.credential, credentialOrigin: this.o.credentialOrigin ?? '' },
        { signal: ctl.signal, now: this.now },
      );
    } catch (err) {
      this.o.log?.(`status probe cancelled: ${redactError(err)}`);
      return;
    }
    if (gen !== this.gen || !this.running) return; // stale: stopped or restarted meanwhile
    this.apply(out);
  }

  private apply(out: StatusOutcome): void {
    const at = this.now();
    let next: number | null = null;
    let reset = true;
    switch (out.kind) {
      case 'connected':
        this.set({
          state: 'connected',
          updateRecommended: out.updateRecommended,
          clockSkewWarning: out.clockSkewWarning,
          lastCheckedAt: at,
        });
        next = healthyDelay(this.rng);
        break;
      case 'update_required':
        this.set({ state: 'update_required', lastCheckedAt: at });
        next = out.stop ? null : healthyDelay(this.rng);
        break;
      case 'reauth_required':
        this.set({ state: 'reauth_required', lastCheckedAt: at });
        this.o.onUnauthorized?.();
        break;
      case 'stopped':
        this.set({ state: 'stopped', lastCheckedAt: at });
        break;
      case 'paused':
        this.set({ state: 'paused', pausedReason: out.reason, lastCheckedAt: at });
        next = Math.max(out.retryAfterMs ?? 0, PAUSED_PROBE_MS);
        break;
      case 'offline':
        this.set({ state: 'offline', lastCheckedAt: at });
        next = offlineDelay(this.attempt, out.retryAfterMs, this.rng);
        this.attempt += 1;
        reset = false;
        break;
    }
    if (reset) this.attempt = 0;
    if (next === null) {
      this.running = false; // terminal: no timers, no further authenticated calls
      return;
    }
    const gen = this.gen;
    this.timer = this.sched.set(
      () => {
        this.timer = null;
        if (gen === this.gen) void this.probe();
      },
      Math.min(next, MAX_TIMER_MS),
    );
  }

  private set(patch: Partial<MonitorSnapshot>): void {
    this.snap = {
      ...this.snap,
      pausedReason: null,
      ...(patch.state === 'connected' || patch.state === 'update_required'
        ? {}
        : { updateRecommended: false, clockSkewWarning: false }),
      ...patch,
    };
    this.o.onUpdate(this.snap);
  }
}
