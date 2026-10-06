import type { BatchResult, IngestClient, ItemStatus } from './ingest';
import { MAX_BATCH } from './ingest';
import type { ReadingQueue } from './queue';

export interface DrainOutcome {
  /** Readings acknowledged and removed from the queue. */
  acked: number;
  counts: Partial<Record<ItemStatus, number>>;
  /** Non-ok batch result (retry / pause / halt), or null when the batch was processed. */
  stop: Exclude<BatchResult, { kind: 'ok' }> | null;
  /** True when more readings remain queued. */
  more: boolean;
}

/**
 * Sends one batch from the queue. Readings are removed only after the server reports a
 * terminal per-reading status for them; anything not mentioned stays queued, and a failed
 * batch removes nothing. The queue's own caps (7 days / 50k) bound growth meanwhile.
 */
export async function drainOnce(
  queue: ReadingQueue,
  client: IngestClient,
  batchSize: number = MAX_BATCH,
): Promise<DrainOutcome> {
  const batch = await queue.peek(Math.min(batchSize, MAX_BATCH));
  if (batch.length === 0) return { acked: 0, counts: {}, stop: null, more: false };
  const result = await client.sendBatch(batch);
  if (result.kind !== 'ok') return { acked: 0, counts: {}, stop: result, more: true };
  const sent = new Set(batch.map((r) => r.clientReadingId));
  const counts: Partial<Record<ItemStatus, number>> = {};
  const ids: string[] = [];
  for (const it of result.items) {
    if (!sent.has(it.clientReadingId)) continue;
    ids.push(it.clientReadingId);
    counts[it.status] = (counts[it.status] ?? 0) + 1;
  }
  await queue.ack(ids);
  return { acked: ids.length, counts, stop: null, more: (await queue.size()) > 0 };
}
