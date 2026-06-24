// @latch/handshake — the Latch Handshake Protocol (HSP) data model (docs/05). The novel,
// defensible core: a bilateral, automated negotiate-and-co-certify between two trading
// partners that replaces the human cert round-trip with a signed certification manifest.
//
// This module is the protocol's TYPES + state vocabulary. The reducer (party.ts) and the
// Ed25519 signing (sign.ts) build on it. Everything here is transport-agnostic and pure.

export const HSP_VERSION = '1.0' as const;

/** Message kinds across the 6 phases (docs/05). */
export type HspType =
  | 'HELLO'
  | 'HELLO_ACK'
  | 'SPEC_OFFER'
  | 'MAP_PROPOSAL'
  | 'GOLDEN_SET'
  | 'GOLDEN_RESULT'
  | 'ATTEST'
  | 'ACTIVATE'
  | 'ACTIVATE_ACK'
  | 'ERROR';

export interface HspParty {
  latchOrg: string;
  /** Identifier of the Ed25519 key pinned for this session. */
  keyId: string;
}

/** The shared envelope. `sig` covers the canonicalized envelope with `sig` removed. */
export interface HspEnvelope<P = unknown> {
  hspVersion: string;
  sessionId: string;
  type: HspType;
  seq: number;
  sender: HspParty;
  payload: P;
  sig?: string;
}

// ── Per-type payloads ────────────────────────────────────────────────────────
export interface HelloPayload {
  latchVersion: string;
  canonicalVersions: string[];
  capabilities: { sets: string[]; connectivity: string[] };
  /** Directional flows the initiator wants to establish. */
  relationshipIntent: { send: string[]; receive: string[] };
  /** Base64 SPKI of this party's Ed25519 public key (pinned for the session). */
  publicKey: string;
}
export interface HelloAckPayload {
  canonicalVersion: string;
  supportedSets: string[];
  connectivity: string[];
  publicKey: string;
}
export interface SpecOfferPayload {
  /** transactionSet → spec digest (segments/elements/qualifiers/loops populated). */
  specDigests: Record<string, string>;
}
export interface MapProposalPayload {
  mapDigest: string;
  /** canonical path → source commitment, e.g. "consignee.name" → "N1*CN/N2". */
  commitments: Record<string, string>;
}
export interface GoldenCase {
  name: string;
  input: string;
}
export interface GoldenSetPayload {
  set: string;
  cases: GoldenCase[];
}
export interface GoldenResultPayload {
  set: string;
  /** The receiver's canonical output per case (signed via the envelope). */
  results: { name: string; canonical: unknown }[];
  /** Hash of `results` for inclusion in the manifest. */
  resultHash: string;
}
export interface AttestPayload {
  manifest: CertManifest;
}
export interface ActivatePayload {
  connectivity: string;
  goLiveWindow: string;
}
export interface ErrorPayload {
  code: string;
  phase: string;
  detail: string;
  recoverable: boolean;
}

/** The cryptographic proof both sides agree (docs/05 Phase 5). */
export interface CertManifest {
  hspVersion: string;
  sessionId: string;
  canonicalVersion: string;
  parties: { initiator: HspParty; responder: HspParty };
  mapDigests: { initiator: string; responder: string };
  /** Hash over both sides' co-certification golden results. */
  coCertResultHash: string;
  flows: { initiatorSends: string[]; responderSends: string[] };
  createdAt: number;
}

/** A manifest with both signatures — the artifact that replaces human cert sign-off. */
export interface SignedManifest {
  manifest: CertManifest;
  initiatorSig?: string;
  responderSig?: string;
}

/** HandshakeDO state machine (docs/05). */
export type HandshakeStatus =
  | 'INIT'
  | 'HELLO_SENT'
  | 'HELLO_OK'
  | 'SPECS_EXCHANGED'
  | 'MAPS_PROPOSED'
  | 'COCERT_RUNNING'
  | 'COCERT_PASSED'
  | 'COCERT_FAILED'
  | 'ATTESTED'
  | 'ACTIVE'
  | 'FAILED';
