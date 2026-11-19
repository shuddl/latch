// A connection's samples as golden records (docs/07). One place builds the corpus that
// certifies a map — used by `certify` and by self-heal's shadow re-certification — so both
// grade against every uploaded sample and its operator-confirmed expected output.

import { buildConnectionCorpus, type GoldenCorpus } from '@latch/verify';
import type { CanonicalRecord } from '@latch/canonical';
import type { Store } from './store/store';
import type { TransactionSetDef } from './transaction-sets';

/** SHA-256 (hex) of a sample's text: the key a confirmation is locked to. */
export async function sampleHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface ConnectionSample {
  hash: string;
  input: string;
  /** Present once an operator has confirmed what this sample means. */
  expected?: CanonicalRecord[];
  confirmedAt?: number;
}

/** The connection's samples (trimmed, de-duplicated) joined with their confirmations. */
export async function loadSamples(store: Store, tenantId: string, connectionId: string): Promise<ConnectionSample[]> {
  const [raw, anchors] = await Promise.all([
    store.getSamples(tenantId, connectionId),
    store.getSampleAnchors(tenantId, connectionId),
  ]);
  const seen = new Set<string>();
  const out: ConnectionSample[] = [];
  for (const text of raw) {
    const input = text.trim();
    const hash = await sampleHash(input);
    if (seen.has(hash)) continue;
    seen.add(hash);
    const anchor = Object.prototype.hasOwnProperty.call(anchors, hash) ? anchors[hash] : undefined;
    out.push({ hash, input, ...(anchor ? { expected: anchor.expected, confirmedAt: anchor.confirmedAt } : {}) });
  }
  return out;
}

/** The golden corpus for a connection: its samples (anchored) + the set's coverage cases. */
export function connectionCorpus(def: TransactionSetDef, samples: ConnectionSample[]): GoldenCorpus {
  return buildConnectionCorpus(
    def.buildCorpus,
    def.referenceFixture,
    samples.map((s) => ({ input: s.input, ...(s.expected ? { expectedCanonical: s.expected } : {}) })),
  );
}
