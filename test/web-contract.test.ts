// The page and the plugin are separate programs. This test drives the real plugin through every
// reachable state and checks that the page's parser understands each /status body.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CredentialStore } from '../src/credential-store';
import {
  createPlugin,
  type PluginState,
  type RequestLike,
  type ResponseLike,
  type RouteHandler,
  type SignalKApp,
} from '../src/plugin';
import {
  KNOWN_STATES,
  UPLOAD_NOTICE,
  actionsFor,
  describeStatus,
  parseStatus,
  stripUploadNotice,
  type KnownState,
} from '../web/view.js';

// Compile-time check: the page's state list and the plugin's `PluginState` are the same set.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const statesInSync: Same<KnownState, PluginState> = true;

const FAKE_CRED = `vti_${'F'.repeat(43)}`;
const dirs: string[] = [];
const plugins: { stop(): void }[] = [];
afterEach(() => {
  for (const p of plugins.splice(0)) p.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 });
});

const json = (status: number, body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));
const never = () => new Promise<Response>(() => undefined);

interface Opts {
  settings?: unknown;
  credential?: boolean;
  fetch: (url: string) => Promise<Response>;
}

async function boot(o: Opts) {
  const dir = mkdtempSync(join(tmpdir(), 'vt-contract-'));
  dirs.push(dir);
  if (o.credential) {
    await new CredentialStore(dir).write({
      credential: FAKE_CRED,
      credentialId: 'cid-1',
      vesselLabel: 'Sea Hag',
      pairedAt: new Date().toISOString(),
      apiOrigin: 'https://api.vesseltwin.io',
    });
  }
  const app: SignalKApp = {
    getDataDirPath: () => dir,
    getSelfPath: () => undefined,
    setPluginStatus: () => undefined,
    setPluginError: () => undefined,
    debug: () => undefined,
    error: () => undefined,
  };
  const plugin = createPlugin(app, { fetch: (u) => o.fetch(u) });
  plugins.push(plugin);
  const routes: Record<string, RouteHandler> = {};
  plugin.registerWithRouter({
    get: (p, h) => {
      routes[`GET ${p}`] = h;
    },
    post: (p, h) => {
      routes[`POST ${p}`] = h;
    },
  });
  plugin.start(o.settings ?? {});
  const call = async (route: string) => {
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
    const req: RequestLike = {};
    await routes[route]?.(req, res);
    return { status, body };
  };
  const waitFor = async (state: PluginState) => {
    await vi.waitFor(
      async () => {
        expect(((await call('GET /status')).body as { state: string }).state).toBe(state);
      },
      { timeout: 3000, interval: 20 },
    );
    return (await call('GET /status')).body;
  };
  /** POST /pair, retrying while the plugin is still loading its stored credential (503). */
  const pair = async () => {
    await vi.waitFor(
      async () => {
        expect((await call('POST /pair')).status).toBe(202);
      },
      { timeout: 3000, interval: 20 },
    );
  };
  return { call, waitFor, pair };
}

const startReply = () =>
  json(200, {
    deviceCode: 'dc_AAAA-AAAA_abcdefghijklmnop',
    userCode: 'AAAA-AAAA',
    verificationUrl: 'https://vesseltwin.io/connect',
    interval: 5,
    expiresIn: 600,
  });

const scenarios: Record<PluginState, () => Opts> = {
  config_error: () => ({ settings: { apiBaseUrl: 'http://example.com' }, fetch: never }),
  not_paired: () => ({ fetch: never }),
  pairing: () => ({
    fetch: (u) => (u.endsWith('/pairing/start') ? startReply() : never()),
  }),
  pairing_failed: () => ({ fetch: () => json(503, {}) }),
  checking: () => ({ credential: true, fetch: never }),
  connected: () => ({
    credential: true,
    fetch: () =>
      json(200, {
        provider: 'signalk',
        minContract: 1,
        latestContract: 1,
        pluginUpdateRecommended: false,
        serverTime: new Date().toISOString(),
        summary: null,
      }),
  }),
  paused: () => ({
    credential: true,
    fetch: () => json(403, { code: 'integration_paused_plan' }),
  }),
  offline: () => ({ credential: true, fetch: () => Promise.reject(new Error('down')) }),
  update_required: () => ({
    credential: true,
    fetch: () => json(426, { code: 'integration_contract_unsupported' }),
  }),
  reauth_required: () => ({
    credential: true,
    fetch: () => json(401, { code: 'integration_unauthorized' }),
  }),
};

describe('page contract', () => {
  it('knows exactly the plugin states', () => {
    expect(statesInSync).toBe(true);
    expect([...KNOWN_STATES].sort()).toEqual(Object.keys(scenarios).sort());
  });

  for (const state of KNOWN_STATES) {
    it(`parses the ${state} body into the same state`, async () => {
      const p = await boot(scenarios[state]());
      if (state === 'pairing_failed') await p.pair();
      if (state === 'pairing') await p.pair();
      const body = await p.waitFor(state);
      const m = parseStatus(body);
      expect(m.state).toBe(state);
      expect(m.message).not.toBe('');
      const screen = describeStatus(m, m.expiresInSeconds);
      expect(screen.message).not.toBe('');
      // The page shows the upload notice permanently; a message must not repeat it after stripping.
      expect(stripUploadNotice(m.message)).not.toContain(UPLOAD_NOTICE);
      if (state === 'pairing') {
        expect(screen.code).toBe('AAAA-AAAA');
        expect(screen.link?.href).toBe('https://vesseltwin.io/connect');
        expect(m.apiHint).toBeNull();
      } else {
        expect(screen.code).toBeNull();
      }
      if (state === 'pairing_failed') {
        expect(m.failureReason).toBe('unavailable');
        expect(actionsFor(m).map((a) => a.id)).toEqual(['pair']);
      }
      if (state === 'connected') expect(m.paired).toBe(true);
    });
  }

  it('never puts the code or link into the status message', async () => {
    const p = await boot(scenarios.pairing());
    await p.pair();
    const m = parseStatus(await p.waitFor('pairing'));
    expect(m.message).not.toContain('AAAA-AAAA');
    expect(m.message).not.toContain('vesseltwin.io');
  });

  it('shows a non-default API origin as a hint', async () => {
    const p = await boot({ settings: { apiBaseUrl: 'http://localhost:3001' }, fetch: never });
    const m = parseStatus(await p.waitFor('not_paired'));
    expect(m.apiHint).toBe('http://localhost:3001');
  });
});
