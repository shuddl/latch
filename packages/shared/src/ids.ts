// Prefixed ULIDs (docs/06 conventions). Dependency-free, Workers-runtime safe.
// ULID = 48-bit timestamp + 80-bit randomness, Crockford base32, lexicographically
// sortable. We prefix per entity type for human-readable, type-safe ids.

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // no I, L, O, U
const TIME_LEN = 10;
const RAND_LEN = 16;

export const ID_PREFIXES = {
  partner: 'ptr',
  connection: 'con',
  spec: 'spc',
  map: 'map',
  golden: 'gld',
  cert: 'crt',
  transaction: 'txn',
  drift: 'drf',
  handshake: 'hs',
} as const;

export type IdPrefix = (typeof ID_PREFIXES)[keyof typeof ID_PREFIXES];

function encodeTime(now: number): string {
  let out = '';
  let t = now;
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    const mod = t % 32;
    out = CROCKFORD[mod]! + out;
    t = (t - mod) / 32;
  }
  return out;
}

function encodeRandom(): string {
  const bytes = new Uint8Array(RAND_LEN);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < RAND_LEN; i++) {
    // Map each byte into the 32-symbol alphabet (top 5 bits is enough for spread).
    out += CROCKFORD[bytes[i]! % 32]!;
  }
  return out;
}

/** Generate a bare ULID (26 chars, time-sortable). */
export function ulid(now: number = Date.now()): string {
  return encodeTime(now) + encodeRandom();
}

/** Generate a prefixed id, e.g. `ptr_01J9...`. */
export function newId(kind: keyof typeof ID_PREFIXES, now: number = Date.now()): string {
  return `${ID_PREFIXES[kind]}_${ulid(now)}`;
}

const PREFIX_SET = new Set<string>(Object.values(ID_PREFIXES));

/** True if `value` is a `<prefix>_<26-char ULID>` for the given (or any) kind. */
export function isId(value: string, kind?: keyof typeof ID_PREFIXES): boolean {
  const idx = value.indexOf('_');
  if (idx < 0) return false;
  const prefix = value.slice(0, idx);
  const body = value.slice(idx + 1);
  if (kind ? prefix !== ID_PREFIXES[kind] : !PREFIX_SET.has(prefix)) return false;
  return body.length === TIME_LEN + RAND_LEN && [...body].every((c) => CROCKFORD.includes(c));
}
