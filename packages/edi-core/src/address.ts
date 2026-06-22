// Element addressing — stable, human-readable coordinates into a parsed interchange.
//
// An address names a single element by (segment tag, zero-based occurrence of that
// tag in document order, one-based element index). One-based element index matches
// X12 convention (B10_02 is "the second element of B10"), so an address renders as
// `B10[0].02`. The transform engine (G1 raw-fidelity contract) and the 997 builder
// (TD2 AK3/AK4 positions) both key off these addresses.

import type { EdiInterchange, EdiSegment } from './index';

export interface ElementAddress {
  tag: string;
  occurrence: number; // 0-based occurrence of `tag` in document order
  element: number; // 1-based element index within the segment
}

/** Render an address as `TAG[occ].NN` (NN zero-padded to 2, the X12 convention). */
export function formatAddress(addr: ElementAddress): string {
  const el = addr.element < 10 ? `0${addr.element}` : String(addr.element);
  return `${addr.tag}[${addr.occurrence}].${el}`;
}

const ADDR_RE = /^([A-Z][A-Z0-9]{1,2})\[(\d+)\]\.(\d{2,})$/;

/** Parse a `TAG[occ].NN` string back into an address. Returns undefined if malformed. */
export function parseAddress(s: string): ElementAddress | undefined {
  const m = ADDR_RE.exec(s);
  if (!m) return undefined;
  return { tag: m[1]!, occurrence: Number(m[2]), element: Number(m[3]) };
}

/** The nth segment (0-based occurrence) bearing `tag`, or undefined. */
export function segmentAt(doc: EdiInterchange, tag: string, occurrence: number): EdiSegment | undefined {
  let seen = -1;
  for (const seg of doc.segments) {
    if (seg.tag === tag) {
      seen += 1;
      if (seen === occurrence) return seg;
    }
  }
  return undefined;
}

/**
 * Read the element at `addr`. Returns undefined when the segment occurrence or the
 * element position is absent. Never throws (hot-path contract, CLAUDE.md §2).
 */
export function readElement(doc: EdiInterchange, addr: ElementAddress): string | undefined {
  const seg = segmentAt(doc, addr.tag, addr.occurrence);
  if (!seg) return undefined;
  return seg.elements[addr.element - 1];
}

/** True when an element address holds a non-empty value in `doc`. */
export function isPopulated(doc: EdiInterchange, addr: ElementAddress): boolean {
  const v = readElement(doc, addr);
  return v !== undefined && v !== '';
}

/**
 * Enumerate every populated element in document order as `(address, value)`.
 * This is the basis for the raw-fidelity contract: a transform must account for
 * every entry here (typed-map it or carry it in `raw`) to claim losslessness.
 */
export function enumerateElements(doc: EdiInterchange): Array<{ address: ElementAddress; value: string }> {
  const out: Array<{ address: ElementAddress; value: string }> = [];
  const counts = new Map<string, number>();
  for (const seg of doc.segments) {
    const occ = counts.get(seg.tag) ?? 0;
    counts.set(seg.tag, occ + 1);
    for (let i = 0; i < seg.elements.length; i++) {
      const value = seg.elements[i]!;
      if (value === '') continue;
      out.push({ address: { tag: seg.tag, occurrence: occ, element: i + 1 }, value });
    }
  }
  return out;
}
