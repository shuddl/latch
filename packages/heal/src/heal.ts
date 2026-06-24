// Self-heal decisioning (docs/07). The Verification Engine is reused as the gate: a
// candidate map (or the current one) is re-certified IN SHADOW against the full
// benchmark bar PLUS the drift case. Policy then decides auto-apply vs approval.
//
// No patch is invented here for the additive case: a partner adding a new qualifier
// value to a generically-mapped segment is already handled losslessly, so shadow
// re-cert of the CURRENT map passes and we resolve calmly. Breaking drift (a new
// segment / structural change) that needs a real rule patch is escalated for
// approval; the patch *proposal* is the one LLM-assisted step (deferred — needs key).

import { certify, type CertificationResult, type GoldenCorpus, type GoldenRecord } from '@latch/verify';
import type { MapArtifact } from '@latch/transform';
import type { DriftFinding } from './drift';

export interface HealPolicy {
  /** Auto-apply only additive drift (new optional data) that passes 100%; otherwise approve. */
  autoApplyAdditiveOnly: boolean;
}

export const DEFAULT_HEAL_POLICY: HealPolicy = { autoApplyAdditiveOnly: true };

export type HealDecision = 'auto_applied' | 'awaiting_approval' | 'hold';

/** Build a deviation golden case from a drifted live transaction. */
export function driftCase(name: string, raw: string): GoldenRecord {
  return { name, category: 'deviation', input: raw };
}

/** Re-certify a map against the existing corpus plus the drift case, in shadow. */
export function shadowReCertify(
  map: MapArtifact,
  corpus: GoldenCorpus,
  drift: GoldenRecord,
): CertificationResult {
  const augmented: GoldenCorpus = {
    ...corpus,
    records: [...corpus.records, drift],
  };
  delete (augmented as { corpusHash?: string }).corpusHash; // force a fresh hash
  return certify(map, augmented);
}

// Only purely additive drift (a new qualifier value on an already-handled segment) is
// safe to auto-apply. New segments / structural / loop changes touch shape → approval.
const ADDITIVE: ReadonlySet<DriftFinding['kind']> = new Set(['changed_qualifier']);

export function decideHeal(
  findings: DriftFinding[],
  shadow: CertificationResult,
  policy: HealPolicy = DEFAULT_HEAL_POLICY,
): HealDecision {
  // A patch that doesn't pass the bar never goes live; the last-good map keeps running.
  if (!shadow.passed) return 'hold';
  const allAdditive = findings.length > 0 && findings.every((f) => ADDITIVE.has(f.kind));
  if (allAdditive && policy.autoApplyAdditiveOnly) return 'auto_applied';
  return 'awaiting_approval';
}
