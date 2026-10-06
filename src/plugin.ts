import { CredentialStore, isTombstone } from './credential-store';
import { SCOPES } from './contract';
import { apiOrigin, configSchema, parseOptions, type PluginOptions } from './config';
import { HttpClient, type FetchLike } from './http';
import { runPairing } from './pairing';
import { redactError } from './redact';
import { StatusMonitor, type MonitorSnapshot, type PauseReason, type Scheduler } from './status';

/** The slice of the SignalK server API this plugin uses (kept minimal; no runtime dependency). */
export interface SignalKApp {
  getDataDirPath(): string;
  getSelfPath(path: string): unknown;
  setPluginStatus(msg: string): void;
  setPluginError(msg: string): void;
  debug(msg: string): void;
  error(msg: string): void;
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
export const PLUGIN_VERSION = '0.0.0';

export interface PluginDeps {
  fetch?: FetchLike;
  /** Test seams for the status monitor. */
  now?: () => number;
  rng?: () => number;
  scheduler?: Scheduler;
}

export type PairingFailure =
  'expired' | 'denied' | 'unavailable' | 'busy' | 'update_required' | 'rejected';

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
};

export const COPY = {
  notPaired: 'Not paired. Start pairing with VesselTwin (see the plugin README).',
  reauth: `Pairing with VesselTwin is no longer valid. Pair again. ${NO_UPLOAD}`,
  credentialUnreadable:
    'Cannot read the stored VesselTwin connection. Check the permissions of the plugin data folder.',
  notRunning: 'The VesselTwin plugin is not running. Enable it first.',
  starting: 'The VesselTwin plugin is starting. Try again in a moment.',
  pairingInProgress: `Pairing in progress. Open /plugins/${PLUGIN_ID}/status as an admin for the code.`,
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
  let abort: AbortController | null = null;
  let pairing: PendingPairing | null = null;
  /**
   * The owner approved: the credential is being saved and the monitor started. Reported as
   * `checking` so /status never shows `not_paired` mid-transition.
   */
  let finalizing = false;
  let failure: PairingFailure | null = null;
  let credentialUnreadable = false;
  /** A credential file exists (it is kept in reauth_required until a new pairing overwrites it). */
  let hasCredential = false;
  /** Set by unpair: keeps the revoke reminder in the status line until the next start or pairing. */
  let unpairedNotice = false;
  let vesselLabel: string | null = null;
  let monitor: StatusMonitor | null = null;
  let snap: MonitorSnapshot | null = null;
  /** The in-flight tombstone write, so unpair and a new pairing never race it. */
  let tombstoneWrite: Promise<void> | null = null;
  /**
   * The in-flight credential write (and the stale-run cleanup that may follow it). start() waits for
   * it before reading, so a pairing that outlived stop() cannot delete a credential the next
   * lifecycle just loaded, or leave a file behind that the next lifecycle did not see.
   */
  let persisting: Promise<boolean> | null = null;

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
  }

  function startMonitor(
    credential: string,
    credentialOrigin: string | null,
    pairedAt?: string,
  ): void {
    stopMonitor();
    const baseUrl = options.apiBaseUrl;
    const origin = baseUrl === null ? null : apiOrigin(baseUrl);
    if (baseUrl === null || origin === null) return;
    const m = new StatusMonitor({
      http: client(baseUrl),
      credential,
      credentialOrigin,
      apiOrigin: origin,
      onUpdate: (s) => {
        if (monitor !== m) return;
        snap = s;
        report();
      },
      onUnauthorized: (tombstone) => {
        // Only the platform's own "credential is bad" answer retires the file. Any other 401 (a
        // proxy, a captive portal) stops probing but leaves the credential for the next start.
        if (monitor === m && tombstone) recordReauth(credentialOrigin, pairedAt);
      },
      log: (msg) => {
        app.debug(msg);
      },
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.rng ? { rng: deps.rng } : {}),
      ...(deps.scheduler ? { scheduler: deps.scheduler } : {}),
    });
    monitor = m;
    snap = m.snapshot();
    m.start();
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

  function state(): PluginState {
    if (options.configError !== null || credentialUnreadable) return 'config_error';
    if (pairing) return 'pairing';
    if (finalizing) return 'checking';
    if (failure) return 'pairing_failed';
    if (!hasCredential) return 'not_paired';
    switch (snap?.state ?? 'checking') {
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
    const pausedReason: PauseReason | null = snap?.pausedReason ?? null;
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
        if (finalizing) return `Pairing approved. Saving the connection. ${NO_UPLOAD}`;
        return `${lead}. Checking the connection. ${NO_UPLOAD}`;
      case 'connected': {
        const extras = [
          snap?.updateRecommended ? 'A plugin update is available.' : '',
          snap?.clockSkewWarning
            ? "This device's clock differs from VesselTwin's. Check the date and time."
            : '',
        ].filter(Boolean);
        return `${lead}. ${extras.length ? `${extras.join(' ')} ` : ''}${NO_UPLOAD}`;
      }
      case 'paused':
        return pausedReason === 'plan'
          ? `${lead}. The connection is paused for your VesselTwin plan. The plugin will keep checking. ${NO_UPLOAD}`
          : `${lead}. VesselTwin integrations are not available for your account right now. The plugin will keep checking. ${NO_UPLOAD}`;
      case 'offline':
        return `${lead}. Cannot reach VesselTwin right now. The plugin will keep trying. ${NO_UPLOAD}`;
      case 'update_required':
        return `${lead}. This plugin version is not supported by VesselTwin. Update the plugin. ${NO_UPLOAD}`;
      case 'reauth_required':
        return COPY.reauth;
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
    } else {
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
      });
      if (!current()) return;
      pairing = null;
      if (out.kind === 'paired') {
        finalizing = true;
        if (issuer === null) throw new Error('invalid API URL');
        const pairedAt = new Date().toISOString();
        await tombstoneWrite; // a late tombstone must not overwrite the new credential
        if (!current()) return;
        const saved = (async () => {
          await s.write({
            credential: out.token.credential,
            credentialId: out.token.credentialId,
            vesselLabel: out.token.vesselLabel,
            pairedAt,
            apiOrigin: issuer,
          });
          if (current()) return true;
          try {
            await s.clear(); // cancelled while the file was being written
          } catch (err) {
            app.debug(`stale pairing cleanup failed: ${redactError(err)}`);
          }
          return false;
        })();
        persisting = saved;
        const keep = await saved.finally(() => {
          if (persisting === saved) persisting = null;
        });
        if (!keep) return;
        vesselLabel = cleanLabel(out.token.vesselLabel);
        hasCredential = true;
        failure = null;
        finalizing = false;
        startMonitor(out.token.credential, issuer, pairedAt); // probe right after pairing
        report();
      } else if (out.kind === 'cancelled') {
        report();
      } else {
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

  function statusBody(): Record<string, unknown> {
    const st = state();
    return {
      state: st,
      // True only while the stored credential is believed to work (not in reauth_required).
      paired: hasCredential && snap?.state !== 'reauth_required',
      vesselLabel,
      apiOrigin: options.apiBaseUrl === null ? null : apiOrigin(options.apiBaseUrl),
      pairing:
        st === 'pairing' && pairing
          ? {
              userCode: pairing.userCode,
              verificationUrl: pairing.verificationUrl,
              expiresAt: new Date(pairing.expiresAt).toISOString(),
            }
          : st === 'pairing_failed' && failure
            ? { reason: failure }
            : null,
      updateRecommended: snap?.updateRecommended ?? false,
      clockSkewWarning: snap?.clockSkewWarning ?? false,
      lastCheckedAt:
        snap?.lastCheckedAt != null ? new Date(snap.lastCheckedAt).toISOString() : null,
      message: message(st),
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
      stopMonitor();
      cancelPairing();
      options = parseOptions(settings);
      store = new CredentialStore(app.getDataDirPath());
      loaded = false;
      failure = null;
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
      const earlier = Promise.allSettled([persisting, tombstoneWrite]);
      earlier
        .then(() => s.read())
        .then((c) => {
          if (mine !== epoch) return;
          loaded = true;
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
      stopMonitor();
      cancelPairing();
      store = null;
      loaded = false;
      hasCredential = false;
      failure = null;
    },

    registerWithRouter(router: RouterLike): void {
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
          if (!loaded) {
            // The stored credential has not been read yet: pairing now could overwrite it.
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
          if (hasCredential && snap?.state !== 'reauth_required' && !abort) {
            res.status(409).json({ error: COPY.alreadyPaired });
            return;
          }
          void startPairing();
          res.status(202).json({ started: true });
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
          cancelPairing();
          stopMonitor();
          try {
            await Promise.allSettled([persisting, tombstoneWrite]);
            await s.clear();
            stopMonitor(); // a load that raced past the epoch check cannot leave a monitor behind
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
          }
        }),
      );
    },
  };
}
