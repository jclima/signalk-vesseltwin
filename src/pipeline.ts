import { CredentialStore } from './credential-store';
import { startCollector, type CollectorApp } from './collector';
import { uuidv7 } from './ids';
import { drainOnce } from './drain';
import { backoffDelay, HttpClient, type FetchLike } from './http';
import { PlaceholderIngestClient, type HaltReason, type IngestClient } from './ingest';
import { normalize } from './normalize';
import type { PluginOptions } from './config';
import { ReadingQueue } from './queue';
import { redactError } from './redact';
import { Sampler } from './sampler';
import type { Reading as WireReading } from './contract';

/** Developer switch. Upload is OFF unless this env var is exactly "1". */
export const DEV_UPLOAD_ENV = 'VESSELTWIN_DEV_UPLOAD';

export interface PipelineDeps {
  fetch?: FetchLike;
  env?: Record<string, string | undefined>;
  now?: () => number;
  /** Test seam: replaces the placeholder transport. */
  client?: IngestClient;
  drainIntervalMs?: number;
  userAgent?: string;
}

const HALT_TEXT: Record<HaltReason, string> = {
  reauth: 'Upload stopped: pair this boat with VesselTwin again.',
  update_required: 'Upload stopped: please update the VesselTwin plugin.',
  scope: 'Upload stopped: this connection is not allowed to send readings.',
  plugin_bug: 'Upload stopped: unexpected response. Please update the VesselTwin plugin.',
};

/**
 * collector -> normalize -> sampler -> queue -> drain loop. Disabled (no subscription, no
 * network, no files) unless VESSELTWIN_DEV_UPLOAD=1, so the released behaviour stays
 * "Data upload is not available in this version".
 */
export function createPipeline(app: CollectorApp, deps: PipelineDeps = {}) {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const drainEvery = deps.drainIntervalMs ?? 30_000;
  let stopCollector: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let chain: Promise<void> = Promise.resolve();
  let queue: ReadingQueue | null = null;
  let store: CredentialStore | null = null;
  let haltedCredential: string | null | undefined;
  let attempt = 0;
  let credCache: { at: number; has: boolean } = { at: 0, has: false };

  const enabled = () => env[DEV_UPLOAD_ENV] === '1';

  async function hasCredential(): Promise<boolean> {
    if (!store) return false;
    if (now() - credCache.at < 5_000) return credCache.has;
    const has = (await store.read().catch(() => null)) !== null;
    credCache = { at: now(), has };
    return has;
  }

  function schedule(ms: number, fn: () => Promise<void>): void {
    if (!running) return;
    timer = setTimeout(() => {
      timer = null;
      void fn().catch((err: unknown) => {
        app.error(`VesselTwin upload error: ${redactError(err)}`);
        schedule(backoffDelay(attempt++), tick);
      });
    }, ms);
  }

  async function tick(): Promise<void> {
    if (!running || !queue || !store) return;
    await queue.enforceCaps();
    const cred = await store.read().catch(() => null);
    if (!cred) {
      schedule(drainEvery, tick);
      return;
    }
    if (haltedCredential !== undefined && haltedCredential === cred.credentialId) {
      schedule(drainEvery, tick); // stay halted until the credential changes (re-pair)
      return;
    }
    haltedCredential = undefined;
    const client =
      deps.client ??
      new PlaceholderIngestClient(
        new HttpClient({
          baseUrl: currentOptions.apiBaseUrl,
          fetch: deps.fetch ?? ((u, i) => fetch(u, i)),
          userAgent: deps.userAgent ?? 'signalk-vesseltwin',
        }),
        async () => (await store?.read().catch(() => null))?.credential ?? null,
        now,
      );
    const out = await drainOnce(queue, client);
    if (out.stop) {
      const s = out.stop;
      if (s.kind === 'halt') {
        haltedCredential = cred.credentialId;
        app.setPluginError(HALT_TEXT[s.reason]);
        schedule(drainEvery, tick);
      } else if (s.kind === 'pause') {
        app.setPluginStatus('Upload paused by VesselTwin. Readings are kept and will be retried.');
        schedule(s.afterMs, tick);
      } else {
        const wait = Math.max(s.afterMs ?? 0, backoffDelay(attempt));
        attempt += 1;
        schedule(wait, tick);
      }
      return;
    }
    if (out.acked === 0 && out.more) {
      schedule(backoffDelay(attempt++), tick); // server answered but acknowledged nothing
      return;
    }
    attempt = 0;
    if (out.acked > 0) {
      app.setPluginStatus(`Uploading readings (DEV): last batch ${JSON.stringify(out.counts)}`);
      app.debug(`VesselTwin upload batch: ${JSON.stringify(out.counts)}`);
    }
    schedule(out.more ? 1_000 : drainEvery, tick);
  }

  let currentOptions: PluginOptions;
  const sampler = new Sampler();

  function onDelta(delta: unknown): void {
    chain = chain
      .then(async () => {
        if (!queue || !(await hasCredential())) return;
        for (const r of normalize(delta, now)) {
          if (!sampler.accept(r)) continue;
          const wire: WireReading = {
            clientReadingId: uuidv7(Date.parse(r.observedAt)),
            path: r.path,
            value: r.value,
            recordedAt: r.observedAt,
          };
          await queue.append(wire);
        }
      })
      .catch((err: unknown) => {
        app.error(`VesselTwin enqueue error: ${redactError(err)}`);
      });
  }

  return {
    enabled,
    start(options: PluginOptions): void {
      if (!enabled() || running) return;
      running = true;
      currentOptions = options;
      const dir = app.getDataDirPath();
      store = new CredentialStore(dir);
      queue = new ReadingQueue({
        dir: `${dir}/queue`,
        maxReadings: options.queueMaxReadings,
        now,
      });
      stopCollector = startCollector(
        app,
        options.categories,
        options.samplePeriodSeconds * 1000,
        onDelta,
      );
      schedule(1_000, tick);
    },
    stop(): void {
      running = false;
      if (timer) clearTimeout(timer);
      timer = null;
      stopCollector?.();
      stopCollector = null;
    },
    /** Test seam: resolves once queued deltas have been written. */
    idle: () => chain,
  };
}
