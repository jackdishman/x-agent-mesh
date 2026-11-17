// In-memory token buckets. One process only: limits reset on restart and are not shared between
// instances (see README "What's stubbed").
import type { BucketConfig } from "./config.js";

export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private cfg: BucketConfig,
    private now: () => number = Date.now,
    private maxKeys = 50_000,
  ) {}

  /** Takes one token for `key`. Returns 0 when allowed, otherwise the seconds to wait (>= 1). */
  take(key: string): number {
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= this.maxKeys) this.sweep(t);
      b = { tokens: this.cfg.capacity, at: t };
      this.buckets.set(key, b);
    } else {
      b.tokens = Math.min(this.cfg.capacity, b.tokens + ((t - b.at) / 1000) * this.cfg.refillPerSec);
      b.at = t;
    }
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return 0;
    }
    return Math.max(1, Math.ceil((1 - b.tokens) / this.cfg.refillPerSec));
  }

  /** Drops buckets that have refilled; if every bucket is still in use, drops the oldest so the map stays bounded. */
  private sweep(t: number) {
    for (const [k, b] of this.buckets) {
      if (b.tokens + ((t - b.at) / 1000) * this.cfg.refillPerSec >= this.cfg.capacity) this.buckets.delete(k);
    }
    if (this.buckets.size >= this.maxKeys) {
      const drop = Math.ceil(this.maxKeys / 10);
      let i = 0;
      for (const k of this.buckets.keys()) {
        if (i++ >= drop) break;
        this.buckets.delete(k);
      }
    }
  }
}
