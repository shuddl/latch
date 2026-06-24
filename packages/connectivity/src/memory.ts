// In-memory adapter — the deterministic test/dev transport. It implements the EXACT
// ConnectivityAdapter contract a real SFTP/AS2 server would, so the drain loop, the
// pipeline wiring, and go-live can all be proven end-to-end with no network or secrets.

import type { ConnectivityAdapter, InboundFile, OutboundFile } from './types';

export class InMemoryAdapter implements ConnectivityAdapter {
  readonly kind = 'memory' as const;
  private inbox: InboundFile[] = [];
  /** Files acknowledged (moved out of the inbox), in order — for assertions. */
  readonly acked: string[] = [];
  /** Files pushed via `send`, in order — for assertions. */
  readonly sent: OutboundFile[] = [];

  constructor(initial: InboundFile[] = []) {
    this.inbox = [...initial];
  }

  /** Simulate a partner dropping a file on the transport. */
  drop(file: InboundFile): void {
    this.inbox.push(file);
  }

  async poll(): Promise<InboundFile[]> {
    return this.inbox.map((f) => ({ ...f }));
  }

  async ack(name: string): Promise<void> {
    this.inbox = this.inbox.filter((f) => f.name !== name);
    this.acked.push(name);
  }

  async send(file: OutboundFile): Promise<void> {
    this.sent.push({ ...file });
  }
}
