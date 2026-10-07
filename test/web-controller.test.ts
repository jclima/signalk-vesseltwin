import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BACKOFF_MAX_MS,
  BACKOFF_MIN_MS,
  FAST_POLL_MS,
  NOTICE_PAIR_FAILED,
  NOTICE_UNPAIR_FAILED,
  PairingController,
  SLOW_POLL_MS,
  STARTING_TIMEOUT_MS,
  errorBackoffMs,
  type FetchInitLike,
  type FetchResponseLike,
  type Snapshot,
} from '../web/controller.js';

interface Call {
  url: string;
  init: FetchInitLike;
}
type Reply = { status: number; body?: unknown; nonJson?: boolean } | 'network';

const BASE = '/plugins/signalk-vesseltwin';

function status(state: string, extra: Record<string, unknown> = {}) {
  return { state, paired: false, message: 'm', ...extra };
}

function setup() {
  const calls: Call[] = [];
  const replies = new Map<string, Reply[]>();
  const fallback = new Map<string, Reply>();
  const reply = (key: string, ...r: Reply[]) => replies.set(key, r);
  const always = (key: string, r: Reply) => fallback.set(key, r);
  let hidden = false;
  const snaps: Snapshot[] = [];
  const fetchFn = (url: string, init: FetchInitLike): Promise<FetchResponseLike> => {
    calls.push({ url, init });
    const key = `${init.method ?? 'GET'} ${url.slice(BASE.length)}`;
    const r = replies.get(key)?.shift() ?? fallback.get(key) ?? { status: 404 };
    if (r === 'network') return Promise.reject(new Error('boom'));
    return Promise.resolve({
      status: r.status,
      json: () =>
        r.nonJson ? Promise.reject(new Error('not json')) : Promise.resolve(r.body ?? null),
    });
  };
  const c = new PairingController({
    fetch: fetchFn,
    timers: {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => {
        clearTimeout(h as ReturnType<typeof setTimeout>);
      },
    },
    isHidden: () => hidden,
    now: () => Date.now(),
    onChange: (s) => snaps.push(s),
  });
  const gets = () => calls.filter((x) => x.url.endsWith('/status')).length;
  return {
    c,
    calls,
    reply,
    always,
    snaps,
    gets,
    setHidden: (v: boolean) => {
      hidden = v;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('polling', () => {
  it('polls /status with same-origin, no-store, error-on-redirect and no body', async () => {
    const t = setup();
    t.always('GET /status', { status: 200, body: status('not_paired') });
    t.c.start();
    await vi.advanceTimersByTimeAsync(0);
    const first = t.calls[0];
    expect(first?.url).toBe(`${BASE}/status`);
    expect(first?.init).toEqual({
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
    });
    expect(t.c.snapshot().status?.state).toBe('not_paired');
    t.c.stop();
  });

  it('polls every 2 s while pairing or checking and every 15 s otherwise', async () => {
    const t = setup();
    t.always('GET /status', { status: 200, body: status('pairing') });
    t.c.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.gets()).toBe(1);
    await vi.advanceTimersByTimeAsync(FAST_POLL_MS);
    expect(t.gets()).toBe(2);
    await vi.advanceTimersByTimeAsync(FAST_POLL_MS * 3);
    expect(t.gets()).toBe(5);
    t.always('GET /status', { status: 200, body: status('checking') });
    await vi.advanceTimersByTimeAsync(FAST_POLL_MS * 2);
    expect(t.gets()).toBe(7);
    t.always('GET /status', { status: 200, body: status('connected', { paired: true }) });
    await vi.advanceTimersByTimeAsync(FAST_POLL_MS);
    const afterConnected = t.gets();
    await vi.advanceTimersByTimeAsync(SLOW_POLL_MS - 1);
    expect(t.gets()).toBe(afterConnected);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.gets()).toBe(afterConnected + 1);
    t.c.stop();
  });

  it('pauses while hidden and resumes at once when visible', async () => {
    const t = setup();
    t.always('GET /status', { status: 200, body: status('pairing') });
    t.c.start();
    await vi.advanceTimersByTimeAsync(0);
    t.setHidden(true);
    t.c.visibilityChanged();
    const n = t.gets();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(t.gets()).toBe(n);
    t.setHidden(false);
    t.c.visibilityChanged();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.gets()).toBe(n + 1);
    await vi.advanceTimersByTimeAsync(FAST_POLL_MS);
    expect(t.gets()).toBe(n + 2);
    t.c.stop();
  });

  it('does not poll at all when started hidden', async () => {
    const t = setup();
    t.setHidden(true);
    t.c.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.gets()).toBe(0);
    t.c.stop();
  });

  it('backs off 2 s to 30 s on errors and recovers', async () => {
    const t = setup();
    t.always('GET /status', 'network');
    t.c.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.c.snapshot().problem?.kind).toBe('unreachable');
    const waits: number[] = [];
    let last = t.gets();
    let elapsed = 0;
    while (waits.length < 7) {
      await vi.advanceTimersByTimeAsync(1000);
      elapsed += 1000;
      if (t.gets() !== last) {
        waits.push(elapsed);
        elapsed = 0;
        last = t.gets();
      }
    }
    expect(waits).toEqual([2000, 4000, 8000, 16000, 30000, 30000, 30000]);
    t.always('GET /status', { status: 200, body: status('not_paired') });
    await vi.advanceTimersByTimeAsync(BACKOFF_MAX_MS);
    expect(t.c.snapshot().problem).toBeNull();
    expect(t.c.snapshot().status?.state).toBe('not_paired');
    t.c.stop();
  });

  it('errorBackoffMs stays within bounds for any input (property style)', () => {
    for (const n of [0, 1, 2, 3, 5, 50, 1e9, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      const v = errorBackoffMs(n);
      expect(v).toBeGreaterThanOrEqual(BACKOFF_MIN_MS);
      expect(v).toBeLessThanOrEqual(BACKOFF_MAX_MS);
    }
  });

  it('maps 401, 403, 503, 404 and non-JSON answers', async () => {
    const t = setup();
    const cases: [Reply, string][] = [
      [{ status: 401, body: { error: 'x' } }, 'signin'],
      [{ status: 403, body: {} }, 'forbidden'],
      [{ status: 503, body: { error: 'Enable it first.' } }, 'unavailable'],
      [{ status: 404 }, 'unreachable'],
      [{ status: 200, nonJson: true }, 'unreachable'],
    ];
    for (const [r, kind] of cases) {
      t.always('GET /status', r);
      await t.c.refresh();
      expect(t.c.snapshot().problem?.kind, kind).toBe(kind);
    }
    t.c.stop();
  });

  it('keeps polling slowly on 503', async () => {
    const t = setup();
    t.always('GET /status', { status: 503, body: { error: 'Enable it first.' } });
    t.c.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.c.snapshot().problem?.message).toBe('Enable it first.');
    const n = t.gets();
    await vi.advanceTimersByTimeAsync(SLOW_POLL_MS - 1);
    expect(t.gets()).toBe(n);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.gets()).toBe(n + 1);
    t.c.stop();
  });

  it('ignores a result that arrives after stop()', async () => {
    const t = setup();
    t.always('GET /status', { status: 200, body: status('connected') });
    t.c.start();
    t.c.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.c.snapshot().status).toBeNull();
    expect(t.gets()).toBe(1);
  });
});

describe('actions', () => {
  it('pair posts with no body, then polls fast, and holds the starting flag', async () => {
    const t = setup();
    t.always('GET /status', { status: 200, body: status('not_paired') });
    t.reply('POST /pair', { status: 202, body: { started: true } });
    t.c.start();
    await vi.advanceTimersByTimeAsync(0);
    await t.c.pair();
    const post = t.calls.find((x) => x.init.method === 'POST');
    expect(post?.url).toBe(`${BASE}/pair`);
    expect(post?.init).toEqual({
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
    });
    expect(Object.keys(post?.init ?? {})).not.toContain('body');
    // The plugin still reports not_paired in the window before the code exists.
    expect(t.c.snapshot().starting).toBe(true);
    t.always('GET /status', { status: 200, body: status('pairing') });
    await vi.advanceTimersByTimeAsync(FAST_POLL_MS);
    expect(t.c.snapshot().starting).toBe(false);
    expect(t.c.snapshot().status?.state).toBe('pairing');
    t.c.stop();
  });

  it('gives up waiting for a code after the starting timeout', async () => {
    const t = setup();
    t.always('GET /status', { status: 200, body: status('not_paired') });
    t.reply('POST /pair', { status: 202 });
    await t.c.pair();
    expect(t.c.snapshot().starting).toBe(true);
    t.c.start();
    await vi.advanceTimersByTimeAsync(STARTING_TIMEOUT_MS + FAST_POLL_MS);
    expect(t.c.snapshot().starting).toBe(false);
    t.c.stop();
  });

  it('refreshes on 409 and reports other failures', async () => {
    const t = setup();
    t.always('GET /status', { status: 200, body: status('connected', { paired: true }) });
    t.reply('POST /pair', { status: 409, body: { error: 'x' } });
    await t.c.pair();
    expect(t.c.snapshot().notice).toBeNull();
    expect(t.c.snapshot().starting).toBe(false);
    expect(t.c.snapshot().status?.state).toBe('connected');
    t.reply('POST /pair', { status: 500 });
    await t.c.pair();
    expect(t.c.snapshot().notice).toBe(NOTICE_PAIR_FAILED);
    t.reply('POST /pair', 'network');
    await t.c.pair();
    expect(t.c.snapshot().notice).toBe('Cannot reach the plugin.');
    t.reply('POST /pair', { status: 401 });
    await t.c.pair();
    expect(t.c.snapshot().notice).toContain('administrator');
    expect(t.c.snapshot().busy).toBe(false);
  });

  it('cancel posts to /pair/cancel and refreshes', async () => {
    const t = setup();
    t.always('GET /status', { status: 200, body: status('not_paired') });
    t.reply('POST /pair/cancel', { status: 200, body: { cancelled: true } });
    await t.c.cancel();
    expect(t.calls.some((x) => x.url === `${BASE}/pair/cancel` && x.init.method === 'POST')).toBe(
      true,
    );
    expect(t.c.snapshot().status?.state).toBe('not_paired');
    expect(t.c.snapshot().starting).toBe(false);
  });

  it('unpair needs a second, explicit confirmation', async () => {
    const t = setup();
    t.always('GET /status', { status: 200, body: status('connected', { paired: true }) });
    t.always('POST /unpair', { status: 200, body: { paired: false } });
    await t.c.refresh();
    await t.c.confirmUnpair(); // no first step: nothing is sent
    expect(t.calls.some((x) => x.url.endsWith('/unpair'))).toBe(false);
    t.c.requestUnpair();
    expect(t.c.snapshot().confirmingUnpair).toBe(true);
    expect(t.calls.some((x) => x.url.endsWith('/unpair'))).toBe(false);
    t.c.dismissUnpair();
    await t.c.confirmUnpair();
    expect(t.calls.some((x) => x.url.endsWith('/unpair'))).toBe(false);
    t.c.requestUnpair();
    t.always('GET /status', { status: 200, body: status('not_paired') });
    await t.c.confirmUnpair();
    expect(t.calls.filter((x) => x.url.endsWith('/unpair')).length).toBe(1);
    expect(t.c.snapshot().confirmingUnpair).toBe(false);
    expect(t.c.snapshot().status?.state).toBe('not_paired');
  });

  it('unpair failure shows a notice and clears the confirmation', async () => {
    const t = setup();
    t.always('GET /status', { status: 200, body: status('connected', { paired: true }) });
    t.always('POST /unpair', { status: 500, body: { error: 'x' } });
    await t.c.refresh();
    t.c.requestUnpair();
    await t.c.confirmUnpair();
    expect(t.c.snapshot().notice).toBe(NOTICE_UNPAIR_FAILED);
    expect(t.c.snapshot().confirmingUnpair).toBe(false);
  });

  it('refuses to ask for unpair when the state has no such button', async () => {
    const t = setup();
    t.always('GET /status', { status: 200, body: status('not_paired') });
    await t.c.refresh();
    t.c.requestUnpair();
    expect(t.c.snapshot().confirmingUnpair).toBe(false);
  });

  it('drops the confirmation when the state no longer offers unpair', async () => {
    const t = setup();
    t.always('GET /status', { status: 200, body: status('connected', { paired: true }) });
    await t.c.refresh();
    t.c.requestUnpair();
    t.always('GET /status', { status: 200, body: status('not_paired') });
    await t.c.refresh();
    expect(t.c.snapshot().confirmingUnpair).toBe(false);
  });

  it('never calls console', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    const t = setup();
    t.always('GET /status', 'network');
    t.reply('POST /pair', 'network');
    await t.c.refresh();
    await t.c.pair();
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    spies.forEach((s) => {
      s.mockRestore();
    });
  });
});
