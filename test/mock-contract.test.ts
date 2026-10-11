import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
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

const headers = { 'user-agent': 'signalk-vesseltwin/test', 'x-vesseltwin-contract': '2' };
const startBody = {
  provider: 'signalk',
  clientName: 'signalk-vesseltwin',
  clientVersion: '0.0.0',
  contractVersion: 2,
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
    // The mock mirrors the real server window (min 1, latest 2): a contract-2 plugin is current.
    expect(out.updateRecommended).toBe(false);
    expect(out.clockSkewWarning).toBe(false);
    expect(out.info.minContract).toBe(1);
    expect(out.info.latestContract).toBe(2);
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
    expect(await probe({ status: 426, minContract: 3 })).toMatchObject({
      kind: 'update_required',
      stop: true,
    });
    expect(await probe({ status: 200, minContract: 3 })).toMatchObject({
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
    expect(body.pluginUpdateRecommended).toBe(CONTRACT_VERSION < body.latestContract);
    expect(body.summary).toBeNull();
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

    await post('/__mock/fault', { route: 'status', status: 200, minContract: 3 });
    const status = await fetch(`${base}/v1/integrations/status`, { headers });
    const body = (await status.json()) as StatusResponse;
    expect(status.status).toBe(200);
    expect(body.minContract).toBe(3);
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

// ---- contract v2: readings route and status summary ---------------------------------------------

const schemaDir = join(__dirname, '..', 'contracts', 'signalk', 'v2');
const ajv = new Ajv({ strict: true, allErrors: true });
addFormats(ajv);
const loadSchema = (n: string) =>
  ajv.compile(JSON.parse(readFileSync(join(schemaDir, `${n}.schema.json`), 'utf8')) as object);
const validateResponse = loadSchema('readings-response');
const validateRequest = loadSchema('readings-request');
const validateSummary = loadSchema('status-summary');

const READINGS = '/v1/integrations/signalk/readings';
const reading = (id: string, over: Record<string, unknown> = {}) => ({
  clientReadingId: id,
  path: 'electrical.batteries.house.voltage',
  value: 12.6,
  recordedAt: new Date().toISOString(),
  ...over,
});

describe('mock readings route (contract 2)', () => {
  async function paired() {
    const b = await boot({ autoApproveAfterPolls: 1 });
    const credential = await pairedCredential(b.post);
    const auth = { ...headers, authorization: `Bearer ${credential}` };
    const send = (readings: unknown, h: Record<string, string> = auth) =>
      b.post(READINGS, { readings }, h);
    return { ...b, credential, auth, send };
  }

  it('answers per item in request order, matching the response schema', async () => {
    const { send } = await paired();
    const now = Date.now();
    const batch = [
      reading('00000000-0000-4000-8000-000000000001'),
      reading('00000000-0000-4000-8000-000000000002', { path: 'navigation.position' }),
      reading('00000000-0000-4000-8000-000000000003', { value: null }),
      reading('00000000-0000-4000-8000-000000000004', { recordedAt: 'not a time' }),
      reading('00000000-0000-4000-8000-000000000005', {
        recordedAt: new Date(now + 3_600_000).toISOString(),
      }),
      reading('00000000-0000-4000-8000-000000000006', {
        recordedAt: new Date(now - 30 * 24 * 3_600_000).toISOString(),
      }),
    ];
    expect(validateRequest({ readings: batch })).toBe(true);
    const res = await send(batch);
    expect(res.status).toBe(200);
    expect(validateResponse(res.json), JSON.stringify(validateResponse.errors)).toBe(true);
    const results = res.json.results as {
      clientReadingId: string;
      status: string;
      reason?: string;
    }[];
    expect(results.map((r) => r.clientReadingId)).toEqual(batch.map((b) => b.clientReadingId));
    expect(results.map((r) => [r.status, r.reason])).toEqual([
      ['accepted', undefined],
      ['rejected', 'invalid_path'],
      ['rejected', 'invalid_value'],
      ['rejected', 'invalid_time'],
      ['rejected', 'future'],
      ['rejected', 'too_old'],
    ]);
  });

  it('rejects readings older than 8 days as too_old and accepts ones just inside the window', async () => {
    const { send } = await paired();
    const day = 24 * 3_600_000;
    const res = await send([
      reading('00000000-0000-4000-8000-0000000000b1', {
        recordedAt: new Date(Date.now() - 9 * day).toISOString(),
      }),
      reading('00000000-0000-4000-8000-0000000000b2', {
        recordedAt: new Date(Date.now() - 7.5 * day).toISOString(),
      }),
    ]);
    expect(
      (res.json.results as { status: string; reason?: string }[]).map((x) => [x.status, x.reason]),
    ).toEqual([
      ['rejected', 'too_old'],
      ['accepted', undefined],
    ]);
  });

  it('is idempotent: same id and body is a duplicate, same id with another body is invalid_id', async () => {
    const { send } = await paired();
    const id = '00000000-0000-4000-8000-0000000000aa';
    const r = reading(id);
    expect(((await send([r])).json.results as { status: string }[])[0]?.status).toBe('accepted');
    const again = await send([r, reading(id, { value: 13.1 })]);
    expect(validateResponse(again.json)).toBe(true);
    expect(
      (again.json.results as { status: string; reason?: string }[]).map((x) => [
        x.status,
        x.reason,
      ]),
    ).toEqual([
      ['duplicate', undefined],
      ['rejected', 'invalid_id'],
    ]);
  });

  it('requires contract 2 (426) and a live bearer credential (401)', async () => {
    const { send, auth, post } = await paired();
    const old = await send([reading('a')], { ...auth, 'x-vesseltwin-contract': '1' });
    expect(old.status).toBe(426);
    expect(old.json.code).toBe('integration_contract_unsupported');
    const none = await send([reading('a')], { ...headers });
    expect(none.status).toBe(401);
    const bad = await post(
      READINGS,
      { readings: [reading('a')] },
      { ...headers, authorization: `Bearer vti_${'A'.repeat(43)}` },
    );
    expect(bad.status).toBe(401);
  });

  it('rejects a malformed envelope with a code-less 400', async () => {
    const { send, post, auth } = await paired();
    for (const readings of [
      [],
      Array.from({ length: 501 }, (_, i) => reading(`id-${String(i)}`)),
    ]) {
      const res = await send(readings);
      expect(res.status).toBe(400);
      expect(res.json.code).toBeUndefined();
    }
    const extra = await post(READINGS, { readings: [reading('a')], more: 1 }, auth);
    expect(extra.status).toBe(400);
    const item = await send([{ ...reading('a'), extra: true }]);
    expect(item.status).toBe(400);
    expect(
      (await send(Array.from({ length: 500 }, (_, i) => reading(`id-${String(i)}`)))).status,
    ).toBe(200);
  });

  it('enforces a 512 KB body limit with 413 and keeps 64 KB for other routes', async () => {
    const { base, auth, send } = await paired();
    const big = await fetch(`${base}${READINGS}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify({ readings: [reading('a', { path: 'x'.repeat(600 * 1024) })] }),
    });
    expect(big.status).toBe(413);
    const mid = await send(
      Array.from({ length: 500 }, (_, k) =>
        reading(`${String(k)}-${'i'.repeat(60)}`, { path: 'x'.repeat(200) }),
      ),
    );
    expect(mid.status).toBe(200); // over 64 KB but under 512 KB: reaches the handler (items rejected)
    const small = await fetch(`${base}/v1/integrations/pairing/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ ...startBody, deviceLabel: 'x'.repeat(100 * 1024) }),
    });
    expect(small.status).toBe(413);
  });

  it('fault injection covers 401, 403, 503, 426, 429, 500 and 413 on the readings route', async () => {
    const { send, post } = await paired();
    const expectFault = async (fault: Record<string, unknown>) => {
      await post('/__mock/fault', { route: 'signalk/readings', once: true, ...fault });
      return send([reading('f')]);
    };
    const r401 = await expectFault({ status: 401 });
    expect([r401.status, r401.json.code]).toEqual([401, 'integration_unauthorized']);
    const r403 = await expectFault({ status: 403 });
    expect([r403.status, r403.json.code]).toEqual([403, 'integration_paused_plan']);
    const r503 = await expectFault({ status: 503 });
    expect([r503.status, r503.json.code]).toEqual([503, 'integration_feature_unavailable']);
    const r426 = await expectFault({ status: 426, minContract: 3 });
    expect([r426.status, r426.json.code, r426.json.minContract]).toEqual([
      426,
      'integration_contract_unsupported',
      3,
    ]);
    const r429 = await expectFault({ status: 429, retryAfter: 9 });
    expect(r429.status).toBe(429);
    const r500 = await expectFault({ status: 500 });
    expect([r500.status, r500.json.code]).toEqual([500, undefined]);
    const r413 = await expectFault({ status: 413 });
    expect([r413.status, r413.json.code]).toEqual([413, undefined]);
    expect((await send([reading('f')])).status).toBe(200); // once-only
  });

  it('a 429 fault carries Retry-After', async () => {
    const { base, auth, post } = await paired();
    await post('/__mock/fault', {
      route: 'signalk/readings',
      status: 429,
      retryAfter: 9,
      once: true,
    });
    const res = await fetch(`${base}${READINGS}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify({ readings: [reading('f')] }),
    });
    expect(res.headers.get('retry-after')).toBe('9');
  });
});

describe('mock status summary', () => {
  it('is null by default and follows /__mock/summary, validating against the schema', async () => {
    const { base, post } = await boot({ autoApproveAfterPolls: 1 });
    const credential = await pairedCredential(post);
    const get = async () =>
      (await (
        await fetch(`${base}/v1/integrations/status`, {
          headers: { ...headers, authorization: `Bearer ${credential}` },
        })
      ).json()) as StatusResponse;
    expect((await get()).summary).toBeNull();

    expect((await post('/__mock/summary', { channels: 3, awaitingSetup: 2, held: 1 })).status).toBe(
      200,
    );
    const body = await get();
    expect(validateSummary(body.summary), JSON.stringify(validateSummary.errors)).toBe(true);
    expect(body.summary).toEqual({ channels: 3, awaitingSetup: 2, held: 1 });

    const out = await checkStatus(plugClient(base), {
      credential,
      credentialOrigin: new URL(base).origin,
    });
    expect(out.kind === 'connected' && out.info.summary).toEqual({
      channels: 3,
      awaitingSetup: 2,
      held: 1,
    });

    expect(
      (await post('/__mock/summary', { channels: -1, awaitingSetup: 0, held: 0 })).status,
    ).toBe(400);
    await post('/__mock/summary', { summary: null });
    expect((await get()).summary).toBeNull();
    await post('/__mock/summary', { channels: 1, awaitingSetup: 0, held: 0 });
    await post('/__mock/reset', {});
    expect((await post('/__mock/summary', { summary: null })).status).toBe(200);
  });
});
