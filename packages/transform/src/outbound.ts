// packages/transform — outbound generation (M3.3). The inverse of `toCanonical`: build an
// EDI interchange FROM a canonical record, with NO inbound snapshot to overlay (this is a
// freshly-authored outbound document, e.g. a 990 emitted in response to a received 204).
// Still deterministic, still NO LLM.
//
// The body skeleton is derived from the map's flat rules: each element/codemap/derived rule
// names a (tag, occurrence) segment and an element position; we materialize those segments
// (in first-seen order) and fill them in reverse:
//   - element : canonical value → element string (cast values are stringified — the outbound
//               document has no prior lexical form to preserve, so String(n) is correct)
//   - codemap : canonical enum → EDI code via the INVERSE table
//   - const   : canonical-only (e.g. `kind`) → never emitted to EDI
//   - derived : forward-only and not reversible (e.g. ISO ← date+time) → skipped with a warning
// Repeating loops/groups outbound are a documented follow-up; v1 covers the flat sets
// (990, 214), which is the 204↔990 response pairing that matters first.

import {
  buildInterchange,
  type EdiDelimiters,
  type EdiInterchange,
  type EdiSegment,
  type FunctionalGroupHeader,
  type InterchangeHeader,
} from '@latch/edi-core';
import type { CanonicalRecord, Tender, TenderResponse } from '@latch/canonical';
import { ok, err, getPath, type Result, type Issue } from '@latch/shared';
import type { MapArtifact } from './map';

/** Standard 004010 delimiters; overridable per partner. */
export const DEFAULT_DELIMITERS: EdiDelimiters = { element: '*', segment: '~', subElement: '>' };

export interface OutboundEnvelope {
  interchange: InterchangeHeader;
  group: FunctionalGroupHeader;
  /** ST02 control number for the single transaction set emitted. */
  stControlNumber: string;
  delimiters?: EdiDelimiters;
}

function setElement(seg: EdiSegment, position1Based: number, value: string): void {
  while (seg.elements.length < position1Based) seg.elements.push('');
  seg.elements[position1Based - 1] = value;
}

/** Inverse of a codemap table (canonical value → EDI code). Last entry wins on collision. */
function invertTable(table: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  for (const [code, canonical] of Object.entries(table)) out[canonical] = code;
  return out;
}

/**
 * Build an EDI interchange from a canonical record using `map` in reverse. Never throws;
 * returns a structured error if the map needs unsupported (loop/group) outbound handling.
 */
export function buildOutbound(
  map: MapArtifact,
  record: CanonicalRecord,
  envelope: OutboundEnvelope,
): Result<EdiInterchange> {
  if (map.rules.some((r) => r.kind === 'loop' || r.kind === 'group')) {
    return err({
      code: 'UNSUPPORTED',
      message: `Outbound generation for ${map.transactionSet} with repeating loops/groups is not supported yet (flat sets only).`,
    });
  }

  const obj = record as unknown as Record<string, unknown>;
  const warnings: Issue[] = [];

  // Materialize segments by (tag, occurrence), preserving first-seen rule order. A segment
  // is only created once it has a populated element, so optional segments don't emit empties.
  const order: string[] = [];
  const byKey = new Map<string, EdiSegment>();
  const ensure = (tag: string, occurrence: number): EdiSegment => {
    const key = `${tag}#${occurrence}`;
    let seg = byKey.get(key);
    if (!seg) {
      seg = { tag, elements: [] };
      byKey.set(key, seg);
      order.push(key);
    }
    return seg;
  };

  for (const rule of map.rules) {
    switch (rule.kind) {
      case 'const':
        continue; // canonical-only; never serialized
      case 'element': {
        const value = getPath(obj, rule.path);
        if (value === undefined || value === null || value === '') continue;
        setElement(ensure(rule.source.tag, rule.source.occurrence), rule.source.element, String(value));
        continue;
      }
      case 'codemap': {
        const value = getPath(obj, rule.path);
        if (value === undefined || value === null) continue;
        const code = invertTable(rule.table)[String(value)];
        if (code === undefined) {
          warnings.push({ code: 'TRANSFORM', message: `No outbound code for ${rule.path}="${String(value)}"`, path: rule.path });
          continue;
        }
        setElement(ensure(rule.source.tag, rule.source.occurrence), rule.source.element, code);
        continue;
      }
      case 'derived':
        warnings.push({
          code: 'TRANSFORM',
          message: `Derived field ${rule.path} is forward-only and cannot be generated outbound; map its source elements explicitly if needed`,
          path: rule.path,
        });
        continue;
      default:
        continue;
    }
  }

  const segments = order.map((k) => byKey.get(k)!);
  const interchange = buildInterchange({
    delimiters: envelope.delimiters ?? DEFAULT_DELIMITERS,
    interchange: envelope.interchange,
    group: envelope.group,
    transactions: [{ code: map.transactionSet, controlNumber: envelope.stControlNumber, segments }],
  });
  return ok(interchange, warnings);
}

/**
 * The 204↔990 pairing: turn a received Tender + a carrier decision into the canonical
 * TenderResponse to emit. Pure canonical→canonical; serialize it via `buildOutbound` with
 * the 990 map. The shipmentId carries through so the partner can correlate the response.
 */
export function respondToTender(
  tender: Tender,
  decision: 'accept' | 'decline',
  reason?: string,
): TenderResponse {
  return {
    kind: 'TenderResponse',
    canonicalVersion: tender.canonicalVersion,
    shipmentId: tender.shipmentId,
    decision,
    ...(reason ? { reason } : {}),
  };
}
