import {
  CONTRACT_VERSION,
  PROVIDER,
  type PairingStartResponse,
  type PairingTokenResponse,
  SCOPES,
  type Scope,
} from './contract';
import { HttpClient, HttpError, type HttpResult, MAX_TIMER_MS, retryAfterMs } from './http';

export type PairingOutcome =
  | { kind: 'paired'; token: PairingTokenResponse }
  | { kind: 'expired' }
  | { kind: 'denied' }
  | { kind: 'unavailable'; retryAfterMs: number | null }
  | { kind: 'busy'; retryAfterMs: number | null }
  | { kind: 'update_required' }
  | { kind: 'rejected' }
  | { kind: 'local_failure' }
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
  /** Must resolve early (not reject) when `signal` aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** `vti_` + 32 random bytes base64url, as issued by the platform. */
export const CREDENTIAL_RE = /^vti_[A-Za-z0-9_-]{43}$/;

const HINT_RE =
  /^(?:urn:mrn:signalk:uuid:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The SignalK self id is only a de-duplication hint. Send it only when it is a UUID (bare or as
 * `urn:mrn:signalk:uuid:`); an MMSI urn or anything else is omitted.
 */
export function cleanSelfUuid(v: unknown): string | undefined {
  return typeof v === 'string' && v.length <= 100 && HINT_RE.test(v) ? v : undefined;
}

const SLOW_DOWN_STEP_S = 5;
const DEFAULT_INTERVAL_S = 5;
/** The server is not trusted to pick our polling cadence or code lifetime. */
export const MIN_INTERVAL_S = 1;
export const MAX_INTERVAL_S = 60;
export const MAX_EXPIRES_IN_S = 1800;
const MAX_URL_LEN = 300;
const MAX_USER_CODE_LEN = 32;

/** Resolves after `ms` or as soon as `signal` aborts. The timer never keeps the process alive. */
export const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, Math.min(Math.max(0, ms), MAX_TIMER_MS));
    timer.unref();
    signal?.addEventListener('abort', done, { once: true });
  });

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Control characters and invisible format characters (bidi overrides, zero-width, tab, newline). */
const UNSAFE_CHARS_RE = /[\p{Cc}\p{Cf}]/u;

/**
 * The normalized URL (`new URL(v).href`) when it is https, or http on a loopback host (development
 * only), has no unsafe characters, and is not too long. Null otherwise.
 */
function safeVerificationUrl(v: string): string | null {
  if (v.length > MAX_URL_LEN || UNSAFE_CHARS_RE.test(v)) return null;
  try {
    const u = new URL(v);
    const ok = u.protocol === 'https:' || (u.protocol === 'http:' && LOCAL_HOSTS.has(u.hostname));
    return ok && u.href.length <= MAX_URL_LEN && !UNSAFE_CHARS_RE.test(u.href) ? u.href : null;
  } catch {
    return null;
  }
}

function safeUserCode(v: string): boolean {
  return v.length > 0 && v.length <= MAX_USER_CODE_LEN && !UNSAFE_CHARS_RE.test(v);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** Null when the body is unusable; the interval and lifetime are clamped to sane bounds. */
function parseStart(json: unknown): PairingStartResponse | null {
  const verificationUrl =
    isObject(json) && typeof json.verificationUrl === 'string'
      ? safeVerificationUrl(json.verificationUrl)
      : null;
  if (
    verificationUrl === null ||
    !isObject(json) ||
    typeof json.deviceCode !== 'string' ||
    json.deviceCode === '' ||
    typeof json.userCode !== 'string' ||
    !safeUserCode(json.userCode) ||
    typeof json.expiresIn !== 'number' ||
    !Number.isFinite(json.expiresIn) ||
    json.expiresIn <= 0
  ) {
    return null;
  }
  const interval =
    typeof json.interval === 'number' && Number.isFinite(json.interval)
      ? json.interval
      : DEFAULT_INTERVAL_S;
  return {
    deviceCode: json.deviceCode,
    userCode: json.userCode,
    verificationUrl,
    interval: Math.min(MAX_INTERVAL_S, Math.max(MIN_INTERVAL_S, interval)),
    expiresIn: Math.min(MAX_EXPIRES_IN_S, json.expiresIn),
  };
}

function parseToken(json: unknown): PairingTokenResponse {
  if (
    !isObject(json) ||
    typeof json.credential !== 'string' ||
    !CREDENTIAL_RE.test(json.credential) ||
    typeof json.credentialId !== 'string' ||
    json.credentialId === ''
  ) {
    throw new HttpError('unexpected pairing/token response');
  }
  // Copy only known fields; never pass unknown server fields along.
  const scopes = Array.isArray(json.scopes)
    ? SCOPES.filter((sc) => (json.scopes as unknown[]).includes(sc))
    : [];
  return {
    credential: json.credential,
    credentialId: json.credentialId,
    scopes,
    vesselLabel: typeof json.vesselLabel === 'string' ? json.vesselLabel : null,
    provider: typeof json.provider === 'string' ? json.provider : PROVIDER,
  };
}

/** RFC 8628 device flow against the VesselTwin integrations platform. No ingest. */
export async function runPairing(p: PairingParams): Promise<PairingOutcome> {
  const now = p.now ?? Date.now;
  const sleep = p.sleep ?? defaultSleep;

  const selfUuid = cleanSelfUuid(p.signalkSelfUuid);
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
      ...(selfUuid ? { providerHints: { signalkSelfUuid: selfUuid } } : {}),
    },
    ro,
  );
  if (start.status === 400) {
    const code = isObject(start.json) && typeof start.json.code === 'string' ? start.json.code : '';
    return code === 'integration_contract_unsupported'
      ? { kind: 'update_required' }
      : { kind: 'rejected' };
  }
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
  if (!s) return { kind: 'rejected' };
  const expiresAt = now() + s.expiresIn * 1000;
  p.onCode({ userCode: s.userCode, verificationUrl: s.verificationUrl, expiresAt });

  let intervalS = s.interval;
  let minWaitMs = 0; // Retry-After floor for the next sleep only
  for (;;) {
    // Never sleep past the code's lifetime, and never beyond what a timer can hold.
    const wait = Math.min(
      MAX_TIMER_MS,
      Math.max(0, expiresAt - now()),
      Math.max(intervalS * 1000, minWaitMs),
    );
    await sleep(wait, p.signal);
    minWaitMs = 0;
    if (p.signal?.aborted) return { kind: 'cancelled' };
    if (now() >= expiresAt) return { kind: 'expired' };

    let res: HttpResult;
    try {
      res = await p.http.post('/v1/integrations/pairing/token', { deviceCode: s.deviceCode }, ro);
    } catch {
      // Network error or timeout: never swallow cancellation; otherwise back off like a 5xx and
      // keep polling until the code expires. The error is dropped on purpose (it is not logged).
      if (p.signal?.aborted) return { kind: 'cancelled' };
      intervalS = Math.min(MAX_INTERVAL_S, intervalS + SLOW_DOWN_STEP_S);
      continue;
    }
    if (res.status === 200 || res.status === 201) {
      try {
        return { kind: 'paired', token: parseToken(res.json) };
      } catch {
        return { kind: 'local_failure' };
      }
    }
    const err = isObject(res.json) && typeof res.json.error === 'string' ? res.json.error : '';
    if (res.status === 400 || res.status === 403) {
      if (err === 'authorization_pending') continue;
      if (err === 'slow_down') {
        intervalS = Math.min(MAX_INTERVAL_S, intervalS + SLOW_DOWN_STEP_S);
        continue;
      }
      if (err === 'expired_token') return { kind: 'expired' };
      if (err === 'access_denied') return { kind: 'denied' };
    }
    if (res.status === 429 || res.status >= 500) {
      intervalS = Math.min(MAX_INTERVAL_S, intervalS + SLOW_DOWN_STEP_S); // be gentle
      minWaitMs = retryAfterMs(res.headers, now()) ?? 0; // never retry sooner than asked
      if (minWaitMs > expiresAt - now()) {
        // The server asks for more patience than this code has lifetime left.
        return res.status === 429
          ? { kind: 'busy', retryAfterMs: minWaitMs }
          : { kind: 'unavailable', retryAfterMs: minWaitMs };
      }
      continue;
    }
    throw new HttpError('pairing/token failed', res.status);
  }
}
