import type { ChatMessage } from './chat.store';

/**
 * Saving the conversation across a page reload.
 *
 * The rail already survives navigation, because it sits outside the router outlet.
 * It did not survive a refresh, which is the more common way to lose a
 * conversation - and losing one after ten questions is the kind of thing that
 * makes people stop trusting a tool.
 *
 * Kept as pure functions rather than inside ChatStore so they can be tested
 * without a browser, a component or a DI container. The store handles the one
 * impure part: talking to localStorage.
 *
 * Why localStorage rather than the server
 * ---------------------------------------
 * The conversation stays on the machine that produced it. Sending it to the
 * server would mean storing the full text of every question and answer, which the
 * question log deliberately does NOT do - it keeps metadata precisely so the
 * largest and most sensitive field never lands on disk. Persisting locally keeps
 * that property while still surviving a refresh.
 */

/**
 * Bumped when the stored shape changes. Old data is then discarded rather than
 * fed to code that no longer understands it - a saved conversation must never be
 * able to break the app it is restored into.
 */
export const STORAGE_VERSION = 1;
export const STORAGE_KEY = 'coursera-rag.conversation.v1';

/**
 * How many messages to keep. localStorage is a few megabytes per origin and each
 * assistant turn carries its sources, scores and confidence reasons, so an
 * unbounded transcript will eventually throw a quota error - on write, which is
 * to say at the worst possible moment.
 */
export const MAX_STORED_MESSAGES = 60;

export interface StoredConversation {
  version: number;
  messages: ChatMessage[];
  /** Index into `messages` from which context is drawn. See ChatStore.startNewTopic. */
  contextBreakAt: number;
  provider: string | null;
  savedAt: number;
}

/**
 * Prepare the state for storage.
 *
 * Error bubbles are dropped. They describe something that went wrong in a
 * previous session - a provider being down, a rate limit - and restoring them
 * presents a stale failure as though it just happened.
 */
export function serialise(
  messages: ChatMessage[],
  contextBreakAt: number,
  provider: string | null,
  now = Date.now(),
): StoredConversation {
  const keep = messages.filter((message) => !message.isError);

  /*
   * Trim from the FRONT, keeping the most recent. The break index has to move with
   * it, or a restored conversation would take context from the wrong point - and
   * clamp at zero, because a break that fell off the front is simply "everything
   * kept is in context".
   */
  const dropped = Math.max(0, keep.length - MAX_STORED_MESSAGES);
  const trimmed = keep.slice(dropped);

  return {
    version: STORAGE_VERSION,
    messages: trimmed,
    contextBreakAt: Math.max(0, Math.min(contextBreakAt - dropped, trimmed.length)),
    provider,
    savedAt: now,
  };
}

/**
 * Read stored state back.
 *
 * Returns null for anything it does not fully trust, and never throws. This runs
 * during construction of a root service: an exception here would take down the
 * whole app because of a corrupt string in localStorage, which is a spectacularly
 * bad trade for a convenience feature.
 */
export function deserialise(raw: string | null): StoredConversation | null {
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') return null;
  const candidate = parsed as Partial<StoredConversation>;

  // A different version is discarded rather than migrated. Migration code for a
  // convenience cache costs more than it saves.
  if (candidate.version !== STORAGE_VERSION) return null;
  if (!Array.isArray(candidate.messages)) return null;

  const messages = candidate.messages.filter(
    (message): message is ChatMessage =>
      !!message &&
      typeof message === 'object' &&
      (message.role === 'user' || message.role === 'assistant') &&
      typeof message.text === 'string',
  );
  if (messages.length === 0) return null;

  const breakAt = Number(candidate.contextBreakAt);

  return {
    version: STORAGE_VERSION,
    messages,
    contextBreakAt: Number.isFinite(breakAt)
      ? Math.max(0, Math.min(breakAt, messages.length))
      : 0,
    provider: typeof candidate.provider === 'string' ? candidate.provider : null,
    savedAt: Number(candidate.savedAt) || 0,
  };
}
