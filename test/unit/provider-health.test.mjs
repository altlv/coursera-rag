import { describe, it, expect } from 'vitest';
import {
  classifyProviderError,
  createHealthTracker,
  TRANSIENT_TTL_MS,
} from '../../server/provider-health.js';

/*
 * The errors below are real, taken from this project's own runs:
 *
 *   xAI    403 "Your newly created team doesn't have any credits or licenses yet"
 *   Gemini 429 on a brand-new free-tier key
 *
 * Both providers had valid keys. One cannot work until credits are purchased; the
 * other recovers on its own. Classifying them identically would either hide a
 * working provider forever or keep offering one that can never answer.
 */

const err = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });

describe('classifyProviderError', () => {
  it('treats a bad key as permanent', () => {
    const c = classifyProviderError(err(401, 'Incorrect API key provided'));
    expect(c.kind).toBe('auth');
    expect(c.permanent).toBe(true);
  });

  it('recognises the real xAI no-credits 403 as permanent', () => {
    const c = classifyProviderError(
      err(403, "Your newly created team doesn't have any credits or licenses yet"),
    );
    expect(c.kind).toBe('credits');
    expect(c.permanent).toBe(true);
    expect(c.hint).toMatch(/credits/i);
  });

  it('separates a plain permission 403 from a credits 403', () => {
    // Same status code, different cause, different fix - so different kind.
    const c = classifyProviderError(err(403, 'The caller does not have permission'));
    expect(c.kind).toBe('forbidden');
    expect(c.permanent).toBe(true);
  });

  it('treats a 429 as TRANSIENT, not as a broken provider', () => {
    // The decisive one. Gemini returned this on a valid new key; marking it
    // permanent would have hidden a working provider indefinitely.
    const c = classifyProviderError(err(429, 'Too Many Requests'));
    expect(c.kind).toBe('rate-limit');
    expect(c.permanent).toBe(false);
  });

  it('treats an unknown model as permanent and points at the fix', () => {
    const c = classifyProviderError(err(404, 'The model `gpt-9` does not exist'));
    expect(c.kind).toBe('model');
    expect(c.permanent).toBe(true);
    expect(c.hint).toMatch(/list-models/);
  });

  it('treats server errors and network failures as transient', () => {
    expect(classifyProviderError(err(503, 'Service Unavailable')).permanent).toBe(false);
    expect(classifyProviderError(err(undefined, 'ECONNREFUSED')).permanent).toBe(false);
  });

  it('defaults unknown failures to transient rather than hiding a provider', () => {
    // Fail open: a misclassified transient error is recoverable, whereas wrongly
    // marking something permanent removes it until a restart.
    const c = classifyProviderError(err(undefined, 'something odd happened'));
    expect(c.permanent).toBe(false);
  });

  it('reads status from a nested response object too', () => {
    expect(classifyProviderError({ response: { status: 401 }, message: '' }).kind).toBe('auth');
  });
});

describe('createHealthTracker', () => {
  it('starts with everything unknown, and unknown is offerable', () => {
    const health = createHealthTracker();
    expect(health.get('openai').status).toBe('unknown');
    // An unprobed provider is not a broken one; hiding it would make a first run
    // look as though nothing were configured.
    expect(health.isOfferable('openai')).toBe(true);
  });

  it('marks a permanent failure unavailable and stops offering it', () => {
    const health = createHealthTracker();
    health.markFailed('xai', err(403, "doesn't have any credits or licenses yet"));

    expect(health.get('xai').status).toBe('unavailable');
    expect(health.isOfferable('xai')).toBe(false);
  });

  it('marks a transient failure degraded but keeps offering it', () => {
    const health = createHealthTracker();
    health.markFailed('gemini', err(429, 'Too Many Requests'));

    expect(health.get('gemini').status).toBe('degraded');
    expect(health.isOfferable('gemini')).toBe(true);
  });

  it('lets a degraded provider recover once the TTL passes', () => {
    let clock = 1000;
    const health = createHealthTracker({ now: () => clock });

    health.markFailed('gemini', err(429, 'rate limit'));
    expect(health.get('gemini').status).toBe('degraded');

    clock += TRANSIENT_TTL_MS + 1;
    expect(health.get('gemini').status).toBe('unknown');
  });

  it('does NOT let a permanent failure expire', () => {
    let clock = 1000;
    const health = createHealthTracker({ now: () => clock });

    health.markFailed('xai', err(403, 'no credits'));
    clock += TRANSIENT_TTL_MS * 100;

    // No amount of waiting buys credits.
    expect(health.get('xai').status).toBe('unavailable');
    expect(health.isOfferable('xai')).toBe(false);
  });

  it('a success clears an earlier failure', () => {
    const health = createHealthTracker();
    health.markFailed('openai', err(429, 'rate limit'));
    health.markOk('openai');

    expect(health.get('openai').status).toBe('ok');
    expect(health.isOfferable('openai')).toBe(true);
  });

  it('reports a snapshot for the whole set', () => {
    const health = createHealthTracker();
    health.markOk('openai');
    health.markFailed('xai', err(403, 'no credits'));
    health.markFailed('gemini', err(429, 'rate limit'));

    const snapshot = health.snapshot(['openai', 'gemini', 'xai', 'openrouter']);
    expect(snapshot.map((s) => s.status)).toEqual(['ok', 'degraded', 'unavailable', 'unknown']);
  });

  it('carries a human-readable hint for the UI', () => {
    const health = createHealthTracker();
    health.markFailed('xai', err(403, "doesn't have any credits or licenses yet"));
    expect(health.get('xai').hint).toMatch(/credits/i);
  });
});
