#!/usr/bin/env node
// Apply D1 migrations in order via wrangler. Usage:
//   node scripts/migrate.mjs            # apply to remote D1
//   node scripts/migrate.mjs --local    # apply to local dev D1
// Requires CLOUDFLARE_ACCOUNT_ID in the environment and `wrangler` available.

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const MIGRATIONS_DIR = join(process.cwd(), 'infra', 'migrations');
const DB = 'latch';
const local = process.argv.includes('--local');

const files = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();

if (files.length === 0) {
  console.error('No migrations found in infra/migrations');
  process.exit(1);
}

for (const file of files) {
  const path = join(MIGRATIONS_DIR, file);
  console.log(`Applying ${file}…`);
  const args = ['d1', 'execute', DB, '--file', path, local ? '--local' : '--remote'];
  execFileSync('wrangler', args, { stdio: 'inherit', cwd: join(process.cwd(), 'apps', 'api') });
}

console.log('Migrations applied.');
