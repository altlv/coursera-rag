import { describe, it, expect } from 'vitest';
import { createRateLimiter } from '../../server/rate-limit.js';

/*
 * Rate limiting on /api/chat.
 *
 * Until now anyone who could reach the endpoint could spend the account's balance
 * in a loop. On localhost that is theoretical; it is the single thing standing
 * between this and being safe to expose.
 *
 * A token bucket rather than a fixed window, because a fixed window lets a caller
 * fire the whole allowance at 59.9s and again at 60.1s - twice the intended rate at
 * the boundary. A bucket refills continuously, so the average rate is what you
 * configured and a short burst is still allowed.
 *
 * The clock is injected. Testing a time-based limiter with real sleeps makes the
 * suite slow and flaky, and it is the kind of test that gets deleted.
 */

const at = (t) => () => t;

describe('createRateLimiter', () => {
  it('allows requests up to the burst size', () => {
    const limiter = createRateLimiter({ perMinute: 60, burst: 3, now: at(0) });
    for (let i = 0; i < 3; i++) {
      expect(limiter.check('a').allowed, `request ${i + 1}`).toBe(true);
    }
  });

  it('blocks the request after the burst is spent', () => {
    const limiter = createRateLimiter({ perMinute: 60, burst: 3, now: at(0) });
    for (let i = 0; i < 3; i++) limiter.check('a');
    const result = limiter.check('a');
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it('refills over time rather than resetting on a boundary', () => {
    // A fixed window would allow the whole allowance again at the tick. A bucket
    // hands back one slot per interval, which is what keeps the AVERAGE rate right.
    let clock = 0;
    const limiter = createRateLimiter({ perMinute: 60, burst: 2, now: () => clock });
    limiter.check('a');
    limiter.check('a');
    expect(limiter.check('a').allowed).toBe(false);

    clock = 1000; // 60/minute means one token per second
    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('a').allowed).toBe(false);
  });

  it('never refills beyond the burst size', () => {
    // Otherwise an idle client accumulates an unbounded allowance and the limit
    // becomes meaningless the first time someone comes back after lunch.
    let clock = 0;
    const limiter = createRateLimiter({ perMinute: 60, burst: 2, now: () => clock });
    clock = 3_600_000;
    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('a').allowed).toBe(false);
  });

  it('keeps separate buckets per caller', () => {
    const limiter = createRateLimiter({ perMinute: 60, burst: 1, now: at(0) });
    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('a').allowed).toBe(false);
    expect(limiter.check('b').allowed).toBe(true);
  });

  it('treats a missing caller key as one shared bucket rather than skipping the limit', () => {
    /*
     * If the address cannot be determined, the safe reading is "one anonymous
     * caller", not "unlimited". Failing open here would make the limiter trivially
     * bypassable by whatever made the key unavailable.
     */
    const limiter = createRateLimiter({ perMinute: 60, burst: 1, now: at(0) });
    expect(limiter.check(undefined).allowed).toBe(true);
    expect(limiter.check(null).allowed).toBe(false);
  });

  it('reports how long to wait, so the caller can be told', () => {
    const limiter = createRateLimiter({ perMinute: 60, burst: 1, now: at(0) });
    limiter.check('a');
    const { retryAfterMs } = limiter.check('a');
    expect(retryAfterMs).toBeGreaterThan(0);
    expect(retryAfterMs).toBeLessThanOrEqual(1000);
  });

  it('can be disabled entirely', () => {
    // Local development should not have to think about it.
    const limiter = createRateLimiter({ enabled: false, perMinute: 1, burst: 1, now: at(0) });
    for (let i = 0; i < 50; i++) expect(limiter.check('a').allowed).toBe(true);
  });

  it('forgets idle callers so memory cannot grow without bound', () => {
    /*
     * One entry per address is a slow leak on a public endpoint. A bucket that has
     * been full for longer than it takes to refill carries no information, so it
     * can be dropped without changing behaviour.
     */
    let clock = 0;
    const limiter = createRateLimiter({ perMinute: 60, burst: 2, now: () => clock });
    for (let i = 0; i < 100; i++) limiter.check(`caller-${i}`);
    expect(limiter.size()).toBe(100);

    clock = 600_000;
    limiter.check('someone-new');
    expect(limiter.size()).toBeLessThan(10);
  });
});
