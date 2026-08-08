/*
 * Rate limiting for /api/chat.
 *
 * Until this existed, anyone who could reach the endpoint could spend the account's
 * balance in a loop. On localhost that is theoretical - it is the thing standing
 * between this and being safe to expose, which is why it lands alongside the spend
 * ceiling rather than after it.
 *
 * A TOKEN BUCKET rather than a fixed window. A fixed window lets a caller fire the
 * whole allowance at 59.9s and again at 60.1s: twice the intended rate, at exactly
 * the moment someone is hammering it. A bucket refills continuously, so the average
 * rate is what you configured while a short burst is still allowed - which matters
 * because a person asking three questions quickly is normal use, not abuse.
 *
 * The clock is injected so the tests need no sleeps. A time-based test built on
 * real delays is slow and flaky, and flaky tests get deleted.
 */

const DEFAULT_PER_MINUTE = 20;
const DEFAULT_BURST = 5;

/**
 * Drop a caller's bucket once it has been full long enough to carry no
 * information. One entry per address is a slow memory leak on a public endpoint,
 * and a full bucket is indistinguishable from a caller that has never been seen.
 */
const IDLE_SWEEP_MS = 5 * 60_000;

function createRateLimiter({
  enabled = true,
  perMinute = DEFAULT_PER_MINUTE,
  burst = DEFAULT_BURST,
  now = Date.now,
} = {}) {
  const buckets = new Map();
  const refillPerMs = perMinute / 60_000;
  /** Time for an empty bucket to refill completely - the point after which it is stale. */
  const fullRefillMs = burst / refillPerMs;
  let lastSweep = now();

  function sweep(current) {
    if (current - lastSweep < IDLE_SWEEP_MS) return;
    lastSweep = current;
    for (const [key, bucket] of buckets) {
      if (current - bucket.updated > fullRefillMs) buckets.delete(key);
    }
  }

  return {
    check(rawKey) {
      if (!enabled) return { allowed: true, remaining: Infinity, retryAfterMs: 0 };

      /*
       * A caller we cannot identify is treated as ONE shared anonymous bucket, not
       * as exempt. Failing open here would make the limiter bypassable by whatever
       * made the address unavailable in the first place.
       */
      const key = rawKey ?? '@anonymous';
      const current = now();
      sweep(current);

      const bucket = buckets.get(key) ?? { tokens: burst, updated: current };

      // Refill for elapsed time, never above the burst size - otherwise an idle
      // caller accumulates an unbounded allowance.
      const refilled = Math.min(burst, bucket.tokens + (current - bucket.updated) * refillPerMs);

      if (refilled < 1) {
        buckets.set(key, { tokens: refilled, updated: current });
        return {
          allowed: false,
          remaining: 0,
          retryAfterMs: Math.ceil((1 - refilled) / refillPerMs),
        };
      }

      buckets.set(key, { tokens: refilled - 1, updated: current });
      return { allowed: true, remaining: Math.floor(refilled - 1), retryAfterMs: 0 };
    },

    /** Exposed for the memory test, and useful in a health endpoint. */
    size() {
      return buckets.size;
    },
  };
}

module.exports = { createRateLimiter, DEFAULT_PER_MINUTE, DEFAULT_BURST };
