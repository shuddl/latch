// Safe dot-path get/set used by the transform engine and verifier.
// setPath refuses prototype-polluting keys — rules can originate from an LLM
// (mapgen) or, later, partner-influenced data, so this must not be trustable input.

const UNSAFE = new Set(['__proto__', 'prototype', 'constructor']);

export function getPath(source: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, key) => {
    if (node && typeof node === 'object') return (node as Record<string, unknown>)[key];
    return undefined;
  }, source);
}

export function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  let node = target;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i]!;
    if (UNSAFE.has(k)) return; // refuse to traverse a polluting path
    const next = node[k];
    if (typeof next !== 'object' || next === null) {
      node[k] = {};
    }
    node = node[k] as Record<string, unknown>;
  }
  const last = keys[keys.length - 1]!;
  if (UNSAFE.has(last)) return;
  node[last] = value;
}
