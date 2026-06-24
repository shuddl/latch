// @latch/connectivity — transport adapters behind one interface (docs/04, docs/08).
//
// Latch owns the *adapter logic* (poll → hand off → acknowledge → send); the concrete
// wire protocol (SSH/SFTP, AS2 S/MIME, a VAN's API) is injected as a thin client so the
// whole layer is unit-testable WITHOUT live credentials or a network. Credentials are a
// deploy-time secret, never a build-time dependency: the in-memory adapter exercises the
// exact same code path a real SFTP server would. No EDI parsing here — adapters move bytes;
// the pipeline (parse/transform/ack) is downstream.

/** A file pulled from (or pushed to) a partner transport. `content` is the raw EDI text. */
export interface InboundFile {
  name: string;
  content: string;
}

export interface OutboundFile {
  name: string;
  content: string;
}

/**
 * One partner transport. Pull transports (SFTP/VAN) implement `poll`; push transports
 * (AS2 over HTTP) deliver via a receive endpoint and leave `poll` returning `[]`.
 * `ack` marks an inbound file handled (move/delete) so it is never reprocessed; `send`
 * writes an outbound file (a 997, an outbound 990/214/210).
 */
export interface ConnectivityAdapter {
  readonly kind: 'sftp' | 'as2' | 'van' | 'api' | 'memory';
  /** Newly-arrived inbound files; `[]` when none (or for push transports). Must not throw for "empty". */
  poll(): Promise<InboundFile[]>;
  /** Mark an inbound file processed so the next poll won't return it again. */
  ack(name: string): Promise<void>;
  /** Push an outbound file to the partner. */
  send(file: OutboundFile): Promise<void>;
}
