// packages/transform — the deterministic interpreter (NO LLM; CLAUDE.md §2).
//
// `toCanonical` and `fromCanonical` execute a MapArtifact, returning a TransformResult
// that never throws into the hot path. The raw-fidelity contract (G1) is enforced
// structurally: each canonical record carries, under `raw.__edi`, a verbatim snapshot
// of its transaction-set envelope + body. `fromCanonical` reconstructs bytes from that
// snapshot, overlaying `element`-rule values written back to their source addresses, so
//   fromCanonical(toCanonical(edi)) === edi   byte-for-byte.
// Anything not typed-mapped is therefore never lost: it rides in the snapshot.

import {
  type EdiInterchange,
  type EdiSegment,
  type ElementAddress,
  readElement,
} from '@latch/edi-core';
import {
  canonicalRecordSchema,
  type CanonicalRecord,
} from '@latch/canonical';
import { ok, err, getPath, setPath, type Result, type Issue } from '@latch/shared';
import type { MapArtifact, FieldRule } from './map';

export type TransformResult<T> = Result<T>;

/** Reserved `raw` key holding the lossless per-record EDI snapshot. */
export const RAW_EDI_KEY = '__edi';

interface EdiSnapshot {
  delimiters: EdiInterchange['delimiters'];
  interchange: string[]; // ISA elements, verbatim
  group: string[]; // GS elements, verbatim
  st: string[]; // ST elements, verbatim
  body: EdiSegment[]; // business segments strictly between ST and SE
}

// ----- pure path helpers (no `any` at the boundary) -----------------------------
// `getPath`/`setPath` live in @latch/shared (prototype-pollution-guarded, single source).

// ----- derived builtins (pure, total) -------------------------------------------

/** YYYYMMDD + HHMM(SS) → advisory ISO-8601 local string (no zone — G2: advisory only). */
function dateTimeToIso(date: string | undefined, time: string | undefined): string | undefined {
  if (!date || date.length !== 8 || !/^\d{8}$/.test(date)) return undefined;
  const ymd = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
  if (!time || time.length < 4 || !/^\d{4,6}$/.test(time)) return ymd;
  const hms =
    time.length >= 6
      ? `${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}`
      : `${time.slice(0, 2)}:${time.slice(2, 4)}:00`;
  return `${ymd}T${hms}`;
}

// ----- transaction-set splitting -------------------------------------------------

interface RawSet {
  delimiters: EdiInterchange['delimiters'];
  interchange: string[];
  group: string[];
  st: string[];
  body: EdiSegment[];
}

function splitTransactionSets(doc: EdiInterchange): Result<RawSet[]> {
  const isa = doc.segments.find((s) => s.tag === 'ISA');
  const gs = doc.segments.find((s) => s.tag === 'GS');
  if (!isa || !gs) {
    return err({ code: 'PARSE', message: 'Interchange is missing its ISA/GS envelope' });
  }
  const sets: RawSet[] = [];
  let i = 0;
  while (i < doc.segments.length) {
    if (doc.segments[i]!.tag !== 'ST') {
      i += 1;
      continue;
    }
    const st = doc.segments[i]!;
    const body: EdiSegment[] = [];
    let j = i + 1;
    while (j < doc.segments.length && doc.segments[j]!.tag !== 'SE') {
      body.push(doc.segments[j]!);
      j += 1;
    }
    if (j >= doc.segments.length) {
      return err({ code: 'PARSE', message: `ST ${st.elements[1] ?? ''} has no closing SE segment` });
    }
    sets.push({
      delimiters: doc.delimiters,
      interchange: isa.elements,
      group: gs.elements,
      st: st.elements,
      body,
    });
    i = j + 1; // skip the SE
  }
  if (sets.length === 0) {
    return err({ code: 'PARSE', message: 'No ST/SE transaction set found in interchange' });
  }
  return ok(sets);
}

// ----- toCanonical ---------------------------------------------------------------

function applyRules(map: MapArtifact, set: RawSet): Result<CanonicalRecord> {
  const bodyDoc: EdiInterchange = {
    segments: set.body,
    delimiters: set.delimiters,
  };
  const record: Record<string, unknown> = {};
  const warnings: Issue[] = [];

  for (const rule of map.rules) {
    applyRule(rule, bodyDoc, record, warnings);
  }

  const snapshot: EdiSnapshot = {
    delimiters: bodyDoc.delimiters,
    interchange: set.interchange,
    group: set.group,
    st: set.st,
    body: set.body,
  };
  const raw = (record['raw'] as Record<string, unknown> | undefined) ?? {};
  raw[RAW_EDI_KEY] = snapshot;
  record['raw'] = raw;

  const parsed = canonicalRecordSchema.safeParse(record);
  if (!parsed.success) {
    return err(
      parsed.error.issues.map((iss) => ({
        code: 'TRANSFORM',
        message: iss.message,
        path: iss.path.join('.'),
      })),
    );
  }
  return ok(parsed.data, warnings);
}

function applyRule(
  rule: FieldRule,
  bodyDoc: EdiInterchange,
  record: Record<string, unknown>,
  warnings: Issue[],
): void {
  switch (rule.kind) {
    case 'const':
      setPath(record, rule.path, rule.value);
      return;
    case 'element': {
      const value = readElement(bodyDoc, rule.source);
      if (value !== undefined && value !== '') setPath(record, rule.path, value);
      return;
    }
    case 'derived': {
      const values = rule.inputs.map((a) => readElement(bodyDoc, a));
      if (rule.transform === 'dateTimeToIso') {
        const iso = dateTimeToIso(values[0], values[1]);
        if (iso !== undefined) setPath(record, rule.path, iso);
        else warnings.push({ code: 'TRANSFORM', message: `Could not derive ${rule.path} from source date/time`, path: rule.path });
      }
      return;
    }
    case 'codemap': {
      const code = readElement(bodyDoc, rule.source);
      if (code === undefined || code === '') return;
      // `code` is EDI-controlled: own-property guard so 'toString'/'constructor' can't
      // resolve to an Object.prototype member instead of a real table entry.
      const mapped = Object.prototype.hasOwnProperty.call(rule.table, code) ? rule.table[code] : undefined;
      if (mapped !== undefined) setPath(record, rule.path, mapped);
      else if (rule.onMiss === 'passthrough') setPath(record, rule.path, code);
      else warnings.push({ code: 'TRANSFORM', message: `No canonical mapping for code "${code}" at ${rule.path}`, path: rule.path });
      return;
    }
  }
}

/** EDI interchange → canonical records (one per transaction set). Never throws. */
export function toCanonical(map: MapArtifact, doc: EdiInterchange): TransformResult<CanonicalRecord[]> {
  const split = splitTransactionSets(doc);
  if (!split.ok) return split;

  const records: CanonicalRecord[] = [];
  const warnings: Issue[] = [];
  for (const set of split.value) {
    const r = applyRules(map, set);
    if (!r.ok) return r;
    records.push(r.value);
    warnings.push(...r.warnings);
  }
  return ok(records, warnings);
}

// ----- fromCanonical -------------------------------------------------------------

function writeElement(segments: EdiSegment[], addr: ElementAddress, value: string): boolean {
  let seen = -1;
  for (const seg of segments) {
    if (seg.tag !== addr.tag) continue;
    seen += 1;
    if (seen !== addr.occurrence) continue;
    while (seg.elements.length < addr.element) seg.elements.push('');
    seg.elements[addr.element - 1] = value;
    return true;
  }
  return false;
}

function readSnapshot(record: CanonicalRecord): EdiSnapshot | undefined {
  const raw = (record as { raw?: Record<string, unknown> }).raw;
  const snap = raw?.[RAW_EDI_KEY];
  if (!snap || typeof snap !== 'object') return undefined;
  return snap as EdiSnapshot;
}

/**
 * Canonical records → EDI interchange, byte-faithful via each record's `raw.__edi`
 * snapshot with `element`-rule values written back. v1 reconstructs a single
 * interchange/group containing all provided records (documented; multi-interchange is
 * a future extension). Never throws.
 */
export function fromCanonical(
  map: MapArtifact,
  records: CanonicalRecord[],
): TransformResult<EdiInterchange> {
  if (records.length === 0) {
    return err({ code: 'TRANSFORM', message: 'No canonical records to serialize' });
  }
  const first = readSnapshot(records[0]!);
  if (!first) {
    return err({
      code: 'TRANSFORM',
      message: 'Record is missing its raw EDI snapshot; cannot reconstruct losslessly',
    });
  }

  const out: EdiSegment[] = [];
  out.push({ tag: 'ISA', elements: [...first.interchange] });
  out.push({ tag: 'GS', elements: [...first.group] });

  const elementRules = map.rules.filter((r): r is Extract<FieldRule, { kind: 'element' }> => r.kind === 'element');

  for (const record of records) {
    const snap = readSnapshot(record);
    if (!snap) {
      return err({ code: 'TRANSFORM', message: 'A record is missing its raw EDI snapshot' });
    }
    // Deep-clone the body so write-backs never mutate the caller's record.
    const body: EdiSegment[] = snap.body.map((s) => ({ tag: s.tag, elements: [...s.elements] }));
    const recordObj = record as unknown as Record<string, unknown>;
    for (const rule of elementRules) {
      const value = getPath(recordObj, rule.path);
      if (value === undefined || value === null) continue;
      writeElement(body, rule.source, String(value));
    }
    out.push({ tag: 'ST', elements: [...snap.st] });
    out.push(...body);
    out.push({ tag: 'SE', elements: [String(body.length + 2), snap.st[1] ?? ''] });
  }

  out.push({ tag: 'GE', elements: [String(records.length), first.group[5] ?? ''] });
  out.push({ tag: 'IEA', elements: ['1', first.interchange[12] ?? ''] });

  return ok({ segments: out, delimiters: first.delimiters });
}
