import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parseOptions } from '../src/config';
import { categoryFor, PATH_RULES } from '../src/mapping';
import { createPlugin, type SignalKApp } from '../src/plugin';

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
    const app = fakeApp('/tmp/does-not-exist-vt');
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
  it('defaults safely and rejects non-https remote URLs', () => {
    const d = parseOptions(undefined);
    expect(d.apiBaseUrl).toBe('https://api.vesseltwin.io');
    expect(d.categories.vesselInfo).toBe(false);
    expect(parseOptions({ apiBaseUrl: 'http://evil.example' }).apiBaseUrl).toBe(
      'https://api.vesseltwin.io',
    );
    expect(parseOptions({ apiBaseUrl: 'http://localhost:3001' }).apiBaseUrl).toBe(
      'http://localhost:3001',
    );
    expect(parseOptions({ queueMaxReadings: 10 ** 9 }).queueMaxReadings).toBe(50_000);
  });
});
