import { describe, it, expect } from 'vitest';
import { transactionSetDef } from './transaction-sets';

describe('transaction-set registry', () => {
  it('resolves supported sets', () => {
    expect(transactionSetDef('214')?.recordKind).toBe('StatusEvent');
    expect(transactionSetDef('990')?.recordKind).toBe('TenderResponse');
    expect(transactionSetDef('204')?.recordKind).toBe('Tender');
    expect(transactionSetDef('210')?.recordKind).toBe('Invoice');
  });

  it('returns undefined for unsupported sets', () => {
    expect(transactionSetDef('211')).toBeUndefined();
    expect(transactionSetDef('')).toBeUndefined();
  });

  it('does not resolve Object.prototype members for a crafted set id (proto guard)', () => {
    // A connection-controlled value must never pull a prototype member as a "def".
    expect(transactionSetDef('constructor')).toBeUndefined();
    expect(transactionSetDef('toString')).toBeUndefined();
    expect(transactionSetDef('__proto__')).toBeUndefined();
  });
});
