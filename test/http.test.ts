import { describe, expect, it } from 'vitest';
import {
  BACKOFF_MAX_MS,
  BACKOFF_MIN_MS,
  HttpClient,
  HttpError,
  errorCode,
  isRetryableStatus,
  joinUrl,
  backoffDelay,
  retryAfterMs,
} from '../src/http';

describe('backoffDelay', () => {
  it('stays within [min, max] for any attempt and rng', () => {
    for (let a = 0; a < 40; a++) {
      for (const r of [0, 0.5, 0.999999]) {
        const d = backoffDelay(a, () => r);
        expect(d).toBeGreaterThanOrEqual(BACKOFF_MIN_MS);
        expect(d).toBeLessThanOrEqual(BACKOFF_MAX_MS);
      }
    }
  });
  it('grows its ceiling exponentially then caps', () => {
    expect(backoffDelay(0, () => 1)).toBe(5_000);
    expect(backoffDelay(1, () => 1)).toBe(10_000);
    expect(backoffDelay(2, () => 1)).toBe(20_000);
    expect(backoffDelay(30, () => 1)).toBe(BACKOFF_MAX_MS);
  });
  it('jitters: rng 0 gives the floor', () => {
    expect(backoffDelay(5, () => 0)).toBe(BACKOFF_MIN_MS);
  });
});

describe('retryAfterMs', () => {
  it('parses seconds and dates, ignores junk', () => {
    expect(retryAfterMs(new Headers({ 'retry-after': '30' }))).toBe(30_000);
    expect(
      retryAfterMs(new Headers({ 'retry-after': new Date(10_000).toUTCString() }), 4_000),
    ).toBe(6_000);
    expect(retryAfterMs(new Headers({ 'retry-after': 'soon' }))).toBeNull();
    expect(retryAfterMs(new Headers())).toBeNull();
  });
});

describe('joinUrl', () => {
  it.each([
    ['https://h', '/v1/x', 'https://h/v1/x'],
    ['https://h/', '/v1/x', 'https://h/v1/x'],
    ['https://h/api', '/v1/x', 'https://h/api/v1/x'],
    ['https://h/api/', 'v1/x', 'https://h/api/v1/x'],
    ['https://h/a/b', '/v1/integrations/status', 'https://h/a/b/v1/integrations/status'],
    ['http://localhost:3001', '/v1/x', 'http://localhost:3001/v1/x'],
  ])('%s + %s', (base, path, expected) => {
    expect(joinUrl(base, path)).toBe(expected);
  });
});

describe('HttpClient', () => {
  it('sends contract + user-agent headers and bearer only when given', async () => {
    let seen: Record<string, string> = {};
    const fetchFn = (_u: string, init?: RequestInit) => {
      seen = init?.headers as Record<string, string>;
      return Promise.resolve(new Response('{"ok":1}', { status: 200 }));
    };
    const c = new HttpClient({ baseUrl: 'https://x.test', fetch: fetchFn, userAgent: 'ua/1' });
    await c.post('/v1/a', {});
    expect(seen['x-vesseltwin-contract']).toBe('1');
    expect(seen['user-agent']).toBe('ua/1');
    expect(seen.authorization).toBeUndefined();
    await c.post('/v1/a', {}, { credential: 'vti_secretsecret1' });
    expect(seen.authorization).toBe('Bearer vti_secretsecret1');
  });

  it('never leaks the credential through errors', async () => {
    const fetchFn = () => Promise.reject(new Error('boom Authorization: Bearer vti_secretsecret1'));
    const c = new HttpClient({ baseUrl: 'https://x.test', fetch: fetchFn, userAgent: 'ua' });
    const err = await c
      .post('/v1/a', {}, { credential: 'vti_secretsecret1' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as Error).message).not.toContain('vti_secretsecret1');
  });

  it('times out', async () => {
    const fetchFn = (_u: string, init?: RequestInit) =>
      new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener('abort', () => {
          rej(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
    const c = new HttpClient({
      baseUrl: 'https://x.test',
      fetch: fetchFn,
      userAgent: 'ua',
      timeoutMs: 20,
    });
    await expect(c.post('/v1/a', {})).rejects.toThrow('timed out');
  });

  it('aborts when the caller signal fires and reports a cancellation', async () => {
    const fetchFn = (_u: string, init?: RequestInit) =>
      new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener('abort', () => {
          rej(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
    const c = new HttpClient({ baseUrl: 'https://x.test', fetch: fetchFn, userAgent: 'ua' });
    const ctl = new AbortController();
    const p = c.post('/v1/a', {}, { signal: ctl.signal });
    ctl.abort();
    await expect(p).rejects.toThrow('request cancelled');
  });

  it('keeps a base path when requesting', async () => {
    let seen = '';
    const fetchFn = (u: string) => {
      seen = u;
      return Promise.resolve(new Response('{}', { status: 200 }));
    };
    const c = new HttpClient({ baseUrl: 'https://h/api', fetch: fetchFn, userAgent: 'ua' });
    await c.post('/v1/integrations/pairing/start', {});
    expect(seen).toBe('https://h/api/v1/integrations/pairing/start');
  });
});

describe('HttpClient.get', () => {
  const capture = () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const fetchFn = (url: string, init?: RequestInit) => {
      seen.url = url;
      seen.init = init;
      return Promise.resolve(new Response('{"ok":1}', { status: 200 }));
    };
    return { seen, fetchFn };
  };

  it('sends no body and no content-type, keeps the standard headers', async () => {
    const { seen, fetchFn } = capture();
    const c = new HttpClient({ baseUrl: 'https://h/api', fetch: fetchFn, userAgent: 'ua/1' });
    const r = await c.get('/v1/integrations/status');
    expect(r.json).toEqual({ ok: 1 });
    expect(seen.url).toBe('https://h/api/v1/integrations/status');
    expect(seen.init?.method).toBe('GET');
    expect(seen.init?.body).toBeUndefined();
    const h = seen.init?.headers as Record<string, string>;
    expect(h['content-type']).toBeUndefined();
    expect(h['user-agent']).toBe('ua/1');
    expect(h['x-vesseltwin-contract']).toBe('1');
    expect(h.accept).toBe('application/json');
    expect(h.authorization).toBeUndefined();
  });

  it('sends Authorization only when a credential is given', async () => {
    const { seen, fetchFn } = capture();
    const c = new HttpClient({ baseUrl: 'https://h', fetch: fetchFn, userAgent: 'ua' });
    await c.get('/v1/a', { credential: 'vti_secretsecret1' });
    expect((seen.init?.headers as Record<string, string>).authorization).toBe(
      'Bearer vti_secretsecret1',
    );
  });

  it('times out, honors the caller signal and redacts errors', async () => {
    const hang = (_u: string, init?: RequestInit) =>
      new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener('abort', () => {
          rej(Object.assign(new Error('aborted vti_secretsecret1'), { name: 'AbortError' }));
        });
      });
    const c = new HttpClient({ baseUrl: 'https://h', fetch: hang, userAgent: 'ua', timeoutMs: 20 });
    await expect(c.get('/v1/a')).rejects.toThrow('timed out');
    const ctl = new AbortController();
    const p = new HttpClient({ baseUrl: 'https://h', fetch: hang, userAgent: 'ua' }).get('/v1/a', {
      signal: ctl.signal,
    });
    ctl.abort();
    await expect(p).rejects.toThrow('request cancelled');
    const boom = new HttpClient({
      baseUrl: 'https://h',
      fetch: () => Promise.reject(new Error('Authorization: Bearer vti_secretsecret1')),
      userAgent: 'ua',
    });
    const err = await boom
      .get('/v1/a', { credential: 'vti_secretsecret1' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as Error).message).not.toContain('vti_secretsecret1');
  });

  it('returns null json for a non-JSON body', async () => {
    const c = new HttpClient({
      baseUrl: 'https://h',
      fetch: () => Promise.resolve(new Response('<html>', { status: 502 })),
      userAgent: 'ua',
    });
    expect((await c.get('/v1/a')).json).toBeNull();
  });
});

describe('isRetryableStatus and errorCode', () => {
  it('classifies by status plus code', () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(502, 'x')).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(503, 'integration_feature_unavailable')).toBe(false);
    expect(isRetryableStatus(401)).toBe(false);
    expect(isRetryableStatus(403, 'integration_paused_plan')).toBe(false);
    expect(isRetryableStatus(426)).toBe(false);
    expect(isRetryableStatus(200)).toBe(false);
  });
  it('reads code or error from a JSON body', () => {
    expect(errorCode({ code: 'integration_scope' })).toBe('integration_scope');
    expect(errorCode({ error: 'slow_down' })).toBe('slow_down');
    expect(errorCode(null)).toBeNull();
    expect(errorCode('x')).toBeNull();
    expect(errorCode({ code: 5 })).toBeNull();
  });
});
