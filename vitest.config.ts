import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.{ts,tsx}', 'apps/**/*.test.{ts,tsx}'],
    environment: 'node',
    // Enable Node's built-in SQLite so the production D1 store can be integration-tested
    // against the real migration (apps/api store contract). Harmless elsewhere.
    pool: 'forks',
    poolOptions: { forks: { execArgv: ['--experimental-sqlite'] } },
  },
});
