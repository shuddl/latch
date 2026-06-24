// Deterministic inbound processing (docs/04 runtime pipeline). Pure: (raw EDI, pinned
// map) → canonical + a 997 ack + an outcome. No IO, no LLM. The caller owns dedup and
// persistence; this is the part that must be provably correct.

import { createEdiCore, type EdiInterchange } from '@latch/edi-core';
import { toCanonical, type MapArtifact } from '@latch/transform';
import type { CanonicalRecord } from '@latch/canonical';
import { build997 } from './ack';

export interface ControlNumbers {
  isa?: string;
  gs?: string;
  st?: string;
}

export interface ProcessOutcome {
  status: 'transformed' | 'error';
  controls: ControlNumbers;
  transactionSet: string;
  canonical?: CanonicalRecord[];
  /** Serialized 997. Empty only when the input could not be parsed at all. */
  ack: string;
  ackStatus: 'accepted' | 'rejected';
  error?: string;
}

const edi = createEdiCore();

function controlsOf(doc: EdiInterchange): ControlNumbers {
  const el = (tag: string, idx: number) => doc.segments.find((s) => s.tag === tag)?.elements[idx];
  const out: ControlNumbers = {};
  const isa = el('ISA', 12);
  const gs = el('GS', 5);
  const st = el('ST', 1);
  if (isa) out.isa = isa;
  if (gs) out.gs = gs;
  if (st) out.st = st;
  return out;
}

export function processInbound(raw: string, map: MapArtifact): ProcessOutcome {
  const parsed = edi.parse(raw);
  if (!parsed.ok) {
    // Can't acknowledge an interchange we couldn't parse — surface a structured error.
    return {
      status: 'error',
      controls: {},
      transactionSet: map.transactionSet,
      ack: '',
      ackStatus: 'rejected',
      error: parsed.errors.map((e) => e.message).join('; '),
    };
  }

  const controls = controlsOf(parsed.value);
  const setType = parsed.value.segments.find((s) => s.tag === 'ST')?.elements[0] ?? map.transactionSet;

  const canon = toCanonical(map, parsed.value);
  if (!canon.ok) {
    return {
      status: 'error',
      controls,
      transactionSet: setType,
      ack: edi.serialize(build997(parsed.value, false)),
      ackStatus: 'rejected',
      error: canon.errors.map((e) => e.message).join('; '),
    };
  }

  return {
    status: 'transformed',
    controls,
    transactionSet: setType,
    canonical: canon.value,
    ack: edi.serialize(build997(parsed.value, true)),
    ackStatus: 'accepted',
  };
}
