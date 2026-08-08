import {
  MAX_STORED_MESSAGES,
  STORAGE_VERSION,
  deserialise,
  serialise,
} from './conversation-storage';
import type { ChatMessage } from './chat.store';

/*
 * Conversation persistence.
 *
 * The rail already survived navigation; it did not survive a refresh, and losing
 * ten questions to an accidental F5 is how people stop trusting a tool.
 *
 * These are pure functions on purpose, so they need no browser, component or DI
 * container. The store owns the one impure part - talking to localStorage.
 *
 * The theme running through these tests is that a convenience cache must never be
 * able to break the app it is restored into. Anything not fully trusted is
 * discarded, and nothing here is allowed to throw.
 */

const user = (text: string): ChatMessage => ({ role: 'user', text });
const reply = (text: string): ChatMessage => ({ role: 'assistant', text, status: 'answered' });

describe('serialise', () => {
  it('keeps the conversation and the context break', () => {
    const stored = serialise([user('a'), reply('b')], 1, 'openai');
    expect(stored.version).toBe(STORAGE_VERSION);
    expect(stored.messages).toHaveLength(2);
    expect(stored.contextBreakAt).toBe(1);
    expect(stored.provider).toBe('openai');
  });

  it('drops error bubbles', () => {
    /*
     * An error describes something that went wrong in a PREVIOUS session - a
     * provider being down, a rate limit. Restoring it presents a stale failure as
     * though it just happened.
     */
    const messages: ChatMessage[] = [
      user('a'),
      { role: 'assistant', text: 'Provider unavailable', isError: true },
      reply('b'),
    ];
    const stored = serialise(messages, 0, null);
    expect(stored.messages).toHaveLength(2);
    expect(stored.messages.some((m) => m.isError)).toBe(false);
  });

  it('caps the transcript, keeping the most recent messages', () => {
    // localStorage is a few megabytes and each assistant turn carries sources,
    // scores and confidence reasons. Unbounded growth throws on WRITE, which is
    // the worst possible moment.
    const many = Array.from({ length: MAX_STORED_MESSAGES + 20 }, (_, i) => user(`m${i}`));
    const stored = serialise(many, 0, null);
    expect(stored.messages).toHaveLength(MAX_STORED_MESSAGES);
    expect(stored.messages.at(-1)!.text).toBe(`m${MAX_STORED_MESSAGES + 19}`);
  });

  it('moves the context break with the trim', () => {
    /*
     * The break is an INDEX. Trimming from the front without adjusting it would
     * silently take context from the wrong point - a bug that would look like the
     * assistant randomly ignoring or over-reading history.
     */
    const many = Array.from({ length: MAX_STORED_MESSAGES + 10 }, (_, i) => user(`m${i}`));
    const stored = serialise(many, MAX_STORED_MESSAGES + 5, null);
    expect(stored.contextBreakAt).toBe(MAX_STORED_MESSAGES + 5 - 10);
  });

  it('clamps a break that fell off the front to zero', () => {
    const many = Array.from({ length: MAX_STORED_MESSAGES + 10 }, (_, i) => user(`m${i}`));
    const stored = serialise(many, 2, null);
    expect(stored.contextBreakAt).toBe(0);
  });

  it('never reports a break beyond the end of the transcript', () => {
    const stored = serialise([user('a')], 99, null);
    expect(stored.contextBreakAt).toBeLessThanOrEqual(stored.messages.length);
  });
});

describe('deserialise', () => {
  const roundTrip = (messages: ChatMessage[], breakAt = 0, provider: string | null = null) =>
    deserialise(JSON.stringify(serialise(messages, breakAt, provider)));

  it('restores what serialise wrote', () => {
    const restored = roundTrip([user('a'), reply('b')], 1, 'groq');
    expect(restored!.messages).toHaveLength(2);
    expect(restored!.contextBreakAt).toBe(1);
    expect(restored!.provider).toBe('groq');
  });

  it('returns null for nothing stored', () => {
    expect(deserialise(null)).toBeNull();
    expect(deserialise('')).toBeNull();
  });

  it('returns null rather than throwing on corrupt JSON', () => {
    /*
     * This runs while constructing a root service. Throwing here would take down
     * the entire app because of a bad string in localStorage - a spectacular
     * trade for a convenience feature.
     */
    expect(() => deserialise('{not json')).not.toThrow();
    expect(deserialise('{not json')).toBeNull();
    expect(deserialise('null')).toBeNull();
    expect(deserialise('[]')).toBeNull();
    expect(deserialise('42')).toBeNull();
  });

  it('discards a different schema version instead of migrating it', () => {
    // Migration code for a convenience cache costs more than it saves.
    const stored = { ...serialise([user('a')], 0, null), version: 999 };
    expect(deserialise(JSON.stringify(stored))).toBeNull();
  });

  it('discards entries that are not messages', () => {
    const stored = {
      version: STORAGE_VERSION,
      messages: [user('good'), { role: 'wizard', text: 'x' }, { role: 'user' }, null],
      contextBreakAt: 0,
      provider: null,
      savedAt: 0,
    };
    const restored = deserialise(JSON.stringify(stored));
    expect(restored!.messages).toHaveLength(1);
    expect(restored!.messages[0].text).toBe('good');
  });

  it('returns null when nothing usable survives filtering', () => {
    const stored = {
      version: STORAGE_VERSION,
      messages: [{ role: 'wizard', text: 'x' }],
      contextBreakAt: 0,
      provider: null,
      savedAt: 0,
    };
    expect(deserialise(JSON.stringify(stored))).toBeNull();
  });

  it('clamps a context break that points past the messages', () => {
    // Hand-edited or truncated storage must not produce an out-of-range slice.
    const stored = { ...serialise([user('a'), reply('b')], 0, null), contextBreakAt: 99 };
    expect(deserialise(JSON.stringify(stored))!.contextBreakAt).toBe(2);
  });

  it('treats a non-numeric context break as no break', () => {
    const stored = { ...serialise([user('a')], 0, null), contextBreakAt: 'later' };
    expect(deserialise(JSON.stringify(stored))!.contextBreakAt).toBe(0);
  });

  it('ignores a provider that is not a string', () => {
    const stored = { ...serialise([user('a')], 0, null), provider: { name: 'openai' } };
    expect(deserialise(JSON.stringify(stored))!.provider).toBeNull();
  });
});
