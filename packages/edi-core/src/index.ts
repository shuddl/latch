// packages/edi-core — X12 parse/serialize behind a thin, swappable interface (docs/08).
//
// LATCH-ASSUMPTION (M0.7 spike): rather than block M0 on a dependency install, this
// ships a minimal, correct, delimiter-driven X12 reader/writer that round-trips
// populated elements byte-faithfully — enough for DoD-0. The interface is the
// contract; before M1's loop-aware spec/mapgen work we evaluate and wrap a vetted
// lib (node-x12 / x12-parser / Stedi tooling) behind this same `EdiCore`, swapping
// the impl without touching callers. Loop-awareness is intentionally deferred to
// that swap (tracked: REVIEW.md / TASKS open-Q #1).
//
// `parse` returns a Result and NEVER throws — malformed input is a structured error,
// which is what lets `verify` claim 100%-graceful adversarial handling (docs/07) and
// keeps the pipeline hot path throw-free (CLAUDE.md §2; packages/shared result.ts).

import { ok, err, type Result } from '@latch/shared';

export interface EdiDelimiters {
  element: string;
  segment: string;
  subElement: string;
}

export interface EdiSegment {
  tag: string;
  elements: string[]; // does not include the tag
}

export interface EdiInterchange {
  segments: EdiSegment[];
  delimiters: EdiDelimiters;
}

export interface EnvelopeIssue {
  code: string;
  message: string;
  segment?: string;
}

export interface EdiCore {
  parse(raw: string): Result<EdiInterchange>;
  serialize(doc: EdiInterchange): string;
  validateEnvelope(doc: EdiInterchange): EnvelopeIssue[];
}

const ISA_LEN = 106; // X12 ISA is a fixed-length 106-char record

/** Detect delimiters from the leading ISA segment (positions are fixed by the standard). */
export function detectDelimiters(raw: string): Result<EdiDelimiters> {
  if (raw.length < ISA_LEN || raw.slice(0, 3) !== 'ISA') {
    return err({
      code: 'PARSE',
      message: 'Not an X12 interchange: input does not begin with a 106-character ISA segment',
    });
  }
  return ok({
    element: raw[3]!,
    subElement: raw[ISA_LEN - 2]!, // index 104
    segment: raw[ISA_LEN - 1]!, // index 105
  });
}

export function createEdiCore(): EdiCore {
  return {
    parse(raw: string): Result<EdiInterchange> {
      const delim = detectDelimiters(raw);
      if (!delim.ok) return delim;
      const delimiters = delim.value;

      const segments: EdiSegment[] = [];
      for (const chunk of raw.split(delimiters.segment)) {
        const seg = chunk.trim(); // tolerate inter-segment whitespace/newlines
        if (seg.length === 0) continue;
        const parts = seg.split(delimiters.element);
        segments.push({ tag: parts[0]!, elements: parts.slice(1) });
      }
      return ok({ segments, delimiters });
    },

    serialize(doc: EdiInterchange): string {
      const { element, segment } = doc.delimiters;
      return (
        doc.segments.map((s) => [s.tag, ...s.elements].join(element)).join(segment) + segment
      );
    },

    validateEnvelope(doc: EdiInterchange): EnvelopeIssue[] {
      const issues: EnvelopeIssue[] = [];
      const tags = doc.segments.map((s) => s.tag);
      const need = (tag: string) => {
        if (!tags.includes(tag)) {
          issues.push({ code: 'MISSING_SEGMENT', message: `Missing required ${tag} segment`, segment: tag });
        }
      };
      need('ISA');
      need('GS');
      need('ST');
      need('SE');
      need('GE');
      need('IEA');

      // SE01 must equal the number of segments from ST..SE inclusive.
      const st = doc.segments.findIndex((s) => s.tag === 'ST');
      const se = doc.segments.findIndex((s) => s.tag === 'SE');
      if (st >= 0 && se > st) {
        const declared = Number(doc.segments[se]!.elements[0]);
        const actual = se - st + 1;
        if (!Number.isNaN(declared) && declared !== actual) {
          issues.push({
            code: 'SE_COUNT_MISMATCH',
            message: `SE segment count ${declared} does not match actual ${actual}`,
            segment: 'SE',
          });
        }
      }
      return issues;
    },
  };
}
