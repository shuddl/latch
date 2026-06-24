// Deterministic drift detection (docs/07). Drift is detected against a baseline of
// what certification actually exercised — no LLM. A baseline is the set of business
// segments, their element widths, and the qualifier codes observed in the certified
// sample/corpus; live traffic that exceeds it is drift.

import type { EdiInterchange } from '@latch/edi-core';

export type DriftKind = 'new_segment' | 'changed_qualifier' | 'structural' | 'loop_change';

/** A 1-based element position that carries a qualifier code we should watch. */
export interface QualifierPosition {
  tag: string;
  element: number;
}

export interface DriftFinding {
  kind: DriftKind;
  segment: string;
  detail: string; // plain English
  evidence: string;
}

export interface DriftBaseline {
  /** business segment tag → max element count observed */
  segments: Record<string, number>;
  /** `${tag}:${element}` → sorted observed qualifier codes */
  qualifiers: Record<string, string[]>;
}

// Common qualifier-bearing positions for the freight sets. The spec ingestor (M1.1)
// will supply these per partner; until then this is a sound default.
export const DEFAULT_QUALIFIER_POSITIONS: QualifierPosition[] = [
  { tag: 'L11', element: 2 },
  { tag: 'N1', element: 1 },
  { tag: 'N9', element: 1 },
  { tag: 'AT7', element: 1 },
];

const ENVELOPE = new Set(['ISA', 'GS', 'ST', 'SE', 'GE', 'IEA']);

export function buildBaseline(
  samples: EdiInterchange[],
  positions: QualifierPosition[] = DEFAULT_QUALIFIER_POSITIONS,
): DriftBaseline {
  const segments: Record<string, number> = {};
  const qsets: Record<string, Set<string>> = {};
  for (const doc of samples) {
    for (const seg of doc.segments) {
      if (ENVELOPE.has(seg.tag)) continue;
      segments[seg.tag] = Math.max(segments[seg.tag] ?? 0, seg.elements.length);
    }
    for (const p of positions) {
      for (const seg of doc.segments) {
        if (seg.tag !== p.tag) continue;
        const code = seg.elements[p.element - 1];
        if (code) (qsets[`${p.tag}:${p.element}`] ??= new Set()).add(code);
      }
    }
  }
  const qualifiers: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(qsets)) qualifiers[k] = [...v].sort();
  return { segments, qualifiers };
}

export function detectDrift(
  baseline: DriftBaseline,
  live: EdiInterchange,
  positions: QualifierPosition[] = DEFAULT_QUALIFIER_POSITIONS,
): DriftFinding[] {
  const found = new Map<string, DriftFinding>();
  const add = (f: DriftFinding) => found.set(`${f.kind}:${f.segment}:${f.evidence}`, f);

  for (const seg of live.segments) {
    if (ENVELOPE.has(seg.tag)) continue;
    const knownWidth = baseline.segments[seg.tag];
    if (knownWidth === undefined) {
      add({
        kind: 'new_segment',
        segment: seg.tag,
        detail: `New segment ${seg.tag} not seen during certification`,
        evidence: seg.tag,
      });
      continue;
    }
    if (seg.elements.length > knownWidth) {
      add({
        kind: 'structural',
        segment: seg.tag,
        detail: `${seg.tag} now carries ${seg.elements.length} elements (certified with ≤ ${knownWidth})`,
        evidence: `len:${seg.elements.length}`,
      });
    }
  }

  for (const p of positions) {
    const known = new Set(baseline.qualifiers[`${p.tag}:${p.element}`] ?? []);
    if (known.size === 0) continue; // position not exercised in cert → can't judge
    for (const seg of live.segments) {
      if (seg.tag !== p.tag) continue;
      const code = seg.elements[p.element - 1];
      if (code && !known.has(code)) {
        add({
          kind: 'changed_qualifier',
          segment: p.tag,
          detail: `New qualifier '${code}' at ${p.tag}-${String(p.element).padStart(2, '0')} (certified: ${[...known].join(', ')})`,
          evidence: code,
        });
      }
    }
  }

  return [...found.values()];
}
