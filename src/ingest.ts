import type { Reading as WireReading } from './contract';
import { HttpClient, HttpError, retryAfterMs } from './http';

/**
 * PLACEHOLDER TRANSPORT. The ingest endpoint and body below are a DRAFT used for local
 * end-to-end testing against the mock server in `dev/mock-server`. The VesselTwin platform
 * has not published the ingest contract (see docs/contract.md); until it does, nothing here
 * may be treated as the real wire format. Swap `PlaceholderIngestClient` for a client built
 * from the published schema; the rest of the pipeline only depends on `IngestClient`.
 */

/** What the platform said about one reading. All of these are terminal: the reading is acked. */
export type ItemStatus = 'accepted' | 'duplicate' | 'skipped' | 'held' | 'rejected';

export interface ItemResult {
  clientReadingId: string;
  status: ItemStatus;
}

export type HaltReason =
  /** 401: credential no longer valid; the user must pair again. */
  | 'reauth'
  /** 426 / contract header problems: the plugin must be updated. */
  | 'update_required'
  /** The credential lacks the scope (403). */
  | 'scope'
  /** Whole-batch validation failure: a plugin bug. */
  | 'plugin_bug';

export type BatchResult =
  /** The batch was processed; per-reading results. Readings missing from `items` are not acked. */
  | { kind: 'ok'; items: ItemResult[] }
  /** Transient failure: keep everything, try again after `afterMs` (null = use exponential backoff). */
  | { kind: 'retry'; afterMs: number | null }
  /** Plan or feature paused server-side: keep everything, probe slowly. */
  | { kind: 'pause'; afterMs: number }
  /** Stop uploading until the user acts. Keep everything. */
  | { kind: 'halt'; reason: HaltReason };

export interface IngestClient {
  sendBatch(readings: WireReading[]): Promise<BatchResult>;
}

export const PAUSE_PROBE_MS = 3600_000;
export const MAX_BATCH = 500;
export const PLACEHOLDER_PATH = '/v1/integrations/signalk/readings';

function code(json: unknown): string {
  if (typeof json === 'object' && json !== null && 'code' in json) {
    const c = json.code;
    if (typeof c === 'string') return c;
  }
  return '';
}

const STATUS_MAP: Record<string, ItemStatus> = {
  accepted: 'accepted',
  duplicate: 'duplicate',
  skipped_downsampled: 'skipped',
  held_unmapped: 'held',
  held_unconfirmed: 'held',
  held_review: 'held',
};

export function parseItemStatus(raw: unknown): ItemStatus | null {
  if (typeof raw !== 'string') return null;
  if (raw === 'rejected' || raw.startsWith('rejected:')) return 'rejected';
  return STATUS_MAP[raw] ?? null;
}

export class PlaceholderIngestClient implements IngestClient {
  constructor(
    private readonly http: HttpClient,
    private readonly getCredential: () => Promise<string | null>,
    private readonly now: () => number = Date.now,
  ) {}

  async sendBatch(readings: WireReading[]): Promise<BatchResult> {
    const credential = await this.getCredential();
    if (!credential) return { kind: 'halt', reason: 'reauth' };
    let res;
    try {
      res = await this.http.post(PLACEHOLDER_PATH, { readings }, { credential });
    } catch (err) {
      if (err instanceof HttpError) return { kind: 'retry', afterMs: null };
      throw err;
    }
    const { status, headers, json } = res;
    const ra = retryAfterMs(headers, this.now());
    if (status === 200) return this.parseOk(json);
    const c = code(json);
    if (status === 401) return { kind: 'halt', reason: 'reauth' };
    if (status === 426) return { kind: 'halt', reason: 'update_required' };
    if (status === 400) {
      return {
        kind: 'halt',
        reason: c === 'integration_contract_unsupported' ? 'update_required' : 'plugin_bug',
      };
    }
    if (status === 403) {
      if (c === 'integration_paused_plan') return { kind: 'pause', afterMs: ra ?? PAUSE_PROBE_MS };
      return { kind: 'halt', reason: 'scope' };
    }
    if (status === 503) return { kind: 'pause', afterMs: ra ?? PAUSE_PROBE_MS };
    if (status === 429) return { kind: 'retry', afterMs: ra ?? null };
    if (status >= 500) return { kind: 'retry', afterMs: ra };
    return { kind: 'halt', reason: 'plugin_bug' };
  }

  private parseOk(json: unknown): BatchResult {
    const results =
      typeof json === 'object' && json !== null
        ? (json as { results?: unknown }).results
        : undefined;
    if (!Array.isArray(results)) return { kind: 'retry', afterMs: null };
    const items: ItemResult[] = [];
    for (const r of results) {
      if (typeof r !== 'object' || r === null) continue;
      const o = r as { clientReadingId?: unknown; status?: unknown };
      const st = parseItemStatus(o.status);
      if (typeof o.clientReadingId === 'string' && st) {
        items.push({ clientReadingId: o.clientReadingId, status: st });
      }
    }
    return { kind: 'ok', items };
  }
}
