// The Spec Ingestor (docs/04 component 1). LLM-assisted at BUILD time: it reads a
// companion guide + sample EDI and emits a Zod-validated Latch Spec, using the samples
// as ground truth and flagging guide-vs-sample deviations. The model proposes; Zod
// validates; low-confidence fields are surfaced for review — never silently accepted.

import { type LlmClient, LatchError } from '@latch/shared';
import { latchSpecSchema, lowConfidenceFields, type LatchSpec } from './latch-spec';

export interface IngestInput {
  transactionSet: string;
  x12Version: string;
  guideText?: string;
  samples: string[];
}

export interface IngestResult {
  spec: LatchSpec;
  lowConfidence: string[];
}

const SYSTEM = [
  'You are an EDI integration analyst. Extract a machine-readable spec of how a trading',
  'partner uses an X12 transaction set, from their companion guide and sample files.',
  'Treat the SAMPLE FILES as ground truth: when the guide and samples disagree, follow the',
  'samples and record the disagreement in "deviations". For each element set a confidence',
  '0..1 reflecting how certain you are. Output JSON matching this shape:',
  '{ transactionSet, x12Version, segments: [{ tag, name?, required, maxUse?, elements:',
  '[{ position, name, usage: "required"|"optional"|"situational", qualifierCodes?: string[],',
  'confidence }] }], deviations: string[], confidence }',
].join(' ');

export async function ingestSpec(client: LlmClient, input: IngestInput): Promise<IngestResult> {
  const user = [
    `Transaction set: ${input.transactionSet}`,
    `X12 version: ${input.x12Version}`,
    input.guideText ? `\nCOMPANION GUIDE:\n${input.guideText}` : '\n(no companion guide provided)',
    `\nSAMPLE FILES (${input.samples.length}):`,
    ...input.samples.map((s, i) => `--- sample ${i + 1} ---\n${s}`),
  ].join('\n');

  const raw = await client.extractJson({ system: SYSTEM, user });
  const parsed = latchSpecSchema.safeParse(raw);
  if (!parsed.success) {
    throw new LatchError('VALIDATION', 'Spec ingestor produced an invalid spec', {
      detail: parsed.error.flatten(),
    });
  }
  // Pin the caller's declared set/version (the model can mislabel).
  const spec: LatchSpec = {
    ...parsed.data,
    transactionSet: input.transactionSet,
    x12Version: input.x12Version,
  };
  return { spec, lowConfidence: lowConfidenceFields(spec) };
}
