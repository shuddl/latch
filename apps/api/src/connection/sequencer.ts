// Per-connection outbound control-number sequencing (task 2.3, M2). X12 requires monotonic,
// unique interchange/group/transaction control numbers per trading-partner connection — and
// the allocation must be atomic so two concurrent outbound sends never collide. A Durable
// Object is exactly the right home: it is single-threaded per connection, so `allocate()` is
// race-free by construction. The sequencer holds NOTHING across calls — it reloads its counters
// from DO storage every time, so the DO can be evicted between sends and resume seamlessly
// (the same eviction-safe shape as the handshake host).

/** The subset of DurableObjectStorage the sequencer needs (so it is testable without workerd). */
export interface SeqStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T = unknown>(key: string, value: T): Promise<void>;
}

/** Freshly-issued control numbers for one outbound interchange (one group, one transaction set). */
export interface ControlNumbers {
  interchangeControlNumber: string; // ISA13 — 9 digits, zero-padded
  groupControlNumber: string; // GS06
  stControlNumber: string; // ST02 — ≥4 digits, zero-padded
}

interface Counters {
  isa: number;
  gs: number;
  st: number;
}

const KEY = 'seq:counters';
/** X12 control numbers are at most 9 digits; wrap back to 1 rather than overflow the field. */
const WRAP = 1_000_000_000;

function bump(n: number): number {
  return n >= WRAP - 1 ? 1 : n + 1;
}

function format(c: Counters): ControlNumbers {
  return {
    interchangeControlNumber: String(c.isa).padStart(9, '0'),
    groupControlNumber: String(c.gs),
    stControlNumber: String(c.st).padStart(4, '0'),
  };
}

export class ControlSequencer {
  constructor(private readonly storage: SeqStorage) {}

  private async load(): Promise<Counters> {
    return (await this.storage.get<Counters>(KEY)) ?? { isa: 0, gs: 0, st: 0 };
  }

  /** Issue the next control-number triple and persist the advance (atomic within the DO). */
  async allocate(): Promise<ControlNumbers> {
    const c = await this.load();
    const next: Counters = { isa: bump(c.isa), gs: bump(c.gs), st: bump(c.st) };
    await this.storage.put(KEY, next);
    return format(next);
  }

  /** The last-issued control numbers without advancing (all-zero before the first allocate). */
  async peek(): Promise<ControlNumbers> {
    return format(await this.load());
  }
}
