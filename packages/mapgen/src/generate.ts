// The Map Generator (docs/04 component 3). LLM-assisted at BUILD time: it proposes
// declarative transform rules from a Latch Spec; the output is Zod-validated and then
// must pass the Verification Engine before it is ever trusted (CLAUDE.md §2: the engine
// is the gate, not the model's confidence). NO LLM at runtime.

import { z } from 'zod';
import { type LlmClient, LatchError } from '@latch/shared';
import { fieldRuleSchema, mapArtifactSchema, withCompiledHash, type MapArtifact } from '@latch/transform';
import type { LatchSpec } from '@latch/spec';

export interface GenerateOptions {
  direction: 'inbound' | 'outbound';
  canonicalVersion: string;
  recordKind: MapArtifact['recordKind'];
  mapVersion?: string;
}

// Canonical targets the generator maps onto, per record kind (the shared semantic hub).
const CANONICAL_FIELDS: Partial<Record<MapArtifact['recordKind'], string>> = {
  StatusEvent:
    'StatusEvent { shipmentId, statusCode, statusDescription?, occurredAt (ISO via derived dateTimeToIso), ' +
    'location.city/state/country?, reasonCode?, references[]: {qualifier,value} }',
};

const rulesSchema = z.array(fieldRuleSchema);

function systemPrompt(opts: GenerateOptions): string {
  return [
    'You generate declarative EDI↔canonical transform rules for the Latch engine.',
    `Direction: ${opts.direction}. Canonical record: ${opts.recordKind}.`,
    `Canonical target shape: ${CANONICAL_FIELDS[opts.recordKind] ?? opts.recordKind}.`,
    'Each rule is one of:',
    '- {"kind":"element","path":"<canonical dot path>","source":{"tag","occurrence":0,"element":<1-based>}}',
    '- {"kind":"const","path":"kind","value":"<RecordKind>"}',
    '- {"kind":"derived","path":"occurredAt","inputs":[{tag,occurrence,element}...],"transform":"dateTimeToIso"}',
    'Map every populated element from the spec to its canonical field. Output a JSON array of rules only.',
  ].join('\n');
}

export async function generateMap(
  client: LlmClient,
  spec: LatchSpec,
  opts: GenerateOptions,
): Promise<MapArtifact> {
  const user = `LATCH SPEC:\n${JSON.stringify(spec, null, 2)}`;
  const raw = await client.extractJson({ system: systemPrompt(opts), user, maxTokens: 4096 });

  const rules = rulesSchema.safeParse(raw);
  if (!rules.success) {
    throw new LatchError('VALIDATION', 'Map generator produced invalid rules', {
      detail: rules.error.flatten(),
    });
  }

  const artifact = mapArtifactSchema.parse({
    mapVersion: opts.mapVersion ?? '1',
    direction: opts.direction,
    transactionSet: spec.transactionSet,
    x12Version: spec.x12Version,
    canonicalVersion: opts.canonicalVersion,
    recordKind: opts.recordKind,
    rules: rules.data,
  });
  return withCompiledHash(artifact);
}

// Self-heal patch proposal (docs/07): given a drift description, propose an UPDATED
// rule set. The result is only adopted after passing shadow re-certification.
export async function patchMap(
  client: LlmClient,
  map: MapArtifact,
  driftDetail: string,
): Promise<MapArtifact> {
  const system = [
    'You patch declarative EDI↔canonical transform rules to handle a newly observed drift.',
    'Return the COMPLETE updated JSON array of rules (same rule shapes as before).',
    'Make the minimal change that handles the drift without altering unrelated mappings.',
  ].join('\n');
  const user = `CURRENT RULES:\n${JSON.stringify(map.rules, null, 2)}\n\nDRIFT:\n${driftDetail}`;
  const raw = await client.extractJson({ system, user, maxTokens: 4096 });

  const rules = rulesSchema.safeParse(raw);
  if (!rules.success) {
    throw new LatchError('VALIDATION', 'Heal patch produced invalid rules', {
      detail: rules.error.flatten(),
    });
  }
  return withCompiledHash(
    mapArtifactSchema.parse({ ...map, compiledHash: undefined, rules: rules.data }),
  );
}
