// In-memory token buckets. One process only: limits reset on restart and are not shared between
// instances (see README "What's stubbed").
import type { BucketConfig } from "./config.js";

/**
 * Most keys one limiter remembers. A bucket is a short key plus two numbers (roughly 150 bytes), so
 * a full limiter stays under ~2 MB: the server runs several of them on a 256 MB machine.
 */
export const DEFAULT_MAX_KEYS = 10_000;
/** Keys longer than this are cut: a key is an IP address or an id, never something a caller can grow. */
const MAX_KEY_LENGTH = 128;

export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private cfg: BucketConfig,
    private now: () => number = Date.now,
    private maxKeys = DEFAULT_MAX_KEYS,
  ) {}

  /** How many keys are remembered right now (never more than `maxKeys`). */
  get size(): number {
    return this.buckets.size;
  }

  /**
   * Takes `cost` tokens (default one) for `key`. Returns 0 when allowed, otherwise the seconds to
   * wait (>= 1). A cost above the bucket's capacity is charged as the whole bucket, so one oversized
   * request waits for a full bucket instead of being refused forever.
   */
  take(key: string, cost = 1): number {
    if (key.length > MAX_KEY_LENGTH) key = key.slice(0, MAX_KEY_LENGTH);
    const need = Math.min(Math.max(cost, 0), this.cfg.capacity);
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= this.maxKeys) this.sweep(t);
      b = { tokens: this.cfg.capacity, at: t };
      this.buckets.set(key, b);
    } else {
      // A clock that steps backwards must not take tokens away.
      b.tokens = Math.min(this.cfg.capacity, b.tokens + (Math.max(0, t - b.at) / 1000) * this.cfg.refillPerSec);
      b.at = t;
    }
    if (b.tokens >= need) {
      b.tokens -= need;
      return 0;
    }
    return Math.max(1, Math.ceil((need - b.tokens) / this.cfg.refillPerSec));
  }

  /**
   * What `take(key, cost)` would answer right now, without taking anything or remembering the key.
   * For a charge against two buckets at once: look at both, then take from both or from neither.
   */
  peek(key: string, cost = 1): number {
    if (key.length > MAX_KEY_LENGTH) key = key.slice(0, MAX_KEY_LENGTH);
    const need = Math.min(Math.max(cost, 0), this.cfg.capacity);
    const b = this.buckets.get(key);
    const tokens = b ? Math.min(this.cfg.capacity, b.tokens + (Math.max(0, this.now() - b.at) / 1000) * this.cfg.refillPerSec) : this.cfg.capacity;
    return tokens >= need ? 0 : Math.max(1, Math.ceil((need - tokens) / this.cfg.refillPerSec));
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
