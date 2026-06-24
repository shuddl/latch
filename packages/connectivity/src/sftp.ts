// SFTP adapter. Latch owns the *workflow* — list the inbound dir, read each file, move
// handled files to an archive dir, write outbound files — and that workflow is fully
// implemented and unit-tested here against an injected `SftpClient`. The concrete SSH
// transport (the only part that needs credentials and a socket) is provided at deploy
// time: a `cloudflare:sockets` `connect()`-based SSH/SFTP client, or a vendored library,
// satisfying this 4-method interface. Swapping transports never touches the workflow.
//
// LATCH-ASSUMPTION (R1): the SSH/SFTP wire client is a deploy-time dependency injected as
// `SftpClient`. We deliberately do NOT hand-roll SSH here — the adapter contract is the
// stable seam, proven with a fake client; the socket implementation is a separate task.

import type { ConnectivityAdapter, InboundFile, OutboundFile } from './types';

/** The minimal SSH/SFTP surface the adapter needs. Injected; never constructed here. */
export interface SftpClient {
  /** Names (not full paths) of files in `dir`. */
  list(dir: string): Promise<string[]>;
  /** UTF-8 contents of the file at `path`. */
  read(path: string): Promise<string>;
  /** Atomically move (rename) `from` → `to`. */
  move(from: string, to: string): Promise<void>;
  /** Write `content` to `path` (create/overwrite). */
  write(path: string, content: string): Promise<void>;
}

export interface SftpConfig {
  /** Directory the partner drops inbound EDI into. */
  inboundDir: string;
  /** Directory handled files are moved to on `ack` (kept for audit/replay). */
  archiveDir: string;
  /** Directory outbound files (997s, outbound sets) are written to. */
  outboundDir: string;
  /** Clock for the unique archive suffix; injectable so tests are deterministic. Defaults to Date.now. */
  now?: () => number;
}

const join = (dir: string, name: string): string => `${dir.replace(/\/$/, '')}/${name}`;

/** `214.edi` → `214-<stamp>.edi` (suffix before the extension). */
function archivedName(name: string, stamp: number): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return `${name}-${stamp}`; // no extension (or dotfile)
  return `${name.slice(0, dot)}-${stamp}${name.slice(dot)}`;
}

export class SftpAdapter implements ConnectivityAdapter {
  readonly kind = 'sftp' as const;

  constructor(
    private readonly client: SftpClient,
    private readonly cfg: SftpConfig,
  ) {}

  async poll(): Promise<InboundFile[]> {
    const names = await this.client.list(this.cfg.inboundDir);
    // Read in parallel — sequential SFTP round-trips would dominate latency. Promise.all
    // preserves order, so file order matches the listing.
    return Promise.all(
      names.map(async (name) => ({ name, content: await this.client.read(join(this.cfg.inboundDir, name)) })),
    );
  }

  async ack(name: string): Promise<void> {
    // Unique suffix: a partner reusing a filename would otherwise collide in the archive —
    // either clobbering audit history or failing the rename and reprocessing forever.
    const stamp = (this.cfg.now ?? (() => Date.now()))();
    await this.client.move(
      join(this.cfg.inboundDir, name),
      join(this.cfg.archiveDir, archivedName(name, stamp)),
    );
  }

  async send(file: OutboundFile): Promise<void> {
    await this.client.write(join(this.cfg.outboundDir, file.name), file.content);
  }
}
