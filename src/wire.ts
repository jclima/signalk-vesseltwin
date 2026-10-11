/**
 * Strict hand-written validators for the contract v2 wire shapes. The vendored schemas under
 * contracts/signalk/v2/ are the source of truth; test/contract-v2.test.ts checks these against them.
 * Zero dependencies.
 *
 * validateReadingItem is deliberately stricter than the schema in one place: `recordedAt` must be
 * UTC (`Z`), which is all the plugin ever produces.
 */

import { isPermittedPath } from './mapping';

export interface ReadingItem {
  clientReadingId: string;
  path: string;
  value: number;
  recordedAt: string;
}

export const READING_STATUSES = [
  'accepted',
  'duplicate',
  'skipped_downsampled',
  'held_unmapped',
  'held_unconfirmed',
  'held_review',
  'rejected',
] as const;
export type ReadingStatus = (typeof READING_STATUSES)[number];

export const READING_REASONS = [
  'meter_backwards',
  'implausible',
  'invalid_id',
  'invalid_path',
  'invalid_value',
  'invalid_time',
  'future',
  'too_old',
  'channel_limit',
] as const;
export type ReadingReason = (typeof READING_REASONS)[number];

export interface ReadingResult {
  clientReadingId: string;
  status: ReadingStatus;
  reason?: ReadingReason;
}

export interface StatusSummary {
  channels: number;
  awaitingSetup: number;
  held: number;
}

export const MAX_BATCH = 500;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RECORDED_AT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/;

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function hasOnlyKeys(o: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(o).every((k) => keys.includes(k));
}

/** True for a real UTC calendar date-time, e.g. not 2026-02-30 or 25:00. */
function isUtcIso(s: string): boolean {
  if (s.length > 40) return false;
  const m = RECORDED_AT_RE.exec(s);
  if (!m) return false;
  const [y, mo, d, h, mi, se] = m.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (mo < 1 || mo > 12 || h > 23 || mi > 59 || se > 59 || d < 1) return false;
  const dim = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return d <= dim;
}

export function validateReadingItem(x: unknown): x is ReadingItem {
  if (!isRecord(x)) return false;
  if (!hasOnlyKeys(x, ['clientReadingId', 'path', 'value', 'recordedAt'])) return false;
  const { clientReadingId, path, value, recordedAt } = x;
  return (
    typeof clientReadingId === 'string' &&
    UUID_RE.test(clientReadingId) &&
    isPermittedPath(path) &&
    typeof value === 'number' &&
    Number.isFinite(value) &&
    typeof recordedAt === 'string' &&
    isUtcIso(recordedAt)
  );
}

function isResult(x: unknown): x is ReadingResult {
  if (!isRecord(x) || !hasOnlyKeys(x, ['clientReadingId', 'status', 'reason'])) return false;
  if (typeof x.clientReadingId !== 'string' || x.clientReadingId.length > 64) return false;
  if (!(READING_STATUSES as readonly unknown[]).includes(x.status)) return false;
  if ('reason' in x && !(READING_REASONS as readonly unknown[]).includes(x.reason)) return false;
  return true;
}

/**
 * Parses a 200 reply to the readings POST. Returns null unless the body is well formed, has exactly
 * one result per batch item, and the ids align by index (the server answers in request order).
 */
export function parseReadingsResponse(
  json: unknown,
  batchIds: readonly string[],
): { serverTime: string; results: ReadingResult[] } | null {
  if (!isRecord(json) || !hasOnlyKeys(json, ['serverTime', 'results'])) return null;
  const { serverTime, results } = json;
  if (
    typeof serverTime !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(serverTime) ||
    Number.isNaN(Date.parse(serverTime))
  )
    return null;
  if (!Array.isArray(results) || results.length !== batchIds.length) return null;
  const out: ReadingResult[] = [];
  for (const [i, r] of (results as unknown[]).entries()) {
    if (!isResult(r) || r.clientReadingId !== batchIds[i]) return null;
    out.push(r);
  }
  return { serverTime, results: out };
}

function isCount(x: unknown): x is number {
  return typeof x === 'number' && Number.isInteger(x) && x >= 0;
}

/** Counts only; unknown keys are tolerated. */
export function parseStatusSummary(json: unknown): StatusSummary | null {
  if (!isRecord(json)) return null;
  const { channels, awaitingSetup, held } = json;
  if (!isCount(channels) || !isCount(awaitingSetup) || !isCount(held)) return null;
  return { channels, awaitingSetup, held };
}
