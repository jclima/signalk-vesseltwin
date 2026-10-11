import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { startCollector, type SubscriptionManagerLike } from './collector';
import { CredentialStore, isTombstone } from './credential-store';
import { SCOPES } from './contract';
import {
  apiOrigin,
  configSchema,
  parseOptions,
  type ChannelOptions,
  type PluginOptions,
} from './config';
import { HttpClient, type FetchLike } from './http';
import { matchPath, PATH_RULES } from './mapping';
import { runPairing } from './pairing';
import { ReadingQueue } from './queue';
import { redact, redactError } from './redact';
import { createSampler, QueueSink, type ReadingSink } from './sampler';
import {
  StatusMonitor,
  type MonitorSnapshot,
  type MonitorState,
  type PauseReason,
  type Scheduler,
} from './status';
import { Uploader, type UploaderEvent, type UploadSnapshot } from './uploader';

/** The slice of the SignalK server API this plugin uses (kept minimal; no runtime dependency). */
export interface SignalKApp {
  getDataDirPath(): string;
  getSelfPath(path: string): unknown;
  setPluginStatus(msg: string): void;
  setPluginError(msg: string): void;
  debug(msg: string): void;
  error(msg: string): void;
  /** Optional: only needed once upload is active. Its absence is reported, never worked around. */
  subscriptionmanager?: SubscriptionManagerLike;
}

/** Minimal structural view of the request: only the headers the origin check needs. */
export interface RequestLike {
  headers?: Record<string, string | string[] | undefined>;
}
export type RouteHandler = (req: RequestLike, res: ResponseLike) => void | Promise<void>;
export interface RouterLike {
  get(path: string, h: RouteHandler): void;
  post(path: string, h: RouteHandler): void;
}
export interface ResponseLike {
  status(code: number): ResponseLike;
  json(body: unknown): void;
}

export const PLUGIN_ID = 'signalk-vesseltwin';
export const PLUGIN_VERSION = '0.1.1';

export interface PluginDeps {
  fetch?: FetchLike;
  /** Test seams for the status monitor. */
  now?: () => number;
  rng?: () => number;
  scheduler?: Scheduler;
  /** Test seam: defaults to UPLOAD_AVAILABLE. */
  uploadAvailable?: boolean;
}

export type PairingFailure =
  | 'expired'
  | 'denied'
  | 'unavailable'
  | 'busy'
  | 'update_required'
  | 'rejected'
  | 'unexpected_response'
  | 'local_failure';

export type PluginState =
  | 'not_paired'
  | 'pairing'
  | 'pairing_failed'
  | 'checking'
  | 'connected'
  | 'paused'
  | 'offline'
  | 'update_required'
  | 'reauth_required'
  | 'config_error';

/** Upload is built but not released. Flip only together with the release work (copy, README, docs). */
const UPLOAD_AVAILABLE = false;

const NO_UPLOAD = 'Data upload is not available in this version.';

/** Neutral copy per failed pairing outcome. Never shows raw server codes. */
export const FAILURE_COPY: Record<PairingFailure, string> = {
  expired:
    'The pairing code expired. Start pairing again. If this keeps happening, VesselTwin integrations may not be enabled for your account yet.',
  denied: 'Pairing was declined in VesselTwin. Start pairing again if that was a mistake.',
  unavailable: 'VesselTwin is not available right now. Try again later.',
  busy: 'VesselTwin is busy. Try pairing again in a few minutes.',
  update_required: 'This plugin version is not supported by VesselTwin. Update the plugin.',
  rejected:
    'VesselTwin could not start pairing with this plugin. Check for a plugin update, then try again.',
  unexpected_response:
    'VesselTwin sent an unexpected answer. Remove this connection in VesselTwin, check for a plugin update, and pair again.',
  local_failure:
    'Pairing finished but the connection could not be saved. Check the plugin data folder permissions, then remove this connection in VesselTwin and pair again.',
};

export const COPY = {
  notPaired: 'Not paired. Open VesselTwin under Webapps in the SignalK admin UI to pair.',
  reauth: `Pairing with VesselTwin is no longer valid. Pair again. ${NO_UPLOAD}`,
  reauthOrigin: `The VesselTwin API address changed since pairing. Pair again, or restore the previous address. ${NO_UPLOAD}`,
  credentialUnreadable:
    'Cannot read the stored VesselTwin connection. Check the permissions of the plugin data folder.',
  notRunning: 'The VesselTwin plugin is not running. Enable it first.',
  starting: 'The VesselTwin plugin is starting. Try again in a moment.',
  pairingInProgress:
    'Pairing in progress. Open VesselTwin under Webapps, signed in as an administrator, to see the code.',
  nothingToCancel: 'No pairing is waiting for approval.',
  alreadyPaired: 'Already paired. Unpair first to pair again.',
  unpairFailed: 'Could not remove the stored connection. Try again.',
  unpaired:
    'Unpaired on this server. Also revoke the connection in VesselTwin so it stops working there.',
  forbidden: 'Request not allowed.',
} as const;

function header(req: RequestLike, name: string): string | undefined {
  const v = req.headers?.[name];
  return Array.isArray(v) ? v[0] : v;
}

/** Browser-driven cross-site requests carry an Origin that differs from Host; reject those. */
function sameOriginOrNone(req: RequestLike): boolean {
  const origin = header(req, 'origin');
  if (origin === undefined) return true; // curl and scripts send none
  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase(); // `Origin: null` and junk throw
  } catch {
    return false;
  }
  // Browsers set Sec-Fetch-Site themselves and page scripts cannot forge it. It also covers a
  // reverse proxy that rewrites Host.
  const site = header(req, 'sec-fetch-site')?.toLowerCase();
  if (site === 'same-origin' || site === 'none') return true;
  const host = header(req, 'host');
  return host !== undefined && originHost === host.toLowerCase();
}

/** The label comes from the server; keep it short and printable before showing it. */
function cleanLabel(v: string | null | undefined): string | null {
  // Control characters and invisible format characters (bidi overrides, zero-width).
  // eslint-disable-next-line no-control-regex
  const t = (v ?? '').replace(/[\u0000-\u001f\u007f-\u009f\p{Cf}]/gu, ' ').trim();
  return t ? t.slice(0, 80) : null;
}

/** Everything that runs while upload is active: one queue, one collector, one uploader. */
interface Pipeline {
  token: number;
  queue: ReadingQueue;
  uploader: Uploader;
  collector: { stop(): void } | null;
  origin: string;
  pairedAt: string | undefined;
}

export const SUBSCRIPTIONS_UNAVAILABLE = 'subscriptions_unavailable';

interface PendingPairing {
  userCode: string;
  verificationUrl: string;
  expiresAt: number;
}

export function createPlugin(app: SignalKApp, deps: PluginDeps = {}) {
  let options: PluginOptions = parseOptions({});
  let store: CredentialStore | null = null;
  /** Bumped by start() and stop(); late async results of an older lifecycle are ignored. */
  let epoch = 0;
  let loaded = false;
  const now = deps.now ?? Date.now;
  const uploadAvailable = deps.uploadAvailable ?? UPLOAD_AVAILABLE;
  let abort: AbortController | null = null;
  let pairing: PendingPairing | null = null;
  /**
   * The owner approved: the credential is being saved and the monitor started. Reported as
   * `checking` so /status never shows `not_paired` mid-transition.
   */
  let finalizing = false;
  let unpairing = false; // an unpair is clearing the store; no new pairing may start meanwhile
  let failure: PairingFailure | null = null;
  let credentialUnreadable = false;
  /** A credential file exists (it is kept in reauth_required until a new pairing overwrites it). */
  let hasCredential = false;
  /** Set by unpair: keeps the revoke reminder in the status line until the next start or pairing. */
  let unpairedNotice = false;
  let vesselLabel: string | null = null;
  let monitor: StatusMonitor | null = null;
  /** The API origin the running monitor's credential was issued for (null: unknown or no monitor). */
  let credentialOrigin: string | null = null;
  /**
   * An error line was last handed to the server. SignalK keeps the last error until it is replaced,
   * so a later non-error state clears it explicitly (see report()).
   */
  let errorShown = false;
  let snap: MonitorSnapshot | null = null;
  /** The in-flight tombstone write, so unpair and a new pairing never race it. */
  let tombstoneWrite: Promise<void> | null = null;
  /**
   * The in-flight credential write (and the stale-run cleanup that may follow it). start() waits for
   * it before reading, so a pairing that outlived stop() cannot delete a credential the next
   * lifecycle just loaded, or leave a file behind that the next lifecycle did not see.
   */
  let persisting: Promise<'kept' | 'stale' | 'failed'> | null = null;
  /** The in-flight unpair (waiting for writers, then clearing the store); start() waits for it too. */
  let unpairWork: Promise<void> | null = null;
  /** The credential file could not be restricted to this user (admin-only /status warning). */
  let permissionWarning = false;
  let permissionLogged = false;
  /** Running collector, uploader and queue (null while upload is off, unpaired or unavailable). */
  let pipe: Pipeline | null = null;
  let pipeSeq = 0;
  /** The previous pipeline's queue is closing; start() and unpair wait for it (single writer). */
  let stopping: Promise<void> | null = null;
  /** Sticky for the lifecycle: wins over whatever the status monitor says. */
  let sticky: 'reauth_required' | 'update_required' | null = null;
  /** The readings route said paused; cleared when the monitor reports connected. */
  let uploadPaused: PauseReason | null = null;
  /** Upload is on but the server offers no subscription manager. */
  let subscriptionsMissing = false;

  const client = (baseUrl: string) =>
    new HttpClient({
      baseUrl,
      fetch: deps.fetch ?? ((u, i) => fetch(u, i)),
      userAgent: `${PLUGIN_ID}/${PLUGIN_VERSION}`,
    });

  function stopMonitor(): void {
    monitor?.stop();
    monitor = null;
    snap = null;
    credentialOrigin = null;
  }

  const queueDir = (): string => path.join(app.getDataDirPath(), 'queue');

  /** Stops the collector and the uploader; the queue and its counters stay (a re-pair clears them). */
  function haltUpload(): void {
    const p = pipe;
    if (!p) return;
    p.collector?.stop();
    p.collector = null;
    void p.uploader.stop();
  }

  /** Synchronous: stops everything upload-related and starts closing the queue in the background. */
  function stopPipeline(): void {
    const p = pipe;
    pipe = null;
    uploadPaused = null;
    subscriptionsMissing = false;
    if (!p) return;
    p.collector?.stop();
    const settled = p.uploader.stop(); // aborts an in-flight request right now
    const before = stopping;
    stopping = (async () => {
      await before;
      await settled;
      await p.queue.close();
    })().catch((err: unknown) => {
      app.debug(`closing the queue failed: ${redactError(err)}`);
    });
  }

  function stopSession(): void {
    stopMonitor();
    stopPipeline();
  }

  /** Best effort. Never throws: a queue that cannot be cleared must not break unpair or pairing. */
  async function clearQueue(): Promise<void> {
    if (!uploadAvailable) return;
    try {
      await stopping;
      const dir = queueDir();
      try {
        await fsp.access(dir);
      } catch {
        return; // nothing was ever queued; do not create the directory
      }
      const q = new ReadingQueue({ dir });
      await q.clear();
      await q.close();
    } catch (err) {
      app.debug(`clearing the queue failed: ${redactError(err)}`);
    }
  }

  function startPipeline(
    credential: string,
    credentialOrigin_: string | null,
    pairedAt: string | undefined,
  ): void {
    if (!uploadAvailable) return;
    const baseUrl = options.apiBaseUrl;
    const origin = baseUrl === null ? null : apiOrigin(baseUrl);
    if (
      !options.uploadEnabled ||
      options.activeCategories.length === 0 ||
      baseUrl === null ||
      origin === null ||
      credentialOrigin_ !== origin
    ) {
      return;
    }
    const sm = app.subscriptionmanager;
    if (!sm) {
      subscriptionsMissing = true;
      return;
    }
    const upload = options.upload;
    const active = new Set<string>(options.activeCategories);
    const isActive = (p: string): boolean => {
      const m = matchPath(p);
      if (!m || !active.has(m.category)) return false;
      const c = upload[m.category];
      return c.instanceMode === 'all' || c.instanceIds.includes(m.instance);
    };
    const token = ++pipeSeq;
    const queue = new ReadingQueue({
      dir: queueDir(),
      maxReadings: options.queueMaxReadings,
      ...(deps.now ? { now: deps.now } : {}),
    });
    const uploader = new Uploader({
      queue,
      baseUrl,
      credential,
      credentialOrigin: origin,
      fetch: deps.fetch ?? ((u, i) => fetch(u, i)),
      userAgent: `${PLUGIN_ID}/${PLUGIN_VERSION}`,
      intervalMs: upload.uploadIntervalMinutes * 60_000,
      isActive,
      onEvent: (e) => {
        onUploaderEvent(token, e);
      },
      log: (msg) => {
        app.debug(msg);
      },
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.rng ? { rng: deps.rng } : {}),
      ...(deps.scheduler ? { scheduler: deps.scheduler } : {}),
    });
    const inner = new QueueSink(queue, now);
    const sink: ReadingSink = {
      write: async (r) => {
        if (pipe?.token !== token) return; // stopped or replaced: nothing may reach the queue
        await inner.write(r);
        void uploader.refreshStats();
      },
    };
    const sampler = createSampler({ options: upload, sink, now });
    const collector = startCollector({
      sm,
      rules: PATH_RULES.filter((r) => active.has(r.category)),
      onDelta: (d) => {
        sampler.handleDelta(d).catch((err: unknown) => {
          app.debug(`reading not recorded: ${redactError(err)}`);
        });
      },
      onError: (msg) => {
        app.debug(`subscription error: ${msg}`);
      },
    });
    pipe = { token, queue, uploader, collector, origin: credentialOrigin_, pairedAt };
    uploader.start();
  }

  function onUploaderEvent(token: number, e: UploaderEvent): void {
    const p = pipe;
    if (p?.token !== token) return;
    switch (e.kind) {
      case 'paused':
        uploadPaused = e.reason;
        break;
      case 'update_required':
        sticky = 'update_required';
        break;
      case 'reauth':
        sticky = 'reauth_required';
        haltUpload();
        stopMonitor();
        if (e.tombstone) recordReauth(p.origin, p.pairedAt);
        break;
      case 'changed':
        break;
    }
    report();
  }

  /** The monitor gates the uploader: paused or unsupported holds it, connected releases it. */
  function syncUploader(s: MonitorSnapshot): void {
    const p = pipe;
    if (!p) return;
    switch (s.state) {
      case 'connected':
        uploadPaused = null;
        p.uploader.resume();
        break;
      case 'paused':
      case 'update_required':
      case 'stopped':
        p.uploader.hold();
        break;
      case 'reauth_required':
        haltUpload();
        break;
      default:
        break;
    }
  }

  function startMonitor(
    credential: string,
    credentialOrigin_: string | null,
    pairedAt?: string,
  ): void {
    stopSession();
    const baseUrl = options.apiBaseUrl;
    const origin = baseUrl === null ? null : apiOrigin(baseUrl);
    if (baseUrl === null || origin === null) return;
    const m = new StatusMonitor({
      http: client(baseUrl),
      credential,
      credentialOrigin: credentialOrigin_,
      apiOrigin: origin,
      onUpdate: (s) => {
        if (monitor !== m) return;
        snap = s;
        syncUploader(s);
        report();
      },
      onUnauthorized: (tombstone) => {
        // Only the platform's own "credential is bad" answer retires the file. Any other 401 (a
        // proxy, a captive portal) stops probing but leaves the credential for the next start.
        if (monitor !== m) return;
        haltUpload();
        if (tombstone) recordReauth(credentialOrigin_, pairedAt);
      },
      log: (msg) => {
        app.debug(msg);
      },
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.rng ? { rng: deps.rng } : {}),
      ...(deps.scheduler ? { scheduler: deps.scheduler } : {}),
    });
    monitor = m;
    credentialOrigin = credentialOrigin_;
    snap = m.snapshot();
    m.start();
    startPipeline(credential, credentialOrigin_, pairedAt);
  }

  /**
   * After a 401 the credential is dead: replace the file with a secret-free tombstone so a restart
   * does not send the dead credential again. Best effort; a failure is only logged.
   */
  function recordReauth(origin: string | null, pairedAt: string | undefined): void {
    const s = store;
    if (!s) return;
    const w = s
      .writeTombstone({
        reauthRequired: true,
        vesselLabel,
        apiOrigin: origin,
        ...(pairedAt ? { pairedAt } : {}),
      })
      .catch((err: unknown) => {
        app.debug(`could not record the re-pair requirement: ${redactError(err)}`);
      })
      .finally(() => {
        if (tombstoneWrite === w) tombstoneWrite = null;
      });
    tombstoneWrite = w;
  }

  /** Sticky states and an upload pause win over what the monitor last said. */
  function effective(): MonitorState {
    if (sticky) return sticky;
    const s = snap?.state ?? 'checking';
    if (uploadPaused && (s === 'connected' || s === 'checking' || s === 'offline')) return 'paused';
    return s;
  }

  function state(): PluginState {
    if (options.configError !== null || credentialUnreadable) return 'config_error';
    if (pairing) return 'pairing';
    if (finalizing) return 'checking';
    if (failure) return 'pairing_failed';
    if (!hasCredential) return 'not_paired';
    switch (effective()) {
      case 'connected':
        return 'connected';
      case 'paused':
        return 'paused';
      case 'offline':
        return 'offline';
      case 'update_required':
      case 'stopped': // 403 for scope: a plugin bug; the remedy for the user is the same
        return 'update_required';
      case 'reauth_required':
        return 'reauth_required';
      default:
        return 'checking';
    }
  }

  function message(st: PluginState = state()): string {
    const lead = vesselLabel ? `Paired with ${vesselLabel}` : 'Paired with VesselTwin';
    const pausedReason: PauseReason | null = uploadPaused ?? snap?.pausedReason ?? null;
    // The "not available" sentence goes away once upload is built in (the flag is flipped at release).
    const tail = uploadAvailable ? '' : ` ${NO_UPLOAD}`;
    const strip = (t: string): string => (uploadAvailable ? t.replace(` ${NO_UPLOAD}`, '') : t);
    switch (st) {
      case 'config_error':
        return options.configError ?? COPY.credentialUnreadable;
      case 'not_paired':
        return unpairedNotice ? COPY.unpaired : COPY.notPaired;
      case 'pairing':
        // The status line is broadcast to every SignalK client, including read-only and anonymous
        // ones. The code is only in the admin-only /status response.
        return COPY.pairingInProgress;
      case 'pairing_failed':
        return FAILURE_COPY[failure ?? 'unavailable'];
      case 'checking':
        if (finalizing) return `Pairing approved. Saving the connection.${tail}`;
        return `${lead}. Checking the connection.${tail}`;
      case 'connected': {
        // `updateRecommended` is only an informational hint in the admin /status response. A newer
        // server contract does not mean a newer plugin exists, so the broadcast line never claims it.
        const extras = [
          snap?.clockSkewWarning
            ? "This device's clock differs from VesselTwin's. Check the date and time."
            : '',
        ].filter(Boolean);
        let upline = NO_UPLOAD;
        if (uploadAvailable) {
          upline = subscriptionsMissing
            ? 'This server cannot provide readings to the plugin.'
            : options.uploadEnabled && options.activeCategories.length > 0
              ? 'Selected readings are sent to VesselTwin.'
              : 'Sending readings is off.';
        }
        return `${lead}. ${extras.length ? `${extras.join(' ')} ` : ''}${upline}`;
      }
      case 'paused':
        return pausedReason === 'plan'
          ? `${lead}. The connection is paused for your VesselTwin plan. The plugin will keep checking.${tail}`
          : `${lead}. VesselTwin integrations are not available for your account right now. The plugin will keep checking.${tail}`;
      case 'offline':
        return `${lead}. Cannot reach VesselTwin right now. The plugin will keep trying.${tail}`;
      case 'update_required':
        return `${lead}. This plugin version is not supported by VesselTwin. Update the plugin.${tail}`;
      case 'reauth_required': {
        // A credential issued for another origin never reached the network (no 401): say what changed.
        const configured = options.apiBaseUrl === null ? null : apiOrigin(options.apiBaseUrl);
        return strip(
          monitor && credentialOrigin !== null && credentialOrigin !== configured
            ? COPY.reauthOrigin
            : COPY.reauth,
        );
      }
    }
  }

  function report(): void {
    if (!loaded && options.configError === null) return;
    const st = state();
    const msg = message(st);
    if (
      st === 'config_error' ||
      st === 'update_required' ||
      st === 'reauth_required' ||
      st === 'pairing_failed'
    ) {
      app.setPluginError(msg);
      errorShown = true;
    } else {
      if (errorShown) {
        app.setPluginError(''); // SignalK keeps the last error otherwise; an empty one clears it
        errorShown = false;
      }
      app.setPluginStatus(msg);
    }
  }

  /** Abort any pending pairing run and forget its code. Safe to call at any time. */
  function cancelPairing(): void {
    abort?.abort();
    abort = null;
    pairing = null;
    finalizing = false;
  }

  async function startPairing(): Promise<void> {
    if (!store || abort) return;
    const s = store;
    const baseUrl = options.apiBaseUrl;
    if (baseUrl === null) return; // config error: no network calls
    const issuer = apiOrigin(baseUrl);
    const ctl = new AbortController();
    abort = ctl;
    failure = null;
    unpairedNotice = false;
    // A run is current only while it is still the registered one (stop/unpair clear `abort`).
    const current = () => abort === ctl && !ctl.signal.aborted;
    const fail = (reason: PairingFailure) => {
      pairing = null;
      finalizing = false;
      failure = reason;
      report();
    };
    try {
      const uuid = app.getSelfPath('uuid');
      const out = await runPairing({
        http: client(baseUrl),
        clientName: PLUGIN_ID,
        clientVersion: PLUGIN_VERSION,
        deviceLabel: 'SignalK server',
        scopes: [SCOPES[0]],
        ...(typeof uuid === 'string' ? { signalkSelfUuid: uuid } : {}),
        onCode: (info) => {
          if (!current()) return;
          pairing = info;
          report();
        },
        signal: ctl.signal,
        ...(deps.now ? { now: deps.now } : {}),
      });
      if (!current()) return;
      pairing = null;
      if (out.kind === 'paired') {
        finalizing = true;
        if (issuer === null) throw new Error('invalid API URL');
        const pairedAt = new Date().toISOString();
        await tombstoneWrite; // a late tombstone must not overwrite the new credential
        if (!current()) return;
        const saved = (async (): Promise<'kept' | 'stale' | 'failed'> => {
          try {
            await s.write({
              credential: out.token.credential,
              credentialId: out.token.credentialId,
              vesselLabel: out.token.vesselLabel,
              pairedAt,
              apiOrigin: issuer,
            });
          } catch (err) {
            app.debug(`saving the credential failed: ${redactError(err)}`);
            return 'failed';
          }
          if (current()) {
            syncPermissions(s);
            return 'kept';
          }
          try {
            await s.clear(); // cancelled while the file was being written
          } catch (err) {
            app.debug(`stale pairing cleanup failed: ${redactError(err)}`);
          }
          return 'stale';
        })();
        persisting = saved;
        const keep = await saved.finally(() => {
          if (persisting === saved) persisting = null;
        });
        if (keep === 'failed') {
          if (current()) fail('local_failure');
          return;
        }
        if (keep === 'stale') return;
        if (uploadAvailable) {
          // A new pairing starts with an empty queue, before the new credential is used.
          stopSession();
          sticky = null;
          await clearQueue();
          if (!current()) return;
        }
        vesselLabel = cleanLabel(out.token.vesselLabel);
        hasCredential = true;
        failure = null;
        finalizing = false;
        startMonitor(out.token.credential, issuer, pairedAt); // probe right after pairing
        report();
      } else if (out.kind === 'cancelled') {
        report();
      } else {
        if (out.kind === 'unexpected_response') app.debug('pairing/token response unusable');
        fail(out.kind);
      }
    } catch (err) {
      if (current()) {
        app.debug(`pairing failed: ${redactError(err)}`);
        fail('unavailable');
      }
    } finally {
      if (abort === ctl) {
        abort = null;
        finalizing = false;
      }
    }
  }

  const guarded =
    (h: RouteHandler): RouteHandler =>
    (req, res) => {
      if (!sameOriginOrNone(req)) {
        res.status(403).json({ error: COPY.forbidden });
        return;
      }
      return h(req, res);
    };

  function uploadBlock(): Record<string, unknown> {
    const u = options.upload;
    const one = (c: ChannelOptions) => ({
      // `enabled` is the configured value; `active` is what the sampler would obey.
      enabled: c.enabled,
      active: c.active,
      recordIntervalMinutes: c.recordIntervalMinutes,
      instanceMode: c.instanceMode,
    });
    const sn: UploadSnapshot | null = pipe?.uploader.snapshot() ?? null;
    return {
      // Available means this build uploads and this server can feed it.
      available: uploadAvailable && !subscriptionsMissing,
      enabled: u.uploadEnabled,
      unavailableReason: uploadAvailable && subscriptionsMissing ? SUBSCRIPTIONS_UNAVAILABLE : null,
      queued: sn?.queued ?? 0,
      lastSentAt: sn?.lastSentAt != null ? new Date(sn.lastSentAt).toISOString() : null,
      results: sn?.results ?? null,
      rejectedReasons: sn?.rejectedReasons ?? null,
      dropped: sn?.dropped ?? 0,
      invalid: sn?.invalid ?? 0,
      categories: {
        engineHours: one(u.engineHours),
        batteries: one(u.batteries),
        tanks: one(u.tanks),
      },
      warnings: options.warnings,
      // Server-reported counts from the last good status probe. Admin-only; never in the status line.
      summary: snap?.summary ?? null,
    };
  }

  /** Syncs the warning from the store and logs it once per lifecycle (no path, no secret). */
  function syncPermissions(s: CredentialStore): void {
    permissionWarning = !s.permissionsRestricted;
    if (permissionWarning && !permissionLogged) {
      permissionLogged = true;
      app.debug(redact('credential file permissions could not be restricted on this filesystem'));
    }
  }

  function statusBody(): Record<string, unknown> {
    const st = state();
    return {
      state: st,
      // True only while the stored credential is believed to work (not in reauth_required).
      paired: hasCredential && effective() !== 'reauth_required',
      vesselLabel,
      apiOrigin: options.apiBaseUrl === null ? null : apiOrigin(options.apiBaseUrl),
      pairing:
        st === 'pairing' && pairing
          ? {
              userCode: pairing.userCode,
              verificationUrl: pairing.verificationUrl,
              expiresAt: new Date(pairing.expiresAt).toISOString(),
              // Seconds left when this response is made, so the page needs no clock comparison.
              expiresInSeconds: Math.max(0, Math.round((pairing.expiresAt - now()) / 1000)),
            }
          : st === 'pairing_failed' && failure
            ? { reason: failure }
            : null,
      updateRecommended: snap?.updateRecommended ?? false,
      clockSkewWarning: snap?.clockSkewWarning ?? false,
      lastCheckedAt:
        snap?.lastCheckedAt != null ? new Date(snap.lastCheckedAt).toISOString() : null,
      message: message(st),
      warnings: permissionWarning ? ['credential_permissions'] : [],
      upload: uploadBlock(),
    };
  }

  return {
    id: PLUGIN_ID,
    name: 'VesselTwin',
    description: 'Pairs this boat with VesselTwin. Never sends position or MMSI.',
    schema: () => configSchema,

    start(settings: unknown): void {
      epoch += 1;
      const mine = epoch;
      stopSession();
      sticky = null;
      cancelPairing();
      options = parseOptions(settings);
      store = new CredentialStore(app.getDataDirPath());
      loaded = false;
      failure = null;
      permissionWarning = false;
      permissionLogged = false;
      unpairedNotice = false;
      credentialUnreadable = false;
      hasCredential = false;
      vesselLabel = null;
      if (options.configError !== null) {
        loaded = true;
        report();
        return;
      }
      const s = store;
      const earlier = Promise.allSettled([persisting, tombstoneWrite, unpairWork, stopping]);
      earlier
        .then(async () => {
          // Owner decision: readings queued under an earlier setting are not kept once upload is off.
          if (!options.uploadEnabled && mine === epoch) await clearQueue();
        })
        .then(() => s.read())
        .then((c) => {
          if (mine !== epoch) return;
          loaded = true;
          syncPermissions(s);
          if (c) {
            hasCredential = true;
            vesselLabel = cleanLabel(c.vesselLabel);
            if (isTombstone(c)) {
              // The server already rejected this pairing: no monitor, no network calls.
              snap = {
                state: 'reauth_required',
                pausedReason: null,
                updateRecommended: false,
                clockSkewWarning: false,
                lastCheckedAt: null,
                summary: null,
              };
            } else {
              // Missing or different origin: the monitor goes to reauth_required with zero calls.
              startMonitor(c.credential, c.apiOrigin, c.pairedAt || undefined);
            }
          }
          report();
        })
        .catch((err: unknown) => {
          if (mine !== epoch) return;
          app.debug(`credential read failed: ${redactError(err)}`);
          loaded = true;
          credentialUnreadable = true;
          report();
        });
    },

    stop(): void {
      epoch += 1;
      stopSession();
      sticky = null;
      cancelPairing();
      store = null;
      loaded = false;
      hasCredential = false;
      failure = null;
    },

    registerWithRouter(router: RouterLike): void {
      // Never call router.access(...). With SignalK security enabled, /plugins/<id>/* is served to
      // admins only unless a plugin lowers that (with security off it is open to the LAN), and
      // /status exposes the pairing user code.
      router.get(
        '/status',
        guarded((_req, res) => {
          if (!store) {
            res.status(503).json({ error: COPY.notRunning });
            return;
          }
          res.json(statusBody());
        }),
      );
      router.post(
        '/pair',
        guarded((_req, res) => {
          if (!store) {
            res.status(503).json({ error: COPY.notRunning });
            return;
          }
          if (options.configError !== null) {
            res.status(503).json({ error: options.configError });
            return;
          }
          if (!loaded || unpairing) {
            // The stored credential has not been read yet (or is being removed): pairing now could
            // overwrite it or have it deleted under a new run.
            res.status(503).json({ error: COPY.starting });
            return;
          }
          const st = state();
          if (st === 'config_error') {
            res.status(503).json({ error: message(st) });
            return;
          }
          // Paired and working (or still checking): refuse. Allowed in not_paired, pairing_failed
          // and reauth_required; a pairing already pending is a no-op.
          if (hasCredential && effective() !== 'reauth_required' && !abort) {
            res.status(409).json({ error: COPY.alreadyPaired });
            return;
          }
          void startPairing();
          res.status(202).json({ started: true });
        }),
      );
      router.post(
        '/pair/cancel',
        guarded((_req, res) => {
          if (!store) {
            res.status(503).json({ error: COPY.notRunning });
            return;
          }
          // Pending means a pairing run is in flight and the owner has not approved yet. That
          // includes the moment before the code exists, but not the credential save that follows
          // an approval. The stored credential or reauth marker is never touched here.
          if (!abort || finalizing) {
            res.status(409).json({ error: COPY.nothingToCancel });
            return;
          }
          cancelPairing();
          failure = null;
          report();
          res.json({ cancelled: true });
        }),
      );
      router.post(
        '/unpair',
        guarded(async (_req, res) => {
          const s = store;
          if (!s) {
            res.status(503).json({ error: COPY.notRunning });
            return;
          }
          // Before any await: a late approval, a racing credential load and a late 401 must all
          // lose against this unpair.
          epoch += 1;
          const mine = epoch;
          unpairing = true;
          cancelPairing();
          stopSession();
          sticky = null;
          const previous = unpairWork; // an overlapping unpair finishes before this one clears
          const work = (async () => {
            await Promise.allSettled([persisting, tombstoneWrite, previous, stopping]);
            await s.clear();
            await clearQueue(); // nothing from this pairing may be uploaded under another
          })();
          unpairWork = work;
          try {
            await work;
            if (mine !== epoch) {
              // start() or stop() ran meanwhile: the new lifecycle owns state and its monitor.
              res.json({ paired: false, message: COPY.unpaired });
              return;
            }
            permissionWarning = false;
            stopSession(); // a load that raced past the epoch check cannot leave a monitor behind
            loaded = true;
            hasCredential = false;
            vesselLabel = null;
            failure = null;
            unpairedNotice = true;
            report();
            res.json({ paired: false, message: COPY.unpaired });
          } catch (err) {
            app.debug(`unpair failed: ${redactError(err)}`);
            res.status(500).json({ error: COPY.unpairFailed });
          } finally {
            // Only the latest unpair ends the transition; an earlier overlapping one must not
            // reopen pairing while a later clear is still running.
            if (unpairWork === work) {
              unpairWork = null;
              unpairing = false;
            }
          }
        }),
      );
    },
  };
}
