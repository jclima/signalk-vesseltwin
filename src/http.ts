import { CONTRACT_VERSION } from './contract';
import { redact } from './redact';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpResult {
  status: number;
  headers: Headers;
  json: unknown;
}

/** Error whose message is always safe to log (no Authorization, no credential). */
export class HttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** Set only for transport-level failures, so callers can tell them from programming errors. */
    readonly kind?: 'network' | 'timeout' | 'cancelled' | 'refused',
  ) {
    super(redact(message));
    this.name = 'HttpError';
  }
}

/** setTimeout overflows (fires at once) above 2^31 - 1 ms. */
export const MAX_TIMER_MS = 2 ** 31 - 1;

export const BACKOFF_MIN_MS = 5_000;
export const BACKOFF_MAX_MS = 30 * 60_000;

/** Exponential backoff with full jitter: uniform in [min, min(max, min * 2^attempt)]. attempt starts at 0. */
export function backoffDelay(attempt: number, rng: () => number = Math.random): number {
  const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.max(0, attempt));
  return Math.round(BACKOFF_MIN_MS + rng() * (ceiling - BACKOFF_MIN_MS));
}

/** Parses `Retry-After` (delta seconds or HTTP date). Returns ms or null. */
export function retryAfterMs(headers: Headers, now: number = Date.now()): number | null {
  const raw = headers.get('retry-after');
  if (raw === null) return null;
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000);
  const at = Date.parse(raw);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

/** Joins keeping any path in the base (https://h/api + /v1/x -> https://h/api/v1/x). */
export function joinUrl(base: string, path: string): string {
  return new URL(path.replace(/^\/+/, ''), base.replace(/\/?$/, '/')).toString();
}

export interface HttpClientOptions {
  baseUrl: string;
  fetch: FetchLike;
  userAgent: string;
  timeoutMs?: number;
  contractVersion?: number;
}

export interface RequestOptions {
  /** Bearer credential. Only ever placed in the Authorization header. */
  credential?: string;
  /**
   * Origin the credential was issued for. The Authorization header is only ever set when the request
   * URL has exactly this origin; a credential without it is refused.
   */
  credentialOrigin?: string;
  /** Cancels the request (in addition to the timeout). */
  signal?: AbortSignal;
}

export class HttpClient {
  private readonly timeoutMs: number;

  constructor(private readonly opts: HttpClientOptions) {
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  post(path: string, body: unknown, ro: RequestOptions = {}): Promise<HttpResult> {
    return this.request('POST', path, ro, body);
  }

  /** GET sends no body and no content-type; every other header matches `post`. */
  get(path: string, ro: RequestOptions = {}): Promise<HttpResult> {
    return this.request('GET', path, ro);
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    ro: RequestOptions,
    body?: unknown,
  ): Promise<HttpResult> {
    const url = joinUrl(this.opts.baseUrl, path);
    const headers: Record<string, string> = {
      accept: 'application/json',
      'user-agent': this.opts.userAgent,
      'x-vesseltwin-contract': String(this.opts.contractVersion ?? CONTRACT_VERSION),
    };
    if (method === 'POST') headers['content-type'] = 'application/json';
    if (ro.credential) {
      let origin: string | null = null;
      try {
        origin = new URL(url).origin;
      } catch {
        origin = null;
      }
      if (ro.credentialOrigin === undefined || origin === null || origin !== ro.credentialOrigin) {
        throw new HttpError(
          'request refused: credential is not valid for this server',
          undefined,
          'refused',
        );
      }
      headers.authorization = `Bearer ${ro.credential}`;
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => {
      ctl.abort();
    }, this.timeoutMs);
    try {
      const res = await this.opts.fetch(url, {
        method,
        headers,
        ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
        redirect: 'error',
        signal: ro.signal ? AbortSignal.any([ctl.signal, ro.signal]) : ctl.signal,
      });
      let json: unknown = null;
      try {
        json = await res.json();
      } catch {
        json = null;
      }
      return { status: res.status, headers: res.headers, json };
    } catch (err) {
      // Never forward the raw error: undici messages can embed request details.
      const aborted = err instanceof Error && err.name === 'AbortError';
      if (aborted && ro.signal?.aborted) {
        throw new HttpError('request cancelled', undefined, 'cancelled');
      }
      throw aborted
        ? new HttpError('request timed out', undefined, 'timeout')
        : new HttpError('network error', undefined, 'network');
    } finally {
      clearTimeout(timer);
    }
  }
}

/** The machine-readable `code` (or poll `error`) of a JSON error body, or null. */
export function errorCode(json: unknown): string | null {
  if (typeof json !== 'object' || json === null) return null;
  const o = json as Record<string, unknown>;
  if (typeof o.code === 'string') return o.code;
  return typeof o.error === 'string' ? o.error : null;
}

/**
 * Whether a response is worth a fast (backoff) retry. A 503 `integration_feature_unavailable` is a
 * dark feature flag: probe slowly (about hourly), not with backoff.
 */
export function isRetryableStatus(status: number, code?: string | null): boolean {
  if (status === 503 && code === 'integration_feature_unavailable') return false;
  return status === 429 || status >= 500;
}
