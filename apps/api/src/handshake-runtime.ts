// HSP co-certification, wired to the REAL deterministic engine (docs/05 Phase 4). The
// handshake package is engine-agnostic (it takes an injected `runCorpus`); here is where a
// Latch node actually runs a peer's golden corpus through its own pinned map and returns the
// canonical output. This is what makes co-certification meaningful: each side proves, with
// the same Verification-Engine machinery used for one-sided certs, that it reproduces the
// other's intended canonical for every case — no human round-trip.

import { createEdiCore } from '@latch/edi-core';
import { toCanonical, RAW_EDI_KEY, type MapArtifact } from '@latch/transform';
import type { GoldenCase, GoldenFlow } from '@latch/handshake';

const edi = createEdiCore();

/** Drop the lossless `raw.__edi` snapshot so co-cert compares semantic canonical only. */
function stripRaw(rec: unknown): unknown {
  if (!rec || typeof rec !== 'object') return rec ?? null;
  const clone = JSON.parse(JSON.stringify(rec)) as { raw?: Record<string, unknown> };
  if (clone.raw && typeof clone.raw === 'object') {
    delete clone.raw[RAW_EDI_KEY];
    if (Object.keys(clone.raw).length === 0) delete clone.raw;
  }
  return clone;
}

/**
 * A co-certification runner backed by the deterministic engine: parse each golden case and
 * run it through `map`, returning the canonical output (raw snapshot stripped). A case that
 * fails to parse/transform yields `canonical: null` — which simply won't match the sender's
 * intended canonical, so co-certification fails closed.
 */
export function corpusRunner(map: MapArtifact): (set: string, cases: GoldenCase[]) => { name: string; canonical: unknown }[] {
  return (_set, cases) =>
    cases.map((c) => {
      const parsed = edi.parse(c.input);
      if (!parsed.ok) return { name: c.name, canonical: null };
      const r = toCanonical(map, parsed.value);
      if (!r.ok || !r.value[0]) return { name: c.name, canonical: null };
      return { name: c.name, canonical: stripRaw(r.value[0]) };
    });
}

/**
 * Build the golden flow a SENDER publishes for a set: the cases plus the sender's own
 * intended canonical (computed by running the cases through the sender's map). The receiver
 * must reproduce these exactly for co-certification to pass.
 */
export function buildGoldenFlow(map: MapArtifact, set: string, cases: GoldenCase[]): GoldenFlow {
  return { cases, expected: corpusRunner(map)(set, cases) };
}
