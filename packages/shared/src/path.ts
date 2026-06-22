/**
 * Safe object-path helpers (defense-in-depth against prototype pollution).
 *
 * Map paths in Latch are authored artifacts, not raw user input, but the transform and
 * verify engines walk those paths to read/write nested canonical objects. Guarding the
 * dangerous keys here keeps a single source of truth and prevents drift between callers.
 */

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** True when `key` cannot be used to pollute Object.prototype. */
export function isSafeKey(key: string): boolean {
  return !UNSAFE_KEYS.has(key);
}

/** Read a dotted path from `source`, returning `undefined` on any miss or unsafe key. */
export function getPath(source: Record<string, unknown>, path: string): unknown {
  let cur: unknown = source;
  for (const key of path.split('.')) {
    if (!isSafeKey(key)) return undefined;
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/**
 * Write `value` at a dotted path in `target`, creating prototype-null intermediates.
 * No-ops (does not throw) if any path segment is an unsafe key.
 */
export function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cur: Record<string, unknown> = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    if (!isSafeKey(key)) return;
    const next = cur[key];
    if (typeof next !== 'object' || next === null) {
      cur[key] = Object.create(null) as Record<string, unknown>;
    }
    cur = cur[key] as Record<string, unknown>;
  }
  const last = parts[parts.length - 1]!;
  if (!isSafeKey(last)) return;
  cur[last] = value;
}
