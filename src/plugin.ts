import { CredentialStore } from './credential-store';
import { SCOPES } from './contract';
import { apiOrigin, configSchema, parseOptions, type PluginOptions } from './config';
import { HttpClient, type FetchLike } from './http';
import { runPairing } from './pairing';
import { redactError } from './redact';
import { createPipeline } from './pipeline';

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
}

const STATUS_PATH = `/plugins/${PLUGIN_ID}/status`;

function header(req: RequestLike, name: string): string | undefined {
  const v = req.headers?.[name];
  return Array.isArray(v) ? v[0] : v;
}

/** Browser-driven cross-site requests carry an Origin that differs from Host; reject those. */
function sameOriginOrNone(req: RequestLike): boolean {
  const origin = header(req, 'origin');
  if (origin === undefined) return true;
  const host = header(req, 'host');
  try {
    return host !== undefined && new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

/** The label comes from the server; keep it short and printable before showing it. */
function cleanLabel(v: string | null | undefined): string | null {
  // eslint-disable-next-line no-control-regex
  const t = (v ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim();
  return t ? t.slice(0, 80) : null;
}

export function createPlugin(app: SignalKApp, deps: PluginDeps = {}) {
  let options: PluginOptions = parseOptions({});
  let store: CredentialStore | null = null;
  let abort: AbortController | null = null;
  let pairing: { userCode: string; verificationUrl: string; expiresAt: number } | null = null;
  let paired = false;
  let vesselLabel: string | null = null;
  let justUnpaired = false;
  const pipeline = createPipeline(app, {
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    userAgent: `${PLUGIN_ID}/${PLUGIN_VERSION}`,
  });

  const client = () =>
    new HttpClient({
      baseUrl: options.apiBaseUrl,
      fetch: deps.fetch ?? ((u, i) => fetch(u, i)),
      userAgent: `${PLUGIN_ID}/${PLUGIN_VERSION}`,
    });

  function report(): void {
    if (paired) {
      app.setPluginStatus(
        `${vesselLabel ? `Paired with ${vesselLabel}` : 'Paired with VesselTwin'}. Data upload is not available in this version.`,
      );
    } else if (pairing) {
      // The code itself is shown only by the admin-only /status endpoint, never in the status line.
      app.setPluginStatus(
        `Pairing in progress: open the plugin page for the code (${STATUS_PATH}).`,
      );
    } else if (justUnpaired) {
      app.setPluginStatus(
        'Unpaired on this server. Also revoke the connection in VesselTwin so it stops working there.',
      );
    } else {
      app.setPluginStatus('Not paired. Open the plugin page to start pairing.');
    }
  }

  /** Abort any pending pairing run and forget its code. Safe to call at any time. */
  function cancelPairing(): void {
    abort?.abort();
    abort = null;
    pairing = null;
  }

  async function startPairing(): Promise<void> {
    if (!store || abort) return;
    const s = store;
    const issuer = apiOrigin(options.apiBaseUrl);
    const ctl = new AbortController();
    abort = ctl;
    // A run is current only while it is still the registered one (stop/unpair clear `abort`).
    const current = () => abort === ctl && !ctl.signal.aborted;
    try {
      const out = await runPairing({
        http: client(),
        clientName: PLUGIN_ID,
        clientVersion: PLUGIN_VERSION,
        deviceLabel: 'SignalK server',
        scopes: [SCOPES[0]],
        ...(typeof app.getSelfPath('uuid') === 'string'
          ? { signalkSelfUuid: app.getSelfPath('uuid') as string }
          : {}),
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
        if (issuer === null) throw new Error('invalid API URL');
        await s.write({
          credential: out.token.credential,
          credentialId: out.token.credentialId,
          vesselLabel: out.token.vesselLabel,
          pairedAt: new Date().toISOString(),
          apiOrigin: issuer,
        });
        if (!current()) {
          await s.clear(); // cancelled while the file was being written
          return;
        }
        vesselLabel = cleanLabel(out.token.vesselLabel);
        justUnpaired = false;
        paired = true;
      } else if (out.kind === 'busy') {
        app.setPluginError('VesselTwin is busy. Try pairing again in a few minutes.');
        return;
      } else if (out.kind !== 'cancelled') {
        app.setPluginError(`Pairing ${out.kind}. Try again from the plugin page.`);
        return;
      }
      report();
    } catch (err) {
      if (abort === ctl) {
        pairing = null;
        app.setPluginError(`Pairing failed: ${redactError(err)}`);
      }
    } finally {
      if (abort === ctl) abort = null;
    }
  }

  const NEUTRAL_FORBIDDEN = { error: 'Request not allowed.' };
  const guarded =
    (h: RouteHandler): RouteHandler =>
    (req, res) => {
      if (!sameOriginOrNone(req)) {
        res.status(403).json(NEUTRAL_FORBIDDEN);
        return;
      }
      return h(req, res);
    };

  return {
    id: PLUGIN_ID,
    name: 'VesselTwin',
    description: 'Pairs this boat with VesselTwin. Never sends position or MMSI.',
    schema: () => configSchema,

    start(settings: unknown): void {
      options = parseOptions(settings);
      store = new CredentialStore(app.getDataDirPath());
      pipeline.start(options);
      store
        .read()
        .then((c) => {
          paired = c !== null;
          vesselLabel = cleanLabel(c?.vesselLabel);
          report();
        })
        .catch((err: unknown) => {
          app.setPluginError(`Cannot read credential: ${redactError(err)}`);
        });
    },

    stop(): void {
      pipeline.stop();
      cancelPairing();
      store = null;
      paired = false;
    },

    registerWithRouter(router: RouterLike): void {
      router.get(
        '/status',
        guarded((_req, res) => {
          res.json({
            paired,
            pairing: pairing && {
              userCode: pairing.userCode,
              verificationUrl: pairing.verificationUrl,
            },
          });
        }),
      );
      router.post(
        '/pair',
        guarded((_req, res) => {
          if (!store) {
            res
              .status(503)
              .json({ error: 'The VesselTwin plugin is not running. Enable it first.' });
            return;
          }
          if (paired) {
            res.status(409).json({ error: 'Already paired. Unpair first to pair again.' });
            return;
          }
          void startPairing(); // no-op while a run is already pending
          res.status(202).json({ started: true });
        }),
      );
      router.post(
        '/unpair',
        guarded(async (_req, res) => {
          const s = store;
          if (!s) {
            res
              .status(503)
              .json({ error: 'The VesselTwin plugin is not running. Enable it first.' });
            return;
          }
          try {
            cancelPairing(); // before the await, so a late approval cannot re-create the file
            await s.clear();
            paired = false;
            vesselLabel = null;
            justUnpaired = true;
            report();
            res.json({
              paired,
              message:
                'Unpaired on this server. Also revoke the connection in VesselTwin so it stops working there.',
            });
          } catch {
            res.status(500).json({ error: 'Could not remove the stored connection. Try again.' });
          }
        }),
      );
    },
  };
}
