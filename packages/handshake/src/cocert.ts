// Shared co-certification helpers used by BOTH the in-process driver (party.ts) and the
// over-the-wire reactive machine (participant.ts). Keeping these in one place guarantees the
// two paths build byte-identical manifests and compare results identically — so a handshake
// run in tests (in-process) and one run across two HandshakeDOs (over HTTPS) produce the same
// signed proof.

import { stableStringify } from '@latch/shared';
import type { CanonicalResult, CertManifest, HspParty } from './types';

/** Order-insensitive deep equality of canonical results, keyed by case name. */
export function compareResults(expected: CanonicalResult[], got: CanonicalResult[]): boolean {
  if (expected.length !== got.length) return false;
  const byName = new Map(got.map((r) => [r.name, stableStringify(r.canonical)]));
  return expected.every((e) => byName.get(e.name) === stableStringify(e.canonical));
}

/** The manifest both sides must construct identically. `createdAt` is fixed at 0 so the
 *  manifest hashes deterministically; the caller stamps real wall-clock time after signing. */
export function buildManifest(args: {
  sessionId: string;
  canonicalVersion: string;
  initiator: HspParty;
  responder: HspParty;
  initiatorMapDigest: string;
  responderMapDigest: string;
  coCertResultHash: string;
  initiatorSends: string[];
  responderSends: string[];
  hspVersion: string;
}): CertManifest {
  return {
    hspVersion: args.hspVersion,
    sessionId: args.sessionId,
    canonicalVersion: args.canonicalVersion,
    parties: { initiator: args.initiator, responder: args.responder },
    mapDigests: { initiator: args.initiatorMapDigest, responder: args.responderMapDigest },
    coCertResultHash: args.coCertResultHash,
    flows: { initiatorSends: args.initiatorSends, responderSends: args.responderSends },
    createdAt: 0,
  };
}
