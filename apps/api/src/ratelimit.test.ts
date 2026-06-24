import { describe, it, expect } from 'vitest';
import { createApp } from './app';
import { InMemoryStore } from './store/memory';
import { InMemoryRateLimiter, KvRateLimiter } from './ratelimit';
import type { Env } from './env';

describe('InMemoryRateLimiter — fixed window', () => {
  it('allows up to the limit, then denies, then resets after the window', async () => {
    let now = 1_000_000;
    const rl = new InMemoryRateLimiter(() => now);
    const a = await rl.hit('t', 2, 60);
    const b = await rl.hit('t', 2, 60);
    const c = await rl.hit('t', 2, 60);
    expect([a.allowed, b.allowed, c.allowed]).toEqual([true, true, false]);
    expect(a.remaining).toBe(1);
    expect(c.remaining).toBe(0);
    expect(c.resetSec).toBeGreaterThan(0);
    // Different key is independent.
    expect((await rl.hit('other', 2, 60)).allowed).toBe(true);
    // After the window elapses, the count resets.
    now += 60_000;
    expect((await rl.hit('t', 2, 60)).allowed).toBe(true);
  });
});

describe('KvRateLimiter — soft window over KV', () => {
  function fakeKv() {
    const m = new Map<string, string>();
    return {
      store: m,
      get: async (k: string) => m.get(k) ?? null,
      put: async (k: string, v: string) => void m.set(k, v),
    } as unknown as KVNamespace;
  }

  it('counts within a window bucket and denies past the limit', async () => {
    const kv = fakeKv();
    const rl = new KvRateLimiter(kv, () => 1_000_000_000);
    expect((await rl.hit('t', 2, 60)).allowed).toBe(true);
    expect((await rl.hit('t', 2, 60)).allowed).toBe(true);
    expect((await rl.hit('t', 2, 60)).allowed).toBe(false);
  });

  it('fails open if KV throws (a limiter outage must not block traffic)', async () => {
    const brokenKv = {
      get: async () => {
        throw new Error('kv down');
      },
      put: async () => undefined,
    } as unknown as KVNamespace;
    const rl = new KvRateLimiter(brokenKv);
    expect((await rl.hit('t', 1, 60)).allowed).toBe(true);
  });
});

describe('API — per-tenant rate limiting middleware', () => {
  const ENV = { LATCH_RATE_LIMIT: '2' } as unknown as Env;

  it('returns 429 with Retry-After once a tenant exceeds its limit; health is exempt', async () => {
    // A single shared limiter (state persists across requests, like KV does in prod).
    const rl = new InMemoryRateLimiter();
    const app = createApp(
      () => new InMemoryStore(),
      () => null,
      () => rl,
    );
    const call = (path: string) => app.request(path, { headers: { 'X-Latch-Dev-Org': 'acme' } }, ENV);

    expect((await call('/v1/partners')).status).toBe(200); // 1
    expect((await call('/v1/partners')).status).toBe(200); // 2
    const limited = await call('/v1/partners'); // 3 → over limit
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBeTruthy();
    expect(((await limited.json()) as { error: { code: string } }).error.code).toBe('RATE_LIMITED');

    // Health is exempt — liveness probes never trip the limit.
    expect((await app.request('/v1/health', { headers: { 'X-Latch-Dev-Org': 'acme' } }, ENV)).status).toBe(200);

    // A different tenant has its own budget.
    expect((await app.request('/v1/partners', { headers: { 'X-Latch-Dev-Org': 'beta' } }, ENV)).status).toBe(200);
  });

  it('does not limit when no limiter is configured (default)', async () => {
    const app = createApp(() => new InMemoryStore());
    for (let i = 0; i < 5; i++) {
      expect((await app.request('/v1/partners', { headers: { 'X-Latch-Dev-Org': 'acme' } }, ENV)).status).toBe(200);
    }
  });
});
