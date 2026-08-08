import { describe, it, expect } from 'vitest';
import {
  PRICES_USD_PER_MTOK,
  estimateCost,
  createSpendLimiter,
} from '../../server/spend-limit.js';

/*
 * The spend ceiling.
 *
 * Rate limiting bounds how FAST the balance can be spent. It does not bound the
 * total: twenty questions a minute all day is still a large bill. So the ceiling is
 * a separate control, and it is the one that actually caps exposure.
 *
 * Two design decisions worth arguing with:
 *
 * 1. TOKENS are the ledger, dollars are a view. Token counts come back from the
 *    provider and are exact; prices are external, drift without warning, and vary
 *    per provider. So usage is recorded in tokens and converted for display and for
 *    the ceiling, with the price table explicitly marked as an estimate.
 *
 * 2. An unknown model is priced at the MOST EXPENSIVE known rate, not at zero.
 *    Pricing something unknown at zero means adding a provider silently disables
 *    the ceiling, which is the worst possible failure for a spend guard. Being
 *    conservative costs a little headroom; failing open costs money.
 */

const at = (t) => () => t;
const usage = (input, output) => ({ prompt_tokens: input, completion_tokens: output });

describe('estimateCost', () => {
  it('prices a known model from the table', () => {
    const price = PRICES_USD_PER_MTOK['gpt-4o-mini'];
    const cost = estimateCost('gpt-4o-mini', usage(1_000_000, 0));
    expect(cost).toBeCloseTo(price.input, 6);
  });

  it('charges input and output at their different rates', () => {
    // Output is several times the price of input on every provider, so a single
    // blended rate would understate a chatty model badly.
    const price = PRICES_USD_PER_MTOK['gpt-4o-mini'];
    expect(price.output).toBeGreaterThan(price.input);
    const cost = estimateCost('gpt-4o-mini', usage(1_000_000, 1_000_000));
    expect(cost).toBeCloseTo(price.input + price.output, 6);
  });

  it('prices an unknown model at the most expensive known rate', () => {
    /*
     * The decisive case. Pricing an unrecognised model at zero would mean adding a
     * provider silently switches the ceiling off.
     */
    const worst = Math.max(...Object.values(PRICES_USD_PER_MTOK).map((p) => p.output));
    const cost = estimateCost('some-brand-new-model', usage(0, 1_000_000));
    expect(cost).toBeCloseTo(worst, 6);
  });

  it('treats a free local model as free', () => {
    // Ollama and LM Studio run on your own hardware; charging for them would make
    // the ceiling fire on usage that costs nothing.
    expect(estimateCost('ollama/llama3.1', usage(1_000_000, 1_000_000))).toBe(0);
  });

  it('returns zero rather than NaN when usage is missing', () => {
    // Some providers omit usage. A NaN would poison the running total silently.
    expect(estimateCost('gpt-4o-mini', undefined)).toBe(0);
    expect(estimateCost('gpt-4o-mini', {})).toBe(0);
  });
});

describe('createSpendLimiter', () => {
  const opts = (over = {}) => ({ dailyUsd: 1, now: at(0), load: () => null, save: () => {}, ...over });

  it('allows spending under the ceiling', () => {
    const limiter = createSpendLimiter(opts());
    expect(limiter.check().allowed).toBe(true);
  });

  it('blocks once the ceiling is reached', () => {
    const limiter = createSpendLimiter(opts({ dailyUsd: 0.001 }));
    limiter.record('gpt-4o-mini', usage(1_000_000, 1_000_000));
    const result = limiter.check();
    expect(result.allowed).toBe(false);
    expect(result.spentUsd).toBeGreaterThan(0.001);
  });

  it('checks BEFORE the call, not after', () => {
    /*
     * The ceiling has to be enforced on the way in. Checking afterwards means the
     * request that breaches it has already been paid for, and with a large enough
     * question that overshoot is the whole budget.
     */
    const limiter = createSpendLimiter(opts({ dailyUsd: 0.001 }));
    expect(limiter.check().allowed).toBe(true);
    limiter.record('gpt-4o-mini', usage(1_000_000, 1_000_000));
    expect(limiter.check().allowed).toBe(false);
  });

  it('resets when the day rolls over', () => {
    let clock = Date.parse('2026-08-08T23:00:00Z');
    const limiter = createSpendLimiter(opts({ dailyUsd: 0.001, now: () => clock }));
    limiter.record('gpt-4o-mini', usage(1_000_000, 1_000_000));
    expect(limiter.check().allowed).toBe(false);

    clock = Date.parse('2026-08-09T01:00:00Z');
    expect(limiter.check().allowed).toBe(true);
    expect(limiter.check().spentUsd).toBe(0);
  });

  it('survives a restart by reloading the ledger', () => {
    /*
     * Without persistence the ceiling is bypassable by restarting the server, and
     * a crash loop would reset it continuously.
     */
    const saved = { day: '2026-08-08', usd: 5, inputTokens: 10, outputTokens: 20 };
    const limiter = createSpendLimiter(
      opts({ dailyUsd: 1, now: at(Date.parse('2026-08-08T12:00:00Z')), load: () => saved }),
    );
    expect(limiter.check().allowed).toBe(false);
    expect(limiter.check().spentUsd).toBe(5);
  });

  it('ignores a ledger from a previous day', () => {
    const stale = { day: '2026-08-01', usd: 99 };
    const limiter = createSpendLimiter(
      opts({ dailyUsd: 1, now: at(Date.parse('2026-08-08T12:00:00Z')), load: () => stale }),
    );
    expect(limiter.check().allowed).toBe(true);
  });

  it('persists after recording, so a crash loses at most one request', () => {
    const writes = [];
    const limiter = createSpendLimiter(opts({ save: (state) => writes.push(state) }));
    limiter.record('gpt-4o-mini', usage(1000, 500));
    expect(writes).toHaveLength(1);
    expect(writes[0].usd).toBeGreaterThan(0);
  });

  it('keeps working when the ledger cannot be read or written', () => {
    /*
     * Persistence failing must not break the chatbot - the same rule as the
     * question log. In-memory accounting still applies for this process, so the
     * ceiling degrades rather than disappearing.
     */
    const limiter = createSpendLimiter(
      opts({
        dailyUsd: 0.001,
        load: () => {
          throw new Error('disk on fire');
        },
        save: () => {
          throw new Error('still on fire');
        },
      }),
    );
    expect(limiter.check().allowed).toBe(true);
    expect(() => limiter.record('gpt-4o-mini', usage(1_000_000, 1_000_000))).not.toThrow();
    expect(limiter.check().allowed).toBe(false);
  });

  it('can be disabled, and says so rather than reporting a huge budget', () => {
    const limiter = createSpendLimiter(opts({ dailyUsd: 0 }));
    const result = limiter.check();
    expect(result.allowed).toBe(true);
    expect(result.enabled).toBe(false);
  });

  it('reports what is left, for a status display', () => {
    const limiter = createSpendLimiter(opts({ dailyUsd: 1 }));
    limiter.record('gpt-4o-mini', usage(1_000_000, 0));
    const { spentUsd, remainingUsd, limitUsd } = limiter.check();
    expect(limitUsd).toBe(1);
    expect(remainingUsd).toBeCloseTo(1 - spentUsd, 6);
  });

  it('tracks token totals alongside the estimate', () => {
    // Tokens are the exact figure; dollars are derived. Keeping both means a
    // wrong price table can be corrected after the fact.
    const limiter = createSpendLimiter(opts());
    limiter.record('gpt-4o-mini', usage(100, 50));
    limiter.record('gpt-4o-mini', usage(200, 25));
    const { inputTokens, outputTokens } = limiter.check();
    expect(inputTokens).toBe(300);
    expect(outputTokens).toBe(75);
  });
});
