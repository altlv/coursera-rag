import { TestBed } from '@angular/core/testing';
import { ChatStore } from './chat.store';
import { ChatService } from './chat.service';
import { STORAGE_KEY } from './conversation-storage';

/*
 * ChatStore wiring.
 *
 * conversation-storage.spec.ts covers the pure serialise/deserialise logic. These
 * tests cover the part that connects it to the store, which is where the mistakes
 * actually happen - a correct pure function called at the wrong moment, or reading
 * a key nothing writes, fails in exactly the way unit tests on the pure half
 * cannot see.
 *
 * ChatService is stubbed so nothing touches the network.
 */

class StubChatService {
  providers = async () => ({ available: [], unavailable: [], active: 'openai', reason: '' });
  rate = async () => {};
  ask = async () => ({ status: 'answered', answer: 'ok' });
}

/** A localStorage that behaves, and one that does not. */
function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
    key: (i: number) => [...data.keys()][i] ?? null,
    get length() {
      return data.size;
    },
    _data: data,
  } as unknown as Storage & { _data: Map<string, string> };
}

function makeStore() {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [ChatStore, { provide: ChatService, useClass: StubChatService }],
  });
  return TestBed.inject(ChatStore);
}

describe('ChatStore context break', () => {
  beforeEach(() => {
    (globalThis as { localStorage?: Storage }).localStorage = fakeStorage();
  });

  it('starts with no break and everything in context', () => {
    const store = makeStore();
    store.messages.update((list) => [...list, { role: 'user', text: 'what are signals?' }]);
    expect(store.contextBreakAt()).toBe(0);
    expect(store.inContext()).toBe(1);
  });

  it('drops earlier questions out of context without removing them', () => {
    /*
     * The whole point of "new topic" as distinct from "clear": the transcript is
     * still readable, but the next question is no longer resolved against it.
     */
    const store = makeStore();
    store.messages.update((list) => [...list, { role: 'user', text: 'what are signals?' }]);
    store.startNewTopic();

    expect(store.inContext()).toBe(0);
    expect(store.messages().some((m) => m.text === 'what are signals?')).toBe(true);
  });

  it('counts only questions asked after the break', () => {
    const store = makeStore();
    store.messages.update((list) => [...list, { role: 'user', text: 'first' }]);
    store.startNewTopic();
    store.messages.update((list) => [...list, { role: 'user', text: 'second' }]);
    expect(store.inContext()).toBe(1);
  });

  it('reports a break only while there is conversation on both sides of it', () => {
    // At the very end of the transcript there is nothing to separate yet, so the
    // divider would be a line under the last message saying nothing.
    const store = makeStore();
    store.messages.update((list) => [...list, { role: 'user', text: 'first' }]);
    store.startNewTopic();
    expect(store.hasContextBreak()).toBe(false);

    store.messages.update((list) => [...list, { role: 'user', text: 'second' }]);
    expect(store.hasContextBreak()).toBe(true);
  });

  it('clears the break when the conversation is reset', () => {
    const store = makeStore();
    store.messages.update((list) => [...list, { role: 'user', text: 'first' }]);
    store.startNewTopic();
    store.reset();
    expect(store.contextBreakAt()).toBe(0);
  });
});

describe('ChatStore persistence', () => {
  it('restores a saved conversation on construction', () => {
    const saved = JSON.stringify({
      version: 1,
      messages: [
        { role: 'user', text: 'what are signals?' },
        { role: 'assistant', text: 'A signal is...', status: 'answered' },
      ],
      contextBreakAt: 1,
      provider: 'openai',
      savedAt: 0,
    });
    (globalThis as { localStorage?: Storage }).localStorage = fakeStorage({ [STORAGE_KEY]: saved });

    const store = makeStore();
    expect(store.messages()).toHaveLength(2);
    expect(store.contextBreakAt()).toBe(1);
    expect(store.selectedProvider()).toBe('openai');
  });

  it('writes the conversation when a new topic starts', () => {
    const storage = fakeStorage();
    (globalThis as { localStorage?: Storage }).localStorage = storage;

    const store = makeStore();
    store.messages.update((list) => [...list, { role: 'user', text: 'hello' }]);
    store.startNewTopic();

    expect(storage._data.has(STORAGE_KEY)).toBe(true);
  });

  it('removes the saved conversation when cleared', () => {
    // Otherwise "Clear" wipes the screen and the conversation reappears on reload,
    // which is worse than not persisting at all.
    const storage = fakeStorage({ [STORAGE_KEY]: '{"version":1,"messages":[]}' });
    (globalThis as { localStorage?: Storage }).localStorage = storage;

    makeStore().reset();
    expect(storage._data.has(STORAGE_KEY)).toBe(false);
  });

  it('starts fresh when nothing is stored', () => {
    (globalThis as { localStorage?: Storage }).localStorage = fakeStorage();
    const store = makeStore();
    expect(store.messages()).toHaveLength(1); // the welcome message
    expect(store.hasConversation()).toBe(false);
  });

  it('ignores corrupt storage rather than failing to construct', () => {
    /*
     * The decisive one. This runs while constructing a root service, so throwing
     * here takes down the whole application because of a bad string in
     * localStorage.
     */
    (globalThis as { localStorage?: Storage }).localStorage = fakeStorage({
      [STORAGE_KEY]: '{ this is not json',
    });
    expect(() => makeStore()).not.toThrow();
    expect(makeStore().hasConversation()).toBe(false);
  });

  it('works when localStorage throws on every call', () => {
    // Safari private browsing, storage disabled by policy, quota exhausted.
    const hostile = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    } as unknown as Storage;
    (globalThis as { localStorage?: Storage }).localStorage = hostile;

    const store = makeStore();
    expect(() => store.startNewTopic()).not.toThrow();
    expect(() => store.reset()).not.toThrow();
  });
});
