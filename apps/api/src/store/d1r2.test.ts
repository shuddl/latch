// Integration-tests the production D1R2Store against the REAL migration, using Node's
// built-in SQLite (D1 is SQLite) behind a tiny D1-compatible adapter, plus in-memory
// R2/KV doubles. This is what lets us trust the SQL the InMemoryStore can't exercise.

import { describe } from 'vitest';
import type { DatabaseSync as DatabaseSyncType, StatementSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { D1R2Store } from './d1r2';
import { runStoreContract } from './contract';

// Load node:sqlite at runtime so Vite/vitest doesn't try to bundle the new builtin.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

type Param = string | number | null | bigint | Uint8Array;

// Minimal D1PreparedStatement over a node:sqlite statement.
class FakeStmt {
  private args: Param[] = [];
  constructor(private readonly stmt: StatementSync) {}
  bind(...args: unknown[]): this {
    this.args = args as Param[];
    return this;
  }
  async run() {
    const r = this.stmt.run(...this.args);
    return { success: true, meta: { changes: Number(r.changes) }, results: [] };
  }
  async all<T>() {
    return { success: true, results: this.stmt.all(...this.args) as T[] };
  }
  async first<T>() {
    return (this.stmt.get(...this.args) as T | undefined) ?? null;
  }
}

class FakeD1 {
  constructor(private readonly db: DatabaseSyncType) {}
  prepare(sql: string) {
    return new FakeStmt(this.db.prepare(sql));
  }
}

class FakeR2 {
  private readonly objects = new Map<string, string>();
  async put(key: string, value: string) {
    this.objects.set(key, value);
  }
  async get(key: string) {
    const v = this.objects.get(key);
    return v === undefined ? null : { text: async () => v };
  }
}

class FakeKV {
  private readonly map = new Map<string, string>();
  async get(key: string) {
    return this.map.get(key) ?? null;
  }
  async put(key: string, value: string) {
    this.map.set(key, value);
  }
}

const MIGRATION = readFileSync(
  fileURLToPath(new URL('../../../../infra/migrations/0001_init.sql', import.meta.url)),
  'utf8',
);

function makeStore() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(MIGRATION);
  db.exec("INSERT INTO tenants (id, name, created_at) VALUES ('other', 'Other tenant', 0)");
  return new D1R2Store(
    new FakeD1(db) as unknown as D1Database,
    new FakeR2() as unknown as R2Bucket,
    new FakeKV() as unknown as KVNamespace,
  );
}

describe('D1R2Store (node:sqlite, real 0001 migration)', () => {
  runStoreContract(makeStore);
});
