import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseOptions } from '../src/config';
import { categoryFor, PATH_RULES } from '../src/mapping';
import { CredentialStore } from '../src/credential-store';
import {
  COPY,
  createPlugin,
  FAILURE_COPY,
  PLUGIN_VERSION,
  type RequestLike,
  type ResponseLike,
  type SignalKApp,
} from '../src/plugin';

const tempDirs: string[] = [];
const tempDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'vt-plugin-'));
  tempDirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 });
});

const fakeApp = (dir: string): SignalKApp & { statuses: string[] } => {
  const statuses: string[] = [];
  return {
    statuses,
    getDataDirPath: () => dir,
    getSelfPath: () => undefined,
    setPluginStatus: (m) => statuses.push(m),
    setPluginError: (m) => statuses.push(`ERR ${m}`),
    debug: vi.fn(),
    error: vi.fn(),
  };
};

describe('plugin shell', () => {
  it('exposes the SignalK plugin shape and reports unpaired status', async () => {
    const app = fakeApp(tempDir());
    const p = createPlugin(app);
    expect(p.id).toBe('signalk-vesseltwin');
    expect(p.schema().properties.apiBaseUrl.default).toBe('https://api.vesseltwin.io');
    p.start({});
    await vi.waitFor(() => {
      expect(app.statuses.at(-1)).toMatch(/Not paired/);
    });
    p.stop();
  });

  it('shows neutral busy copy when pairing is throttled', async () => {
    const app = fakeApp(tempDir());
    const fetchFn = () =>
      Promise.resolve(new Response('{}', { status: 429, headers: { 'retry-after': '60' } }));
    const p = createPlugin(app, { fetch: fetchFn });
    p.start({});
    const routes: Record<string, () => void | Promise<void>> = {};
    const res = { status: () => res, json: () => undefined };
    p.registerWithRouter({
      get: () => undefined,
      post: (path, h) => {
        routes[path] = () => h({}, res);
      },
    });
    await vi.waitFor(() => {
      expect(app.statuses.at(-1)).toMatch(/Not paired/);
    });
    await routes['/pair']?.();
    await vi.waitFor(() => {
      expect(app.statuses.at(-1)).toBe(
        'ERR VesselTwin is busy. Try pairing again in a few minutes.',
      );
    });
    p.stop();
  });

  it('collects nothing yet: mapping registry is empty', () => {
    expect(PATH_RULES).toHaveLength(0);
    expect(categoryFor('navigation.position')).toBeNull();
  });
});

describe('PLUGIN_VERSION', () => {
  it('matches package.json', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as {
      version: string;
    };
    expect(PLUGIN_VERSION).toBe(pkg.version);
  });
});

describe('parseOptions', () => {
  it('defaults safely, flags non-https remote URLs and clamps the queue cap', () => {
    const d = parseOptions(undefined);
    expect(d.apiBaseUrl).toBe('https://api.vesseltwin.io');
    expect(d.categories.vesselInfo).toBe(false);
    expect(parseOptions({ apiBaseUrl: 'http://evil.example' }).apiBaseUrl).toBeNull();
    expect(parseOptions({ apiBaseUrl: 'http://localhost:3001' }).apiBaseUrl).toBe(
      'http://localhost:3001',
    );
    expect(parseOptions({ queueMaxReadings: 10 ** 9 }).queueMaxReadings).toBe(50_000);
  });
});

// ---- pairing lifecycle and route hardening -------------------------------------------------

const realSetTimeout = setTimeout;
const realPause = (ms: number) =>
  new Promise<void>((r) => {
    realSetTimeout(r, ms);
  });

const FAKE_CRED = `vti_${'F'.repeat(43)}`;
const tokenBody = {
  credential: FAKE_CRED,
  credentialId: 'cid-1',
  scopes: ['meters:write'],
  vesselLabel: 'Sea Hag',
  provider: 'signalk',
};

interface Deferred {
  resolve: (r: Response) => void;
}

const okStatusBody = () => ({
  provider: 'signalk',
  minContract: 1,
  latestContract: 1,
  pluginUpdateRecommended: false,
  serverTime: new Date().toISOString(),
  summary: null,
});

function harness(opts: { dir?: string } = {}) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const dir = opts.dir ?? tempDir();
  const app = fakeApp(dir);
  const calls: string[] = [];
  const held: Deferred[] = [];
  let starts = 0;
  /** Replies for GET /v1/integrations/status, consumed in order; then a healthy 200. */
  const statusReplies: (() => Response)[] = [];
  const fetchFn = (url: string): Promise<Response> => {
    calls.push(url);
    if (url.endsWith('/v1/integrations/status')) {
      const r = statusReplies.shift();
      return Promise.resolve(
        r ? r() : new Response(JSON.stringify(okStatusBody()), { status: 200 }),
      );
    }
    if (url.endsWith('/pairing/start')) {
      starts += 1;
      const code = starts === 1 ? 'AAAA-AAAA' : 'BBBB-BBBB';
      return Promise.resolve(
        new Response(
          JSON.stringify({
            deviceCode: `dc_${code}_abcdefghijklmnop`,
            userCode: code,
            verificationUrl: 'https://vesseltwin.io/connect',
            interval: 5,
            expiresIn: 600,
          }),
          { status: 200 },
        ),
      );
    }
    return new Promise<Response>((resolve) => {
      held.push({ resolve });
    });
  };
  const plugin = createPlugin(app, { fetch: fetchFn });
  const routes: Record<string, RouteFn> = {};
  plugin.registerWithRouter({
    get: (p, h) => {
      routes[`GET ${p}`] = h;
    },
    post: (p, h) => {
      routes[`POST ${p}`] = h;
    },
  });
  const call = async (route: string, headers?: Record<string, string>) => {
    let status = 200;
    let body: unknown;
    const res: ResponseLike = {
      status: (c) => {
        status = c;
        return res;
      },
      json: (b) => {
        body = b;
      },
    };
    await routes[route]?.({ ...(headers ? { headers } : {}) }, res);
    return { status, body: body as Record<string, unknown> };
  };
  // Fake timers drive the poll loop; real file I/O needs a real pause to settle.
  const tick = async (ms = 0) => {
    await vi.advanceTimersByTimeAsync(ms);
    await realPause(40);
  };
  /** Poll until `cond` holds (real fs I/O has no fixed completion time); bounded, no fixed sleep. */
  const until = async (cond: () => boolean | Promise<boolean>) => {
    for (let i = 0; i < 200; i++) {
      if (await cond()) return;
      await tick();
    }
    throw new Error('condition not reached');
  };
  const untilState = (state: string) =>
    until(async () => (await call('GET /status')).body.state === state);
  /** Answer the first held (pairing poll) request once it has actually been issued. */
  const resolveHeld = async (r: Response) => {
    await until(() => held.length > 0);
    held[0]?.resolve(r);
  };
  const ok = () => new Response(JSON.stringify(tokenBody), { status: 200 });
  const files = () => readdirSync(dir);
  /** Wait for in-flight temp-file writes to settle, then assert the directory listing. */
  const untilFiles = async (expected: string[]) => {
    await until(() => JSON.stringify(readdirSync(dir)) === JSON.stringify(expected));
    expect(readdirSync(dir)).toEqual(expected);
  };
  const statusCalls = () => calls.filter((u) => u.endsWith('/v1/integrations/status')).length;
  return {
    app,
    plugin,
    call,
    tick,
    until,
    untilState,
    untilFiles,
    resolveHeld,
    calls,
    held,
    ok,
    files,
    dir,
    statusReplies,
    statusCalls,
  };
}
type RouteFn = (req: RequestLike, res: ResponseLike) => void | Promise<void>;

afterEach(() => {
  vi.useRealTimers();
});

describe('pairing lifecycle', () => {
  it('pairs end to end: 0600 credential bound to the API origin, label shown, code only while pending', async () => {
    const h = harness();
    h.plugin.start({});
    await h.tick();
    expect((await h.call('POST /pair')).status).toBe(202);
    await h.tick();
    expect((await h.call('GET /status')).body).toMatchObject({
      state: 'pairing',
      paired: false,
      pairing: { userCode: 'AAAA-AAAA', verificationUrl: 'https://vesseltwin.io/connect' },
    });
    await h.tick(5_000);
    await h.resolveHeld(h.ok());
    await h.untilState('connected');
    expect((await h.call('GET /status')).body).toMatchObject({
      state: 'connected',
      paired: true,
      vesselLabel: 'Sea Hag',
      apiOrigin: 'https://api.vesseltwin.io',
      pairing: null,
    });
    expect(h.statusCalls()).toBe(1); // probe right after pairing
    const file = join(h.dir, 'credential.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({
      credential: FAKE_CRED,
      apiOrigin: 'https://api.vesseltwin.io',
    });
    expect(h.app.statuses.at(-1)).toBe(
      'Paired with Sea Hag. Data upload is not available in this version.',
    );
    expect(h.app.statuses).toContain(COPY.pairingInProgress);
    // The status line is broadcast to anonymous clients: it never carries the code or the URL.
    for (const line of h.app.statuses) {
      expect(line).not.toContain('AAAA-AAAA');
      expect(line).not.toContain('vesseltwin.io/connect');
    }
    expect(h.app.statuses.join('\n')).not.toContain(FAKE_CRED);
    h.plugin.stop();
  });

  it('never reports not_paired while the approved credential is still being saved', async () => {
    const h = harness();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    // eslint-disable-next-line @typescript-eslint/unbound-method -- re-bound via .call(this)
    const realWrite = CredentialStore.prototype.write;
    const spy = vi.spyOn(CredentialStore.prototype, 'write').mockImplementation(async function (
      this: CredentialStore,
      c,
    ) {
      await gate;
      return realWrite.call(this, c);
    });
    try {
      h.plugin.start({});
      await h.tick();
      await h.call('POST /pair');
      await h.tick(5_000);
      await h.resolveHeld(h.ok());
      await h.until(() => spy.mock.calls.length > 0); // the save is now held open
      const mid = (await h.call('GET /status')).body;
      expect(mid.state).toBe('checking');
      expect(mid.pairing).toBeNull();
      expect(String(mid.message)).not.toContain('AAAA-AAAA');
      expect(String(mid.message)).not.toContain(FAKE_CRED);
      await h.untilFiles([]);
      release();
      await h.untilState('connected');
      expect((await h.call('GET /status')).body).toMatchObject({ paired: true });
      h.plugin.stop();
    } finally {
      release();
      spy.mockRestore();
    }
  });

  it('shows distinct local-failure copy when the token response is malformed', async () => {
    const h = harness();
    h.plugin.start({});
    await h.tick();
    await h.call('POST /pair');
    await h.tick(5_000);
    await h.resolveHeld(new Response(JSON.stringify({ credential: 'bad' }), { status: 200 }));
    await h.untilState('pairing_failed');
    const st = (await h.call('GET /status')).body;
    expect(st.pairing).toEqual({ reason: 'local_failure' });
    expect(st.message).toBe(FAILURE_COPY.local_failure);
    expect(FAILURE_COPY.local_failure).not.toBe(FAILURE_COPY.unavailable);
    expect(String(st.message)).not.toMatch(/AAAA-AAAA|vesseltwin\.io\/connect/);
    h.plugin.stop();
  });

  it('shows distinct local-failure copy when the credential cannot be saved, without logging it', async () => {
    const h = harness();
    const spy = vi
      .spyOn(CredentialStore.prototype, 'write')
      .mockRejectedValue(new Error(`EACCES ${FAKE_CRED}`));
    try {
      h.plugin.start({});
      await h.tick();
      await h.call('POST /pair');
      await h.tick(5_000);
      await h.resolveHeld(h.ok());
      await h.untilState('pairing_failed');
      const st = (await h.call('GET /status')).body;
      expect(st).toMatchObject({ paired: false, pairing: { reason: 'local_failure' } });
      expect(st.message).toBe(FAILURE_COPY.local_failure);
      const logged = (h.app.debug as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
      expect(logged.join('\n')).not.toContain(FAKE_CRED);
      expect(h.app.statuses.join('\n')).not.toContain(FAKE_CRED);
      h.plugin.stop();
    } finally {
      spy.mockRestore();
    }
  });

  it('unpair during a pending pairing wins over a late approval', async () => {
    const h = harness();
    h.plugin.start({});
    await h.tick();
    await h.call('POST /pair');
    await h.tick(5_000); // token poll now in flight
    expect(h.held).toHaveLength(1);
    const un = await h.call('POST /unpair');
    expect(un.status).toBe(200);
    expect(String(un.body.message)).toMatch(/revoke the connection in VesselTwin/);
    await h.resolveHeld(h.ok());
    await h.tick();
    await h.untilFiles([]);
    expect((await h.call('GET /status')).body).toMatchObject({
      state: 'not_paired',
      paired: false,
      pairing: null,
    });
    // The revoke reminder stays in the status line after an unpair.
    expect(h.app.statuses.at(-1)).toBe(COPY.unpaired);
    expect(h.statusCalls()).toBe(0);
    h.plugin.stop();
  });

  it('answers 500 with neutral copy when the credential cannot be removed', async () => {
    const dir = tempDir();
    const h = harness({ dir });
    h.plugin.start({});
    await h.tick();
    // Make credential.json a non-empty directory so removal fails.
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(dir, 'credential.json'));
    await writeFile(join(dir, 'credential.json', 'x'), '1');
    const r = await h.call('POST /unpair');
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).not.toMatch(/ENOTEMPTY|EISDIR|credential\.json|\/tmp|\/var/);
    h.plugin.stop();
  });

  it('stop() while the token POST is in flight leaves no credential', async () => {
    const h = harness();
    h.plugin.start({});
    await h.tick();
    await h.call('POST /pair');
    await h.tick(5_000);
    expect(h.held).toHaveLength(1);
    h.plugin.stop();
    await h.resolveHeld(h.ok());
    await h.tick();
    await h.untilFiles([]);
  });

  it('a stale run cannot disturb a restarted one; duplicate /pair is a no-op; stop() cancels it', async () => {
    const h = harness();
    h.plugin.start({});
    await h.tick();
    await h.call('POST /pair'); // run A, sleeping
    await h.tick();
    h.plugin.stop();
    h.plugin.start({});
    await h.tick();
    await h.call('POST /pair'); // run B
    await h.tick();
    const startsBefore = h.calls.filter((u) => u.endsWith('/pairing/start')).length;
    expect(startsBefore).toBe(2);
    await h.tick(5_000); // A wakes (cancelled), B polls
    expect((await h.call('GET /status')).body).toMatchObject({
      pairing: { userCode: 'BBBB-BBBB' },
    });
    expect(h.held).toHaveLength(1); // only B reached the token endpoint
    const before = h.calls.length;
    expect((await h.call('POST /pair')).status).toBe(202);
    await h.tick();
    expect(h.calls.length).toBe(before); // no extra pairing/start
    h.plugin.stop();
    await h.resolveHeld(h.ok());
    await h.tick();
    await h.untilFiles([]);
  });

  it('refuses /pair when already paired, with no pairing requests', async () => {
    const dir = tempDir();
    await writeFile(
      join(dir, 'credential.json'),
      JSON.stringify({
        credential: FAKE_CRED,
        credentialId: 'c',
        apiOrigin: 'https://api.vesseltwin.io',
      }),
    );
    const h = harness({ dir });
    h.plugin.start({});
    await h.tick();
    expect((await h.call('GET /status')).body.paired).toBe(true);
    expect((await h.call('POST /pair')).status).toBe(409);
    expect(h.calls.filter((u) => u.includes('/pairing/'))).toEqual([]);
    h.plugin.stop();
  });

  it('refuses /pair when the plugin is not started, with no requests', async () => {
    const h = harness();
    expect((await h.call('POST /pair')).status).toBe(503);
    h.plugin.start({});
    h.plugin.stop();
    expect((await h.call('POST /pair')).status).toBe(503);
    expect(h.calls).toEqual([]);
  });
});

describe('origin check', () => {
  it('rejects a cross-origin browser request on every route, allows same-origin and none', async () => {
    const h = harness();
    h.plugin.start({});
    await h.tick();
    const evil = { origin: 'https://evil.example', host: 'boat:3000' };
    for (const r of ['GET /status', 'POST /pair', 'POST /unpair']) {
      const out = await h.call(r, evil);
      expect(out.status).toBe(403);
      expect(JSON.stringify(out.body)).not.toMatch(/evil|origin/i);
    }
    expect((await h.call('POST /pair', { origin: 'null', host: 'boat:3000' })).status).toBe(403);
    expect(h.calls).toEqual([]);
    expect(
      (await h.call('GET /status', { origin: 'http://boat:3000', host: 'boat:3000' })).status,
    ).toBe(200);
    expect((await h.call('GET /status')).status).toBe(200);
    expect((await h.call('POST /pair')).status).toBe(202);
    h.plugin.stop();
  });
});

describe('label and token handling', () => {
  it('takes the vessel label only from the server response, cleaned', async () => {
    const h = harness();
    const asked: string[] = [];
    h.app.getSelfPath = (p: string) => {
      asked.push(p);
      return p === 'name' ? 'SIGNALK VESSEL NAME' : undefined;
    };
    h.plugin.start({});
    await h.tick();
    await h.call('POST /pair');
    await h.tick(5_000);
    await h.resolveHeld(
      new Response(
        JSON.stringify({ ...tokenBody, vesselLabel: `Sea\u0007Hag\n${'x'.repeat(200)}` }),
        {
          status: 200,
        },
      ),
    );
    await h.untilState('connected');
    const line = h.app.statuses.at(-1) ?? '';
    expect(line).toMatch(/^Paired with Sea Hag x+\. /);
    expect(line).not.toContain('SIGNALK VESSEL NAME');
    expect(line.length).toBeLessThan(140);
    expect(asked).not.toContain('name');
    expect(asked.every((p) => p === 'uuid')).toBe(true);
    h.plugin.stop();
  });

  it('falls back to neutral copy when the server sends no label', async () => {
    const h = harness();
    h.plugin.start({});
    await h.tick();
    await h.call('POST /pair');
    await h.tick(5_000);
    await h.resolveHeld(
      new Response(JSON.stringify({ ...tokenBody, vesselLabel: null }), { status: 200 }),
    );
    await h.untilState('connected');
    expect(h.app.statuses.at(-1)).toBe(
      'Paired with VesselTwin. Data upload is not available in this version.',
    );
    h.plugin.stop();
  });

  it('does not store a malformed credential', async () => {
    const h = harness();
    h.plugin.start({});
    await h.tick();
    await h.call('POST /pair');
    await h.tick(5_000);
    await h.resolveHeld(
      new Response(JSON.stringify({ ...tokenBody, credential: 'vti_short' }), { status: 200 }),
    );
    await h.until(() => /^ERR /.test(h.app.statuses.at(-1) ?? ''));
    await h.untilFiles([]);
    expect(h.app.statuses.at(-1)).toMatch(/^ERR /);
    h.plugin.stop();
  });
});

describe('origin check without an Origin header', () => {
  it('lets curl and scripts through (no Origin, no Host)', async () => {
    const h = harness();
    h.plugin.start({});
    await h.tick();
    expect((await h.call('GET /status')).status).toBe(200);
    expect((await h.call('GET /status', { 'user-agent': 'curl/8' })).status).toBe(200);
    h.plugin.stop();
  });
});

describe('config error', () => {
  it('reports a neutral error and makes no network calls for an invalid API URL', async () => {
    const h = harness();
    h.plugin.start({ apiBaseUrl: 'http://evil.example' });
    await h.tick();
    expect(h.app.statuses.at(-1)).toMatch(/^ERR The VesselTwin API URL .* not valid/);
    const r = await h.call('POST /pair');
    expect(r.status).toBe(503);
    await h.tick(10_000);
    expect(h.calls).toEqual([]);
    h.plugin.stop();
  });

  it('pairs through a base path in the API URL', async () => {
    const h = harness();
    h.plugin.start({ apiBaseUrl: 'https://h.example/api' });
    await h.tick();
    await h.call('POST /pair');
    await h.tick();
    expect(h.calls[0]).toBe('https://h.example/api/v1/integrations/pairing/start');
    h.plugin.stop();
  });
});

describe('pairing failure copy', () => {
  async function run(startReply: () => Response) {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const app = fakeApp(tempDir());
    const plugin = createPlugin(app, { fetch: () => Promise.resolve(startReply()) });
    const routes: Record<string, RouteFn> = {};
    plugin.registerWithRouter({
      get: () => undefined,
      post: (p, h) => {
        routes[p] = h;
      },
    });
    plugin.start({});
    await vi.advanceTimersByTimeAsync(0);
    await realPause(40);
    const res: ResponseLike = { status: () => res, json: () => undefined };
    await routes['/pair']?.({}, res);
    await vi.advanceTimersByTimeAsync(0);
    await realPause(40);
    plugin.stop();
    return app.statuses.at(-1) ?? '';
  }
  const j = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status });

  it('contract unsupported asks for a plugin update', async () => {
    expect(await run(j(400, { code: 'integration_contract_unsupported' }))).toBe(
      'ERR This plugin version is not supported by VesselTwin. Update the plugin.',
    );
  });
  it('other 400s say pairing could not start, without raw codes', async () => {
    const m = await run(j(400, { code: 'integration_scope_invalid' }));
    expect(m).toMatch(/could not start pairing/);
    expect(m).not.toMatch(/integration_/);
  });
  it('503 says try again later', async () => {
    expect(await run(j(503, { code: 'integration_feature_unavailable' }))).toBe(
      'ERR VesselTwin is not available right now. Try again later.',
    );
  });
  it('a network failure says try again later and leaks nothing', async () => {
    const m = await run(() => {
      throw new Error('boom');
    });
    expect(m).toBe('ERR VesselTwin is not available right now. Try again later.');
  });
});

describe('expired and denied copy', () => {
  it('expired hints the integration may not be enabled yet; denied is neutral', async () => {
    for (const [error, re] of [
      ['expired_token', /may not be enabled for your account yet/],
      ['access_denied', /declined in VesselTwin/],
    ] as const) {
      const h = harness();
      h.plugin.start({});
      await h.tick();
      await h.call('POST /pair');
      await h.tick(5_000);
      await h.resolveHeld(new Response(JSON.stringify({ error }), { status: 400 }));
      await h.tick();
      expect(h.app.statuses.at(-1)).toMatch(re);
      expect(h.app.statuses.at(-1)).not.toMatch(/expired_token|access_denied/);
      h.plugin.stop();
    }
  });
});

// ---- state machine -------------------------------------------------------------------------

const ORIGIN = 'https://api.vesseltwin.io';
const NO_UPLOAD = 'Data upload is not available in this version.';
const MIN = 60_000;

async function seed(dir: string, over: Record<string, unknown> = {}) {
  await writeFile(
    join(dir, 'credential.json'),
    JSON.stringify({
      credential: FAKE_CRED,
      credentialId: 'c0',
      vesselLabel: 'Sea Hag',
      pairedAt: '2030-01-01T00:00:00.000Z',
      apiOrigin: ORIGIN,
      ...over,
    }),
  );
}
const reply =
  (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
  () =>
    new Response(JSON.stringify(body), { status, headers });

describe('state machine', () => {
  it('full flow: pending, paired, probe ok, 401 reauth_required, re-pair succeeds', async () => {
    const h = harness();
    h.plugin.start({});
    await h.tick();
    expect((await h.call('GET /status')).body).toMatchObject({
      state: 'not_paired',
      paired: false,
    });

    await h.call('POST /pair');
    await h.tick();
    expect(h.app.statuses.at(-1)).toBe(COPY.pairingInProgress);
    await h.tick(5_000);
    await h.resolveHeld(h.ok());
    await h.untilState('connected');
    expect(h.statusCalls()).toBe(1);
    expect((await h.call('GET /status')).body).toMatchObject({ state: 'connected', paired: true });

    // An hour later the probe gets a 401: keep the credential, stop, ask for a new pairing.
    h.statusReplies.push(reply(401, { code: 'integration_unauthorized' }));
    await h.tick(70 * MIN);
    expect(h.statusCalls()).toBe(2);
    const st = (await h.call('GET /status')).body;
    expect(st).toMatchObject({ state: 'reauth_required', paired: false, vesselLabel: 'Sea Hag' });
    expect(h.app.statuses.at(-1)).toBe(
      `ERR Pairing with VesselTwin is no longer valid. Pair again. ${NO_UPLOAD}`,
    );
    // The tombstone write (temp file, rename, dir fsync) is async: wait for it to settle.
    await h.untilFiles(['credential.json']);
    await h.until(async () =>
      (await readFile(join(h.dir, 'credential.json'), 'utf8')).includes('reauthRequired'),
    );
    // The dead credential is replaced by a secret-free tombstone (same 0600 file).
    const tomb = JSON.parse(await readFile(join(h.dir, 'credential.json'), 'utf8')) as object;
    expect(Object.keys(tomb).sort()).toEqual([
      'apiOrigin',
      'pairedAt',
      'reauthRequired',
      'vesselLabel',
    ]);
    expect(tomb).toMatchObject({ reauthRequired: true, vesselLabel: 'Sea Hag', apiOrigin: ORIGIN });
    expect(JSON.stringify(tomb)).not.toContain('vti_');
    expect(statSync(join(h.dir, 'credential.json')).mode & 0o777).toBe(0o600);
    await h.tick(5 * 60 * MIN);
    expect(h.statusCalls()).toBe(2); // never retried

    // /pair is allowed in reauth_required, and success overwrites the credential.
    expect((await h.call('POST /pair')).status).toBe(202);
    await h.tick();
    expect((await h.call('GET /status')).body).toMatchObject({
      state: 'pairing',
      pairing: { userCode: 'BBBB-BBBB' },
    });
    await h.tick(5_000);
    h.held[1]?.resolve(
      new Response(
        JSON.stringify({
          ...tokenBody,
          credentialId: 'cid-2',
          credential: `vti_${'G'.repeat(43)}`,
        }),
        { status: 200 },
      ),
    );
    await h.untilState('connected');
    await h.until(() => h.statusCalls() === 3);
    expect(h.statusCalls()).toBe(3);
    expect((await h.call('GET /status')).body).toMatchObject({ state: 'connected', paired: true });
    await h.until(async () =>
      (await readFile(join(h.dir, 'credential.json'), 'utf8')).includes('cid-2'),
    );
    expect(JSON.parse(await readFile(join(h.dir, 'credential.json'), 'utf8'))).toMatchObject({
      credentialId: 'cid-2',
    });
    h.plugin.stop();
  });

  it('a restart during pairing means pairing again: no resume, no stale polling', async () => {
    const h = harness();
    h.plugin.start({});
    await h.tick();
    await h.call('POST /pair');
    await h.tick(5_000);
    expect(h.held).toHaveLength(1);
    h.plugin.stop();
    h.plugin.start({});
    await h.tick();
    expect((await h.call('GET /status')).body).toMatchObject({
      state: 'not_paired',
      pairing: null,
    });
    await h.tick(10 * MIN);
    expect(h.calls.filter((u) => u.endsWith('/pairing/token'))).toHaveLength(1); // only the old one
    expect(h.calls.filter((u) => u.endsWith('/pairing/start'))).toHaveLength(1);
    await h.resolveHeld(h.ok());
    await h.tick();
    await h.untilFiles([]);
    h.plugin.stop();
  });

  it.each([
    ['missing', undefined, COPY.reauth],
    ['different', 'https://other.example', COPY.reauthOrigin],
  ])(
    'a credential with a %s origin goes to reauth_required with zero network calls',
    async (_n, origin, copy) => {
      const dir = tempDir();
      await seed(dir, { apiOrigin: origin });
      const h = harness({ dir });
      h.plugin.start({});
      await h.tick();
      expect((await h.call('GET /status')).body).toMatchObject({
        state: 'reauth_required',
        paired: false,
      });
      await h.tick(3 * 60 * MIN);
      expect(h.calls).toEqual([]);
      expect(h.app.statuses.at(-1)).toBe(`ERR ${copy}`);
      h.plugin.stop();
    },
  );

  it('origin-change copy is neutral: no URLs, no server codes; real 401s keep the generic copy', () => {
    expect(COPY.reauthOrigin).toBe(
      `The VesselTwin API address changed since pairing. Pair again, or restore the previous address. ${NO_UPLOAD}`,
    );
    expect(COPY.reauthOrigin).not.toMatch(/https?:|integration_|\.example/);
    expect(COPY.reauth).toMatch(/no longer valid/);
    expect(COPY.reauth).not.toBe(COPY.reauthOrigin);
  });

  it('a changed API URL after pairing shows the origin copy', async () => {
    const dir = tempDir();
    await seed(dir);
    const h = harness({ dir });
    h.plugin.start({ apiBaseUrl: 'https://other.example' });
    await h.tick();
    expect(h.app.statuses.at(-1)).toBe(`ERR ${COPY.reauthOrigin}`);
    expect(h.app.statuses.at(-1)).not.toMatch(/other\.example|vesseltwin\.io/);
    h.plugin.stop();
  });

  it('a real 401 keeps the generic re-pair copy, not the origin copy', async () => {
    const dir = tempDir();
    await seed(dir);
    const h = harness({ dir });
    h.statusReplies.push(reply(401, { code: 'integration_unauthorized' }));
    h.plugin.start({});
    await h.tick();
    await h.untilState('reauth_required');
    expect(h.app.statuses.at(-1)).toBe(`ERR ${COPY.reauth}`);
    h.plugin.stop();
  });

  it('a stale error is cleared when pairing starts again', async () => {
    const h = harness();
    h.plugin.start({});
    await h.tick();
    // Reuse the rig: first pairing fails (a held reply is never used; make start fail via expiry).
    await h.call('POST /pair');
    await h.tick(5_000);
    await h.resolveHeld(new Response(JSON.stringify({ error: 'expired_token' }), { status: 400 }));
    await h.untilState('pairing_failed');
    expect(h.app.statuses.at(-1)).toBe(`ERR ${FAILURE_COPY.expired}`);
    const before = h.app.statuses.length;
    await h.call('POST /pair');
    await h.untilState('pairing');
    const after = h.app.statuses.slice(before);
    expect(after).toEqual(['ERR ', COPY.pairingInProgress]); // error cleared, then the status line
    h.plugin.stop();
  });

  it('a stale reauth error is cleared once re-paired and connected', async () => {
    const dir = tempDir();
    await seed(dir);
    const h = harness({ dir });
    h.statusReplies.push(reply(401, { code: 'integration_unauthorized' }));
    h.plugin.start({});
    await h.tick();
    await h.untilState('reauth_required');
    expect(h.app.statuses.at(-1)).toBe(`ERR ${COPY.reauth}`);
    // Re-pair and connect: the reauth error must not linger.
    await h.call('POST /pair');
    await h.tick(5_000);
    await h.resolveHeld(h.ok());
    await h.untilState('connected');
    const i = h.app.statuses.lastIndexOf('ERR ');
    expect(i).toBeGreaterThan(-1);
    expect(h.app.statuses.slice(i).every((l) => !l.startsWith('ERR ') || l === 'ERR ')).toBe(true);
    expect(h.app.statuses.at(-1)).toMatch(/^Paired with Sea Hag/);
    h.plugin.stop();
  });

  it('a credential issued for a configured non-default origin works against it', async () => {
    const dir = tempDir();
    await seed(dir, { apiOrigin: 'https://h.example' });
    const h = harness({ dir });
    h.plugin.start({ apiBaseUrl: 'https://h.example/api' });
    await h.tick();
    expect(h.calls).toEqual(['https://h.example/api/v1/integrations/status']);
    expect((await h.call('GET /status')).body).toMatchObject({
      state: 'connected',
      apiOrigin: 'https://h.example',
    });
    h.plugin.stop();
  });

  const lines: [string, () => Response, string, Record<string, unknown>, boolean][] = [
    [
      'connected',
      () => new Response(JSON.stringify(okStatusBody()), { status: 200 }),
      `Paired with Sea Hag. ${NO_UPLOAD}`,
      { state: 'connected', updateRecommended: false, clockSkewWarning: false },
      false,
    ],
    [
      'connected with update and clock skew',
      () =>
        new Response(
          JSON.stringify({
            ...okStatusBody(),
            pluginUpdateRecommended: true,
            serverTime: new Date(Date.now() + 10 * MIN).toISOString(),
          }),
          { status: 200 },
        ),
      `Paired with Sea Hag. A plugin update is available. This device's clock differs from VesselTwin's. Check the date and time. ${NO_UPLOAD}`,
      { state: 'connected', updateRecommended: true, clockSkewWarning: true },
      false,
    ],
    [
      'paused (feature off)',
      reply(503, { code: 'integration_feature_unavailable' }),
      `Paired with Sea Hag. VesselTwin integrations are not available for your account right now. The plugin will keep checking. ${NO_UPLOAD}`,
      { state: 'paused', paired: true },
      false,
    ],
    [
      'paused (plan)',
      reply(403, { code: 'integration_paused_plan' }),
      `Paired with Sea Hag. The connection is paused for your VesselTwin plan. The plugin will keep checking. ${NO_UPLOAD}`,
      { state: 'paused', paired: true },
      false,
    ],
    [
      'offline',
      reply(503, {}),
      `Paired with Sea Hag. Cannot reach VesselTwin right now. The plugin will keep trying. ${NO_UPLOAD}`,
      { state: 'offline', paired: true },
      false,
    ],
    [
      'update_required (426)',
      reply(426, { code: 'integration_contract_unsupported' }),
      `Paired with Sea Hag. This plugin version is not supported by VesselTwin. Update the plugin. ${NO_UPLOAD}`,
      { state: 'update_required', paired: true },
      true,
    ],
    [
      'update_required (minContract)',
      () => new Response(JSON.stringify({ ...okStatusBody(), minContract: 2 }), { status: 200 }),
      `Paired with Sea Hag. This plugin version is not supported by VesselTwin. Update the plugin. ${NO_UPLOAD}`,
      { state: 'update_required', paired: true },
      true,
    ],
    [
      'stopped by a scope error (reported as update_required)',
      reply(403, { code: 'integration_scope' }),
      `Paired with Sea Hag. This plugin version is not supported by VesselTwin. Update the plugin. ${NO_UPLOAD}`,
      { state: 'update_required', paired: true },
      true,
    ],
    [
      'reauth_required',
      reply(401, { code: 'integration_unauthorized' }),
      `Pairing with VesselTwin is no longer valid. Pair again. ${NO_UPLOAD}`,
      { state: 'reauth_required', paired: false },
      true,
    ],
  ];
  it.each(lines)('status line and /status for %s', async (_n, r, line, body, isError) => {
    const dir = tempDir();
    await seed(dir);
    const h = harness({ dir });
    h.statusReplies.push(r);
    h.plugin.start({});
    await h.tick();
    expect(h.app.statuses.at(-1)).toBe(`${isError ? 'ERR ' : ''}${line}`);
    const out = (await h.call('GET /status')).body;
    expect(out).toMatchObject(body);
    expect(out.message).toBe(line);
    expect(JSON.stringify(out)).not.toMatch(/integration_|vti_|dc_/);
    expect(typeof out.lastCheckedAt).toBe('string');
    h.plugin.stop();
  });

  it('shows the checking line until the first probe returns', async () => {
    const dir = tempDir();
    await seed(dir);
    const app = fakeApp(dir);
    const plugin = createPlugin(app, { fetch: () => new Promise<Response>(() => undefined) });
    plugin.start({});
    await vi.waitFor(() => {
      expect(app.statuses.at(-1)).toBe(
        `Paired with Sea Hag. Checking the connection. ${NO_UPLOAD}`,
      );
    });
    plugin.stop();
  });

  it('keeps probing hourly while paused or offline, never faster than Retry-After', async () => {
    const dir = tempDir();
    await seed(dir);
    const h = harness({ dir });
    h.statusReplies.push(
      reply(503, { code: 'integration_feature_unavailable' }, { 'retry-after': '7200' }),
    );
    h.plugin.start({});
    await h.tick();
    expect(h.statusCalls()).toBe(1);
    await h.tick(110 * MIN);
    expect(h.statusCalls()).toBe(1);
    await h.tick(11 * MIN);
    expect(h.statusCalls()).toBe(2);
    expect((await h.call('GET /status')).body.state).toBe('connected');
    h.plugin.stop();
  });

  it('/pair is refused with 409 in every credentialed working state', async () => {
    for (const r of [
      reply(503, {}),
      reply(503, { code: 'integration_feature_unavailable' }),
      reply(426, {}),
      () => new Response(JSON.stringify(okStatusBody()), { status: 200 }),
    ]) {
      const dir = tempDir();
      await seed(dir);
      const h = harness({ dir });
      h.statusReplies.push(r);
      h.plugin.start({});
      // The credential load (which precedes the first probe) must be done, or /pair answers 503.
      await h.until(() => h.statusCalls() === 1);
      expect((await h.call('POST /pair')).status).toBe(409);
      expect(h.calls.some((u) => u.includes('/pairing/'))).toBe(false);
      h.plugin.stop();
    }
  });

  it('pairing_failed exposes the reason, and /pair can start again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const dir = tempDir();
    const app = fakeApp(dir);
    let n = 0;
    const plugin = createPlugin(app, {
      fetch: (url) => {
        if (url.endsWith('/pairing/start')) {
          n += 1;
          return Promise.resolve(
            n === 1
              ? new Response('{}', { status: 503 })
              : new Response(
                  JSON.stringify({
                    deviceCode: 'dc_abcdefghijklmnop',
                    userCode: 'CCCC-DDDD',
                    verificationUrl: 'https://vesseltwin.io/connect',
                    interval: 5,
                    expiresIn: 600,
                  }),
                  { status: 200 },
                ),
          );
        }
        return new Promise<Response>(() => undefined);
      },
    });
    const routes: Record<string, RouteFn> = {};
    plugin.registerWithRouter({
      get: (p, hd) => {
        routes[`GET ${p}`] = hd;
      },
      post: (p, hd) => {
        routes[`POST ${p}`] = hd;
      },
    });
    const call = async (r: string) => {
      let body: unknown;
      const res: ResponseLike = { status: () => res, json: (b) => (body = b) };
      await routes[r]?.({}, res);
      return body as Record<string, unknown>;
    };
    plugin.start({});
    await vi.advanceTimersByTimeAsync(0);
    await realPause(40);
    await call('POST /pair');
    await vi.advanceTimersByTimeAsync(0);
    await realPause(40);
    expect(await call('GET /status')).toMatchObject({
      state: 'pairing_failed',
      paired: false,
      pairing: { reason: 'unavailable' },
      message: 'VesselTwin is not available right now. Try again later.',
    });
    expect(app.statuses.at(-1)).toBe('ERR VesselTwin is not available right now. Try again later.');
    await call('POST /pair');
    await vi.advanceTimersByTimeAsync(0);
    await realPause(40);
    expect(await call('GET /status')).toMatchObject({
      state: 'pairing',
      pairing: { userCode: 'CCCC-DDDD' },
    });
    plugin.stop();
  });

  it('/unpair stops the monitor and stop() clears its timer: no probes afterwards', async () => {
    for (const how of ['unpair', 'stop'] as const) {
      const dir = tempDir();
      await seed(dir);
      const h = harness({ dir });
      h.plugin.start({});
      await h.tick();
      expect(h.statusCalls()).toBe(1);
      if (how === 'unpair') await h.call('POST /unpair');
      else h.plugin.stop();
      await h.tick(5 * 60 * MIN);
      expect(h.statusCalls()).toBe(1);
      h.plugin.stop();
    }
  });

  it('a config error with a stored credential makes no calls and reads nothing', async () => {
    const dir = tempDir();
    await seed(dir);
    const h = harness({ dir });
    h.plugin.start({ apiBaseUrl: 'ftp://nope' });
    await h.tick(2 * 60 * MIN);
    expect(h.calls).toEqual([]);
    expect((await h.call('GET /status')).body).toMatchObject({
      state: 'config_error',
      apiOrigin: null,
      paired: false,
    });
    h.plugin.stop();
  });

  it('an unreadable credential file is reported neutrally as config_error', async () => {
    const dir = tempDir();
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(dir, 'credential.json'));
    const h = harness({ dir });
    h.plugin.start({});
    await h.tick();
    const out = (await h.call('GET /status')).body;
    expect(out.state).toBe('config_error');
    expect(String(out.message)).toMatch(/Cannot read the stored VesselTwin connection/);
    expect(JSON.stringify(out)).not.toMatch(/EISDIR|credential\.json|\/var|\/tmp/);
    expect(h.calls).toEqual([]);
    h.plugin.stop();
  });

  it('never exposes the credential or device code in /status or the status lines', async () => {
    const h = harness();
    h.plugin.start({});
    await h.tick();
    await h.call('POST /pair');
    await h.tick(5_000);
    const pending = JSON.stringify((await h.call('GET /status')).body);
    await h.resolveHeld(h.ok());
    await h.untilState('connected');
    const done = JSON.stringify((await h.call('GET /status')).body);
    for (const text of [pending, done, h.app.statuses.join('\n')]) {
      expect(text).not.toContain(FAKE_CRED);
      expect(text).not.toContain('dc_');
      expect(text).not.toContain('deviceCode');
    }
    h.plugin.stop();
  });
});

describe('tombstone after a 401', () => {
  const credFile = (dir: string) => join(dir, 'credential.json');

  async function reachReauth() {
    const dir = tempDir();
    await seed(dir);
    const h = harness({ dir });
    h.statusReplies.push(reply(401, { code: 'integration_unauthorized' }));
    h.plugin.start({});
    await h.tick();
    expect(h.statusCalls()).toBe(1);
    // The 401 handler rewrites the credential file asynchronously; wait for the tombstone to land.
    await h.until(() => {
      try {
        const f = JSON.parse(readFileSync(credFile(dir), 'utf8')) as Record<string, unknown>;
        return f.reauthRequired === true && !('credential' in f);
      } catch {
        return false;
      }
    });
    h.plugin.stop();
    return { dir, h };
  }

  it('a 401 leaves a file with no credential or credentialId', async () => {
    const { dir } = await reachReauth();
    const tomb = JSON.parse(await readFile(credFile(dir), 'utf8')) as Record<string, unknown>;
    expect(Object.keys(tomb)).not.toContain('credential');
    expect(Object.keys(tomb)).not.toContain('credentialId');
    expect(tomb).toMatchObject({
      reauthRequired: true,
      vesselLabel: 'Sea Hag',
      apiOrigin: ORIGIN,
      pairedAt: '2030-01-01T00:00:00.000Z',
    });
    expect(readFileSyncText(credFile(dir))).not.toContain(FAKE_CRED);
  });

  it('a restart over the tombstone is reauth_required and makes zero network calls', async () => {
    const { dir } = await reachReauth();
    const h2 = harness({ dir });
    h2.plugin.start({});
    // Wait for the restart's credential load to finish (state leaves its initial value), then let
    // three hours of fake time pass so any timer that could trigger a probe has fired.
    await h2.untilState('reauth_required');
    await h2.tick(3 * 60 * MIN);
    expect(h2.calls).toEqual([]);
    expect((await h2.call('GET /status')).body).toMatchObject({
      state: 'reauth_required',
      paired: false,
      vesselLabel: 'Sea Hag',
    });
    expect(h2.app.statuses.at(-1)).toBe(`ERR ${COPY.reauth}`);
    h2.plugin.stop();
  });

  it('a hand-made tombstone is also reauth_required with zero calls', async () => {
    const dir = tempDir();
    await writeFile(credFile(dir), JSON.stringify({ reauthRequired: true, apiOrigin: ORIGIN }));
    const h = harness({ dir });
    h.plugin.start({});
    await h.tick();
    expect((await h.call('GET /status')).body).toMatchObject({ state: 'reauth_required' });
    expect(h.calls).toEqual([]);
    h.plugin.stop();
  });

  it('re-pairing overwrites the tombstone with a fresh credential', async () => {
    const { dir } = await reachReauth();
    const h2 = harness({ dir });
    h2.plugin.start({});
    await h2.tick();
    expect((await h2.call('POST /pair')).status).toBe(202);
    await h2.tick(5_000);
    await h2.resolveHeld(h2.ok());
    await h2.untilState('connected');
    expect((await h2.call('GET /status')).body).toMatchObject({ state: 'connected', paired: true });
    const file = JSON.parse(await readFile(credFile(dir), 'utf8')) as Record<string, unknown>;
    expect(file).toMatchObject({ credential: FAKE_CRED, credentialId: 'cid-1' });
    expect(file).not.toHaveProperty('reauthRequired');
    expect(statSync(credFile(dir)).mode & 0o777).toBe(0o600);
    h2.plugin.stop();
  });

  it('/unpair deletes the tombstone', async () => {
    const { dir } = await reachReauth();
    const h2 = harness({ dir });
    h2.plugin.start({});
    await h2.tick();
    expect((await h2.call('POST /unpair')).status).toBe(200);
    await h2.untilFiles([]);
    expect((await h2.call('GET /status')).body).toMatchObject({ state: 'not_paired' });
    h2.plugin.stop();
  });

  it('an origin mismatch (no call made) does not tombstone the credential', async () => {
    const dir = tempDir();
    await seed(dir, { apiOrigin: 'https://elsewhere.test' });
    const h = harness({ dir });
    h.plugin.start({});
    await h.tick();
    expect((await h.call('GET /status')).body).toMatchObject({ state: 'reauth_required' });
    expect(h.calls).toEqual([]);
    expect(JSON.parse(await readFile(credFile(dir), 'utf8'))).toHaveProperty('credential');
    h.plugin.stop();
  });
});

function readFileSyncText(file: string): string {
  return readFileSync(file, 'utf8');
}

describe('unpair, cleanup and route hardening', () => {
  it('unpair bumps the epoch first: a racing credential load cannot start a monitor', async () => {
    const dir = tempDir();
    await seed(dir);
    const h = harness({ dir });
    h.plugin.start({}); // the credential read is now in flight
    expect((await h.call('POST /unpair')).status).toBe(200);
    await h.tick(2 * MIN);
    expect(h.statusCalls()).toBe(0);
    await h.untilFiles([]);
    expect((await h.call('GET /status')).body).toMatchObject({ state: 'not_paired' });
    expect(h.app.statuses.at(-1)).toBe(COPY.unpaired);
    h.plugin.stop();
  });

  it('logs, redacted, when the stale-run cleanup cannot clear the file', async () => {
    const h = harness();
    const debug = vi.fn<(m: string) => void>();
    h.app.debug = debug;
    h.plugin.start({});
    await h.tick();
    const write = vi.spyOn(CredentialStore.prototype, 'write').mockImplementation(() => {
      h.plugin.stop(); // cancelled while the file is being written
      return Promise.resolve();
    });
    const clear = vi
      .spyOn(CredentialStore.prototype, 'clear')
      .mockRejectedValue(new Error(`boom ${FAKE_CRED}`));
    try {
      await h.call('POST /pair');
      await h.tick(5_000);
      await h.resolveHeld(h.ok());
      await h.until(() => clear.mock.calls.length > 0);
      await h.tick();
      expect(clear).toHaveBeenCalled();
      const logged = debug.mock.calls.map((c) => c[0]);
      expect(logged.some((l) => l.startsWith('stale pairing cleanup failed'))).toBe(true);
      expect(logged.join('\n')).not.toContain(FAKE_CRED);
    } finally {
      write.mockRestore();
      clear.mockRestore();
    }
  });

  it('Sec-Fetch-Site same-origin or none is allowed; Origin null or unparsable stays 403', async () => {
    const h = harness();
    h.plugin.start({});
    await h.tick();
    const proxied = { origin: 'https://boat.example', host: 'internal:3000' };
    expect((await h.call('GET /status', proxied)).status).toBe(403);
    for (const site of ['same-origin', 'none', 'Same-Origin']) {
      expect((await h.call('GET /status', { ...proxied, 'sec-fetch-site': site })).status).toBe(
        200,
      );
    }
    for (const site of ['cross-site', 'same-site']) {
      expect((await h.call('GET /status', { ...proxied, 'sec-fetch-site': site })).status).toBe(
        403,
      );
    }
    for (const origin of ['null', 'not a url']) {
      const hdrs = { origin, host: 'boat:3000', 'sec-fetch-site': 'same-origin' };
      expect((await h.call('POST /pair', hdrs)).status).toBe(403);
    }
    expect(h.calls).toEqual([]);
    // no Origin at all: still allowed
    expect((await h.call('GET /status', { 'sec-fetch-site': 'cross-site' })).status).toBe(200);
    h.plugin.stop();
  });

  it('GET /status says the plugin is not running before start and after stop', async () => {
    const h = harness();
    const before = await h.call('GET /status');
    expect(before.status).toBe(503);
    expect(before.body).toEqual({ error: COPY.notRunning });
    h.plugin.start({});
    await h.tick();
    expect((await h.call('GET /status')).status).toBe(200);
    h.plugin.stop();
    const after = await h.call('GET /status');
    expect(after.status).toBe(503);
    expect(after.body).toEqual({ error: COPY.notRunning });
  });

  it('strips invisible format characters from the vessel label', async () => {
    const h = harness();
    h.plugin.start({});
    await h.tick();
    await h.call('POST /pair');
    await h.tick(5_000);
    await h.resolveHeld(
      new Response(JSON.stringify({ ...tokenBody, vesselLabel: 'Sea\u202eHag\u200b\ufeff' }), {
        status: 200,
      }),
    );
    await h.untilState('connected');
    expect((await h.call('GET /status')).body.vesselLabel).toBe('Sea Hag');
    h.plugin.stop();
  });

  it('a pairing start with an unsafe verification URL is rejected without showing it', async () => {
    const dir = tempDir();
    const app = fakeApp(dir);
    const fetchFn = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            deviceCode: 'dc_x',
            userCode: 'AAAA-AAAA',
            verificationUrl: 'javascript:alert(1)',
            interval: 5,
            expiresIn: 600,
          }),
          { status: 200 },
        ),
      );
    const p = createPlugin(app, { fetch: fetchFn });
    p.start({});
    const routes: Record<string, RouteFn> = {};
    p.registerWithRouter({
      get: () => undefined,
      post: (path, hd) => {
        routes[path] = hd;
      },
    });
    await vi.waitFor(() => {
      expect(app.statuses.at(-1)).toMatch(/Not paired/);
    });
    const res: ResponseLike = { status: () => res, json: () => undefined };
    await routes['/pair']?.({}, res);
    await vi.waitFor(() => {
      expect(app.statuses.at(-1)).toBe(`ERR ${FAILURE_COPY.rejected}`);
    });
    expect(app.statuses.join('\n')).not.toMatch(/javascript|AAAA/);
    p.stop();
  });

  it('copy never points at a plugin page', () => {
    for (const text of [...Object.values(FAILURE_COPY), ...Object.values(COPY)]) {
      expect(text).not.toMatch(/plugin page/i);
    }
  });
});

function gate() {
  let open!: () => void;
  const p = new Promise<void>((r) => {
    open = r;
  });
  return { p, open };
}

describe('lifecycle races and the status line', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('never puts the pairing code or URL in a status line, only in the admin /status body', async () => {
    const h = harness();
    h.plugin.start({});
    await h.tick();
    await h.call('POST /pair');
    await h.tick();
    expect(h.app.statuses.at(-1)).toBe(COPY.pairingInProgress);
    expect(COPY.pairingInProgress).toContain('/plugins/signalk-vesseltwin/status');
    expect((await h.call('GET /status')).body.pairing).toMatchObject({ userCode: 'AAAA-AAAA' });
    for (const line of h.app.statuses) expect(line).not.toMatch(/AAAA|connect/);
    h.plugin.stop();
  });

  it('POST /pair is refused until the stored credential has loaded, with zero network calls', async () => {
    const dir = tempDir();
    await seed(dir);
    const g = gate();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- re-bound with .call below
    const read = CredentialStore.prototype.read;
    vi.spyOn(CredentialStore.prototype, 'read').mockImplementation(async function (
      this: CredentialStore,
    ) {
      await g.p;
      return read.call(this);
    });
    const h = harness({ dir });
    h.plugin.start({});
    await h.tick();
    const early = await h.call('POST /pair');
    expect(early.status).toBe(503);
    expect(early.body).toEqual({ error: COPY.starting });
    expect(h.calls).toHaveLength(0);
    g.open();
    await h.untilState('connected');
    // Loaded and paired: now it is the normal refusal, still without a pairing/start call.
    expect((await h.call('POST /pair')).status).toBe(409);
    expect(h.calls.some((u) => u.endsWith('/pairing/start'))).toBe(false);
    h.plugin.stop();
  });

  it('a pairing write that outlives stop() cannot leave file and monitor out of step', async () => {
    const h = harness();
    h.plugin.start({});
    await h.tick();
    await h.call('POST /pair');
    await h.tick(5_000); // token poll in flight

    const writeGate = gate();
    const clearGate = gate();
    const readGate = gate();
    let clearCalled = false;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- re-bound with .call below
    const { write, clear, read } = CredentialStore.prototype;
    vi.spyOn(CredentialStore.prototype, 'write').mockImplementation(async function (
      this: CredentialStore,
      c,
    ) {
      await writeGate.p;
      return write.call(this, c);
    });
    vi.spyOn(CredentialStore.prototype, 'clear').mockImplementation(async function (
      this: CredentialStore,
    ) {
      clearCalled = true;
      await clearGate.p;
      return clear.call(this);
    });
    vi.spyOn(CredentialStore.prototype, 'read').mockImplementation(async function (
      this: CredentialStore,
    ) {
      await readGate.p;
      return read.call(this);
    });

    await h.resolveHeld(h.ok()); // approval arrives; the credential write is now pending
    await h.tick();
    h.plugin.stop();
    h.plugin.start({}); // the next lifecycle begins while the old write is pending
    await h.tick();
    writeGate.open(); // file lands, the stale run then tries to clear it
    await h.until(() => clearCalled);
    readGate.open(); // a load that did not wait for the stale run would now see the file
    await h.tick();
    clearGate.open();
    await h.until(() => h.files().length === 0);
    await h.tick(2 * MIN);

    await h.untilFiles([]);
    expect((await h.call('GET /status')).body).toMatchObject({
      state: 'not_paired',
      paired: false,
    });
    expect(h.statusCalls()).toBe(0); // no monitor on a credential that was deleted
    h.plugin.stop();
  });

  it('an unrecognised 401 stops probing but keeps the credential file untouched', async () => {
    for (const body of [{}, { code: 'something_else' }]) {
      const dir = tempDir();
      await seed(dir);
      const before = await readFile(join(dir, 'credential.json'), 'utf8');
      const h = harness({ dir });
      h.statusReplies.push(reply(401, body));
      h.plugin.start({});
      await h.tick();
      expect(h.statusCalls()).toBe(1);
      expect((await h.call('GET /status')).body).toMatchObject({
        state: 'reauth_required',
        paired: false,
      });
      await h.tick(3 * 60 * MIN);
      expect(h.statusCalls()).toBe(1); // stopped
      expect(await readFile(join(dir, 'credential.json'), 'utf8')).toBe(before);
      await h.untilFiles(['credential.json']);
      h.plugin.stop();
    }
  });

  it('keeps the revoke reminder after unpair until the next start or pairing', async () => {
    const dir = tempDir();
    await seed(dir);
    const h = harness({ dir });
    h.plugin.start({});
    await h.untilState('connected');
    await h.call('POST /unpair');
    expect(h.app.statuses.at(-1)).toBe(COPY.unpaired);
    h.plugin.stop();
    h.plugin.start({});
    await h.until(() => h.app.statuses.at(-1) === COPY.notPaired);
    h.plugin.stop();
  });
});
