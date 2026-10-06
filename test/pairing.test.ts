import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpClient } from '../src/http';
import { cleanSelfUuid, runPairing } from '../src/pairing';

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
    const caught = p.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(String(await caught)).toMatch(/unexpected pairing\/token response/);
  });

  it('rejects a non-string credentialId', async () => {
    const { http } = setup([json(200, { credential: `vti_${'x'.repeat(43)}`, credentialId: 7 })]);
    const caught = runPairing(base(http)).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(String(await caught)).toMatch(/unexpected pairing\/token response/);
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
