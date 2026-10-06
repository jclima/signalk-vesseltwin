import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { CONTRACT_VERSION } from '../src/contract';
import { HttpClient } from '../src/http';
import { runPairing } from '../src/pairing';
import { checkStatus } from '../src/status';

/** Local copy of the platform's device-facing status response fields (all required, no extras). */
interface StatusResponse {
  provider: string;
  minContract: number;
  latestContract: number;
  pluginUpdateRecommended: boolean;
  serverTime: string;
  summary: Record<string, unknown> | null;
}

const headers = { 'user-agent': 'signalk-vesseltwin/test', 'x-vesseltwin-contract': '1' };
const startBody = {
  provider: 'signalk',
  clientName: 'signalk-vesseltwin',
  clientVersion: '0.0.0',
  contractVersion: 1,
  deviceLabel: 'SignalK server',
  requestedScopes: ['meters:write'],
};

// The mock is plain ESM and this package compiles to CommonJS, so load it dynamically.
const startMock = async (
  options: {
    host?: string;
    port?: number;
    pollIntervalS?: number;
    autoApproveAfterPolls?: number;
  } = {},
) => (await import('../dev/mock-server/mock.mjs')).startMock(options);

let server: Server | undefined;
afterEach(async () => {
  const s = server;
  server = undefined;
  if (s)
    await new Promise<void>((resolve) =>
      s.close(() => {
        resolve();
      }),
    );
});

async function boot(options: { autoApproveAfterPolls?: number } = {}) {
  server = await startMock({ host: '127.0.0.1', port: 0, pollIntervalS: 0, ...options });
  const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  const post = async (path: string, body: unknown, h: Record<string, string> = headers) => {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...h },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  return { base, post };
}

function plugClient(base: string): HttpClient {
  return new HttpClient({
    baseUrl: base,
    fetch: (u, i) => fetch(u, i),
    userAgent: 'signalk-vesseltwin/test',
  });
}

async function pairedCredential(post: Awaited<ReturnType<typeof boot>>['post']): Promise<string> {
  const start = await post('/v1/integrations/pairing/start', startBody);
  const token = await post('/v1/integrations/pairing/token', { deviceCode: start.json.deviceCode });
  return token.json.credential as string;
}

describe('mock status vs the plugin status parser', () => {
  it('a paired credential is classified as connected by checkStatus', async () => {
    const { base, post } = await boot({ autoApproveAfterPolls: 1 });
    const credential = await pairedCredential(post);
    const out = await checkStatus(plugClient(base), {
      credential,
      credentialOrigin: new URL(base).origin,
    });
    expect(out.kind).toBe('connected');
    if (out.kind !== 'connected') return;
    expect(out.updateRecommended).toBe(false);
    expect(out.clockSkewWarning).toBe(false);
    expect(out.info.minContract).toBe(1);
    expect(out.info.latestContract).toBe(1);
    expect(out.info.serverTime).not.toBeNull();
  });

  it('an unknown credential is reauth_required', async () => {
    const { base } = await boot();
    const credential = `vti_${'A'.repeat(43)}`;
    expect(
      (await checkStatus(plugClient(base), { credential, credentialOrigin: new URL(base).origin }))
        .kind,
    ).toBe('reauth_required');
  });

  it('injected faults map to the documented outcomes', async () => {
    const { base, post } = await boot({ autoApproveAfterPolls: 1 });
    const credential = await pairedCredential(post);
    const http = plugClient(base);
    const probe = async (fault: Record<string, unknown>) => {
      await post('/__mock/fault', { route: 'status', once: true, ...fault });
      return checkStatus(http, { credential, credentialOrigin: new URL(base).origin });
    };
    expect(await probe({ status: 503, retryAfter: 120 })).toEqual({
      kind: 'paused',
      reason: 'feature',
      retryAfterMs: 120_000,
    });
    expect(await probe({ status: 403 })).toMatchObject({ kind: 'paused', reason: 'plan' });
    expect(await probe({ status: 401 })).toEqual({ kind: 'reauth_required', tombstone: true });
    expect(await probe({ status: 426, minContract: 2 })).toMatchObject({
      kind: 'update_required',
      stop: true,
    });
    expect(await probe({ status: 200, minContract: 2 })).toMatchObject({
      kind: 'update_required',
      stop: false,
    });
    expect(await probe({ status: 429, retryAfter: 7 })).toEqual({
      kind: 'offline',
      retryAfterMs: 7000,
    });
    expect(
      (await checkStatus(http, { credential, credentialOrigin: new URL(base).origin })).kind,
    ).toBe('connected'); // faults were once-only
  });
});

describe('mock server vs the plugin pairing parsers', () => {
  it('a full pairing is accepted by runPairing', async () => {
    const { base } = await boot({ autoApproveAfterPolls: 2 });
    const codes: string[] = [];
    const out = await runPairing({
      http: new HttpClient({
        baseUrl: base,
        fetch: (u, i) => fetch(u, i),
        userAgent: 'signalk-vesseltwin/test',
      }),
      clientName: 'signalk-vesseltwin',
      clientVersion: '0.0.0',
      deviceLabel: 'SignalK server',
      scopes: ['meters:write'],
      onCode: (info) => codes.push(info.userCode),
      sleep: () => Promise.resolve(),
    });
    expect(out.kind).toBe('paired');
    if (out.kind !== 'paired') return;
    expect(codes[0]).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(out.token.credential).toMatch(/^vti_[A-Za-z0-9_-]{43}$/);
    expect(out.token.credentialId).toMatch(/^[0-9a-f-]{36}$/);
    expect(out.token.scopes).toEqual(['meters:write']);
    expect(out.token.provider).toBe('signalk');
    expect(typeof out.token.vesselLabel).toBe('string');
  });

  it('pairing responses carry the documented fields and the poll error states', async () => {
    const { post } = await boot();
    const start = await post('/v1/integrations/pairing/start', startBody);
    expect(start.status).toBe(200);
    expect(Object.keys(start.json).sort()).toEqual(
      ['deviceCode', 'expiresIn', 'interval', 'userCode', 'verificationUrl'].sort(),
    );
    const deviceCode = start.json.deviceCode as string;

    const pending = await post('/v1/integrations/pairing/token', { deviceCode });
    expect(pending).toEqual({ status: 400, json: { error: 'authorization_pending' } });

    const unknown = await post('/v1/integrations/pairing/token', { deviceCode: 'x'.repeat(43) });
    expect(unknown).toEqual({ status: 400, json: { error: 'expired_token' } });

    await post('/__mock/approve', { userCode: start.json.userCode, deny: true });
    const denied = await post('/v1/integrations/pairing/token', { deviceCode });
    expect(denied).toEqual({ status: 400, json: { error: 'access_denied' } });
  });

  it('answers slow_down when polled faster than the interval', async () => {
    server = await startMock({ host: '127.0.0.1', port: 0, pollIntervalS: 60 });
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    const call = async (path: string, body: unknown) =>
      (
        await fetch(`${base}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      ).json() as Promise<Record<string, unknown>>;
    const start = await call('/v1/integrations/pairing/start', startBody);
    const deviceCode = start.deviceCode as string;
    expect(await call('/v1/integrations/pairing/token', { deviceCode })).toEqual({
      error: 'authorization_pending',
    });
    expect(await call('/v1/integrations/pairing/token', { deviceCode })).toEqual({
      error: 'slow_down',
    });
  });

  it('status requires a well-formed credential and matches the status schema fields', async () => {
    const { base, post } = await boot({ autoApproveAfterPolls: 1 });
    const start = await post('/v1/integrations/pairing/start', startBody);
    const token = await post('/v1/integrations/pairing/token', {
      deviceCode: start.json.deviceCode,
    });
    expect(token.status).toBe(200);
    const credential = token.json.credential as string;

    const anon = await fetch(`${base}/v1/integrations/status`, { headers });
    expect(anon.status).toBe(401);
    const malformed = await fetch(`${base}/v1/integrations/status`, {
      headers: { ...headers, authorization: 'Bearer vti_short' },
    });
    expect(malformed.status).toBe(401);

    const res = await fetch(`${base}/v1/integrations/status`, {
      headers: { ...headers, authorization: `Bearer ${credential}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as StatusResponse;
    expect(Object.keys(body).sort()).toEqual(
      [
        'latestContract',
        'minContract',
        'pluginUpdateRecommended',
        'provider',
        'serverTime',
        'summary',
      ].sort(),
    );
    expect(body.provider).toBe('signalk');
    expect(Number.isInteger(body.minContract)).toBe(true);
    expect(Number.isInteger(body.latestContract)).toBe(true);
    expect(body.minContract).toBeLessThanOrEqual(CONTRACT_VERSION);
    expect(body.latestContract).toBeGreaterThanOrEqual(CONTRACT_VERSION);
    expect(body.pluginUpdateRecommended).toBe(false);
    expect(Number.isNaN(Date.parse(body.serverTime))).toBe(false);
    expect(body.summary === null || typeof body.summary === 'object').toBe(true);
  });

  it('fault injection: 503 with Retry-After, once, and 200 with minContract 2', async () => {
    const { base, post } = await boot({ autoApproveAfterPolls: 1 });
    await post('/__mock/fault', {
      route: 'pairing/start',
      status: 503,
      retryAfter: 120,
      once: true,
    });
    const res = await fetch(`${base}/v1/integrations/pairing/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(startBody),
    });
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('120');
    expect(((await res.json()) as { code: string }).code).toBe('integration_feature_unavailable');
    expect((await post('/v1/integrations/pairing/start', startBody)).status).toBe(200);

    await post('/__mock/fault', { route: 'status', status: 200, minContract: 2 });
    const status = await fetch(`${base}/v1/integrations/status`, { headers });
    const body = (await status.json()) as StatusResponse;
    expect(status.status).toBe(200);
    expect(body.minContract).toBe(2);
    expect(body.pluginUpdateRecommended).toBe(true);
  });
});

describe('mock request log', () => {
  it('never records the credential, device code or user code', async () => {
    const { base, post } = await boot({ autoApproveAfterPolls: 1 });
    const start = await post('/v1/integrations/pairing/start', startBody);
    const deviceCode = start.json.deviceCode as string;
    const userCode = start.json.userCode as string;
    await post('/__mock/approve', { userCode });
    const token = await post('/v1/integrations/pairing/token', { deviceCode });
    const credential = token.json.credential as string;
    await fetch(`${base}/v1/integrations/status`, {
      headers: { ...headers, authorization: `Bearer ${credential}` },
    });
    await post(
      '/v1/integrations/credential/rotate',
      {},
      {
        ...headers,
        authorization: `Bearer ${credential}`,
      },
    );

    const raw = await (await fetch(`${base}/__mock/log`)).text();
    const entries = (JSON.parse(raw) as { entries: { path: string; auth: boolean }[] }).entries;
    expect(entries.length).toBeGreaterThanOrEqual(4);
    expect(entries.some((e) => e.auth)).toBe(true);
    for (const secret of [credential, deviceCode, userCode, userCode.replace('-', '')]) {
      expect(raw).not.toContain(secret);
    }
    expect(raw).not.toMatch(/vti_/);
  });
});
