import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONTRACT_VERSION } from '../src/contract';
import { BACKOFF_MAX_MS, HttpClient } from '../src/http';
import {
  CLOCK_SKEW_LIMIT_MS,
  PAUSED_PROBE_MS,
  PROBE_INTERVAL_MS,
  StatusMonitor,
  checkStatus,
  classify,
  healthyDelay,
  offlineDelay,
  parseStatusBody,
  type MonitorSnapshot,
  type Scheduler,
} from '../src/status';

const CRED = `vti_${'S'.repeat(43)}`;
const NOW = Date.parse('2030-01-01T00:00:00Z');
const res = (status: number, json: unknown, headers: Record<string, string> = {}) => ({
  status,
  headers: new Headers(headers),
  json,
});
const okBody = (over: Record<string, unknown> = {}) => ({
  provider: 'signalk',
  minContract: 1,
  latestContract: 1,
  pluginUpdateRecommended: false,
  serverTime: new Date(NOW).toISOString(),
  summary: null,
  ...over,
});

describe('parseStatusBody', () => {
  it('parses tolerantly and ignores unknown fields', () => {
    expect(parseStatusBody(okBody({ extra: 1, summary: { a: 1 } }))).toEqual({
      minContract: 1,
      latestContract: 1,
      pluginUpdateRecommended: false,
      serverTime: NOW,
      summary: { a: 1 },
    });
    expect(parseStatusBody({})).toEqual({
      minContract: null,
      latestContract: null,
      pluginUpdateRecommended: false,
      serverTime: null,
      summary: null,
    });
    expect(
      parseStatusBody({
        minContract: '1',
        serverTime: 'nope',
        summary: [1],
        pluginUpdateRecommended: 'yes',
      }),
    ).toMatchObject({
      minContract: null,
      serverTime: null,
      summary: null,
      pluginUpdateRecommended: false,
    });
  });
  it('rejects a non-object body', () => {
    for (const j of [null, 'x', 5, [1]]) expect(parseStatusBody(j)).toBeNull();
  });
});

describe('classify', () => {
  it('200 is connected, with update recommendation from the server flag or latestContract', () => {
    expect(classify(res(200, okBody()), NOW)).toMatchObject({
      kind: 'connected',
      updateRecommended: false,
      clockSkewWarning: false,
    });
    expect(classify(res(200, okBody({ pluginUpdateRecommended: true })), NOW)).toMatchObject({
      updateRecommended: true,
    });
    expect(classify(res(200, okBody({ latestContract: 2 })), NOW)).toMatchObject({
      updateRecommended: true,
    });
  });

  it('flags clock skew beyond 5 minutes, either direction', () => {
    const at = (offset: number) =>
      classify(res(200, okBody({ serverTime: new Date(NOW + offset).toISOString() })), NOW);
    expect(at(CLOCK_SKEW_LIMIT_MS)).toMatchObject({ clockSkewWarning: false });
    expect(at(CLOCK_SKEW_LIMIT_MS + 1)).toMatchObject({ clockSkewWarning: true });
    expect(at(-CLOCK_SKEW_LIMIT_MS - 1)).toMatchObject({ clockSkewWarning: true });
    expect(classify(res(200, okBody({ serverTime: undefined })), NOW)).toMatchObject({
      clockSkewWarning: false,
    });
  });

  it('a contract below minContract needs an update but keeps probing', () => {
    expect(classify(res(200, okBody({ minContract: CONTRACT_VERSION + 1 })), NOW)).toMatchObject({
      kind: 'update_required',
      stop: false,
    });
    expect(classify(res(200, okBody({ minContract: CONTRACT_VERSION })), NOW).kind).toBe(
      'connected',
    );
  });

  it('maps the error statuses', () => {
    expect(classify(res(401, { code: 'integration_unauthorized' }), NOW)).toEqual({
      kind: 'reauth_required',
    });
    expect(
      classify(res(503, { code: 'integration_feature_unavailable' }, { 'retry-after': '90' }), NOW),
    ).toEqual({ kind: 'paused', reason: 'feature', retryAfterMs: 90_000 });
    expect(classify(res(403, { code: 'integration_paused_plan' }), NOW)).toEqual({
      kind: 'paused',
      reason: 'plan',
      retryAfterMs: null,
    });
    expect(classify(res(403, { code: 'integration_scope' }), NOW)).toEqual({ kind: 'stopped' });
    expect(classify(res(426, { code: 'integration_contract_unsupported' }), NOW)).toMatchObject({
      kind: 'update_required',
      stop: true,
    });
    expect(classify(res(400, { code: 'integration_contract_required' }), NOW)).toMatchObject({
      kind: 'update_required',
      stop: true,
    });
    expect(classify(res(426, null), NOW)).toMatchObject({ kind: 'update_required', stop: true });
  });

  it('429, 5xx and unexpected statuses are offline, carrying Retry-After', () => {
    for (const status of [429, 500, 502, 503, 504, 404, 403, 400]) {
      expect(classify(res(status, {}, { 'retry-after': '12' }), NOW)).toEqual({
        kind: 'offline',
        retryAfterMs: 12_000,
      });
    }
    expect(classify(res(503, { code: 'other' }), NOW)).toEqual({
      kind: 'offline',
      retryAfterMs: null,
    });
  });

  it('a 200 with an unusable body is treated as offline', () => {
    expect(classify(res(200, null), NOW).kind).toBe('offline');
    expect(classify(res(200, '<html>'), NOW).kind).toBe('offline');
  });
});

describe('delays', () => {
  it('offline delay stays within [Retry-After, 30 min] for any attempt, rng and Retry-After up to 30 min', () => {
    for (let attempt = 0; attempt < 30; attempt++) {
      for (const rng of [0, 0.25, 0.5, 0.999999]) {
        for (const ra of [null, 0, 1_000, 60_000, 10 * 60_000, BACKOFF_MAX_MS]) {
          const d = offlineDelay(attempt, ra, () => rng);
          expect(d).toBeGreaterThanOrEqual(ra ?? 0);
          expect(d).toBeGreaterThanOrEqual(5_000);
          expect(d).toBeLessThanOrEqual(BACKOFF_MAX_MS);
        }
      }
    }
  });
  it('a Retry-After above the backoff ceiling is still honored', () => {
    expect(offlineDelay(0, 2 * 3600_000, () => 0.5)).toBe(2 * 3600_000);
  });
  it('healthy cadence is about 60 minutes with jitter', () => {
    expect(healthyDelay(() => 0)).toBe(Math.round(PROBE_INTERVAL_MS * 0.9));
    expect(healthyDelay(() => 1)).toBe(Math.round(PROBE_INTERVAL_MS * 1.1));
  });
});

describe('checkStatus', () => {
  it('GETs the status route with the credential and classifies', async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    const http = new HttpClient({
      baseUrl: 'https://h/api',
      userAgent: 'ua',
      fetch: (url, init) => {
        seen.push({ url, ...(init ? { init } : {}) });
        return Promise.resolve(new Response(JSON.stringify(okBody()), { status: 200 }));
      },
    });
    const out = await checkStatus(http, { credential: CRED }, { now: () => NOW });
    expect(out.kind).toBe('connected');
    expect(seen[0]?.url).toBe('https://h/api/v1/integrations/status');
    expect(seen[0]?.init?.method).toBe('GET');
    expect((seen[0]?.init?.headers as Record<string, string>).authorization).toBe(`Bearer ${CRED}`);
  });
  it('maps a network failure to offline', async () => {
    const http = new HttpClient({
      baseUrl: 'https://h',
      userAgent: 'ua',
      fetch: () => Promise.reject(new Error('down')),
    });
    expect(await checkStatus(http, { credential: CRED })).toEqual({
      kind: 'offline',
      retryAfterMs: null,
    });
  });
});

// ---- StatusMonitor with a fake scheduler -------------------------------------------------------

type Reply = () => Response | Promise<Response> | Error;

function monitorHarness(replies: Reply[], over: { credentialOrigin?: string | null } = {}) {
  let t = NOW;
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const scheduler: Scheduler = {
    set: (fn, ms) => {
      const h = { fn, ms, cleared: false };
      timers.push(h);
      return h;
    },
    clear: (h) => {
      (h as { cleared: boolean }).cleared = true;
    },
  };
  let calls = 0;
  const queue = [...replies];
  const http = new HttpClient({
    baseUrl: 'https://api.test',
    userAgent: 'ua',
    fetch: () => {
      calls += 1;
      const r = (
        queue.shift() ?? (() => new Response(JSON.stringify(okBody()), { status: 200 }))
      )();
      return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
    },
  });
  const updates: MonitorSnapshot[] = [];
  const m = new StatusMonitor({
    http,
    credential: CRED,
    credentialOrigin:
      over.credentialOrigin === undefined ? 'https://api.test' : over.credentialOrigin,
    apiOrigin: 'https://api.test',
    onUpdate: (s) => updates.push(s),
    now: () => t,
    rng: () => 0.5,
    scheduler,
  });
  const live = () => timers.filter((x) => !x.cleared);
  const fire = async () => {
    const x = live().at(-1);
    if (!x) throw new Error('no pending timer');
    x.cleared = true;
    t += x.ms;
    x.fn();
    await m.probe();
  };
  return { m, updates, timers, live, fire, calls: () => calls, tick: (ms: number) => (t += ms) };
}
const json =
  (status: number, body: unknown, headers: Record<string, string> = {}) =>
  () =>
    new Response(JSON.stringify(body), { status, headers });

const settle = () => new Promise<void>((r) => setImmediate(r));

describe('StatusMonitor', () => {
  it('probes on start, reports connected, then schedules about hourly', async () => {
    const h = monitorHarness([json(200, okBody({ pluginUpdateRecommended: true }))]);
    h.m.start();
    expect(h.m.snapshot().state).toBe('checking');
    await settle();
    expect(h.calls()).toBe(1);
    expect(h.m.snapshot()).toMatchObject({
      state: 'connected',
      updateRecommended: true,
      clockSkewWarning: false,
      lastCheckedAt: NOW,
    });
    expect(h.live()).toHaveLength(1);
    expect(h.live()[0]?.ms).toBe(PROBE_INTERVAL_MS);
    await h.fire();
    expect(h.calls()).toBe(2);
    h.m.stop();
  });

  it('401 ends all authenticated calls: one fetch, no timer, probe is a no-op', async () => {
    const h = monitorHarness([json(401, { code: 'integration_unauthorized' })]);
    h.m.start();
    await settle();
    expect(h.m.snapshot().state).toBe('reauth_required');
    expect(h.live()).toHaveLength(0);
    await h.m.probe();
    await h.m.probe();
    expect(h.calls()).toBe(1);
  });

  it('a missing or different credential origin means re-pair with zero fetches', async () => {
    for (const credentialOrigin of [null, 'https://other.test']) {
      const h = monitorHarness([], { credentialOrigin });
      h.m.start();
      await settle();
      expect(h.m.snapshot().state).toBe('reauth_required');
      await h.m.probe();
      expect(h.calls()).toBe(0);
      expect(h.live()).toHaveLength(0);
    }
  });

  it('feature flag off pauses and probes at max(Retry-After, 1h)', async () => {
    const a = monitorHarness([json(503, { code: 'integration_feature_unavailable' })]);
    a.m.start();
    await settle();
    expect(a.m.snapshot()).toMatchObject({ state: 'paused', pausedReason: 'feature' });
    expect(a.live()[0]?.ms).toBe(PAUSED_PROBE_MS);
    const b = monitorHarness([
      json(503, { code: 'integration_feature_unavailable' }, { 'retry-after': '7200' }),
    ]);
    b.m.start();
    await settle();
    expect(b.live()[0]?.ms).toBe(7_200_000);
    const c = monitorHarness([
      json(503, { code: 'integration_feature_unavailable' }, { 'retry-after': '30' }),
    ]);
    c.m.start();
    await settle();
    expect(c.live()[0]?.ms).toBe(PAUSED_PROBE_MS);
  });

  it('plan pause probes hourly', async () => {
    const h = monitorHarness([json(403, { code: 'integration_paused_plan' })]);
    h.m.start();
    await settle();
    expect(h.m.snapshot()).toMatchObject({ state: 'paused', pausedReason: 'plan' });
    expect(h.live()[0]?.ms).toBe(PAUSED_PROBE_MS);
  });

  it('403 integration_scope stops: no timer, no more calls', async () => {
    const h = monitorHarness([json(403, { code: 'integration_scope' })]);
    h.m.start();
    await settle();
    expect(h.m.snapshot().state).toBe('stopped');
    expect(h.live()).toHaveLength(0);
    await h.m.probe();
    expect(h.calls()).toBe(1);
  });

  it('426 and contract 400s stop with update_required', async () => {
    for (const r of [
      json(426, { code: 'integration_contract_unsupported' }),
      json(400, { code: 'integration_contract_required' }),
    ]) {
      const h = monitorHarness([r]);
      h.m.start();
      await settle();
      expect(h.m.snapshot().state).toBe('update_required');
      expect(h.live()).toHaveLength(0);
      await h.m.probe();
      expect(h.calls()).toBe(1);
    }
  });

  it('a minContract above ours is update_required but keeps probing hourly', async () => {
    const h = monitorHarness([json(200, okBody({ minContract: CONTRACT_VERSION + 1 }))]);
    h.m.start();
    await settle();
    expect(h.m.snapshot().state).toBe('update_required');
    expect(h.live()[0]?.ms).toBe(PROBE_INTERVAL_MS);
    await h.fire();
    expect(h.m.snapshot().state).toBe('connected'); // server window moved back; recovers
    expect(h.calls()).toBe(2);
  });

  it('clock skew is surfaced and cleared on the next good probe', async () => {
    const skewed = okBody({ serverTime: new Date(NOW + 10 * 60_000).toISOString() });
    const h = monitorHarness([
      json(200, skewed),
      json(200, okBody({ serverTime: new Date(NOW + PROBE_INTERVAL_MS).toISOString() })),
    ]);
    h.m.start();
    await settle();
    expect(h.m.snapshot().clockSkewWarning).toBe(true);
    await h.fire();
    expect(h.m.snapshot().clockSkewWarning).toBe(false);
  });

  it('offline backs off with growing attempts, never sooner than Retry-After, and recovers', async () => {
    const h = monitorHarness([
      json(500, {}, { 'retry-after': '120' }),
      json(429, {}),
      () => new Error('down'),
    ]);
    h.m.start();
    await settle();
    expect(h.m.snapshot().state).toBe('offline');
    const d1 = h.live()[0]?.ms ?? 0;
    expect(d1).toBeGreaterThanOrEqual(120_000);
    expect(d1).toBeLessThanOrEqual(BACKOFF_MAX_MS);
    await h.fire();
    const d2 = h.live()[0]?.ms ?? 0; // attempt 1, rng .5: 5s + .5*(10s-5s) = 7.5s
    expect(d2).toBe(7_500);
    await h.fire();
    expect(h.live()[0]?.ms).toBe(5_000 + Math.round(0.5 * (20_000 - 5_000)));
    await h.fire(); // default reply: 200
    expect(h.m.snapshot().state).toBe('connected');
    expect(h.live()[0]?.ms).toBe(PROBE_INTERVAL_MS);
    h.m.stop();
  });

  it('is single-flight', async () => {
    let release: (r: Response) => void = () => undefined;
    const h = monitorHarness([
      () =>
        new Promise<Response>((r) => {
          release = r;
        }),
    ]);
    h.m.start();
    const a = h.m.probe();
    const b = h.m.probe();
    expect(a).toBe(b);
    release(new Response(JSON.stringify(okBody()), { status: 200 }));
    await a;
    expect(h.calls()).toBe(1);
    h.m.stop();
  });

  it('a result that arrives after stop() is discarded and nothing is scheduled', async () => {
    let release: (r: Response) => void = () => undefined;
    const h = monitorHarness([
      () =>
        new Promise<Response>((r) => {
          release = r;
        }),
    ]);
    h.m.start();
    await settle();
    h.m.stop();
    release(new Response(JSON.stringify(okBody()), { status: 200 }));
    await settle();
    expect(h.m.snapshot().state).toBe('checking');
    expect(h.live()).toHaveLength(0);
  });

  it('a restart discards the old generation result', async () => {
    const releases: ((r: Response) => void)[] = [];
    const slow = () =>
      new Promise<Response>((r) => {
        releases.push(r);
      }) as unknown as Response;
    const h = monitorHarness([slow, slow]);
    h.m.start();
    await settle();
    h.m.start();
    await settle();
    releases[0]?.(
      new Response(JSON.stringify({ code: 'integration_unauthorized' }), { status: 401 }),
    );
    await settle();
    expect(h.m.snapshot().state).toBe('checking'); // old 401 ignored
    releases[1]?.(new Response(JSON.stringify(okBody()), { status: 200 }));
    await settle();
    expect(h.m.snapshot().state).toBe('connected');
    h.m.stop();
  });

  it('stop() clears the pending timer', async () => {
    const h = monitorHarness([]);
    h.m.start();
    await settle();
    expect(h.live()).toHaveLength(1);
    h.m.stop();
    expect(h.live()).toHaveLength(0);
  });
});

describe('StatusMonitor with the real scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('re-probes after about an hour of fake time', async () => {
    let calls = 0;
    const http = new HttpClient({
      baseUrl: 'https://api.test',
      userAgent: 'ua',
      fetch: () => {
        calls += 1;
        return Promise.resolve(new Response(JSON.stringify(okBody()), { status: 200 }));
      },
    });
    const m = new StatusMonitor({
      http,
      credential: CRED,
      credentialOrigin: 'https://api.test',
      apiOrigin: 'https://api.test',
      onUpdate: () => undefined,
      rng: () => 0.5,
    });
    m.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS);
    expect(calls).toBe(2);
    m.stop();
    await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS * 3);
    expect(calls).toBe(2);
  });
});
