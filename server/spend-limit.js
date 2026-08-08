/*
 * A daily spend ceiling.
 *
 * Rate limiting bounds how FAST the balance can be spent; it does not bound the
 * total. Twenty questions a minute all day is still a large bill, so the ceiling is
 * a separate control and it is the one that actually caps exposure.
 *
 * Tokens are the ledger, dollars are a view
 * -----------------------------------------
 * Token counts come back from the provider and are exact. Prices are external, drift
 * without notice, and differ per provider. So usage is recorded in TOKENS and
 * converted for the ceiling and the display - which means a wrong price here can be
 * corrected after the fact from data that is still right.
 *
 * An unknown model is priced at the most expensive known rate
 * ----------------------------------------------------------
 * The decisive decision. Pricing an unrecognised model at zero would mean that
 * adding a provider silently switches the ceiling off, which is the worst possible
 * failure for a spend guard: it fails open, quietly, exactly when something changed.
 * Being conservative costs a little headroom. Failing open costs money.
 *
 * Local models are the one exception, priced at zero, because they run on your own
 * hardware and charging for them would fire the ceiling on usage that costs nothing.
 */

/*
 * Approximate, USD per million tokens, correct to the best of my knowledge when
 * written and guaranteed to go stale. Deliberately a small table: it exists to make
 * the ceiling roughly right, not to be a billing system. Check your provider's
 * pricing page before trusting a number here.
 */
const PRICES_USD_PER_MTOK = {
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'text-embedding-3-small': { input: 0.02, output: 0 },
  'gemini-2.0-flash': { input: 0.1, output: 0.4 },
  'gemini-1.5-flash': { input: 0.075, output: 0.3 },
  'llama-3.3-70b-versatile': { input: 0.59, output: 0.79 },
  'meta-llama/llama-3.3-70b-instruct': { input: 0.12, output: 0.3 },
  'grok-2': { input: 2, output: 10 },
};

/** Models that run on your own hardware and cost nothing per token. */
const FREE_MODEL_PATTERN = /^(ollama|lmstudio|local)[/:]|^llama[\d.]*$/i;

const WORST_INPUT = Math.max(...Object.values(PRICES_USD_PER_MTOK).map((p) => p.input));
const WORST_OUTPUT = Math.max(...Object.values(PRICES_USD_PER_MTOK).map((p) => p.output));

function estimateCost(model, usage) {
  const input = Number(usage?.prompt_tokens) || 0;
  const output = Number(usage?.completion_tokens) || 0;
  if (input === 0 && output === 0) return 0;
  if (FREE_MODEL_PATTERN.test(model || '')) return 0;

  const price = PRICES_USD_PER_MTOK[model] ?? { input: WORST_INPUT, output: WORST_OUTPUT };
  return (input / 1e6) * price.input + (output / 1e6) * price.output;
}

/** UTC day key. UTC rather than local time so the reset point is unambiguous. */
function dayKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * `load` and `save` are injected so the ledger can be persisted without this module
 * knowing about the filesystem - and so the tests need no temp directories.
 *
 * `dailyUsd` of 0 disables the ceiling.
 */
function createSpendLimiter({ dailyUsd = 0, now = Date.now, load = () => null, save = () => {} } = {}) {
  const enabled = dailyUsd > 0;

  let state = { day: dayKey(now()), usd: 0, inputTokens: 0, outputTokens: 0 };

  /*
   * A ledger that cannot be read must not stop the server. In-memory accounting
   * still applies for this process, so the ceiling degrades to per-process rather
   * than disappearing - the same rule the question log follows.
   */
  try {
    const stored = load();
    // A ledger from a previous day is not an error, it is simply spent.
    if (stored && stored.day === state.day) {
      state = {
        day: stored.day,
        usd: Number(stored.usd) || 0,
        inputTokens: Number(stored.inputTokens) || 0,
        outputTokens: Number(stored.outputTokens) || 0,
      };
    }
  } catch {
    /* unreadable ledger - start this process's accounting from zero */
  }

  function rollOver() {
    const today = dayKey(now());
    if (state.day !== today) state = { day: today, usd: 0, inputTokens: 0, outputTokens: 0 };
  }

  return {
    /**
     * Called BEFORE generation. Enforcing on the way in matters: checking
     * afterwards means the request that breaches the ceiling has already been paid
     * for, and with a large enough question that overshoot is the whole budget.
     */
    check() {
      rollOver();
      return {
        enabled,
        allowed: !enabled || state.usd < dailyUsd,
        limitUsd: dailyUsd,
        spentUsd: state.usd,
        remainingUsd: enabled ? Math.max(0, dailyUsd - state.usd) : Infinity,
        inputTokens: state.inputTokens,
        outputTokens: state.outputTokens,
        day: state.day,
      };
    },

    /** Called after a completed call, with whatever usage the provider reported. */
    record(model, usage) {
      rollOver();
      state.usd += estimateCost(model, usage);
      state.inputTokens += Number(usage?.prompt_tokens) || 0;
      state.outputTokens += Number(usage?.completion_tokens) || 0;
      try {
        // Written every time, so a crash loses at most one request's worth.
        save({ ...state });
      } catch {
        /* a full disk must not break the request that just succeeded */
      }
    },
  };
}

module.exports = {
  PRICES_USD_PER_MTOK,
  FREE_MODEL_PATTERN,
  estimateCost,
  dayKey,
  createSpendLimiter,
};
