// The transport-agnostic inbound drain: poll an adapter, hand each file to a sink, and
// acknowledge ONLY the files the sink accepted. A sink failure leaves that file
// un-acked (so the next poll retries it) and never aborts the batch — one bad file can't
// block the rest. Deterministic and adapter-agnostic: the same loop drives SFTP, AS2,
// VAN, or the in-memory adapter.

import type { ConnectivityAdapter, InboundFile } from './types';

export interface DrainResult {
  /** Names of files the sink accepted and the adapter acknowledged. */
  processed: string[];
  /** Files the sink rejected (left un-acked for retry), with the error text. */
  failed: { name: string; error: string }[];
}

/**
 * Drain all currently-available inbound files through `sink`. `sink` should be idempotent
 * (the same file may be retried after a transient failure); the pipeline already dedups on
 * EDI control numbers, so re-delivery is safe.
 */
export async function drainInbound(
  adapter: ConnectivityAdapter,
  sink: (file: InboundFile) => Promise<void>,
): Promise<DrainResult> {
  const files = await adapter.poll();
  const processed: string[] = [];
  const failed: { name: string; error: string }[] = [];
  for (const file of files) {
    try {
      await sink(file);
    } catch (err) {
      failed.push({ name: file.name, error: err instanceof Error ? err.message : String(err) });
      continue; // leave un-acked → retried next poll; don't abort the batch
    }
    try {
      await adapter.ack(file.name);
      processed.push(file.name);
    } catch (err) {
      // Sink succeeded but ack failed: report it; the pipeline's control-number dedup
      // makes the inevitable re-delivery a no-op rather than a duplicate transaction.
      failed.push({ name: file.name, error: `processed but ack failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  return { processed, failed };
}
