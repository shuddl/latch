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
  TenderResponse:
    'TenderResponse { shipmentId, decision ("accept"|"decline" — use a codemap from the B1 ' +
    'reservation action code, e.g. {"A":"accept","D":"decline"}), reason? }',
  Tender:
    'Tender { shipmentId, scac?, purpose ("original"|"cancel"|"replace" via codemap from B2A), ' +
    'stops[] (loop on S5: {sequence(cast number), type("pickup"|"delivery" via codemap on S5 reason), ' +
    'party{role(codemap on N1 entity code),name,idQualifier,id,address{line1,city,state,postalCode,country}}}), ' +
    'freight[] (loop on AT8: {weight(cast number),weightUom,pieces(cast number)}), ' +
    'references[] (loop on L11: {qualifier,value}) }',
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
    '- {"kind":"codemap","path":"<canonical enum path>","source":{tag,occurrence,element},"table":{"<code>":"<canonical>"},"onMiss":"unset"}',
    '- {"kind":"loop","path":"<canonical array path>","anchor":"<segment tag>","fields":[<element/const/derived/codemap rules>]}',
    'Use codemap for any element whose canonical target is a fixed enum (e.g. accept/decline).',
    'Use loop for any repeating segment that maps to a canonical array (stops, freight, charges, references);',
    'inside a loop, element addresses are RELATIVE to the loop window (occurrence restarts at 0 per window),',
    'and add "cast":"number" to element rules whose canonical target is numeric (weights, counts, amounts).',
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

  const artifact = mapArtifactSchema.safeParse({
    mapVersion: opts.mapVersion ?? '1',
    direction: opts.direction,
    transactionSet: spec.transactionSet,
    x12Version: spec.x12Version,
    canonicalVersion: opts.canonicalVersion,
    recordKind: opts.recordKind,
    rules: rules.data,
  });
  if (!artifact.success) {
    throw new LatchError('VALIDATION', 'Map generator produced an invalid map artifact', {
      detail: artifact.error.flatten(),
    });
  }
  return withCompiledHash(artifact.data);
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
  const patched = mapArtifactSchema.safeParse({ ...map, compiledHash: undefined, rules: rules.data });
  if (!patched.success) {
    throw new LatchError('VALIDATION', 'Heal patch produced an invalid map artifact', {
      detail: patched.error.flatten(),
    });
  }
  return withCompiledHash(patched.data);
}
