import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CollectorApp, SubscriptionManagerLike } from '../src/collector';
import { CredentialStore } from '../src/credential-store';
import { parseOptions } from '../src/config';
import type { Reading } from '../src/contract';
import type { BatchResult, IngestClient } from '../src/ingest';
import { createPipeline } from '../src/pipeline';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'vt-p-'));
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true });
});

function fakeApp() {
  const subs: {
    sub: Parameters<SubscriptionManagerLike['subscribe']>[0];
    push: (d: unknown) => void;
  }[] = [];
  let unsub = 0;
  const app: CollectorApp & { statuses: string[]; errors: string[] } = {
    statuses: [],
    errors: [],
    getDataDirPath: () => dir,
    getSelfPath: () => undefined,
    setPluginStatus: (m) => app.statuses.push(m),
    setPluginError: (m) => app.errors.push(m),
    debug: () => undefined,
    error: (m) => app.errors.push(m),
    subscriptionmanager: {
      subscribe(sub, unsubscribes, _err, onDelta) {
        subs.push({ sub, push: onDelta });
        unsubscribes.push(() => {
          unsub += 1;
        });
      },
    },
  };
  return { app, subs, unsubs: () => unsub };
}

const delta = (path: string, value: number, ts: string) => ({
  context: 'vessels.self',
  updates: [{ timestamp: ts, values: [{ path, value }] }],
});
const pair = (apiOrigin: string | null = 'https://api.vesseltwin.io') =>
  new CredentialStore(dir).write({
    apiOrigin,
    credential: 'vti_FAKEFAKEFAKEFAKEFAKE',
    credentialId: 'cid',
    vesselLabel: null,
    pairedAt: '',
  });

describe('pipeline gate', () => {
  it('does nothing unless the dev switch is exactly "1"', () => {
    for (const env of [{}, { VESSELTWIN_DEV_UPLOAD: '0' }, { VESSELTWIN_DEV_UPLOAD: 'true' }]) {
      const f = fakeApp();
      const fetchSpy = vi.fn();
      const p = createPipeline(f.app, { env, fetch: fetchSpy });
      p.start(parseOptions({}));
      expect(f.subs).toHaveLength(0);
      p.stop();
      expect(fetchSpy).not.toHaveBeenCalled();
    }
  });

  it('is a no-op without a subscription manager', () => {
    const f = fakeApp();
    delete f.app.subscriptionmanager;
    const p = createPipeline(f.app, { env: { VESSELTWIN_DEV_UPLOAD: '1' } });
    p.start(parseOptions({}));
    p.stop();
  });
});

describe('pipeline (enabled)', () => {
  const env = { VESSELTWIN_DEV_UPLOAD: '1' };

  it('subscribes to self-vessel permitted paths only, honouring category switches', () => {
    const f = fakeApp();
    const p = createPipeline(f.app, { env });
    p.start(parseOptions({ sendTanks: false, samplePeriodSeconds: 30 }));
    const sub = f.subs[0]?.sub;
    expect(sub?.context).toBe('vessels.self');
    const paths = sub?.subscribe.map((s) => s.path) ?? [];
    expect(paths).toContain('propulsion.*.runTime');
    expect(paths).toContain('electrical.batteries.*.voltage');
    expect(paths.some((x) => x.startsWith('tanks'))).toBe(false);
    expect(paths).not.toContain('*');
    expect(sub?.subscribe.every((s) => s.period === 30_000)).toBe(true);
    p.stop();
    expect(f.unsubs()).toBe(1);
  });

  it('enqueues sampled readings only once paired, then drains and acks', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const f = fakeApp();
    const sent: Reading[][] = [];
    const client: IngestClient = {
      sendBatch: (rs): Promise<BatchResult> => {
        sent.push(rs);
        return Promise.resolve({
          kind: 'ok',
          items: rs.map((r) => ({ clientReadingId: r.clientReadingId, status: 'accepted' })),
        });
      },
    };
    let clock = Date.parse('2026-10-05T12:05:00Z');
    const p = createPipeline(f.app, { env, client, drainIntervalMs: 10_000, now: () => clock });
    p.start(parseOptions({}));
    const push = f.subs[0]?.push;
    push?.(delta('propulsion.port.runTime', 3600, '2026-10-05T12:00:00Z')); // not paired: dropped
    await p.idle();
    await pair();
    clock += 6_000; // credential cache expires
    push?.(delta('propulsion.port.runTime', 7200, '2026-10-05T12:01:00Z'));
    push?.(delta('navigation.position', 1, '2026-10-05T12:01:00Z'));
    push?.(delta('propulsion.port.runTime', 7210, '2026-10-05T12:02:00Z')); // downsampled
    await p.idle();
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(sent[0]).toHaveLength(1);
    expect(sent[0]?.[0]).toMatchObject({
      path: 'propulsion.port.runTime',
      value: 7200,
      recordedAt: '2026-10-05T12:01:00.000Z',
    });
    expect(Object.keys(sent[0]?.[0] ?? {}).sort()).toEqual([
      'clientReadingId',
      'path',
      'recordedAt',
      'value',
    ]);
    p.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(await readdir(path.join(dir, 'queue'))).toEqual([]); // acked and removed
  });

  it('halts on 401 and keeps the queue', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await pair();
    const f = fakeApp();
    let calls = 0;
    const client: IngestClient = {
      sendBatch: () => {
        calls += 1;
        return Promise.resolve({ kind: 'halt', reason: 'reauth' });
      },
    };
    const p = createPipeline(f.app, { env, client, drainIntervalMs: 10_000 });
    p.start(parseOptions({}));
    f.subs[0]?.push(delta('propulsion.port.runTime', 7200, new Date().toISOString()));
    await p.idle();
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => {
      expect(calls).toBe(1);
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toBe(1); // no loop on a halt
    expect(f.app.errors.at(-1)).toMatch(/pair this boat/);
    p.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['another origin', 'http://localhost:3001'],
    ['no recorded origin (older file)', null],
  ])('refuses to send when the credential is bound to %s', async (_n, bound) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await pair(bound);
    const f = fakeApp();
    const fetchSpy = vi.fn();
    const p = createPipeline(f.app, { env, fetch: fetchSpy, drainIntervalMs: 10_000 });
    p.start(parseOptions({}));
    f.subs[0]?.push(delta('propulsion.port.runTime', 7200, new Date().toISOString()));
    await p.idle();
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => {
      expect(f.app.errors.at(-1)).toMatch(/Pair this boat with VesselTwin again/);
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(JSON.stringify([f.app.errors, f.app.statuses])).not.toContain('vti_');
    p.stop();
  });
});
