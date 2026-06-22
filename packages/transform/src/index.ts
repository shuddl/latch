// packages/transform — the deterministic runtime transform engine (docs/08).
// Pure, typed, NO LLM. Returns Result and never throws into the hot path.
//
// Round-trip strategy (docs/06 design rule 1, "round-trip fidelity over prettiness"):
// toCanonical stashes the full source interchange under `raw.__source`; fromCanonical
// rebuilds by writing the canonical values back into a clone of that source via the
// inverse of each rule. This preserves the envelope + unmapped segments losslessly
// while still proving the map both directions — a read/write index mismatch changes
// the output and is caught by round-trip comparison in `verify`.

import type { CanonicalRecord, StatusEvent } from '@latch/canonical';
import { statusEventSchema } from '@latch/canonical';
import type { EdiInterchange, EdiSegment } from '@latch/edi-core';
import { ok, err, type Result, type Issue } from '@latch/shared';
import { type MapArtifact } from './map';

export * from './map';

const SOURCE_KEY = '__source';

function nth(segments: EdiSegment[], tag: string, occurrence: number): EdiSegment | undefined {
  let seen = 0;
  for (const s of segments) {
    if (s.tag === tag && ++seen === occurrence) return s;
  }
  return undefined;
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  let node = target;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i]!;
    if (typeof node[k] !== 'object' || node[k] === null) node[k] = {};
    node = node[k] as Record<string, unknown>;
  }
  node[keys[keys.length - 1]!] = value;
}

function getPath(source: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((node, k) => {
    if (node && typeof node === 'object') return (node as Record<string, unknown>)[k];
    return undefined;
  }, source);
}

// X12 CCYYMMDD + HHMM → 'CCYY-MM-DDTHH:MM:00' (no tz: reversible without assumptions).
function toIso(date8: string | undefined, time4: string | undefined): string | undefined {
  if (!date8 || date8.length !== 8) return undefined;
  const d = `${date8.slice(0, 4)}-${date8.slice(4, 6)}-${date8.slice(6, 8)}`;
  const t =
    time4 && time4.length >= 4 ? `${time4.slice(0, 2)}:${time4.slice(2, 4)}:00` : '00:00:00';
  return `${d}T${t}`;
}

function fromIso(iso: string): { date8: string; time4: string } {
  // 'CCYY-MM-DDTHH:MM:SS' → CCYYMMDD + HHMM
  const [date = '', time = ''] = iso.split('T');
  return {
    date8: date.replace(/-/g, ''),
    time4: time.slice(0, 5).replace(':', ''),
  };
}

export interface TransformEngine {
  toCanonical(map: MapArtifact, doc: EdiInterchange): Result<CanonicalRecord[]>;
  fromCanonical(map: MapArtifact, records: CanonicalRecord[]): Result<EdiInterchange>;
}

export function createTransformEngine(): TransformEngine {
  return {
    toCanonical(map: MapArtifact, doc: EdiInterchange): Result<CanonicalRecord[]> {
      const out: Record<string, unknown> = {
        kind: 'StatusEvent',
        canonicalVersion: map.canonicalVersion,
      };

      for (const rule of map.rules) {
        if (rule.kind === 'scalar') {
          const seg = nth(doc.segments, rule.segment, rule.occurrence);
          const value = seg?.elements[rule.element - 1];
          if (value !== undefined && value !== '') setPath(out, rule.path, value);
        } else if (rule.kind === 'datetime') {
          const seg = nth(doc.segments, rule.segment, rule.occurrence);
          const iso = toIso(
            seg?.elements[rule.dateElement - 1],
            seg?.elements[rule.timeElement - 1],
          );
          if (iso) setPath(out, rule.path, iso);
        } else {
          const refs = doc.segments
            .filter((s) => s.tag === rule.segment)
            .map((s) => ({
              qualifier: s.elements[rule.qualifierElement - 1] ?? '',
              value: s.elements[rule.valueElement - 1] ?? '',
            }))
            .filter((r) => r.value !== '');
          if (refs.length > 0) setPath(out, rule.path, refs);
        }
      }

      // Preserve the full source for lossless round-trip (design rule 1).
      out['raw'] = { [SOURCE_KEY]: doc };

      const parsed = statusEventSchema.safeParse(out);
      if (!parsed.success) {
        return err(
          parsed.error.issues.map<Issue>((i) => ({
            code: 'TRANSFORM',
            message: i.message,
            path: i.path.join('.'),
          })),
        );
      }
      return ok([parsed.data]);
    },

    fromCanonical(map: MapArtifact, records: CanonicalRecord[]): Result<EdiInterchange> {
      const rec = records[0];
      if (!rec || rec.kind !== 'StatusEvent') {
        return err({ code: 'TRANSFORM', message: 'Expected a single StatusEvent record' });
      }
      const source = (rec.raw as Record<string, unknown> | undefined)?.[SOURCE_KEY] as
        | EdiInterchange
        | undefined;
      if (!source) {
        return err({
          code: 'TRANSFORM',
          message: 'Cannot reconstruct EDI: source interchange not preserved on the record',
        });
      }

      // Deep clone so we never mutate the canonical record's preserved source.
      const clone: EdiInterchange = {
        delimiters: { ...source.delimiters },
        segments: source.segments.map((s) => ({ tag: s.tag, elements: [...s.elements] })),
      };

      const ensureLen = (seg: EdiSegment, idx: number) => {
        while (seg.elements.length < idx) seg.elements.push('');
      };

      for (const rule of map.rules) {
        if (rule.kind === 'scalar') {
          const v = getPath(rec, rule.path);
          if (v === undefined) continue;
          const seg = nth(clone.segments, rule.segment, rule.occurrence);
          if (!seg) continue;
          ensureLen(seg, rule.element);
          seg.elements[rule.element - 1] = String(v);
        } else if (rule.kind === 'datetime') {
          const iso = getPath(rec, rule.path);
          if (typeof iso !== 'string') continue;
          const { date8, time4 } = fromIso(iso);
          const seg = nth(clone.segments, rule.segment, rule.occurrence);
          if (!seg) continue;
          ensureLen(seg, Math.max(rule.dateElement, rule.timeElement));
          seg.elements[rule.dateElement - 1] = date8;
          seg.elements[rule.timeElement - 1] = time4;
        } else {
          const refs = (getPath(rec, rule.path) as StatusEvent['references'] | undefined) ?? [];
          const segs = clone.segments.filter((s) => s.tag === rule.segment);
          refs.forEach((r, i) => {
            const seg = segs[i];
            if (!seg) return;
            ensureLen(seg, Math.max(rule.valueElement, rule.qualifierElement));
            seg.elements[rule.valueElement - 1] = r.value;
            seg.elements[rule.qualifierElement - 1] = r.qualifier;
          });
        }
      }

      return ok(clone);
    },
  };
}
