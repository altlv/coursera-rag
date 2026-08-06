import { describe, it, expect } from 'vitest';
import { createLlm, REQUEST_TIMEOUT_MS, MAX_ATTEMPTS } from '../../server/llm-providers.js';
import { classifyProviderError } from '../../server/provider-health.js';

/*
 * Timeout and retry behaviour, exercised against the real code path.
 *
 * A scripted transport is injected via `client`, so these tests drive the actual
 * retry loop in createLlm rather than a copy of it. Injecting the client exists
 * for exactly this reason - a test that re-implements the logic it is checking
 * proves only that the copy works.
 *
 * The point of retrying is to recover from failures that CAN succeed on a second
 * attempt. provider-health already classifies which those are, and that knowledge
 * was previously unused: a single 429 failed a request one retry would have
 * satisfied.
 *
 * The mirror-image mistake matters equally. Retrying a permanent failure - no
 * credits, revoked key - fails identically every time and only makes the user wait
 * through the backoff to reach the same error.
 */

const ENV = { OPENAI_API_KEY: 'test-key' };
const err = (status, message) => Object.assign(new Error(message), { status });

/** A chat client that replays a script: Errors are thrown, anything else returned. */
function scriptedClient(script) {
  const calls = [];
  return {
    calls,
    chat: {
      completions: {
        async create(body, options) {
          calls.push({ body, options });
          const next = script[calls.length - 1];
          if (next instanceof Error) throw next;
          return next ?? { choices: [{ message: { content: 'ok' } }], usage: { total_tokens: 7 } };
        },
      },
    },
  };
}

const build = (script, overrides = {}) => {
  const client = scriptedClient(script);
  const llm = createLlm({ env: ENV, client, sleep: async () => {}, ...overrides });
  return { llm, client };
};

describe('timeout', () => {
  it('is bounded by default rather than waiting forever', () => {
    // Without a deadline a hung provider holds the request open indefinitely;
    // nothing upstream would cut it off.
    expect(REQUEST_TIMEOUT_MS).toBeGreaterThan(0);
    expect(REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
  });

  it('is passed to the transport on every call', async () => {
    const { llm, client } = build([]);
    await llm.complete({ system: 's', user: 'u' });

    expect(client.calls[0].options).toMatchObject({ timeout: REQUEST_TIMEOUT_MS });
  });

  it('honours an overridden timeout', async () => {
    const { llm, client } = build([], { timeoutMs: 1234 });
    await llm.complete({ system: 's', user: 'u' });
    expect(client.calls[0].options.timeout).toBe(1234);
  });
});

describe('retry', () => {
  it('retries a transient failure and succeeds', async () => {
    const { llm, client } = build([
      err(429, 'Too Many Requests'),
      { choices: [{ message: { content: 'recovered' } }], usage: {} },
    ]);

    await expect(llm.complete({ system: 's', user: 'u' })).resolves.toBe('recovered');
    expect(client.calls).toHaveLength(2);
    expect(llm.lastAttempts).toBe(2);
  });

  it('does NOT retry a permanent failure', async () => {
    // The decisive case: one attempt, not three. Retrying reaches the same
    // conclusion while making the user wait through the backoff.
    const { llm, client } = build([err(403, "doesn't have any credits or licenses yet")]);

    await expect(llm.complete({ system: 's', user: 'u' })).rejects.toThrow(/credits/);
    expect(client.calls).toHaveLength(1);
  });

  it('does not retry a bad key either', async () => {
    const { llm, client } = build([err(401, 'Incorrect API key provided')]);
    await expect(llm.complete({ system: 's', user: 'u' })).rejects.toThrow();
    expect(client.calls).toHaveLength(1);
  });

  it('gives up after MAX_ATTEMPTS on a persistent transient failure', async () => {
    const { llm, client } = build([
      err(503, 'Service Unavailable'),
      err(503, 'Service Unavailable'),
      err(503, 'Service Unavailable'),
      err(503, 'Service Unavailable'),
    ]);

    await expect(llm.complete({ system: 's', user: 'u' })).rejects.toThrow(/Unavailable/);
    expect(client.calls).toHaveLength(MAX_ATTEMPTS);
  });

  it('backs off between attempts, with increasing delay', async () => {
    const delays = [];
    const client = scriptedClient([
      err(429, 'rate limit'),
      err(429, 'rate limit'),
      { choices: [{ message: { content: 'ok' } }], usage: {} },
    ]);
    const llm = createLlm({
      env: ENV,
      client,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });

    await llm.complete({ system: 's', user: 'u' });

    expect(delays).toHaveLength(2);
    expect(delays[1]).toBeGreaterThan(delays[0]);
  });

  it('treats a timeout as transient, so it is retried', async () => {
    expect(classifyProviderError(err(undefined, 'Request timeout')).permanent).toBe(false);

    const { llm, client } = build([
      err(undefined, 'Request timeout'),
      { choices: [{ message: { content: 'second try' } }], usage: {} },
    ]);
    await expect(llm.complete({ system: 's', user: 'u' })).resolves.toBe('second try');
    expect(client.calls).toHaveLength(2);
  });

  it('records usage from the successful attempt', async () => {
    const { llm } = build([err(429, 'rate limit'), { choices: [{ message: { content: 'x' } }], usage: { total_tokens: 42 } }]);
    await llm.complete({ system: 's', user: 'u' });
    expect(llm.lastUsage).toEqual({ total_tokens: 42 });
  });

  it('sends the same messages on every attempt', async () => {
    const { llm, client } = build([err(429, 'rate limit'), undefined]);
    await llm.complete({ system: 'sys', user: 'usr' });

    expect(client.calls[0].body.messages).toEqual(client.calls[1].body.messages);
    expect(client.calls[0].body.messages[0]).toMatchObject({ role: 'system', content: 'sys' });
  });
});
