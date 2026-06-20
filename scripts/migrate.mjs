#!/usr/bin/env node
// Apply D1 migrations idempotently via Wrangler's own migration system, which tracks
// applied migrations in a `d1_migrations` table — so re-running is safe (Copilot/PR#1).
// Migration files live in infra/migrations and are wired via `migrations_dir` in
// apps/api/wrangler.toml. Usage:
//   node scripts/migrate.mjs            # apply to remote D1
//   node scripts/migrate.mjs --local    # apply to local dev D1
// Requires CLOUDFLARE_ACCOUNT_ID in the environment and `wrangler` available.

import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const DB = 'latch';
const local = process.argv.includes('--local');
const args = ['d1', 'migrations', 'apply', DB, local ? '--local' : '--remote'];

execFileSync('wrangler', args, { stdio: 'inherit', cwd: join(process.cwd(), 'apps', 'api') });
