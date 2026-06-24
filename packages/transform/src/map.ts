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
//  - `codemap`  forward-only: a single EDI code element → a canonical enum value via a
//               declared lookup table (e.g. 990 B1_04 'A'/'D' → 'accept'/'decline').
//               NOT written back — the authoritative source code rides verbatim in `raw`,
//               so round-trip stays byte-faithful even when the table isn't 1:1.

import { z } from 'zod';
import { elementAddressSchema } from './address-schema';

export const elementRuleSchema = z.object({
  kind: z.literal('element'),
  path: z.string(), // dot path into the canonical record, e.g. 'location.city'
  source: elementAddressSchema,
  /**
   * Optional cast of the raw EDI string to a canonical scalar type (e.g. freight weight,
   * piece count, invoice amount). A cast element is FORWARD-ONLY: it is not written back,
   * because re-serializing a Number can lose the source's exact lexical form ('01' → '1',
   * '10.50' → '10.5'). The authoritative source string rides verbatim in the raw snapshot,
   * so round-trip stays byte-faithful. Uncast elements remain bidirectional.
   */
  cast: z.enum(['number']).optional(),
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

export const codemapRuleSchema = z.object({
  kind: z.literal('codemap'),
  path: z.string(), // canonical enum path, e.g. 'decision'
  source: elementAddressSchema,
  /** EDI code → canonical value. Forward-only; write-back rides in the raw snapshot. */
  table: z.record(z.string(), z.string()),
  /** Source code absent from the table: 'unset' (warn, leave unmapped) or 'passthrough'. */
  onMiss: z.enum(['unset', 'passthrough']).default('unset'),
});

/**
 * The flat (non-loop) rule kinds. These are the only rules allowed *inside* a loop's
 * `fields` — loops do not nest in v1, which keeps the engine and the oracles simple.
 */
export const childRuleSchema = z.discriminatedUnion('kind', [
  elementRuleSchema,
  constRuleSchema,
  derivedRuleSchema,
  codemapRuleSchema,
]);
export type ChildRule = z.infer<typeof childRuleSchema>;

/**
 * A repeating loop: each occurrence of `anchor` in the transaction body opens a window
 * (anchor segment up to, but excluding, the next same-tag anchor — or end of body), and
 * each window becomes one item in the canonical array at `path`. Child rule addresses are
 * RELATIVE to the window (occurrence counts restart at 0 per window); child paths are
 * relative to the item object (e.g. 'party.address.city'). Round-trip is byte-faithful:
 * item i ↔ window i, with uncast `element` children written back onto the snapshot.
 */
export const loopRuleSchema = z.object({
  kind: z.literal('loop'),
  path: z.string(),
  anchor: z.string(), // segment tag that begins each iteration (e.g. 'S5', 'L11')
  fields: z.array(childRuleSchema),
});

/**
 * A qualifier-selected single group: the FIRST `anchor` occurrence whose `match` element
 * equals the given code opens a window (to the next same-tag anchor), mapped to a single
 * object at `path` (NOT an array). The freight pattern N1*SH / N1*CN / N1*BT — three party
 * loops distinguished only by N1-01 — becomes three `group` rules. Child addresses are
 * relative to the window; round-trip is byte-faithful (uncast element children overlaid).
 */
export const groupRuleSchema = z.object({
  kind: z.literal('group'),
  path: z.string(),
  anchor: z.string(),
  match: z.object({
    element: z.number().int().positive(), // 1-based element on the anchor segment
    equals: z.string(),
  }),
  fields: z.array(childRuleSchema),
});

export const fieldRuleSchema = z.discriminatedUnion('kind', [
  elementRuleSchema,
  constRuleSchema,
  derivedRuleSchema,
  codemapRuleSchema,
  loopRuleSchema,
  groupRuleSchema,
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
