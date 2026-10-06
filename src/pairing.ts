import {
  CONTRACT_VERSION,
  PROVIDER,
  type PairingStartResponse,
  type PairingTokenResponse,
  type Scope,
} from './contract';
import { HttpClient, HttpError } from './http';

export type PairingOutcome =
  | { kind: 'paired'; token: PairingTokenResponse }
  | { kind: 'expired' }
  | { kind: 'denied' }
  | { kind: 'unavailable'; retryAfterMs: number | null }
  | { kind: 'cancelled' };

export interface PairingParams {
  http: HttpClient;
  clientName: string;
  clientVersion: string;
  deviceLabel: string;
  scopes: Scope[];
  signalkSelfUuid?: string;
  /** Called once the user code is known so the UI can show it. */
  onCode: (info: { userCode: string; verificationUrl: string; expiresAt: number }) => void;
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const SLOW_DOWN_STEP_S = 5;
const DEFAULT_INTERVAL_S = 5;

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function parseStart(json: unknown): PairingStartResponse {
  if (
    !isObject(json) ||
    typeof json.deviceCode !== 'string' ||
    typeof json.userCode !== 'string' ||
    typeof json.verificationUrl !== 'string' ||
    typeof json.expiresIn !== 'number'
  ) {
    throw new HttpError('unexpected pairing/start response');
  }
  return {
    deviceCode: json.deviceCode,
    userCode: json.userCode,
    verificationUrl: json.verificationUrl,
    interval: typeof json.interval === 'number' ? json.interval : DEFAULT_INTERVAL_S,
    expiresIn: json.expiresIn,
  };
}

function parseToken(json: unknown): PairingTokenResponse {
  if (
    !isObject(json) ||
    typeof json.credential !== 'string' ||
    typeof json.credentialId !== 'string'
  ) {
    throw new HttpError('unexpected pairing/token response');
  }
  return json as unknown as PairingTokenResponse;
}

/** RFC 8628 device flow against the VesselTwin integrations platform. No ingest. */
export async function runPairing(p: PairingParams): Promise<PairingOutcome> {
  const now = p.now ?? Date.now;
  const sleep = p.sleep ?? defaultSleep;

  const start = await p.http.post('/v1/integrations/pairing/start', {
    provider: PROVIDER,
    clientName: p.clientName,
    clientVersion: p.clientVersion,
    contractVersion: CONTRACT_VERSION,
    deviceLabel: p.deviceLabel,
    requestedScopes: p.scopes,
    ...(p.signalkSelfUuid ? { providerHints: { signalkSelfUuid: p.signalkSelfUuid } } : {}),
  });
  if (start.status === 503) {
    const ra = start.headers.get('retry-after');
    return { kind: 'unavailable', retryAfterMs: ra && Number(ra) >= 0 ? Number(ra) * 1000 : null };
  }
  if (start.status !== 200 && start.status !== 201) {
    throw new HttpError(`pairing/start failed`, start.status);
  }
  const s = parseStart(start.json);
  const expiresAt = now() + s.expiresIn * 1000;
  p.onCode({ userCode: s.userCode, verificationUrl: s.verificationUrl, expiresAt });

  let intervalS = s.interval > 0 ? s.interval : DEFAULT_INTERVAL_S;
  for (;;) {
    await sleep(intervalS * 1000);
    if (p.signal?.aborted) return { kind: 'cancelled' };
    if (now() >= expiresAt) return { kind: 'expired' };

    const res = await p.http.post('/v1/integrations/pairing/token', { deviceCode: s.deviceCode });
    if (res.status === 200 || res.status === 201) {
      return { kind: 'paired', token: parseToken(res.json) };
    }
    const err = isObject(res.json) && typeof res.json.error === 'string' ? res.json.error : '';
    if (res.status === 400 || res.status === 403) {
      if (err === 'authorization_pending') continue;
      if (err === 'slow_down') {
        intervalS += SLOW_DOWN_STEP_S;
        continue;
      }
      if (err === 'expired_token') return { kind: 'expired' };
      if (err === 'access_denied') return { kind: 'denied' };
    }
    if (res.status === 429 || res.status >= 500) {
      intervalS += SLOW_DOWN_STEP_S; // be gentle on transient failures
      continue;
    }
    throw new HttpError('pairing/token failed', res.status);
  }
}
