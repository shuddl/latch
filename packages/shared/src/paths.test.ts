import { describe, it, expect } from 'vitest';
import { getPath, setPath } from './paths';

describe('paths', () => {
  it('gets and sets nested values', () => {
    expect(getPath({ a: { b: 1 } }, 'a.b')).toBe(1);
    const o: Record<string, unknown> = {};
    setPath(o, 'a.b', 2);
    expect(o).toEqual({ a: { b: 2 } });
  });

  it('refuses prototype-polluting paths', () => {
    const o: Record<string, unknown> = {};
    setPath(o, '__proto__.polluted', 'yes');
    setPath(o, 'constructor.prototype.polluted', 'yes');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(({} as any).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted')).toBe(false);
  });
});
