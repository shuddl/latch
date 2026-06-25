// packages/transform — outbound generation (M3.3). The inverse of `toCanonical`: build an
// EDI interchange FROM a canonical record, with NO inbound snapshot to overlay (this is a
// freshly-authored outbound document, e.g. a 990 emitted in response to a received 204).
// Still deterministic, still NO LLM.
//
// The body is materialized from the map's rules:
//   - flat rules (element/codemap/const/derived) → top-level segments, filled in reverse:
//       element : canonical value → element string (cast values are stringified — the outbound
//                 document has no prior lexical form to preserve, so String(n) is correct)
//       codemap : canonical enum → EDI code via the INVERSE table
//       const   : canonical-only (e.g. `kind`) → never emitted to EDI
//       derived : forward-only and not reversible (e.g. ISO ← date+time) → skipped with a warning
//   - loop  → one window per canonical array item (anchor segment + child segments)
//   - group → one qualifier-stamped window when the canonical object is present
//
// Because there is no snapshot to guarantee fidelity, `buildOutbound` is SELF-VERIFYING: it
// parses the document it just built back through `toCanonical` and confirms it reproduces the
// intended canonical. If it does not (a map structure outbound can't faithfully express — e.g.
// a derived field whose sources aren't mapped, or colliding loop/flat tags), it returns a
// clear error instead of emitting a wrong document. Correctness is the product (CLAUDE.md §2).

import {
  buildInterchange,
  type EdiDelimiters,
  type EdiInterchange,
  type EdiSegment,
  type FunctionalGroupHeader,
  type InterchangeHeader,
} from '@latch/edi-core';
import type { CanonicalRecord, Tender, TenderResponse } from '@latch/canonical';
import { ok, err, getPath, stableStringify, type Result, type Issue } from '@latch/shared';
import type { ChildRule, MapArtifact } from './map';
import { toCanonical } from './engine';

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

type InvertedCache = Map<Record<string, string>, Record<string, string>>;

/**
 * Materialize a set of FLAT rules against a source object into EDI segments. Used for the
 * top-level flat rules (source = the record) and for each loop item / group window (source =
 * the item/group object; child paths are relative to it, child addresses relative to the
 * window). Emits each tag's occurrences 0..max CONTIGUOUSLY so re-parse keeps occurrence
 * indexing stable (occurrence 1 must not slide to 0 when occurrence 0 is empty).
 */
function materializeFlat(rules: ChildRule[], obj: Record<string, unknown>, inverted: InvertedCache, warnings: Issue[]): EdiSegment[] {
  const tagOrder: string[] = [];
  const cells = new Map<string, Map<number, Map<number, string>>>();
  const put = (tag: string, occurrence: number, position: number, value: string): void => {
    let occMap = cells.get(tag);
    if (!occMap) {
      occMap = new Map();
      cells.set(tag, occMap);
      tagOrder.push(tag);
    }
    let posMap = occMap.get(occurrence);
    if (!posMap) {
      posMap = new Map();
      occMap.set(occurrence, posMap);
    }
    posMap.set(position, value);
  };

  for (const rule of rules) {
    switch (rule.kind) {
      case 'const':
        continue; // canonical-only; never serialized
      case 'element': {
        const value = getPath(obj, rule.path);
        // Skip empties and non-primitives — String({}) would emit a malformed "[object Object]".
        if (value === undefined || value === null || value === '' || typeof value === 'object') continue;
        put(rule.source.tag, rule.source.occurrence, rule.source.element, String(value));
        continue;
      }
      case 'codemap': {
        const value = getPath(obj, rule.path);
        if (value === undefined || value === null || typeof value === 'object') continue;
        let table = inverted.get(rule.table);
        if (!table) {
          table = invertTable(rule.table);
          inverted.set(rule.table, table);
        }
        const code = table[String(value)];
        if (code === undefined) {
          warnings.push({ code: 'TRANSFORM', message: `No outbound code for ${rule.path}="${String(value)}"`, path: rule.path });
          continue;
        }
        put(rule.source.tag, rule.source.occurrence, rule.source.element, code);
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

  const segments: EdiSegment[] = [];
  for (const tag of tagOrder) {
    const occMap = cells.get(tag)!;
    const maxOcc = Math.max(...occMap.keys());
    for (let occ = 0; occ <= maxOcc; occ++) {
      const seg: EdiSegment = { tag, elements: [] };
      const posMap = occMap.get(occ);
      if (posMap) for (const [pos, val] of posMap) setElement(seg, pos, val);
      segments.push(seg);
    }
  }
  return segments;
}

/** Ensure a window opens with its anchor segment (re-parse slices iterations by anchor). */
function ensureAnchorLeads(segs: EdiSegment[], anchor: string): EdiSegment {
  const idx = segs.findIndex((s) => s.tag === anchor);
  if (idx === -1) {
    const seg: EdiSegment = { tag: anchor, elements: [] };
    segs.unshift(seg);
    return seg;
  }
  if (idx > 0) {
    const [a] = segs.splice(idx, 1);
    segs.unshift(a!);
  }
  return segs[0]!;
}

/** A shallow copy of a canonical record with its `raw` removed — what we compare on round-trip
 *  (an authored outbound record has no `raw`; the parsed-back one carries the snapshot). */
function withoutRaw(rec: unknown): unknown {
  if (!rec || typeof rec !== 'object') return rec;
  const { raw: _raw, ...rest } = rec as { raw?: unknown } & Record<string, unknown>;
  void _raw;
  return rest;
}

/**
 * Build an EDI interchange from a canonical record using `map` in reverse. Never throws.
 * Self-verifies: the generated document is parsed back and must reproduce the intended
 * canonical, else a structured error is returned (never a silently-wrong document).
 */
export function buildOutbound(
  map: MapArtifact,
  record: CanonicalRecord,
  envelope: OutboundEnvelope,
): Result<EdiInterchange> {
  if (record.kind !== map.recordKind) {
    return err({
      code: 'VALIDATION',
      message: `Record kind "${record.kind}" does not match the map's recordKind "${map.recordKind}"`,
    });
  }

  const obj = record as unknown as Record<string, unknown>;
  const warnings: Issue[] = [];
  const inverted: InvertedCache = new Map();

  // Top-level flat rules first, then each loop's windows, then each group's window.
  const flatRules = map.rules.filter((r): r is ChildRule => r.kind !== 'loop' && r.kind !== 'group');
  const body: EdiSegment[] = materializeFlat(flatRules, obj, inverted, warnings);

  for (const rule of map.rules) {
    if (rule.kind === 'loop') {
      const arr = getPath(obj, rule.path);
      if (!Array.isArray(arr)) continue;
      for (const item of arr) {
        if (!item || typeof item !== 'object') continue;
        const window = materializeFlat(rule.fields, item as Record<string, unknown>, inverted, warnings);
        ensureAnchorLeads(window, rule.anchor);
        body.push(...window);
      }
    } else if (rule.kind === 'group') {
      const g = getPath(obj, rule.path);
      if (!g || typeof g !== 'object') continue;
      const window = materializeFlat(rule.fields, g as Record<string, unknown>, inverted, warnings);
      const anchorSeg = ensureAnchorLeads(window, rule.anchor);
      // Stamp the qualifier so re-parse selects this window for the group.
      setElement(anchorSeg, rule.match.element, rule.match.equals);
      body.push(...window);
    }
  }

  const interchange = buildInterchange({
    delimiters: envelope.delimiters ?? DEFAULT_DELIMITERS,
    interchange: envelope.interchange,
    group: envelope.group,
    transactions: [{ code: map.transactionSet, controlNumber: envelope.stControlNumber, segments: body }],
  });

  // Self-verify: the document we just built must parse back to the canonical we were given.
  // This is what lets outbound be trusted without a snapshot — a structure outbound can't
  // faithfully express is rejected, never emitted wrong.
  const back = toCanonical(map, interchange);
  if (!back.ok || !back.value[0]) {
    return err({
      code: 'UNSUPPORTED',
      message: `Outbound generation for ${map.transactionSet} produced a document that does not parse back to canonical.`,
    });
  }
  if (stableStringify(withoutRaw(back.value[0])) !== stableStringify(withoutRaw(record))) {
    return err({
      code: 'UNSUPPORTED',
      message: `Outbound generation for ${map.transactionSet} could not produce a document that round-trips to the intended canonical (map structure is not outbound-expressible — e.g. derived fields without mapped sources, or colliding loop/flat tags).`,
    });
  }

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
