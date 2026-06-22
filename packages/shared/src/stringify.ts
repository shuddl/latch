// Deterministic JSON: object keys sorted recursively so semantically-equal values
// stringify identically (key-order-insensitive). Depth-bounded against cyclic/
// pathological inputs. Used for content hashing and the forward oracle's comparison.

export function stableStringify(value: unknown, depth = 0): string {
  if (depth > 50) return '"[max-depth]"';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v, depth + 1)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k], depth + 1)}`)
    .join(',')}}`;
}
