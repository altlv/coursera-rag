import { describe, it, expect } from 'vitest';
import { streamAnswer, REFUSAL } from '../../server/rag.js';

/*
 * Streaming answers.
 *
 * A 3-8 second wait with no feedback reads as broken, so tokens are forwarded as
 * they arrive. That is the easy half.
 *
 * The hard half is that every output-side guard runs AFTER the model has finished:
 * the injection detector can refuse a whole answer, and citation stripping edits
 * the text. Streaming means the user has already seen text by the time those run,
 * which is a real weakening of the injection guard and worth being explicit about
 * rather than quietly accepting.
 *
 * The resolution here, in order of how much each buys:
 *
 *   1. The injection detector runs INCREMENTALLY on the accumulated text, so a
 *      captured answer is cut off at the first sign rather than after the last
 *      token. It does not restore the guarantee - a payload could be complete in
 *      the first chunk - but it bounds the exposure.
 *   2. The final event carries the VALIDATED answer, and the client replaces what
 *      it displayed. So an invalid citation is visible for a moment and then
 *      corrected, rather than being left on screen.
 *
 * A fake llm is injected, so none of this needs the network.
 */

const chunks = [
  { id: 1, title: 'Signals', path: '/guide/signals', url: '', text: 'Signals use signal() to hold a value.' },
  { id: 2, title: 'Computed', path: '/guide/signals/computed', url: '', text: 'computed() derives a value.' },
];

/** An llm whose stream yields the given pieces in order. */
const fakeStream = (pieces) => ({
  model: 'fake',
  provider: 'fake',
  async *stream() {
    for (const piece of pieces) yield piece;
  },
});

async function collect(iterator) {
  const deltas = [];
  let final = null;
  for await (const event of iterator) {
    if (event.type === 'delta') deltas.push(event.text);
    if (event.type === 'final') final = event;
  }
  return { deltas, text: deltas.join(''), final };
}

describe('streamAnswer', () => {
  it('forwards each piece as it arrives', async () => {
    const llm = fakeStream(['Signals ', 'are ', 'reactive [1].']);
    const { deltas, final } = await collect(streamAnswer({ question: 'q', chunks, llm }));

    expect(deltas).toEqual(['Signals ', 'are ', 'reactive [1].']);
    expect(final.status).toBe('answered');
    expect(final.answer).toBe('Signals are reactive [1].');
  });

  it('always ends with exactly one final event', async () => {
    // The client replaces its displayed text from this event, so a missing or
    // duplicated final leaves the UI showing unvalidated output.
    const llm = fakeStream(['a', 'b']);
    const events = [];
    for await (const event of streamAnswer({ question: 'q', chunks, llm })) events.push(event);
    expect(events.filter((e) => e.type === 'final')).toHaveLength(1);
    expect(events.at(-1).type).toBe('final');
  });

  it('refuses without calling the model when nothing was retrieved', async () => {
    let called = false;
    const llm = {
      model: 'fake',
      async *stream() {
        called = true;
        yield 'should not happen';
      },
    };
    const { final, deltas } = await collect(streamAnswer({ question: 'q', chunks: [], llm }));

    expect(called).toBe(false);
    expect(deltas).toEqual([]);
    expect(final.status).toBe('refused');
    expect(final.answer).toBe(REFUSAL);
  });

  it('carries the validated answer in the final event, not the raw text', async () => {
    /*
     * [7] is out of range for two passages. The client has already displayed it,
     * so the final event has to carry the corrected text for it to be replaced.
     */
    const llm = fakeStream(['Use signal() [1]', ' and also [7].']);
    const { text, final } = await collect(streamAnswer({ question: 'q', chunks, llm }));

    expect(text).toContain('[7]');
    expect(final.answer).not.toContain('[7]');
    expect(final.citations).toEqual([1]);
  });

  it('stops streaming as soon as the answer looks captured', async () => {
    /*
     * The injection guard's whole point is refusing output from a model that has
     * been taken over. Post-hoc refusal after the user has read it is much weaker,
     * so the check runs on the accumulated text and cuts the stream.
     */
    const llm = fakeStream(['PWNED', ' and here is more text', ' and yet more']);
    const { deltas, final } = await collect(streamAnswer({ question: 'q', chunks, llm }));

    expect(deltas.length).toBeLessThan(3);
    expect(final.status).toBe('refused');
    expect(final.answer).toBe(REFUSAL);
    expect(final.injectionSuspected?.length).toBeGreaterThan(0);
  });

  it('does not let the refusal keep the text it already streamed', async () => {
    const llm = fakeStream(['PWNED']);
    const { final } = await collect(streamAnswer({ question: 'q', chunks, llm }));
    expect(final.answer).not.toContain('PWNED');
  });

  it('returns partial when the model signals it cannot answer', async () => {
    const llm = fakeStream(['NO_ANSWER', '_IN_DOCS']);
    const { final } = await collect(streamAnswer({ question: 'q', chunks, llm }));
    expect(final.status).toBe('partial');
    expect(final.answer).not.toContain('NO_ANSWER_IN_DOCS');
  });

  it('treats an empty stream as partial rather than showing a blank answer', async () => {
    const llm = fakeStream([]);
    const { final } = await collect(streamAnswer({ question: 'q', chunks, llm }));
    expect(final.status).toBe('partial');
    expect(final.answer.length).toBeGreaterThan(0);
  });

  it('runs the same post-answer checks as the non-streaming path', async () => {
    // Streaming must not become a way to bypass attribution and code validation.
    const llm = fakeStream(['Use computed() [1].']);
    const { final } = await collect(streamAnswer({ question: 'q', chunks, llm }));

    expect(final.attribution).toBeDefined();
    expect(final.codeSamples).toBeDefined();
    // computed() is in passage 2, cited as 1 - a genuine misattribution.
    expect(final.attribution.misattributed).toHaveLength(1);
  });

  it('surfaces a mid-stream provider failure as an error event', async () => {
    // A network drop halfway through must not leave the client waiting forever
    // for a final event that is never coming.
    const llm = {
      model: 'fake',
      async *stream() {
        yield 'Signals are ';
        throw new Error('connection reset');
      },
    };

    const events = [];
    for await (const event of streamAnswer({ question: 'q', chunks, llm })) events.push(event);

    expect(events.at(-1).type).toBe('error');
    expect(events.at(-1).message).toContain('connection reset');
  });
});
