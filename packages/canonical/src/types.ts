// packages/canonical/src/types.ts — the canonical model (docs/06 §B).
// Zod schemas are the single source of truth; TS types are inferred from them.
// Design rules (docs/06): round-trip fidelity over prettiness, lean & freight-true,
// versioned, enums with raw passthrough, no partner-specific fields here.

import { z } from 'zod';

export const CANONICAL_VERSION = '1' as const;
export const canonicalVersionSchema = z.literal('1');
export type CanonicalVersion = z.infer<typeof canonicalVersionSchema>;

export const partyRoleSchema = z.enum([
  'shipper',
  'consignee',
  'billTo',
  'carrier',
  'broker',
  'thirdParty',
]);

export const addressSchema = z.object({
  line1: z.string().optional(),
  line2: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  postalCode: z.string().optional(),
  country: z.string().optional(),
});
export type Address = z.infer<typeof addressSchema>;

export const partySchema = z.object({
  role: partyRoleSchema,
  name: z.string(),
  idQualifier: z.string().optional(), // preserve source qualifier for round-trip fidelity
  id: z.string().optional(),
  address: addressSchema.optional(),
  contact: z
    .object({
      name: z.string().optional(),
      phone: z.string().optional(),
      email: z.string().optional(),
    })
    .optional(),
});
export type Party = z.infer<typeof partySchema>;

export const referenceSchema = z.object({
  qualifier: z.string(), // e.g. 'BM' = BOL, 'PO' = purchase order
  value: z.string(),
});
export type Reference = z.infer<typeof referenceSchema>;

export const freightSchema = z.object({
  pieces: z.number().optional(),
  weight: z.number().optional(),
  weightUom: z.enum(['L', 'K']).optional(),
  class: z.string().optional(),
  nmfc: z.string().optional(),
  commodity: z.string().optional(),
  hazmat: z.boolean().optional(),
  volume: z.number().optional(),
  pallets: z.number().optional(),
});
export type Freight = z.infer<typeof freightSchema>;

export const stopSchema = z.object({
  sequence: z.number().int(),
  type: z.enum(['pickup', 'delivery']),
  party: partySchema,
  earliest: z.string().optional(), // ISO 8601
  latest: z.string().optional(),
  references: z.array(referenceSchema).optional(),
});
export type Stop = z.infer<typeof stopSchema>;

// Escape hatch for lossless round-trip of anything not yet modeled.
const rawSchema = z.record(z.string(), z.unknown()).optional();

// 204 — Motor Carrier Load Tender
export const tenderSchema = z.object({
  kind: z.literal('Tender'),
  canonicalVersion: canonicalVersionSchema,
  shipmentId: z.string(),
  scac: z.string().optional(),
  purpose: z.enum(['original', 'cancel', 'replace']),
  stops: z.array(stopSchema),
  freight: z.array(freightSchema),
  references: z.array(referenceSchema),
  raw: rawSchema,
});
export type Tender = z.infer<typeof tenderSchema>;

// 990 — Response to a Load Tender
export const tenderResponseSchema = z.object({
  kind: z.literal('TenderResponse'),
  canonicalVersion: canonicalVersionSchema,
  shipmentId: z.string(),
  decision: z.enum(['accept', 'decline']),
  reason: z.string().optional(),
  raw: rawSchema,
});
export type TenderResponse = z.infer<typeof tenderResponseSchema>;

// 211 — Motor Carrier Bill of Lading
export const bolSchema = z.object({
  kind: z.literal('BOL'),
  canonicalVersion: canonicalVersionSchema,
  bolNumber: z.string(),
  shipper: partySchema,
  consignee: partySchema,
  billTo: partySchema.optional(),
  freight: z.array(freightSchema),
  references: z.array(referenceSchema),
  specialInstructions: z.string().optional(),
  raw: rawSchema,
});
export type BOL = z.infer<typeof bolSchema>;

// 214 — Transportation Carrier Shipment Status
export const statusEventSchema = z.object({
  kind: z.literal('StatusEvent'),
  canonicalVersion: canonicalVersionSchema,
  shipmentId: z.string(),
  statusCode: z.string(), // canonical enum mapping + preserve raw
  statusDescription: z.string().optional(),
  occurredAt: z.string(), // ISO 8601
  location: addressSchema.optional(),
  reasonCode: z.string().optional(),
  // LATCH-ASSUMPTION: docs/06 omits references on StatusEvent, but a real 214 carries
  // qualified reference numbers (BOL/PRO/PO via L11). Modeling them here keeps the
  // transform lossless and makes qualifier-coverage meaningful. Proposed docs/06 refinement.
  references: z.array(referenceSchema).optional(),
  raw: rawSchema,
});
export type StatusEvent = z.infer<typeof statusEventSchema>;

// 210 — Motor Carrier Freight Details & Invoice
export const invoiceSchema = z.object({
  kind: z.literal('Invoice'),
  canonicalVersion: canonicalVersionSchema,
  invoiceNumber: z.string(),
  shipmentId: z.string().optional(),
  billTo: partySchema,
  charges: z.array(
    z.object({
      code: z.string(),
      description: z.string().optional(),
      amount: z.number(),
    }),
  ),
  total: z.number(),
  currency: z.string(),
  weight: freightSchema.optional(),
  raw: rawSchema,
});
export type Invoice = z.infer<typeof invoiceSchema>;

// 997 — Functional Acknowledgment
export const ackSchema = z.object({
  kind: z.literal('Ack'),
  canonicalVersion: canonicalVersionSchema,
  acknowledges: z.object({
    groupControl: z.string(),
    setCount: z.number().int(),
    status: z.enum(['accepted', 'rejected', 'partial']),
  }),
  errors: z
    .array(
      z.object({
        segment: z.string().optional(),
        element: z.string().optional(),
        note: z.string(),
      }),
    )
    .optional(),
  raw: rawSchema,
});
export type Ack = z.infer<typeof ackSchema>;

export const canonicalRecordSchema = z.discriminatedUnion('kind', [
  tenderSchema,
  tenderResponseSchema,
  bolSchema,
  statusEventSchema,
  invoiceSchema,
  ackSchema,
]);
export type CanonicalRecord = z.infer<typeof canonicalRecordSchema>;
