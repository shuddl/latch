// Self-identity & outbound envelope model (M3.3). Authoring an outbound interchange needs OUR
// own ISA/GS identity — something inbound parsing never had to model. Two ways to obtain it,
// neither requiring a settings screen (CLAUDE.md §1):
//   - deriveResponseEnvelope: for a REPLY to a received document (e.g. a 990 answering a 204),
//     WE are the inbound's receiver and the partner is its sender — so swap the roles straight
//     off the source record's raw snapshot. Zero configuration: both identities were already
//     learned from the inbound interchange.
//   - buildOutboundEnvelope: for an UNSOLICITED document, supply our identity + the partner's
//     explicitly (sensible 'ZZ'/004010 defaults).

import type { CanonicalRecord } from '@latch/canonical';
import type { EdiDelimiters } from '@latch/edi-core';
import { RAW_EDI_KEY } from './engine';
import { DEFAULT_DELIMITERS, type OutboundEnvelope } from './outbound';

/** Control numbers + timestamps the caller stamps for the outbound interchange/group/set. */
export interface ResponseControls {
  interchangeControlNumber: string; // ISA13
  groupControlNumber: string; // GS06
  stControlNumber: string; // ST02
  isaDate: string; // ISA09 YYMMDD
  isaTime: string; // ISA10 HHMM
  gsDate: string; // GS04 CCYYMMDD
  gsTime: string; // GS05 HHMM
  /** GS01 functional id code for the RESPONSE set (e.g. 'GF' for a 990). */
  functionalIdCode: string;
}

interface Snap {
  delimiters?: EdiDelimiters;
  interchange: string[]; // ISA elements (after the tag), verbatim
  group: string[]; // GS elements, verbatim
}

function readSnap(rec: CanonicalRecord): Snap | undefined {
  const raw = (rec as { raw?: Record<string, unknown> }).raw;
  const snap = raw?.[RAW_EDI_KEY];
  if (!snap || typeof snap !== 'object') return undefined;
  const s = snap as Snap;
  return Array.isArray(s.interchange) && Array.isArray(s.group) ? s : undefined;
}

/** Trimmed element read (ISA ids are space-padded in the snapshot; `buildInterchange` re-pads). */
const el = (arr: string[], i: number, fallback = ''): string => (arr[i] ?? fallback).trim();

/**
 * Build the envelope for a REPLY to `source`: we send as its receiver, addressed back to its
 * sender. Returns undefined if `source` carries no raw snapshot (can't learn the identities).
 */
export function deriveResponseEnvelope(source: CanonicalRecord, controls: ResponseControls): OutboundEnvelope | undefined {
  const snap = readSnap(source);
  if (!snap) return undefined;
  const isa = snap.interchange;
  const gs = snap.group;
  return {
    interchange: {
      senderQualifier: el(isa, 6, 'ZZ'), // inbound receiver qualifier (ISA07) → our sender qual
      senderId: el(isa, 7), // inbound receiver id (ISA08) → our sender id
      receiverQualifier: el(isa, 4, 'ZZ'), // inbound sender qualifier (ISA05) → partner
      receiverId: el(isa, 5), // inbound sender id (ISA06) → partner
      date: controls.isaDate,
      time: controls.isaTime,
      controlNumber: controls.interchangeControlNumber,
    },
    group: {
      functionalIdCode: controls.functionalIdCode,
      senderCode: el(gs, 2), // inbound GS receiver (GS03) → our sender
      receiverCode: el(gs, 1), // inbound GS sender (GS02) → partner
      date: controls.gsDate,
      time: controls.gsTime,
      controlNumber: controls.groupControlNumber,
      version: el(gs, 7, '004010'),
    },
    stControlNumber: controls.stControlNumber,
    delimiters: snap.delimiters ?? DEFAULT_DELIMITERS,
  };
}

/** One party's interchange/group identity. */
export interface PartyIdentity {
  /** ISA05/ISA07 qualifier (default 'ZZ'). */
  qualifier?: string;
  /** ISA06/ISA08 id. */
  isaId: string;
  /** GS02/GS03 code. */
  gsCode: string;
}

export interface OutboundEnvelopeSpec {
  self: PartyIdentity;
  partner: PartyIdentity;
  controls: ResponseControls;
  /** GS08 version (default '004010'). */
  version?: string;
}

/** Build an envelope from scratch (unsolicited outbound) from explicit identities. */
export function buildOutboundEnvelope(spec: OutboundEnvelopeSpec): OutboundEnvelope {
  const { self, partner, controls } = spec;
  return {
    interchange: {
      senderQualifier: self.qualifier ?? 'ZZ',
      senderId: self.isaId,
      receiverQualifier: partner.qualifier ?? 'ZZ',
      receiverId: partner.isaId,
      date: controls.isaDate,
      time: controls.isaTime,
      controlNumber: controls.interchangeControlNumber,
    },
    group: {
      functionalIdCode: controls.functionalIdCode,
      senderCode: self.gsCode,
      receiverCode: partner.gsCode,
      date: controls.gsDate,
      time: controls.gsTime,
      controlNumber: controls.groupControlNumber,
      version: spec.version ?? '004010',
    },
    stControlNumber: controls.stControlNumber,
    delimiters: DEFAULT_DELIMITERS,
  };
}
