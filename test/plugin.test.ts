import { mkdtempSync, readdirSync, statSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseOptions } from '../src/config';
import { categoryFor, PATH_RULES } from '../src/mapping';
import { createPlugin, type RequestLike, type ResponseLike, type SignalKApp } from '../src/plugin';

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
    const app = fakeApp(mkdtempSync(join(tmpdir(), 'vt-plugin-')));
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
    const app = fakeApp(mkdtempSync(join(tmpdir(), 'vt-plugin-')));
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

describe('parseOptions', () => {
  it('defaults safely and flags non-https remote URLs', () => {
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

function harness(opts: { dir?: string } = {}) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), 'vt-plugin-'));
  const app = fakeApp(dir);
  const calls: string[] = [];
  const held: Deferred[] = [];
  let starts = 0;
  const fetchFn = (url: string): Promise<Response> => {
    calls.push(url);
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
  const ok = () => new Response(JSON.stringify(tokenBody), { status: 200 });
  const files = () => readdirSync(dir);
  return { app, plugin, call, tick, calls, held, ok, files, dir };
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
      paired: false,
      pairing: { userCode: 'AAAA-AAAA' },
    });
    await h.tick(5_000);
    h.held[0]?.resolve(h.ok());
    await h.tick();
    expect((await h.call('GET /status')).body).toEqual({ paired: true, pairing: null });
    const file = join(h.dir, 'credential.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({
      credential: FAKE_CRED,
      apiOrigin: 'https://api.vesseltwin.io',
    });
    expect(h.app.statuses.at(-1)).toMatch(/^Paired with Sea Hag\./);
    expect(h.app.statuses).toContain('Enter code AAAA-AAAA at https://vesseltwin.io/connect');
    expect(h.app.statuses.at(-1)).not.toContain('AAAA-AAAA');
    expect(h.app.statuses.join('\n')).not.toContain(FAKE_CRED);
    h.plugin.stop();
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
    h.held[0]?.resolve(h.ok());
    await h.tick();
    expect(h.files()).toEqual([]);
    expect((await h.call('GET /status')).body).toEqual({ paired: false, pairing: null });
    expect(h.app.statuses.at(-1)).toMatch(/revoke the connection in VesselTwin/);
    h.plugin.stop();
  });

  it('answers 500 with neutral copy when the credential cannot be removed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vt-plugin-'));
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
    h.held[0]?.resolve(h.ok());
    await h.tick();
    expect(h.files()).toEqual([]);
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
    h.held[0]?.resolve(h.ok());
    await h.tick();
    expect(h.files()).toEqual([]);
  });

  it('refuses /pair when already paired, with no requests', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vt-plugin-'));
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
    expect(h.calls).toEqual([]);
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
    h.held[0]?.resolve(
      new Response(
        JSON.stringify({ ...tokenBody, vesselLabel: `Sea\u0007Hag\n${'x'.repeat(200)}` }),
        {
          status: 200,
        },
      ),
    );
    await h.tick();
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
    h.held[0]?.resolve(
      new Response(JSON.stringify({ ...tokenBody, vesselLabel: null }), { status: 200 }),
    );
    await h.tick();
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
    h.held[0]?.resolve(
      new Response(JSON.stringify({ ...tokenBody, credential: 'vti_short' }), { status: 200 }),
    );
    await h.tick();
    expect(h.files()).toEqual([]);
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
