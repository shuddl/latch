// Loop-aware structural grouping (TD1/G4). X12 documents are flat segment lists,
// but their meaning is hierarchical: repeating loops (e.g. the 214 `LX` status loop,
// the 204 `S5` stop loop, the `N1` party loop). `spec`/`verify` need this structure
// to reason about qualifier coverage and loop cardinality (docs/07 benchmark bar).
//
// This is an *analysis view* layered on top of the byte-faithful flat parser — it is
// deliberately NOT the serialization path. Round-trip fidelity (the moat) always runs
// on the original flat segments, so grouping can never threaten losslessness.

import type { EdiSegment } from './index';

export interface LoopSchema {
  name: string;
  start: string; // segment tag that opens an instance of this loop
  /** Tags that close the loop without opening a peer (e.g. `SE`, a parent closer). */
  terminators?: string[];
  /** Nested loops contained within an instance of this loop. */
  groups?: LoopSchema[];
}

export interface LoopInstance {
  name: string;
  /** The full span of this instance, in document order (includes descendants). */
  segments: EdiSegment[];
  /** Nested loop instances found within this instance's span. */
  children: LoopInstance[];
}

export interface GroupingResult {
  /** Segments before the first loop at this level (e.g. heading B10/L11 for a 214). */
  lead: EdiSegment[];
  loops: LoopInstance[];
}

/**
 * Group a segment list into loop instances per the given schemas. Deterministic and
 * total: every segment lands either in `lead` or inside exactly one top-level instance.
 */
export function groupSegments(segments: EdiSegment[], schemas: LoopSchema[]): GroupingResult {
  const startToSchema = new Map<string, LoopSchema>();
  for (const s of schemas) startToSchema.set(s.start, s);
  const peerStarts = new Set(startToSchema.keys());

  const lead: EdiSegment[] = [];
  const loops: LoopInstance[] = [];

  let i = 0;
  // Collect leading segments until the first loop opener.
  while (i < segments.length && !peerStarts.has(segments[i]!.tag)) {
    lead.push(segments[i]!);
    i += 1;
  }

  while (i < segments.length) {
    const startSeg = segments[i]!;
    const schema = startToSchema.get(startSeg.tag);
    if (!schema) {
      // Not a loop opener at this level (e.g. a trailing terminator); treat as lead.
      lead.push(startSeg);
      i += 1;
      continue;
    }
    const terminators = new Set(schema.terminators ?? []);
    const span: EdiSegment[] = [startSeg];
    let j = i + 1;
    while (j < segments.length) {
      const tag = segments[j]!.tag;
      // A peer opener or a declared terminator closes this instance.
      if (peerStarts.has(tag) || terminators.has(tag)) break;
      span.push(segments[j]!);
      j += 1;
    }
    const children = schema.groups && schema.groups.length > 0
      ? groupSegments(span.slice(1), schema.groups).loops
      : [];
    loops.push({ name: schema.name, segments: span, children });
    i = j;
  }

  return { lead, loops };
}

/** Count top-level instances of each named loop — the loop-cardinality signal. */
export function loopCardinality(segments: EdiSegment[], schemas: LoopSchema[]): Record<string, number> {
  const { loops } = groupSegments(segments, schemas);
  const counts: Record<string, number> = {};
  for (const schema of schemas) counts[schema.name] = 0;
  for (const inst of loops) counts[inst.name] = (counts[inst.name] ?? 0) + 1;
  return counts;
}
