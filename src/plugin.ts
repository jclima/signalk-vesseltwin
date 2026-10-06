import { CredentialStore } from './credential-store';
import { SCOPES } from './contract';
import { configSchema, parseOptions, type PluginOptions } from './config';
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

export interface RouterLike {
  get(path: string, h: (req: unknown, res: ResponseLike) => void | Promise<void>): void;
  post(path: string, h: (req: unknown, res: ResponseLike) => void | Promise<void>): void;
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

export function createPlugin(app: SignalKApp, deps: PluginDeps = {}) {
  let options: PluginOptions = parseOptions({});
  let store: CredentialStore | null = null;
  let abort: AbortController | null = null;
  let pairing: { userCode: string; verificationUrl: string; expiresAt: number } | null = null;
  let paired = false;
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
      app.setPluginStatus('Paired with VesselTwin. Data upload is not available in this version.');
    } else if (pairing) {
      app.setPluginStatus(`Enter code ${pairing.userCode} at ${pairing.verificationUrl}`);
    } else {
      app.setPluginStatus('Not paired. Open the plugin page to start pairing.');
    }
  }

  async function startPairing(): Promise<void> {
    if (!store || abort) return;
    const s = store;
    abort = new AbortController();
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
          pairing = info;
          report();
        },
        signal: abort.signal,
      });
      pairing = null;
      if (out.kind === 'paired') {
        await s.write({
          credential: out.token.credential,
          credentialId: out.token.credentialId,
          vesselLabel: out.token.vesselLabel,
          pairedAt: new Date().toISOString(),
        });
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
      pairing = null;
      app.setPluginError(`Pairing failed: ${redactError(err)}`);
    } finally {
      abort = null;
    }
  }

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
          report();
        })
        .catch((err: unknown) => {
          app.setPluginError(`Cannot read credential: ${redactError(err)}`);
        });
    },

    stop(): void {
      pipeline.stop();
      abort?.abort();
      abort = null;
      pairing = null;
    },

    registerWithRouter(router: RouterLike): void {
      router.get('/status', (_req, res) => {
        res.json({
          paired,
          pairing: pairing && {
            userCode: pairing.userCode,
            verificationUrl: pairing.verificationUrl,
          },
        });
      });
      router.post('/pair', (_req, res) => {
        void startPairing();
        res.status(202).json({ started: true });
      });
      router.post('/unpair', async (_req, res) => {
        await store?.clear();
        paired = false;
        report();
        res.json({ paired });
      });
    },
  };
}
