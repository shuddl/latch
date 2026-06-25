import { describe, it, expect } from 'vitest';
import { ControlSequencer, type SeqStorage } from './sequencer';

/** A faithful stand-in for DurableObjectStorage: a plain Map. */
class MemoryStorage implements SeqStorage {
  private readonly m = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return this.m.get(key) as T | undefined;
  }
  async put<T>(key: string, value: T): Promise<void> {
    this.m.set(key, value);
  }
}

describe('ControlSequencer — per-connection outbound control numbers', () => {
  it('issues monotonic, X12-formatted control numbers', async () => {
    const seq = new ControlSequencer(new MemoryStorage());
    const first = await seq.allocate();
    expect(first).toEqual({ interchangeControlNumber: '000000001', groupControlNumber: '1', stControlNumber: '0001' });
    const second = await seq.allocate();
    expect(second).toEqual({ interchangeControlNumber: '000000002', groupControlNumber: '2', stControlNumber: '0002' });
  });

  it('peek returns the last-issued numbers without advancing', async () => {
    const storage = new MemoryStorage();
    const seq = new ControlSequencer(storage);
    expect(await seq.peek()).toEqual({ interchangeControlNumber: '000000000', groupControlNumber: '0', stControlNumber: '0000' });
    await seq.allocate();
    expect(await seq.peek()).toEqual({ interchangeControlNumber: '000000001', groupControlNumber: '1', stControlNumber: '0001' });
    expect(await seq.peek()).toEqual({ interchangeControlNumber: '000000001', groupControlNumber: '1', stControlNumber: '0001' }); // still no advance
  });

  it('survives eviction: a fresh sequencer over the same storage continues the sequence', async () => {
    const storage = new MemoryStorage();
    await new ControlSequencer(storage).allocate(); // 1
    await new ControlSequencer(storage).allocate(); // 2 — reconstructed each time, as a DO would
    const third = await new ControlSequencer(storage).allocate();
    expect(third.interchangeControlNumber).toBe('000000003');
  });

  it('wraps at the 9-digit X12 ceiling rather than overflowing', async () => {
    const storage = new MemoryStorage();
    await storage.put('seq:counters', { isa: 999_999_999, gs: 999_999_999, st: 999_999_999 });
    const next = await new ControlSequencer(storage).allocate();
    expect(next.interchangeControlNumber).toBe('000000001');
    expect(next.groupControlNumber).toBe('1');
    expect(next.stControlNumber).toBe('0001');
  });
});
