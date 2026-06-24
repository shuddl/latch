import { describe, it, expect } from 'vitest';
import { InMemoryAdapter, SftpAdapter, drainInbound, type SftpClient, type InboundFile } from './index';

describe('drainInbound — transport-agnostic inbound loop', () => {
  it('hands each polled file to the sink and acks only the accepted ones', async () => {
    const adapter = new InMemoryAdapter([
      { name: 'a.edi', content: 'ISA*A~' },
      { name: 'b.edi', content: 'ISA*B~' },
    ]);
    const seen: string[] = [];
    const res = await drainInbound(adapter, async (f) => {
      seen.push(f.content);
    });
    expect(seen).toEqual(['ISA*A~', 'ISA*B~']);
    expect(res.processed).toEqual(['a.edi', 'b.edi']);
    expect(res.failed).toEqual([]);
    expect(adapter.acked).toEqual(['a.edi', 'b.edi']);
    // Acked files are gone from the inbox → a second drain is a no-op.
    expect(await adapter.poll()).toEqual([]);
  });

  it('leaves a rejected file un-acked (retried next poll) without aborting the batch', async () => {
    const adapter = new InMemoryAdapter([
      { name: 'bad.edi', content: 'boom' },
      { name: 'good.edi', content: 'ok' },
    ]);
    const res = await drainInbound(adapter, async (f) => {
      if (f.name === 'bad.edi') throw new Error('parse failed');
    });
    expect(res.processed).toEqual(['good.edi']);
    expect(res.failed).toEqual([{ name: 'bad.edi', error: 'parse failed' }]);
    expect(adapter.acked).toEqual(['good.edi']);
    // The bad file is still pending for the next poll; the good one is gone.
    expect((await adapter.poll()).map((f) => f.name)).toEqual(['bad.edi']);
  });

  it('records outbound sends (e.g. a 997 ack) on the adapter', async () => {
    const adapter = new InMemoryAdapter();
    await adapter.send({ name: '997-1.edi', content: 'ISA*...997~' });
    expect(adapter.sent).toEqual([{ name: '997-1.edi', content: 'ISA*...997~' }]);
  });
});

// A fake SSH/SFTP client: an in-memory filesystem. Proves the SftpAdapter workflow
// (list → read → move-to-archive → write-outbound) with zero network or credentials.
function fakeSftp(initial: Record<string, string>): SftpClient & { fs: Record<string, string> } {
  const fs: Record<string, string> = { ...initial };
  return {
    fs,
    async list(dir) {
      const prefix = `${dir.replace(/\/$/, '')}/`;
      return Object.keys(fs)
        .filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
        .map((p) => p.slice(prefix.length));
    },
    async read(path) {
      const v = fs[path];
      if (v === undefined) throw new Error(`no such file: ${path}`);
      return v;
    },
    async move(from, to) {
      const v = fs[from];
      if (v === undefined) throw new Error(`no such file: ${from}`);
      fs[to] = v;
      delete fs[from];
    },
    async write(path, content) {
      fs[path] = content;
    },
  };
}

describe('SftpAdapter — real workflow over an injected SSH client', () => {
  // Fixed clock so the unique archive suffix is deterministic in assertions.
  const cfg = { inboundDir: '/in', archiveDir: '/archive', outboundDir: '/out', now: () => 1_700_000_000_000 };

  it('polls the inbound dir and reads file contents', async () => {
    const client = fakeSftp({ '/in/214-1.edi': 'ISA*214~', '/in/214-2.edi': 'ISA*215~', '/other/x.edi': 'nope' });
    const adapter = new SftpAdapter(client, cfg);
    const files = await adapter.poll();
    expect(files.map((f) => f.name).sort()).toEqual(['214-1.edi', '214-2.edi']);
    expect(files.find((f) => f.name === '214-1.edi')?.content).toBe('ISA*214~');
  });

  it('acks by moving the file to archive with a unique suffix (kept for audit/replay)', async () => {
    const client = fakeSftp({ '/in/214-1.edi': 'ISA*214~' });
    const adapter = new SftpAdapter(client, cfg);
    await adapter.ack('214-1.edi');
    expect(client.fs['/in/214-1.edi']).toBeUndefined();
    expect(client.fs['/archive/214-1-1700000000000.edi']).toBe('ISA*214~');
  });

  it('does not collide when a partner reuses a filename (audit history preserved)', async () => {
    let t = 1_700_000_000_000;
    const client = fakeSftp({ '/in/dup.edi': 'first' });
    const adapter = new SftpAdapter(client, { ...cfg, now: () => t });
    await adapter.ack('dup.edi'); // archived as dup-...000.edi
    // The same filename arrives again later.
    t += 1000;
    client.fs['/in/dup.edi'] = 'second';
    await adapter.ack('dup.edi'); // archived as dup-...001000.edi
    expect(client.fs['/archive/dup-1700000000000.edi']).toBe('first');
    expect(client.fs['/archive/dup-1700000001000.edi']).toBe('second');
  });

  it('drains end-to-end: poll → sink → archive, leaving the inbound dir empty', async () => {
    const client = fakeSftp({ '/in/a.edi': 'A', '/in/b.edi': 'B' });
    const adapter = new SftpAdapter(client, cfg);
    const received: InboundFile[] = [];
    const res = await drainInbound(adapter, async (f) => {
      received.push(f);
    });
    expect(received.map((f) => f.name).sort()).toEqual(['a.edi', 'b.edi']);
    expect(res.processed.sort()).toEqual(['a.edi', 'b.edi']);
    expect(await adapter.poll()).toEqual([]); // inbound drained
    expect(client.fs['/archive/a-1700000000000.edi']).toBe('A'); // archived (suffixed), not lost
  });

  it('sends an outbound file into the outbound dir', async () => {
    const client = fakeSftp({});
    const adapter = new SftpAdapter(client, cfg);
    await adapter.send({ name: '990-resp.edi', content: 'ISA*990~' });
    expect(client.fs['/out/990-resp.edi']).toBe('ISA*990~');
  });
});
