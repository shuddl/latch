// 997 Functional Acknowledgment generation (docs/03). Deterministic X12 build:
// echoes the inbound functional group, swaps sender/receiver so the ack routes back,
// and reports group-level acceptance (AK1 + AK9). Minimal but valid; per-set AK2/AK5
// detail can be added when a partner requires it.

import type { EdiInterchange, EdiSegment } from '@latch/edi-core';

function swap<T>(arr: T[], i: number, j: number): void {
  const t = arr[i] as T;
  arr[i] = arr[j] as T;
  arr[j] = t;
}

/** Build a 997 acknowledging the inbound interchange's first functional group. */
export function build997(inbound: EdiInterchange, accepted: boolean): EdiInterchange {
  const find = (tag: string): EdiSegment | undefined => inbound.segments.find((s) => s.tag === tag);
  const isa = find('ISA');
  const gs = find('GS');

  // ISA: clone + swap qualifier/id pairs (idx 4↔6, 5↔7), set a control number (idx 12).
  const isaEls = isa ? [...isa.elements] : [];
  if (isaEls.length >= 16) {
    swap(isaEls, 4, 6);
    swap(isaEls, 5, 7);
    isaEls[12] = '000000001';
  }

  // GS: GS01 is the functional ID code, GS06 the group control number.
  const gsEls = gs ? [...gs.elements] : [];
  const funcId = gsEls[0] ?? 'XX';
  const groupControl = gsEls[5] ?? '1';
  const ackGsEls = [...gsEls];
  if (ackGsEls.length >= 6) {
    ackGsEls[0] = 'FA'; // functional acknowledgment group
    swap(ackGsEls, 1, 2); // sender ↔ receiver
    ackGsEls[5] = '1';
  }

  const setCount = inbound.segments.filter((s) => s.tag === 'ST').length || 1;
  const status = accepted ? 'A' : 'R';
  const acceptedCount = accepted ? setCount : 0;

  const segments: EdiSegment[] = [
    { tag: 'ISA', elements: isaEls },
    { tag: 'GS', elements: ackGsEls },
    { tag: 'ST', elements: ['997', '0001'] },
    { tag: 'AK1', elements: [funcId, groupControl] },
    { tag: 'AK9', elements: [status, String(setCount), String(setCount), String(acceptedCount)] },
    { tag: 'SE', elements: ['4', '0001'] },
    { tag: 'GE', elements: ['1', '1'] },
    { tag: 'IEA', elements: ['1', '000000001'] },
  ];
  return { segments, delimiters: inbound.delimiters };
}
