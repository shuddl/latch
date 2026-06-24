// Control-plane domain model (docs/06, docs/08). Zod is the single source of truth;
// request bodies and stored records are validated at the boundary — no `any` crosses it.

import { z } from 'zod';

// ── Input-size limits (PG-5) ─────────────────────────────────────────────────
// Bound every untrusted free-text/byte input at the boundary so a single request can't
// exhaust Worker memory. Generous for real freight EDI (a 214 is ~1KB; a companion guide
// a few hundred KB), tight enough to reject abuse. Byte-measured (EDI is ASCII, but be safe).
export const LIMITS = {
  maxSampleBytes: 1_000_000, // 1 MB per sample EDI file
  maxSamples: 50, // sample files per upload
  maxGuideBytes: 5_000_000, // 5 MB companion-guide text
  maxIngestBytes: 5_000_000, // 5 MB per inbound interchange
} as const;

const byteLen = (s: string): number => new TextEncoder().encode(s).length;

/** A non-empty EDI/text string bounded to `maxBytes`, with a plain-English overflow message. */
export const boundedText = (maxBytes: number, label: string): z.ZodString | z.ZodEffects<z.ZodString, string, string> =>
  z
    .string()
    .min(1)
    .refine((s) => byteLen(s) <= maxBytes, {
      message: `${label} exceeds the ${Math.round(maxBytes / 1_000_000)}MB limit`,
    });

export const directionSchema = z.enum(['inbound', 'outbound']);
export type Direction = z.infer<typeof directionSchema>;

export const connectionStatusSchema = z.enum([
  'draft',
  'certified',
  'production',
  'paused',
  'retired',
]);
export type ConnectionStatus = z.infer<typeof connectionStatusSchema>;

export const mapStatusSchema = z.enum(['draft', 'certified', 'production', 'retired']);
export type MapStatus = z.infer<typeof mapStatusSchema>;

export const connectivitySchema = z.object({
  type: z.enum(['sftp', 'as2', 'van', 'api']),
  // Reference to a Cloudflare secret holding credentials — never the secret itself.
  secretRef: z.string().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});
export type Connectivity = z.infer<typeof connectivitySchema>;

// ── Records (as stored / returned) ──────────────────────────────────────────

export const partnerSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  name: z.string(),
  scac: z.string().optional(),
  isaQualifier: z.string().optional(),
  isaId: z.string().optional(),
  gsId: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Partner = z.infer<typeof partnerSchema>;

export const connectionSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  partnerId: z.string(),
  direction: directionSchema,
  transactionSet: z.string(),
  x12Version: z.string(),
  connectivity: connectivitySchema,
  status: connectionStatusSchema,
  activeMapId: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Connection = z.infer<typeof connectionSchema>;

export const mapRecordSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  connectionId: z.string(),
  transactionSet: z.string(),
  direction: directionSchema,
  canonicalVersion: z.string(),
  compiledHash: z.string(),
  status: mapStatusSchema,
  latestCertId: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type MapRecord = z.infer<typeof mapRecordSchema>;

export const certificationSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  mapId: z.string(),
  connectionId: z.string(),
  passed: z.boolean(),
  requiredCoverage: z.number(),
  qualifierCoverage: z.number(),
  loopCoverage: z.number(),
  roundtripFidelity: z.number(),
  adversarialOk: z.number(),
  deviationHandling: z.number(),
  shortfalls: z.array(z.string()),
  mapHash: z.string(),
  corpusHash: z.string(),
  createdAt: z.number(),
});
export type Certification = z.infer<typeof certificationSchema>;

// ── Request bodies ───────────────────────────────────────────────────────────

export const createPartnerInput = z.object({
  name: z.string().min(1, 'Partner name is required'),
  scac: z.string().optional(),
  isaQualifier: z.string().optional(),
  isaId: z.string().optional(),
  gsId: z.string().optional(),
});

export const createConnectionInput = z.object({
  partnerId: z.string().min(1),
  direction: directionSchema,
  transactionSet: z.string().min(1),
  x12Version: z.string().default('004010'),
  connectivity: connectivitySchema,
});

export const addSamplesInput = z.object({
  samples: z
    .array(boundedText(LIMITS.maxSampleBytes, 'A sample EDI file'))
    .min(1, 'At least one sample EDI file is required')
    .max(LIMITS.maxSamples, `At most ${LIMITS.maxSamples} sample files per upload`),
});

export const goLiveInput = z
  .object({ mapId: z.string().optional() })
  .optional()
  .default({});

// Store input types are exactly the validated request shapes (optionals include
// `undefined`, matching exactOptionalPropertyTypes).
export type CreatePartnerData = z.infer<typeof createPartnerInput>;
export type CreateConnectionData = z.infer<typeof createConnectionInput>;

// ── Transactions (live traffic) ──────────────────────────────────────────────

export const transactionStatusSchema = z.enum([
  'received',
  'transformed',
  'delivered',
  'ack_sent',
  'error',
]);
export type TransactionStatus = z.infer<typeof transactionStatusSchema>;

// ── Drift events (self-heal) ─────────────────────────────────────────────────

export const driftStatusSchema = z.enum([
  'open',
  'patched_shadow',
  'auto_applied',
  'awaiting_approval',
  'applied',
  'dismissed',
]);
export type DriftStatus = z.infer<typeof driftStatusSchema>;

export const driftEventSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  connectionId: z.string(),
  detectedFromTxn: z.string().optional(),
  kind: z.string(),
  detail: z.string(), // JSON: { findings, decision, shadowPassed }
  status: driftStatusSchema,
  createdAt: z.number(),
  resolvedAt: z.number().optional(),
});
export type DriftEvent = z.infer<typeof driftEventSchema>;

export const transactionSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  connectionId: z.string(),
  mapId: z.string().optional(),
  direction: directionSchema,
  transactionSet: z.string(),
  isaControl: z.string().optional(),
  gsControl: z.string().optional(),
  stControl: z.string().optional(),
  status: transactionStatusSchema,
  errorDetail: z.string().optional(),
  ackStatus: z.string().optional(),
  receivedAt: z.number(),
  processedAt: z.number().optional(),
});
export type Transaction = z.infer<typeof transactionSchema>;
