import { describe, it, expect } from 'vitest';
import { newId, ulid, isId, ID_PREFIXES } from './ids';

describe('ids', () => {
  it('generates prefixed ids that validate', () => {
    const id = newId('partner');
    expect(id.startsWith(`${ID_PREFIXES.partner}_`)).toBe(true);
    expect(isId(id, 'partner')).toBe(true);
    expect(isId(id, 'connection')).toBe(false);
  });

  it('rejects malformed ids', () => {
    expect(isId('not-an-id')).toBe(false);
    expect(isId('ptr_short')).toBe(false);
    expect(isId('xxx_01234567890123456789012345')).toBe(false); // unknown prefix
  });

  it('ulids are time-sortable across timestamps', () => {
    const a = ulid(1_000_000_000_000);
    const b = ulid(1_000_000_000_001);
    expect(a < b).toBe(true);
    expect(a).toHaveLength(26);
  });
});
