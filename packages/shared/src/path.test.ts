import { describe, it, expect } from 'vitest';
import { getPath, setPath, isSafeKey } from './path';

describe('shared/path — getPath', () => {
  it('reads nested values', () => {
    expect(getPath({ a: { b: { c: 1 } } }, 'a.b.c')).toBe(1);
  });
  it('returns undefined on a miss', () => {
    expect(getPath({ a: {} }, 'a.b.c')).toBeUndefined();
  });
  it('refuses unsafe keys', () => {
    expect(getPath({}, '__proto__.polluted')).toBeUndefined();
    expect(getPath({}, 'constructor.prototype')).toBeUndefined();
  });
});

describe('shared/path — setPath', () => {
  it('writes nested values, creating intermediates', () => {
    const t: Record<string, unknown> = {};
    setPath(t, 'a.b.c', 7);
    expect(getPath(t, 'a.b.c')).toBe(7);
  });
  it('never pollutes Object.prototype', () => {
    const t: Record<string, unknown> = {};
    setPath(t, '__proto__.polluted', 'yes');
    expect((Object.prototype as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});

describe('shared/path — isSafeKey', () => {
  it('flags the three dangerous keys', () => {
    expect(isSafeKey('__proto__')).toBe(false);
    expect(isSafeKey('constructor')).toBe(false);
    expect(isSafeKey('prototype')).toBe(false);
    expect(isSafeKey('shipmentId')).toBe(true);
  });
});
