/*
 * Provider health: which providers are actually usable right now.
 *
 * Having a key is not the same as being able to use it. Observed in this project:
 *
 *   xAI    403 "Your newly created team doesn't have any credits or licenses yet"
 *   Gemini 429 rate limited on a brand-new free-tier key
 *
 * Both have valid keys. One is unusable until credits are bought; the other will
 * work again shortly. Offering either as a working choice would be misleading, but
 * treating them the SAME would be wrong too - so failures are classified, and only
 * permanent ones remove a provider from the list.
 *
 * The distinction that matters:
 *
 *   permanent  - will not fix itself. Bad key, no credits, unknown model.
 *                Stop offering the provider until configuration changes.
 *   transient  - expected to recover. Rate limits, server errors, timeouts.
 *                Keep offering it, but mark it degraded and re-check later.
 *
 * Getting this backwards is what produces both classic failure modes: a provider
 * permanently hidden because it was briefly rate-limited, or one repeatedly
 * offered when it can never work.
 */

/** How long a transient failure keeps a provider marked degraded. */
const TRANSIENT_TTL_MS = 60_000;

/**
 * Classify a provider error.
 *
 * Matches on HTTP status first, since that is structured, and falls back to
 * message text only where the status is ambiguous - 403 covers both "no credits"
 * and generic permission problems, and the distinction is worth surfacing to the
 * user because the fixes differ.
 */
function classifyProviderError(error) {
  const status = error?.status ?? error?.response?.status ?? null;
  const raw = `${error?.message || ''} ${JSON.stringify(error?.error || '')}`.toLowerCase();

  if (status === 401 || /invalid api key|unauthorized|invalid_api_key/.test(raw)) {
    return {
      kind: 'auth',
      permanent: true,
      hint: 'The API key is missing, wrong, or revoked.',
    };
  }

  if (status === 402 || /insufficient|no credits|quota exceeded|billing|licenses yet/.test(raw)) {
    return {
      kind: 'credits',
      permanent: true,
      hint: 'The account has no credits or an inactive plan.',
    };
  }

  if (status === 403) {
    // 403 is ambiguous: credit exhaustion and permission denial both use it.
    const credits = /credit|licens|billing|quota/.test(raw);
    return {
      kind: credits ? 'credits' : 'forbidden',
      permanent: true,
      hint: credits
        ? 'The account has no credits or licenses yet.'
        : 'The key exists but is not permitted to use this endpoint or model.',
    };
  }

  if (status === 404 || /model.*(not found|does not exist)|unknown model/.test(raw)) {
    return {
      kind: 'model',
      permanent: true,
      hint: 'The configured model name does not exist. Run npm run list-models.',
    };
  }

  if (status === 429 || /rate limit|too many requests|resource_exhausted/.test(raw)) {
    return {
      kind: 'rate-limit',
      permanent: false,
      hint: 'Rate limited or over the current quota window. Should recover.',
    };
  }

  if (status >= 500 || /timeout|econnrefused|enotfound|socket hang up/.test(raw)) {
    return {
      kind: 'server',
      permanent: false,
      hint: 'The provider is unreachable or erroring. Should recover.',
    };
  }

  return { kind: 'unknown', permanent: false, hint: error?.message || 'Unknown provider error.' };
}

/**
 * Tracks per-provider health.
 *
 * Deliberately in-memory: this is a liveness cache, not a record. Restarting
 * should re-probe rather than inherit a stale verdict from an earlier session.
 */
function createHealthTracker({ now = () => Date.now() } = {}) {
  const state = new Map();

  function markOk(provider) {
    state.set(provider, { status: 'ok', checkedAt: now() });
  }

  function markFailed(provider, error) {
    const classified = classifyProviderError(error);
    state.set(provider, {
      status: classified.permanent ? 'unavailable' : 'degraded',
      kind: classified.kind,
      permanent: classified.permanent,
      hint: classified.hint,
      message: error?.message,
      checkedAt: now(),
    });
    return classified;
  }

  /** Current verdict, expiring transient failures so they get another chance. */
  function get(provider) {
    const entry = state.get(provider);
    if (!entry) return { status: 'unknown' };

    if (entry.status === 'degraded' && now() - entry.checkedAt > TRANSIENT_TTL_MS) {
      state.delete(provider);
      return { status: 'unknown' };
    }

    return entry;
  }

  /**
   * Should this provider be offered to the user?
   *
   * Unknown counts as offerable: an unprobed provider is not a broken one, and
   * refusing to offer it would make a first run look empty.
   */
  function isOfferable(provider) {
    return get(provider).status !== 'unavailable';
  }

  function snapshot(providers) {
    return providers.map((name) => ({ name, ...get(name) }));
  }

  return { markOk, markFailed, get, isOfferable, snapshot, classifyProviderError };
}

module.exports = { classifyProviderError, createHealthTracker, TRANSIENT_TTL_MS };
