import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpClient } from '../src/http';
import { cleanSelfUuid, defaultSleep, runPairing } from '../src/pairing';

const startBody = {
  deviceCode: 'dc_abcdefghijklmnopqrstuvwxyz',
  userCode: 'ABCD-EFGH',
  verificationUrl: 'https://vesseltwin.io/connect',
  interval: 5,
  expiresIn: 600,
};
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

function setup(tokenReplies: Response[], startReply: Response = json(200, startBody)) {
  const calls: { url: string; body: unknown }[] = [];
  const queue = [...tokenReplies];
  const fetchFn = (url: string, init?: RequestInit) => {
    calls.push({ url, body: JSON.parse(init?.body as string) });
    if (url.endsWith('/pairing/start')) return Promise.resolve(startReply);
    const next = queue.shift();
    return Promise.resolve(next ?? json(400, { error: 'authorization_pending' }));
  };
  const http = new HttpClient({ baseUrl: 'https://api.test', fetch: fetchFn, userAgent: 'ua' });
  return { http, calls };
}

const base = (http: HttpClient, onCode = vi.fn()) => ({
  http,
  clientName: 'signalk-vesseltwin',
  clientVersion: '0.0.0',
  deviceLabel: 'Boat',
  scopes: ['meters:write' as const],
  onCode,
});

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

let ctl: AbortController;

describe('runPairing', () => {
  it('shows the code, polls every 5s through pending, then returns the credential', async () => {
    const token = {
      credential: `vti_${'x'.repeat(43)}`,
      credentialId: 'c1',
      scopes: ['meters:write'],
      vesselLabel: 'V',
      provider: 'signalk',
    };
    const { http, calls } = setup([
      json(400, { error: 'authorization_pending' }),
      json(400, { error: 'authorization_pending' }),
      json(200, token),
    ]);
    const onCode = vi.fn();
    const p = runPairing(base(http, onCode));
    await vi.advanceTimersByTimeAsync(5_000 * 3);
    const out = await p;
    expect(out).toEqual({ kind: 'paired', token });
    expect(onCode).toHaveBeenCalledWith(expect.objectContaining({ userCode: 'ABCD-EFGH' }));
    expect(calls[0]?.body).toMatchObject({
      provider: 'signalk',
      contractVersion: 1,
      requestedScopes: ['meters:write'],
    });
    expect(calls.filter((c) => c.url.endsWith('/pairing/token')).length).toBe(3);
  });

  it('slow_down adds 5s to the interval', async () => {
    const { http, calls } = setup([json(400, { error: 'slow_down' })]);
    const p = runPairing(base(http));
    await vi.advanceTimersByTimeAsync(5_000); // first poll -> slow_down
    expect(calls.filter((c) => c.url.endsWith('/token')).length).toBe(1);
    await vi.advanceTimersByTimeAsync(9_000); // next due at +10s
    expect(calls.filter((c) => c.url.endsWith('/token')).length).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls.filter((c) => c.url.endsWith('/token')).length).toBe(2);
    void p.catch(() => undefined);
  });

  it('maps expired_token and access_denied', async () => {
    const a = setup([json(400, { error: 'expired_token' })]);
    const pa = runPairing(base(a.http));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await pa).toEqual({ kind: 'expired' });
    const b = setup([json(400, { error: 'access_denied' })]);
    const pb = runPairing(base(b.http));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await pb).toEqual({ kind: 'denied' });
  });

  it('gives up locally when the code lifetime passes', async () => {
    const { http } = setup([], json(200, { ...startBody, expiresIn: 12 }));
    const p = runPairing(base(http));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await p).toEqual({ kind: 'expired' });
  });

  it('reports a dark feature flag (503) with Retry-After', async () => {
    const { http } = setup(
      [],
      json(503, { code: 'integration_feature_unavailable' }, { 'retry-after': '60' }),
    );
    expect(await runPairing(base(http))).toEqual({ kind: 'unavailable', retryAfterMs: 60_000 });
  });

  it('start 429 returns busy with Retry-After', async () => {
    const { http } = setup([], json(429, {}, { 'retry-after': '90' }));
    expect(await runPairing(base(http))).toEqual({ kind: 'busy', retryAfterMs: 90_000 });
  });

  it('start 503 parses an HTTP-date Retry-After', async () => {
    const now = Date.parse('2030-01-01T00:00:00Z');
    const { http } = setup(
      [],
      json(503, {}, { 'retry-after': new Date(now + 120_000).toUTCString() }),
    );
    expect(await runPairing({ ...base(http), now: () => now })).toEqual({
      kind: 'unavailable',
      retryAfterMs: 120_000,
    });
  });

  it('token 429 never retries sooner than Retry-After, then resumes the interval', async () => {
    const { http, calls } = setup([json(429, {}, { 'retry-after': '120' })]);
    const sleeps: number[] = [];
    let t = 0;
    const out = runPairing({
      ...base(http),
      now: () => t,
      sleep: (ms) => {
        sleeps.push(ms);
        t += ms;
        if (sleeps.length >= 3) ctl.abort();
        return Promise.resolve();
      },
      signal: (ctl = new AbortController()).signal,
    });
    expect(await out).toEqual({ kind: 'cancelled' });
    expect(sleeps[0]).toBe(5_000);
    expect(sleeps[1]).toBeGreaterThanOrEqual(120_000);
    expect(sleeps[2]).toBe(10_000); // back to intervalS (5 + 5 step), no Retry-After floor
    expect(calls.filter((c) => c.url.endsWith('/token')).length).toBe(2);
  });

  it('stops when aborted', async () => {
    const { http } = setup([]);
    const ctl = new AbortController();
    const p = runPairing({ ...base(http), signal: ctl.signal });
    ctl.abort();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await p).toEqual({ kind: 'cancelled' });
  });

  it.each([
    ['too short', 'vti_short'],
    ['one char short', `vti_${'x'.repeat(42)}`],
    ['one char long', `vti_${'x'.repeat(44)}`],
    ['wrong prefix', `xxx_${'x'.repeat(43)}`],
    ['bad characters', `vti_${'x'.repeat(42)} `],
    ['not a string', 12345],
  ])('rejects a malformed credential (%s)', async (_n, credential) => {
    const { http } = setup([
      json(200, { credential, credentialId: 'c1', scopes: [], vesselLabel: null, provider: 'x' }),
    ]);
    const p = runPairing(base(http));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await p).toEqual({ kind: 'local_failure' });
  });

  it('rejects a non-string credentialId', async () => {
    const { http } = setup([json(200, { credential: `vti_${'x'.repeat(43)}`, credentialId: 7 })]);
    const p = runPairing(base(http));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await p).toEqual({ kind: 'local_failure' });
  });

  it('copies only known token fields', async () => {
    const { http } = setup([
      json(200, {
        credential: `vti_${'x'.repeat(43)}`,
        credentialId: 'c1',
        scopes: ['meters:write', 'bogus:scope'],
        vesselLabel: 'V',
        provider: 'signalk',
        extra: 'nope',
        position: { lat: 1 },
      }),
    ]);
    const p = runPairing(base(http));
    await vi.advanceTimersByTimeAsync(5_000);
    const out = await p;
    expect(out).toEqual({
      kind: 'paired',
      token: {
        credential: `vti_${'x'.repeat(43)}`,
        credentialId: 'c1',
        scopes: ['meters:write'],
        vesselLabel: 'V',
        provider: 'signalk',
      },
    });
  });

  it('passes the abort signal to the HTTP layer', async () => {
    const seen: (AbortSignal | null | undefined)[] = [];
    const fetchFn = (_u: string, init?: RequestInit) => {
      seen.push(init?.signal);
      return Promise.resolve(json(200, startBody));
    };
    const http = new HttpClient({ baseUrl: 'https://api.test', fetch: fetchFn, userAgent: 'ua' });
    const c = new AbortController();
    const p = runPairing({ ...base(http), signal: c.signal });
    c.abort();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await p).toEqual({ kind: 'cancelled' });
    expect(seen[0]).toBeTruthy();
  });

  it.each([
    [
      'contract unsupported',
      { code: 'integration_contract_unsupported', message: 'x' },
      'update_required',
    ],
    ['scope invalid', { code: 'integration_scope_invalid', message: 'x' }, 'rejected'],
    ['validation failed, no code', { message: 'Validation failed', errors: [] }, 'rejected'],
    ['contract required', { code: 'integration_contract_required' }, 'rejected'],
    ['empty body', null, 'rejected'],
  ])('start 400 (%s) maps to %s', async (_n, body, kind) => {
    const { http, calls } = setup([], json(400, body));
    expect(await runPairing(base(http))).toEqual({ kind });
    expect(calls).toHaveLength(1);
  });

  it.each([
    ['feature code, no Retry-After', { code: 'integration_feature_unavailable' }, {}, null],
    [
      'feature code, Retry-After',
      { code: 'integration_feature_unavailable' },
      { 'retry-after': '30' },
      30_000,
    ],
    ['no code, no Retry-After', {}, {}, null],
    ['no code, Retry-After', { message: 'Please try again.' }, { 'retry-after': '7' }, 7_000],
  ])('start 503 (%s) maps to unavailable', async (_n, body, headers, ms) => {
    const { http } = setup([], json(503, body, headers));
    expect(await runPairing(base(http))).toEqual({ kind: 'unavailable', retryAfterMs: ms });
  });

  it('start 5xx other than 503 and 4xx other than 400/429 throw a redacted HttpError', async () => {
    for (const status of [401, 403, 404, 500]) {
      const { http } = setup([], json(status, {}));
      await expect(runPairing(base(http))).rejects.toThrow('pairing/start failed');
    }
  });
});

describe('token poll network errors', () => {
  const token = {
    credential: `vti_${'x'.repeat(43)}`,
    credentialId: 'c1',
    scopes: ['meters:write'],
    vesselLabel: null,
    provider: 'signalk',
  };
  /** Token replies: a Response, or 'net' for a rejected fetch (network error). */
  function flaky(replies: (Response | 'net')[], onToken?: () => void) {
    const queue = [...replies];
    const fetchFn = (url: string) => {
      if (url.endsWith('/pairing/start')) return Promise.resolve(json(200, startBody));
      onToken?.();
      const next = queue.shift();
      if (next === 'net') return Promise.reject(new TypeError('fetch failed vti_secret'));
      return Promise.resolve(next ?? json(400, { error: 'authorization_pending' }));
    };
    return new HttpClient({ baseUrl: 'https://api.test', fetch: fetchFn, userAgent: 'ua' });
  }

  it('survives a network error mid-poll and still pairs', async () => {
    const http = flaky(['net', json(200, token)]);
    const p = runPairing(base(http));
    await vi.advanceTimersByTimeAsync(5_000); // first poll fails
    await vi.advanceTimersByTimeAsync(10_000); // interval widened to 10s; second poll pairs
    expect(await p).toEqual({ kind: 'paired', token });
  });

  it('ends as expired when the errors persist until the code expires', async () => {
    const http = flaky(Array.from({ length: 1000 }, () => 'net' as const));
    const p = runPairing(base(http));
    await vi.advanceTimersByTimeAsync(700_000);
    expect(await p).toEqual({ kind: 'expired' });
  });

  it('returns cancelled, not an error, when aborted during the failing request', async () => {
    const ac = new AbortController();
    const http = flaky(['net'], () => {
      ac.abort();
    });
    const p = runPairing({ ...base(http), signal: ac.signal });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await p).toEqual({ kind: 'cancelled' });
  });

  it('a malformed 200 token response is a local failure, not a thrown error', async () => {
    const http = flaky([json(200, { credential: 'nope' })]);
    const p = runPairing(base(http));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await p).toEqual({ kind: 'local_failure' });
  });
});

describe('signalkSelfUuid hint', () => {
  const U = '123e4567-e89b-12d3-a456-426614174000';
  const hintOf = async (v: unknown) => {
    const { http, calls } = setup([], json(503, {}));
    await runPairing({ ...base(http), signalkSelfUuid: v as string });
    return (calls[0]?.body as { providerHints?: unknown }).providerHints;
  };

  it.each([`urn:mrn:signalk:uuid:${U}`, U, U.toUpperCase()])('sends %s', async (v) => {
    expect(await hintOf(v)).toEqual({ signalkSelfUuid: v });
  });

  it.each([
    'urn:mrn:imo:mmsi:123456789',
    'urn:mrn:signalk:uuid:not-a-uuid',
    `urn:mrn:signalk:uuid:${U}-extra`,
    `${U}\n`,
    `urn:mrn:signalk:uuid:${U}${' '.repeat(100)}`,
    '123456789',
    '',
    undefined,
    42,
    null,
  ])('omits %j', async (v) => {
    expect(await hintOf(v)).toBeUndefined();
  });

  it('cleanSelfUuid enforces the 100 character cap', () => {
    expect(cleanSelfUuid(`urn:mrn:signalk:uuid:${U}`)?.length).toBeLessThanOrEqual(100);
    expect(cleanSelfUuid(`${U}${'a'.repeat(70)}`)).toBeUndefined();
  });
});

/** Runs a pairing with an injected clock/sleep; stops after `max` sleeps. */
async function drive(
  startOver: Record<string, unknown>,
  tokenReplies: Response[],
  max = 4,
  startReply?: Response,
) {
  const { http, calls } = setup(
    tokenReplies,
    startReply ?? json(200, { ...startBody, ...startOver }),
  );
  const sleeps: number[] = [];
  const codes: { expiresAt: number }[] = [];
  let t = 1_000_000;
  const c = new AbortController();
  const out = await runPairing({
    ...base(
      http,
      vi.fn((info: { expiresAt: number }) => codes.push(info)),
    ),
    now: () => t,
    sleep: (ms) => {
      sleeps.push(ms);
      t += ms;
      if (sleeps.length >= max) c.abort();
      return Promise.resolve();
    },
    signal: c.signal,
  });
  return { out, sleeps, codes, calls, tokenCalls: calls.filter((x) => x.url.endsWith('/token')) };
}

describe('server-controlled timing is clamped', () => {
  it('clamps a huge or tiny interval to 1..60 s, and slow_down never grows it past 60 s', async () => {
    expect((await drive({ interval: 1e12 }, [])).sleeps[0]).toBe(60_000);
    expect((await drive({ interval: 0.001 }, [])).sleeps[0]).toBe(1_000);
    expect((await drive({ interval: -3 }, [])).sleeps[0]).toBe(1_000);
    expect((await drive({ interval: 1e12 }, [json(400, { error: 'slow_down' })])).sleeps).toEqual([
      60_000, 60_000, 60_000, 60_000,
    ]);
  });

  it('clamps expiresIn to 30 minutes and rejects a non-positive one', async () => {
    const r = await drive({ expiresIn: 1e12 }, [], 1);
    expect(r.codes[0]?.expiresAt).toBe(1_000_000 + 1_800_000);
    for (const expiresIn of [0, -5]) {
      const bad = await drive({ expiresIn }, []);
      expect(bad.out).toEqual({ kind: 'rejected' });
      expect(bad.codes).toEqual([]);
    }
  });

  it('never sleeps beyond the remaining lifetime, and expires on schedule', async () => {
    const r = await drive({ interval: 60, expiresIn: 100 }, [], 5);
    expect(r.sleeps).toEqual([60_000, 40_000]);
    expect(r.out).toEqual({ kind: 'expired' });
    expect(r.tokenCalls).toHaveLength(1);
  });

  it('no sleep ever exceeds the timer limit', async () => {
    const r = await drive({ interval: 60 }, [json(429, {}, { 'retry-after': '1000' })], 3);
    for (const ms of r.sleeps) expect(ms).toBeLessThanOrEqual(2 ** 31 - 1);
  });

  it('a huge delta-seconds Retry-After past the code lifetime returns busy without sleeping', async () => {
    const r = await drive({}, [json(429, {}, { 'retry-after': '99999999999' })]);
    expect(r.out).toEqual({ kind: 'busy', retryAfterMs: 99_999_999_999_000 });
    expect(r.sleeps).toEqual([5_000]);
    expect(r.tokenCalls).toHaveLength(1);
  });

  it('an HTTP-date Retry-After far in the future returns busy; a 5xx returns unavailable', async () => {
    const far = new Date(Date.UTC(2099, 0, 1)).toUTCString();
    const busy = await drive({}, [json(429, {}, { 'retry-after': far })]);
    expect(busy.out).toMatchObject({ kind: 'busy' });
    expect(busy.sleeps).toEqual([5_000]);
    const down = await drive({}, [json(503, {}, { 'retry-after': '3600' })]);
    expect(down.out).toEqual({ kind: 'unavailable', retryAfterMs: 3_600_000 });
    expect(down.tokenCalls).toHaveLength(1);
  });

  it('a Retry-After within the remaining lifetime is still honoured', async () => {
    const r = await drive({ expiresIn: 600 }, [json(429, {}, { 'retry-after': '120' })], 3);
    expect(r.sleeps[1]).toBe(120_000);
    expect(r.out).toEqual({ kind: 'cancelled' });
  });
});

describe('start response validation', () => {
  it.each([
    ['javascript url', { verificationUrl: 'javascript:alert(1)' }],
    ['plain http remote', { verificationUrl: 'http://vesseltwin.io/connect' }],
    ['not a url', { verificationUrl: 'vesseltwin.io/connect' }],
    ['file url', { verificationUrl: 'file:///etc/passwd' }],
    ['url too long', { verificationUrl: `https://vesseltwin.io/${'a'.repeat(300)}` }],
    ['tab in url', { verificationUrl: 'https://vesseltwin.io/con\tnect' }],
    ['newline in url', { verificationUrl: 'https://vesseltwin.io/\nconnect' }],
    ['bidi override in url', { verificationUrl: 'https://vesseltwin.io/\u202econnect' }],
    ['zero-width char in url', { verificationUrl: 'https://vesseltwin.io/co\u200bnnect' }],
    ['empty user code', { userCode: '' }],
    ['long user code', { userCode: 'A'.repeat(33) }],
    ['control chars in code', { userCode: 'AB\nCD' }],
    ['bidi override in code', { userCode: 'AB\u202eCD' }],
    ['missing device code', { deviceCode: '' }],
  ])('rejects %s', async (_n, over) => {
    const r = await drive(over, [], 1);
    expect(r.out).toEqual({ kind: 'rejected' });
    expect(r.codes).toEqual([]);
    expect(r.tokenCalls).toEqual([]);
  });

  it.each([
    'https://vesseltwin.io/connect',
    'http://localhost:3000/connect',
    'http://127.0.0.1:3000/connect',
    'http://[::1]:3000/connect',
  ])('accepts %s', async (verificationUrl) => {
    const r = await drive({ verificationUrl }, [], 1);
    expect(r.codes).toHaveLength(1);
  });
});

describe('verification URL normalization', () => {
  it.each([
    ['HTTPS://VesselTwin.IO/connect', 'https://vesseltwin.io/connect'],
    ['https://vesseltwin.io', 'https://vesseltwin.io/'],
    ['https://vesseltwin.io:443/a/../connect', 'https://vesseltwin.io/connect'],
  ])('passes %s on as %s', async (given, normalized) => {
    const r = await drive({ verificationUrl: given }, [], 1);
    expect(r.codes).toEqual([expect.objectContaining({ verificationUrl: normalized })]);
  });
});

describe('defaultSleep', () => {
  it('resolves promptly when aborted mid-sleep, and immediately if already aborted', async () => {
    const c = new AbortController();
    const p = defaultSleep(60_000, c.signal);
    c.abort();
    await p; // would hang (fake timers) if abort were ignored
    await defaultSleep(60_000, c.signal);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits for the timer otherwise, and its timer is unref-ed', async () => {
    const spy = vi.spyOn(globalThis, 'setTimeout');
    let done = false;
    const p = defaultSleep(1_000).then(() => {
      done = true;
    });
    const handle = spy.mock.results.at(-1)?.value as { hasRef?: () => boolean } | undefined;
    if (typeof handle?.hasRef === 'function') expect(handle.hasRef()).toBe(false);
    await vi.advanceTimersByTimeAsync(999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(done).toBe(true);
    spy.mockRestore();
  });

  it('runPairing returns cancelled promptly when aborted during the default sleep', async () => {
    const { http } = setup([]);
    const c = new AbortController();
    const p = runPairing({ ...base(http), signal: c.signal });
    await vi.advanceTimersByTimeAsync(10); // start response is in; now sleeping 5 s
    c.abort();
    expect(await p).toEqual({ kind: 'cancelled' });
    expect(vi.getTimerCount()).toBe(0);
  });
});
