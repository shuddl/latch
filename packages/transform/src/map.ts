// packages/transform — the declarative MapArtifact (docs/04 §maps, docs/08).
//
// A map is DATA, not code: a versioned list of field rules the deterministic engine
// interprets in both directions. Declarative rules are diffable, certifiable,
// patchable (self-heal), and attestable — and, critically, contain NO LLM at runtime.
//
// Rule kinds:
//  - `element`  bidirectional: a canonical path ↔ a single EDI element address. Read
//               on `toCanonical`, written back verbatim on `fromCanonical`.
//  - `const`    sets a required canonical field not sourced from EDI (e.g. `kind`).
//               Forward-only; never written back.
//  - `derived`  forward-only convenience value computed from source elements by a pure
//               named builtin (e.g. AT7 date+time → advisory ISO). NOT written back, so
//               its authoritative source elements ride untouched in `raw` (G2: no
//               timezone/precision loss on round-trip).

import { z } from 'zod';
import { elementAddressSchema } from './address-schema';

export const elementRuleSchema = z.object({
  kind: z.literal('element'),
  path: z.string(), // dot path into the canonical record, e.g. 'location.city'
  source: elementAddressSchema,
});

export const constRuleSchema = z.object({
  kind: z.literal('const'),
  path: z.string(),
  value: z.union([z.string(), z.number(), z.boolean()]),
});

export const derivedRuleSchema = z.object({
  kind: z.literal('derived'),
  path: z.string(),
  inputs: z.array(elementAddressSchema),
  transform: z.enum(['dateTimeToIso']),
});

export const fieldRuleSchema = z.discriminatedUnion('kind', [
  elementRuleSchema,
  constRuleSchema,
  derivedRuleSchema,
]);
export type FieldRule = z.infer<typeof fieldRuleSchema>;

export const mapArtifactSchema = z.object({
  mapVersion: z.string(),
  direction: z.enum(['inbound', 'outbound']),
  transactionSet: z.string(), // '214'
  x12Version: z.string(), // '004010' (TD3: version is first-class)
  canonicalVersion: z.string(), // '1'
  recordKind: z.enum(['Tender', 'TenderResponse', 'BOL', 'StatusEvent', 'Invoice', 'Ack']),
  rules: z.array(fieldRuleSchema),
  /** Content hash of the rules — the unit of map identity for certification. */
  compiledHash: z.string().optional(),
});
export type MapArtifact = z.infer<typeof mapArtifactSchema>;

/** Deterministic JSON: object keys sorted recursively, so equal maps hash equally. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/** FNV-1a (32-bit) over the canonical rule JSON — dependency-free, Workers-safe. */
function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Compute the content hash of a map's identity-bearing fields (excludes the hash itself). */
export function computeCompiledHash(map: MapArtifact): string {
  const identity: Record<string, unknown> = { ...map };
  delete identity['compiledHash'];
  return `map_${fnv1a(stableStringify(identity))}`;
}

/** Return a copy of the map with `compiledHash` filled in deterministically. */
export function withCompiledHash(map: MapArtifact): MapArtifact {
  return { ...map, compiledHash: computeCompiledHash(map) };
}
