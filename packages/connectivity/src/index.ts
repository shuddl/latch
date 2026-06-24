// @latch/connectivity — AS2/SFTP/VAN/API transport adapters behind one interface
// (docs/04, docs/08). The adapter logic is owned and tested here; concrete wire clients
// (SSH/SFTP, AS2 S/MIME) are injected at deploy time, so transport needs credentials to
// *run* — never to *build or test*.

export * from './types';
export * from './poll';
export { InMemoryAdapter } from './memory';
export { SftpAdapter, type SftpClient, type SftpConfig } from './sftp';
