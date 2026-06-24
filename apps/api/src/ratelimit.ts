// Per-tenant rate limiting (PG-1, M5.2 hardening). The limiter is INJECTED into createApp
// (like the store and the LLM client), so the policy is verifiable with a deterministic
// in-memory limiter in tests and runs on KV in production — no real infra needed to prove it.
//
// Fixed-window counting: simple, predictable, and cheap. KV is eventually consistent, so the
// KV limiter is a SOFT limit (ample for abuse protection); a Durable Object gives hard
// per-tenant limits if/when a connection needs them (documented follow-up, ties to 2.3).

export interface RateDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the current window resets (for the Retry-After / reset header). */
  resetSec: number;
}

export interface RateLimiter {
  /** Count one request against `key` in its fixed window and decide allow/deny. */
  hit(key: string, limit: number, windowSec: number): Promise<RateDecision>;
}

/** Deterministic fixed-window limiter for tests/dev (and `wrangler dev` without KV). */
export class InMemoryRateLimiter implements RateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();
  constructor(private readonly now: () => number = () => Date.now()) {}

  async hit(key: string, limit: number, windowSec: number): Promise<RateDecision> {
    const nowMs = this.now();
    const w = this.windows.get(key);
    if (!w || nowMs >= w.resetAt) {
      this.windows.set(key, { count: 1, resetAt: nowMs + windowSec * 1000 });
      return { allowed: true, limit, remaining: limit - 1, resetSec: windowSec };
    }
    w.count += 1;
    return {
      allowed: w.count <= limit,
      limit,
      remaining: Math.max(0, limit - w.count),
      resetSec: Math.max(1, Math.ceil((w.resetAt - nowMs) / 1000)),
    };
  }
}

/**
 * KV-backed fixed window for production. The window bucket is encoded in the key and the
 * value TTL'd to the window length, so old buckets expire themselves. Eventually consistent
 * → a soft limit. Best-effort: a KV hiccup fails open (allow) rather than blocking traffic.
 */
export class KvRateLimiter implements RateLimiter {
  constructor(
    private readonly kv: KVNamespace,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async hit(key: string, limit: number, windowSec: number): Promise<RateDecision> {
    const nowSec = Math.floor(this.now() / 1000);
    const bucket = Math.floor(nowSec / windowSec);
    const k = `rl:${key}:${bucket}`;
    const resetSec = windowSec - (nowSec % windowSec);
    try {
      const current = Number((await this.kv.get(k)) ?? '0') + 1;
      // KV requires expirationTtl >= 60s; clamp so a short window never throws (→ fail-open).
      await this.kv.put(k, String(current), { expirationTtl: Math.max(60, windowSec) });
      return { allowed: current <= limit, limit, remaining: Math.max(0, limit - current), resetSec };
    } catch {
      // Fail open — a rate-limiter outage must not take down the API.
      return { allowed: true, limit, remaining: limit, resetSec };
    }
  }
}

/** Default policy: requests per tenant per window. Generous enough for the hero flow's
 *  burst of onboarding calls, tight enough to blunt abuse. */
export const RATE_LIMIT_DEFAULT = 300;
export const RATE_WINDOW_SEC_DEFAULT = 60;
