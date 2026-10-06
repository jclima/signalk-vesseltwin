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
  ) {
    super(redact(message));
    this.name = 'HttpError';
  }
}

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
}

export class HttpClient {
  private readonly timeoutMs: number;

  constructor(private readonly opts: HttpClientOptions) {
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  async post(path: string, body: unknown, ro: RequestOptions = {}): Promise<HttpResult> {
    const url = new URL(path, this.opts.baseUrl.replace(/\/?$/, '/')).toString();
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': this.opts.userAgent,
      'x-vesseltwin-contract': String(this.opts.contractVersion ?? CONTRACT_VERSION),
    };
    if (ro.credential) headers.authorization = `Bearer ${ro.credential}`;
    const ctl = new AbortController();
    const timer = setTimeout(() => {
      ctl.abort();
    }, this.timeoutMs);
    try {
      const res = await this.opts.fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: ctl.signal,
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
      throw new HttpError(aborted ? 'request timed out' : 'network error');
    } finally {
      clearTimeout(timer);
    }
  }
}

export function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 503 || status >= 500;
}
