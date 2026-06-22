// Deterministic envelope builder (G3). `serialize` joins segments but does not
// recompute control structures; outbound generation (M1 round-trip, M3.3) needs an
// enveloper that regenerates SE01/GE01/IEA01 counts and lays down a spec-correct
// fixed-width ISA. Pure and deterministic: same input → same bytes.

import type { EdiInterchange, EdiSegment, EdiDelimiters } from './index';

/** Fixed ISA field widths (X12 004010), in element order ISA01..ISA16. */
const ISA_WIDTHS = [2, 10, 2, 10, 2, 15, 2, 15, 6, 4, 1, 5, 9, 1, 1, 1] as const;

export interface InterchangeHeader {
  authQualifier?: string; // ISA01 (default '00')
  authInformation?: string; // ISA02
  securityQualifier?: string; // ISA03 (default '00')
  securityInformation?: string; // ISA04
  senderQualifier: string; // ISA05
  senderId: string; // ISA06
  receiverQualifier: string; // ISA07
  receiverId: string; // ISA08
  date: string; // ISA09 YYMMDD
  time: string; // ISA10 HHMM
  repetitionSeparator?: string; // ISA11 ('U' in 004010)
  versionNumber?: string; // ISA12 (default '00401')
  controlNumber: string; // ISA13
  ackRequested?: string; // ISA14 (default '0')
  usageIndicator?: string; // ISA15 ('P'|'T', default 'P')
}

export interface FunctionalGroupHeader {
  functionalIdCode: string; // GS01 (e.g. 'QM' for 214)
  senderCode: string; // GS02
  receiverCode: string; // GS03
  date: string; // GS04 CCYYMMDD
  time: string; // GS05 HHMM
  controlNumber: string; // GS06
  responsibleAgency?: string; // GS07 (default 'X')
  version: string; // GS08 (e.g. '004010')
}

export interface TransactionSet {
  code: string; // ST01 (e.g. '214')
  controlNumber: string; // ST02
  /** Business segments between ST and SE (exclusive). */
  segments: EdiSegment[];
}

export interface EnvelopeOptions {
  delimiters: EdiDelimiters;
  interchange: InterchangeHeader;
  group: FunctionalGroupHeader;
  transactions: TransactionSet[];
}

/** Right-pad (and hard-truncate) a value to a fixed width — ISA is fixed-length. */
function fixed(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : value + ' '.repeat(width - value.length);
}

function isaElements(h: InterchangeHeader, componentSeparator: string): string[] {
  const raw = [
    h.authQualifier ?? '00',
    h.authInformation ?? '',
    h.securityQualifier ?? '00',
    h.securityInformation ?? '',
    h.senderQualifier,
    h.senderId,
    h.receiverQualifier,
    h.receiverId,
    h.date,
    h.time,
    h.repetitionSeparator ?? 'U',
    h.versionNumber ?? '00401',
    h.controlNumber,
    h.ackRequested ?? '0',
    h.usageIndicator ?? 'P',
    componentSeparator, // ISA16 carries the component separator itself
  ];
  return raw.map((v, idx) => fixed(v, ISA_WIDTHS[idx]!));
}

/**
 * Build a complete interchange (ISA…IEA) with correct control counts, ready for
 * `serialize`. SE01 = segments from ST..SE inclusive; GE01 = #transaction sets;
 * IEA01 = #functional groups (always 1 here, matching one GS/GE pair).
 */
export function buildInterchange(opts: EnvelopeOptions): EdiInterchange {
  const { delimiters, interchange, group, transactions } = opts;
  const segs: EdiSegment[] = [];

  segs.push({ tag: 'ISA', elements: isaElements(interchange, delimiters.subElement) });
  segs.push({
    tag: 'GS',
    elements: [
      group.functionalIdCode,
      group.senderCode,
      group.receiverCode,
      group.date,
      group.time,
      group.controlNumber,
      group.responsibleAgency ?? 'X',
      group.version,
    ],
  });

  for (const tx of transactions) {
    segs.push({ tag: 'ST', elements: [tx.code, tx.controlNumber] });
    for (const s of tx.segments) segs.push(s);
    // SE count includes ST and SE themselves.
    const stToSe = tx.segments.length + 2;
    segs.push({ tag: 'SE', elements: [String(stToSe), tx.controlNumber] });
  }

  segs.push({ tag: 'GE', elements: [String(transactions.length), group.controlNumber] });
  segs.push({ tag: 'IEA', elements: ['1', interchange.controlNumber] });

  return { segments: segs, delimiters };
}
