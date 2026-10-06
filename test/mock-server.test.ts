import { describe, expect, it } from 'vitest';
import { HttpClient } from '../src/http';
import { drainOnce } from '../src/drain';
import { PlaceholderIngestClient } from '../src/ingest';
import { runPairing } from '../src/pairing';
import { ReadingQueue } from '../src/queue';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const createMock = async (o?: { intervalS?: number; autoApproveS?: number; now?: () => number }) =>
  (await import('../dev/mock-server/handler.mjs')).createMock(o);
type Mock = Awaited<ReturnType<typeof createMock>>;
const CRED = /^vti_[A-Za-z0-9_-]{43}$/;
const H = { 'x-vesseltwin-contract': '1' };
const start = {
  method: 'POST',
  url: '/v1/integrations/pairing/start',
  body: { provider: 'signalk', requestedScopes: ['meters:write'] },
};

async function paired() {
  const m = await createMock({ intervalS: 0 });
  const s = (await m.handle(start)).body as { deviceCode: string };
  m.approve();
  const t = (
    await m.handle({
      method: 'POST',
      url: '/v1/integrations/pairing/token',
      body: { deviceCode: s.deviceCode },
    })
  ).body as { credential: string };
  return { m, cred: t.credential };
}

const reading = (n: number) => ({
  clientReadingId: `0199a000-0000-7000-8000-${String(n).padStart(12, '0')}`,
  path: 'propulsion.port.runTime',
  value: 3600 * n,
  recordedAt: '2026-10-05T12:00:00.000Z',
});
const post = (m: Mock, cred: string, body: unknown, q = '') =>
  m.handle({
    method: 'POST',
    url: `/v1/integrations/signalk/readings${q}`,
    headers: { ...H, authorization: `Bearer ${cred}` },
    body,
  });

describe('mock server', () => {
  it('pairing: pending until approved, then one credential in the platform format', async () => {
    const m = await createMock({ intervalS: 0 });
    const s = (await m.handle(start)).body as {
      deviceCode: string;
      userCode: string;
      interval: number;
    };
    expect(s.userCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const poll = () =>
      m.handle({
        method: 'POST',
        url: '/v1/integrations/pairing/token',
        body: { deviceCode: s.deviceCode },
      });
    expect(await poll()).toMatchObject({ status: 400, body: { error: 'authorization_pending' } });
    m.approve();
    const ok = await poll();
    expect(ok.status).toBe(200);
    expect((ok.body as { credential: string }).credential).toMatch(CRED);
    expect(await poll()).toMatchObject({ status: 400, body: { error: 'expired_token' } });
  });

  it('auto-approves after N seconds', async () => {
    let t = 0;
    const m = await createMock({ intervalS: 0, autoApproveS: 3, now: () => t });
    const s = (await m.handle(start)).body as { deviceCode: string };
    const poll = () =>
      m.handle({
        method: 'POST',
        url: '/v1/integrations/pairing/token',
        body: { deviceCode: s.deviceCode },
      });
    expect((await poll()).status).toBe(400);
    t = 3000;
    expect((await poll()).status).toBe(200);
  });

  it('status and rotate need the credential; rotate is single shot', async () => {
    const { m, cred } = await paired();
    const bad = await m.handle({ method: 'GET', url: '/v1/integrations/status', headers: H });
    expect(bad).toMatchObject({ status: 401, body: { code: 'integration_unauthorized' } });
    const ok = await m.handle({
      method: 'GET',
      url: '/v1/integrations/status',
      headers: { ...H, authorization: `Bearer ${cred}` },
    });
    expect(ok.body).toMatchObject({ provider: 'signalk', pluginUpdateRecommended: false });
    const rot = (
      await m.handle({
        method: 'POST',
        url: '/v1/integrations/credential/rotate',
        headers: { ...H, authorization: `Bearer ${cred}` },
      })
    ).body as { credential: string };
    expect(rot.credential).toMatch(CRED);
    const again = await m.handle({
      method: 'POST',
      url: '/v1/integrations/credential/rotate',
      headers: { ...H, authorization: `Bearer ${cred}` },
    });
    expect(again).toMatchObject({
      status: 409,
      body: { code: 'integration_credential_superseded' },
    });
  });

  it('readings: validates, stores, dedupes', async () => {
    const { m, cred } = await paired();
    const r1 = await post(m, cred, { readings: [reading(1), reading(2)] });
    expect(r1.body).toMatchObject({ results: [{ status: 'accepted' }, { status: 'accepted' }] });
    const r2 = await post(m, cred, { readings: [reading(1)] });
    expect(r2.body).toMatchObject({ results: [{ status: 'duplicate' }] });
    expect(m.state.readings).toHaveLength(2);
    expect(
      (await post(m, cred, { readings: [{ ...reading(3), path: 'navigation.position' }] })).status,
    ).toBe(400);
    expect((await post(m, cred, { readings: [{ ...reading(3), extra: 1 }] })).status).toBe(400);
    expect((await post(m, cred, { readings: [] })).status).toBe(400);
    const noContract = await m.handle({
      method: 'POST',
      url: '/v1/integrations/signalk/readings',
      headers: { authorization: `Bearer ${cred}` },
      body: { readings: [reading(4)] },
    });
    expect(noContract).toMatchObject({
      status: 400,
      body: { code: 'integration_contract_required' },
    });
  });

  it.each([
    ['401', 401, 'integration_unauthorized'],
    ['403', 403, 'integration_paused_plan'],
    ['503', 503, 'integration_feature_unavailable'],
    ['426', 426, 'integration_contract_unsupported'],
    ['429', 429, 'integration_rate_limited'],
  ])('fault %s', async (fault, status, code) => {
    const { m, cred } = await paired();
    const r = await post(m, cred, { readings: [reading(1)] }, `?fault=${fault}`);
    expect(r).toMatchObject({ status, body: { code } });
    if (status === 503 || status === 429) expect(r.headers['retry-after']).toBe('5');
    expect(m.state.readings).toHaveLength(0);
  });

  it('sticky fault with a count, and duplicate fault', async () => {
    const { m, cred } = await paired();
    await m.handle({ method: 'POST', url: '/__debug/fault', body: { fault: '500', count: 1 } });
    expect((await post(m, cred, { readings: [reading(1)] })).status).toBe(500);
    expect((await post(m, cred, { readings: [reading(1)] })).status).toBe(200);
    expect(
      (await post(m, cred, { readings: [reading(2)] }, '?fault=duplicate')).body,
    ).toMatchObject({
      results: [{ status: 'duplicate' }],
    });
  });
});

describe('plugin against the mock (in-process, no sockets)', () => {
  it('pairs, then drains a queue and acks everything the mock accepted', async () => {
    const m = await createMock({ intervalS: 0 });
    const f = async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      const out = await m.handle({
        method: init?.method ?? 'GET',
        url: u.pathname + u.search,
        headers: init?.headers as Record<string, string>,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      });
      return new Response(JSON.stringify(out.body), { status: out.status, headers: out.headers });
    };
    const http = new HttpClient({ baseUrl: 'http://localhost:4010', fetch: f, userAgent: 't/0' });
    const pairing = runPairing({
      http,
      clientName: 't',
      clientVersion: '0',
      deviceLabel: 'dev',
      scopes: ['meters:write'],
      onCode: () => {
        m.approve();
      },
      sleep: () => Promise.resolve(),
    });
    const out = await pairing;
    expect(out.kind).toBe('paired');
    if (out.kind !== 'paired') return;
    const dir = await mkdtemp(path.join(tmpdir(), 'vt-m-'));
    try {
      const q = new ReadingQueue({ dir, now: () => Date.parse('2026-10-05T12:30:00Z') });
      for (let i = 1; i <= 3; i++) await q.append(reading(i));
      const client = new PlaceholderIngestClient(http, () => Promise.resolve(out.token.credential));
      const d = await drainOnce(q, client);
      expect(d).toMatchObject({ acked: 3, counts: { accepted: 3 }, more: false });
      expect(m.state.readings).toHaveLength(3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
