import {
  CONTRACT_VERSION,
  PROVIDER,
  type PairingStartResponse,
  type PairingTokenResponse,
  type Scope,
} from './contract';
import { HttpClient, HttpError, retryAfterMs } from './http';

export type PairingOutcome =
  | { kind: 'paired'; token: PairingTokenResponse }
  | { kind: 'expired' }
  | { kind: 'denied' }
  | { kind: 'unavailable'; retryAfterMs: number | null }
  | { kind: 'busy'; retryAfterMs: number | null }
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

/** Documented format is `vti_` + 43 url-safe chars; accept any plausible length of that alphabet. */
export const CREDENTIAL_RE = /^vti_[A-Za-z0-9_-]{16,}$/;

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
    !CREDENTIAL_RE.test(json.credential) ||
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

  const ro = p.signal ? { signal: p.signal } : {};
  const start = await p.http.post(
    '/v1/integrations/pairing/start',
    {
      provider: PROVIDER,
      clientName: p.clientName,
      clientVersion: p.clientVersion,
      contractVersion: CONTRACT_VERSION,
      deviceLabel: p.deviceLabel,
      requestedScopes: p.scopes,
      ...(p.signalkSelfUuid ? { providerHints: { signalkSelfUuid: p.signalkSelfUuid } } : {}),
    },
    ro,
  );
  if (p.signal?.aborted) return { kind: 'cancelled' };
  if (start.status === 503) {
    return { kind: 'unavailable', retryAfterMs: retryAfterMs(start.headers, now()) };
  }
  if (start.status === 429) {
    return { kind: 'busy', retryAfterMs: retryAfterMs(start.headers, now()) };
  }
  if (start.status !== 200 && start.status !== 201) {
    throw new HttpError(`pairing/start failed`, start.status);
  }
  const s = parseStart(start.json);
  const expiresAt = now() + s.expiresIn * 1000;
  p.onCode({ userCode: s.userCode, verificationUrl: s.verificationUrl, expiresAt });

  let intervalS = s.interval > 0 ? s.interval : DEFAULT_INTERVAL_S;
  let minWaitMs = 0; // Retry-After floor for the next sleep only
  for (;;) {
    await sleep(Math.max(intervalS * 1000, minWaitMs));
    minWaitMs = 0;
    if (p.signal?.aborted) return { kind: 'cancelled' };
    if (now() >= expiresAt) return { kind: 'expired' };

    const res = await p.http.post(
      '/v1/integrations/pairing/token',
      { deviceCode: s.deviceCode },
      ro,
    );
    if (p.signal?.aborted) return { kind: 'cancelled' };
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
      minWaitMs = retryAfterMs(res.headers, now()) ?? 0; // never retry sooner than asked
      continue;
    }
    throw new HttpError('pairing/token failed', res.status);
  }
}
