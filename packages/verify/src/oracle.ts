// The Proof's oracles (docs/07, B1). Three independent ways to judge a map, none of
// which grades the map purely against its own interpretation:
//
//  1. Invariant oracle  — round-trip losslessness, required-segment & qualifier
//     preservation, loop-cardinality. Map-independent: a map cannot satisfy round-trip
//     losslessness while silently dropping/mis-tagging an element.
//  2. Forward oracle     — compare engine output to a human-confirmed expected canonical
//     (sample anchors). Ground truth.
//  3. Differential oracle — re-derive each `element` rule's expected value by reading the
//     source address DIRECTLY (independent of the engine's path/loop logic) and check the
//     engine placed exactly that value. Catches mis-placement bugs in the engine.

import {
  createEdiCore,
  enumerateElements,
  formatAddress,
  readElement,
  type EdiInterchange,
  type EdiSegment,
} from '@latch/edi-core';
import type { CanonicalRecord } from '@latch/canonical';
import { toCanonical, fromCanonical, RAW_EDI_KEY, type MapArtifact, type ChildRule } from '@latch/transform';
import { getPath, stableStringify } from '@latch/shared';

const edi = createEdiCore();

/** Element-level fidelity of a reconstructed interchange vs the original [0,1]. */
export function elementFidelity(original: EdiInterchange, rebuilt: EdiInterchange): number {
  const want = enumerateElements(original).map((e) => `${formatAddress(e.address)}=${e.value}`);
  if (want.length === 0) return 1;
  const have = new Set(enumerateElements(rebuilt).map((e) => `${formatAddress(e.address)}=${e.value}`));
  let matched = 0;
  for (const w of want) if (have.has(w)) matched += 1;
  return matched / want.length;
}

export interface RoundTripOutcome {
  ok: boolean;
  fidelity: number;
  issues: string[];
}

/** Invariant oracle: EDI → canonical → EDI must reproduce every populated element. */
export function roundTripOracle(map: MapArtifact, input: string): RoundTripOutcome {
  const parsed = edi.parse(input);
  if (!parsed.ok) {
    return { ok: false, fidelity: 0, issues: parsed.errors.map((e) => e.message) };
  }
  const fwd = toCanonical(map, parsed.value);
  if (!fwd.ok) {
    return { ok: false, fidelity: 0, issues: fwd.errors.map((e) => e.message) };
  }
  const back = fromCanonical(map, fwd.value);
  if (!back.ok) {
    return { ok: false, fidelity: 0, issues: back.errors.map((e) => e.message) };
  }
  const fidelity = elementFidelity(parsed.value, back.value);
  const exact = edi.serialize(back.value) === input;
  const issues: string[] = [];
  if (!exact) issues.push('Round-trip is not byte-identical to the source interchange');
  return { ok: exact && fidelity >= 0.999, fidelity, issues };
}

/** Strip the lossless EDI snapshot so canonical comparison ignores the raw escape hatch. */
function stripRaw(rec: CanonicalRecord): unknown {
  const clone = JSON.parse(JSON.stringify(rec)) as { raw?: Record<string, unknown> };
  if (clone.raw && typeof clone.raw === 'object') {
    delete clone.raw[RAW_EDI_KEY];
    if (Object.keys(clone.raw).length === 0) delete clone.raw;
  }
  return clone;
}

/** Forward oracle: engine output equals the human-confirmed expected canonical. */
export function forwardOracle(
  map: MapArtifact,
  input: string,
  expected: CanonicalRecord[],
): { match: boolean; issues: string[] } {
  const parsed = edi.parse(input);
  if (!parsed.ok) return { match: false, issues: ['input did not parse'] };
  const fwd = toCanonical(map, parsed.value);
  if (!fwd.ok) return { match: false, issues: fwd.errors.map((e) => e.message) };
  if (fwd.value.length !== expected.length) {
    return { match: false, issues: [`expected ${expected.length} record(s), got ${fwd.value.length}`] };
  }
  const issues: string[] = [];
  for (let i = 0; i < expected.length; i++) {
    const got = stableStringify(stripRaw(fwd.value[i]!));
    const want = stableStringify(stripRaw(expected[i]!));
    if (got !== want) issues.push(`record ${i} differs from the confirmed expected canonical`);
  }
  return { match: issues.length === 0, issues };
}

/** Independent re-windowing (NOT the engine's): each `anchor` occurrence opens a window
 *  to the next same-tag anchor. Duplicated here on purpose so the oracle never trusts the
 *  engine's loop logic to judge the engine's loop output. */
function windows(segments: EdiSegment[], anchor: string): EdiSegment[][] {
  const starts: number[] = [];
  segments.forEach((s, i) => {
    if (s.tag === anchor) starts.push(i);
  });
  return starts.map((start, k) =>
    segments.slice(start, k + 1 < starts.length ? starts[k + 1] : segments.length),
  );
}

/** Independent group selection (NOT the engine's): the window of the first `anchor`
 *  occurrence whose 1-based `matchElement` equals `matchValue`, to the next same-tag anchor. */
function selectGroup(
  segments: EdiSegment[],
  anchor: string,
  matchElement: number,
  matchValue: string,
): EdiSegment[] | undefined {
  let start = -1;
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]!;
    if (s.tag === anchor && s.elements[matchElement - 1] === matchValue) {
      start = i;
      break;
    }
  }
  if (start < 0) return undefined;
  let end = segments.length;
  for (let i = start + 1; i < segments.length; i++) {
    if (segments[i]!.tag === anchor) {
      end = i;
      break;
    }
  }
  return segments.slice(start, end);
}

/** Re-derive one flat rule's expected value directly from `doc` and compare to the engine's
 *  placement at `target[path]`. Independent of the engine's path logic. */
function diffChild(
  rule: ChildRule,
  doc: EdiInterchange,
  target: Record<string, unknown>,
  label: string,
  issues: string[],
): void {
  if (rule.kind === 'element') {
    const raw = readElement(doc, rule.source);
    // Match the engine: trim only the populated-check + numeric parse; compare the
    // uncast string against the engine's verbatim (untrimmed) stored value.
    if (raw === undefined || raw.trim() === '') return; // not populated → not required at path
    if (rule.cast === 'number') {
      const n = Number(raw.trim());
      if (!Number.isFinite(n)) return;
      const got = getPath(target, rule.path);
      if (got !== n) issues.push(`${label}${rule.path}: engine has ${JSON.stringify(got)} but source ${formatAddress(rule.source)} casts to ${JSON.stringify(n)}`);
      return;
    }
    const got = getPath(target, rule.path);
    if (got !== raw) issues.push(`${label}${rule.path}: engine has ${JSON.stringify(got)} but source ${formatAddress(rule.source)} is ${JSON.stringify(raw)}`);
  } else if (rule.kind === 'codemap') {
    const code = readElement(doc, rule.source)?.trim();
    if (code === undefined || code === '') return;
    const mapped = Object.prototype.hasOwnProperty.call(rule.table, code) ? rule.table[code] : undefined;
    const expected = mapped ?? (rule.onMiss === 'passthrough' ? code : undefined);
    if (expected === undefined) return;
    const got = getPath(target, rule.path);
    if (got !== expected) issues.push(`${label}${rule.path}: engine has ${JSON.stringify(got)} but codemap of ${formatAddress(rule.source)}="${code}" is ${JSON.stringify(expected)}`);
  }
}

/**
 * Differential oracle: re-derive every `element`/`codemap` rule's expected value by reading
 * the source address DIRECTLY (and, for loops, re-windowing the body independently) and
 * confirm the engine placed exactly that value. Independent of the engine's path/loop logic.
 */
export function differentialOracle(map: MapArtifact, input: string): { match: boolean; issues: string[] } {
  const parsed = edi.parse(input);
  if (!parsed.ok) return { match: false, issues: ['input did not parse'] };
  const fwd = toCanonical(map, parsed.value);
  if (!fwd.ok) return { match: false, issues: fwd.errors.map((e) => e.message) };
  const record = fwd.value[0];
  if (!record) return { match: false, issues: ['no canonical record produced'] };

  // Independent body extraction (does not reuse the engine's splitter internals).
  const segs = parsed.value.segments;
  const stIdx = segs.findIndex((s) => s.tag === 'ST');
  const seIdx = segs.findIndex((s) => s.tag === 'SE');
  const body = stIdx >= 0 && seIdx > stIdx ? segs.slice(stIdx + 1, seIdx) : [];
  const bodyDoc: EdiInterchange = { segments: body, delimiters: parsed.value.delimiters };

  const obj = record as unknown as Record<string, unknown>;
  const issues: string[] = [];
  for (const rule of map.rules) {
    if (rule.kind === 'element' || rule.kind === 'codemap') {
      diffChild(rule, bodyDoc, obj, '', issues);
    } else if (rule.kind === 'loop') {
      const arr = getPath(obj, rule.path);
      if (!Array.isArray(arr)) {
        issues.push(`${rule.path}: engine did not produce an array for the loop`);
        continue;
      }
      const wins = windows(body, rule.anchor);
      if (wins.length !== arr.length) {
        issues.push(`${rule.path}: engine produced ${arr.length} item(s) but body has ${wins.length} ${rule.anchor} window(s)`);
      }
      const n = Math.min(wins.length, arr.length);
      for (let k = 0; k < n; k++) {
        const windowDoc: EdiInterchange = { segments: wins[k]!, delimiters: bodyDoc.delimiters };
        const item = (arr[k] ?? {}) as Record<string, unknown>;
        for (const child of rule.fields) diffChild(child, windowDoc, item, `${rule.path}[${k}].`, issues);
      }
    } else if (rule.kind === 'group') {
      const win = selectGroup(body, rule.anchor, rule.match.element, rule.match.equals);
      if (!win) continue; // no matching group in this record → optional path stays unset
      const target = getPath(obj, rule.path);
      if (!target || typeof target !== 'object') {
        issues.push(`${rule.path}: engine did not produce an object for the ${rule.anchor}*${rule.match.equals} group`);
        continue;
      }
      const windowDoc: EdiInterchange = { segments: win, delimiters: bodyDoc.delimiters };
      for (const child of rule.fields) diffChild(child, windowDoc, target as Record<string, unknown>, `${rule.path}.`, issues);
    }
  }
  return { match: issues.length === 0, issues };
}

/** Adversarial oracle: a malformed input must be rejected gracefully (no throw, no silent map). */
export function adversarialOracle(map: MapArtifact, input: string): { graceful: boolean; issues: string[] } {
  try {
    const parsed = edi.parse(input);
    if (!parsed.ok) return { graceful: true, issues: [] };
    const fwd = toCanonical(map, parsed.value);
    if (!fwd.ok) return { graceful: true, issues: [] };
    // It parsed AND transformed — graceful only if the envelope itself was flagged.
    const envelope = edi.validateEnvelope(parsed.value);
    if (envelope.length > 0) return { graceful: true, issues: [] };
    return { graceful: false, issues: ['adversarial input was silently accepted and transformed'] };
  } catch (e) {
    return { graceful: false, issues: [`hot path threw instead of returning a structured error: ${String(e)}`] };
  }
}
