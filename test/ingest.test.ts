import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Reading } from '../src/contract';
import { drainOnce } from '../src/drain';
import { HttpClient, type FetchLike } from '../src/http';
import { PlaceholderIngestClient, type IngestClient } from '../src/ingest';
import { ReadingQueue } from '../src/queue';

const NOW = Date.parse('2026-10-05T12:00:00Z');
const wire = (n: number): Reading => ({
  clientReadingId: `id-${String(n)}`,
  path: 'propulsion.port.runTime',
  value: n,
  recordedAt: new Date(NOW).toISOString(),
});
const res = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

function client(fetchImpl: FetchLike, cred: string | null = 'vti_FAKEFAKEFAKEFAKE') {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f: FetchLike = (url, init) => {
    calls.push({ url, ...(init ? { init } : {}) });
    return fetchImpl(url, init);
  };
  const http = new HttpClient({ baseUrl: 'http://localhost:4010', fetch: f, userAgent: 'test/0' });
  return {
    c: new PlaceholderIngestClient(
      http,
      () => Promise.resolve(cred),
      () => NOW,
    ),
    calls,
  };
}

describe('PlaceholderIngestClient', () => {
  it('posts readings with bearer + contract header and maps per-item statuses', async () => {
    const { c, calls } = client(() =>
      Promise.resolve(
        res(200, {
          results: [
            { clientReadingId: 'id-1', status: 'accepted' },
            { clientReadingId: 'id-2', status: 'duplicate' },
            { clientReadingId: 'id-3', status: 'held_unmapped' },
            { clientReadingId: 'id-4', status: 'rejected:future' },
            { clientReadingId: 'id-5', status: 'skipped_downsampled' },
            { clientReadingId: 'id-6', status: 'weird' },
          ],
        }),
      ),
    );
    const out = await c.sendBatch([wire(1)]);
    expect(out).toEqual({
      kind: 'ok',
      items: [
        { clientReadingId: 'id-1', status: 'accepted' },
        { clientReadingId: 'id-2', status: 'duplicate' },
        { clientReadingId: 'id-3', status: 'held' },
        { clientReadingId: 'id-4', status: 'rejected' },
        { clientReadingId: 'id-5', status: 'skipped' },
      ],
    });
    const call = calls[0];
    expect(call?.url).toBe('http://localhost:4010/v1/integrations/signalk/readings');
    const h = call?.init?.headers as Record<string, string>;
    expect(h.authorization).toBe('Bearer vti_FAKEFAKEFAKEFAKE');
    expect(h['x-vesseltwin-contract']).toBe('1');
    expect(JSON.parse(call?.init?.body as string)).toEqual({ readings: [wire(1)] });
  });

  it.each([
    [401, { code: 'integration_unauthorized' }, {}, { kind: 'halt', reason: 'reauth' }],
    [
      426,
      { code: 'integration_contract_unsupported' },
      {},
      { kind: 'halt', reason: 'update_required' },
    ],
    [400, { code: 'integration_contract_required' }, {}, { kind: 'halt', reason: 'plugin_bug' }],
    [400, { message: 'Validation failed' }, {}, { kind: 'halt', reason: 'plugin_bug' }],
    [403, { code: 'integration_scope' }, {}, { kind: 'halt', reason: 'scope' }],
    [403, { code: 'integration_paused_plan' }, {}, { kind: 'pause', afterMs: 3600_000 }],
    [
      503,
      { code: 'integration_feature_unavailable' },
      { 'retry-after': '7200' },
      { kind: 'pause', afterMs: 7_200_000 },
    ],
    [
      429,
      { code: 'integration_rate_limited' },
      { 'retry-after': '30' },
      { kind: 'retry', afterMs: 30_000 },
    ],
    [500, {}, {}, { kind: 'retry', afterMs: null }],
  ])('status %i maps to %j', async (status, body, headers, expected) => {
    const { c } = client(() => Promise.resolve(res(status, body, headers)));
    expect(await c.sendBatch([wire(1)])).toEqual(expected);
  });

  it('network errors retry; missing credential halts without a request', async () => {
    const fail = client(() => Promise.reject(new Error('boom')));
    expect(await fail.c.sendBatch([wire(1)])).toEqual({ kind: 'retry', afterMs: null });
    const none = client(() => Promise.resolve(res(200, {})), null);
    expect(await none.c.sendBatch([wire(1)])).toEqual({ kind: 'halt', reason: 'reauth' });
    expect(none.calls).toHaveLength(0);
  });
});

describe('drainOnce', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'vt-d-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('acks only readings the server answered for; keeps the rest', async () => {
    const q = new ReadingQueue({ dir, now: () => NOW });
    for (let i = 1; i <= 4; i++) await q.append(wire(i));
    const c: IngestClient = {
      sendBatch: () =>
        Promise.resolve({
          kind: 'ok' as const,
          items: [
            { clientReadingId: 'id-1', status: 'accepted' as const },
            { clientReadingId: 'id-3', status: 'held' as const },
            { clientReadingId: 'not-ours', status: 'accepted' as const },
          ],
        }),
    };
    const out = await drainOnce(q, c);
    expect(out).toMatchObject({
      acked: 2,
      counts: { accepted: 1, held: 1 },
      more: true,
      stop: null,
    });
    expect((await q.peek(10)).map((r) => r.clientReadingId)).toEqual(['id-2', 'id-4']);
  });

  it('removes nothing on retry, pause or halt', async () => {
    const q = new ReadingQueue({ dir, now: () => NOW });
    await q.append(wire(1));
    for (const r of [
      { kind: 'retry' as const, afterMs: 5 },
      { kind: 'pause' as const, afterMs: 5 },
      { kind: 'halt' as const, reason: 'reauth' as const },
    ]) {
      const out = await drainOnce(q, { sendBatch: () => Promise.resolve(r) });
      expect(out.stop).toEqual(r);
      expect(await q.size()).toBe(1);
    }
  });

  it('is a no-op on an empty queue', async () => {
    const q = new ReadingQueue({ dir, now: () => NOW });
    const out = await drainOnce(q, { sendBatch: () => Promise.reject(new Error('unreachable')) });
    expect(out).toEqual({ acked: 0, counts: {}, stop: null, more: false });
  });
});
