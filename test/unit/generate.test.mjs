import { describe, it, expect, vi } from 'vitest';
import { buildPrompt, extractCitations, generateAnswer, REFUSAL } from '../../server/rag.js';

/*
 * Generation is the stochastic half of RAG, so these tests never assert on
 * wording. They assert on contracts: what the model is shown, when it is called
 * at all, and that its citations are checked before we trust them.
 *
 * The LLM is injected as `llm`, so nothing here touches the network or costs
 * money. The real OpenAI path is covered separately by `npm run test:live`.
 */

const CHUNKS = [
  { title: 'Signals', path: '/guide/signals', text: 'A signal is a wrapper around a value.' },
  { title: 'Components', path: '/guide/components', text: 'Components are the building blocks.' },
];

/** An llm stub that returns a fixed string and records what it was asked. */
function fakeLlm(reply) {
  const calls = [];
  return {
    calls,
    async complete(prompt) {
      calls.push(prompt);
      return reply;
    },
  };
}

describe('buildPrompt', () => {
  it('numbers passages from 1 and includes title and path', () => {
    const { user } = buildPrompt('what is a signal?', CHUNKS);
    expect(user).toContain('[1] Signals (/guide/signals)');
    expect(user).toContain('[2] Components (/guide/components)');
  });

  it('includes the chunk text and the question', () => {
    const { user } = buildPrompt('what is a signal?', CHUNKS);
    expect(user).toContain('A signal is a wrapper around a value.');
    expect(user).toContain('Question: what is a signal?');
  });

  it('instructs the model to stay inside the context and to cite', () => {
    const { system } = buildPrompt('q', CHUNKS);
    expect(system).toMatch(/ONLY using the numbered context/i);
    expect(system).toMatch(/cite/i);
  });
});

describe('extractCitations', () => {
  it('finds each distinct bracketed number once, in order', () => {
    expect(extractCitations('See [2] and [1], also [2] again.')).toEqual([1, 2]);
  });

  it('returns an empty array when nothing is cited', () => {
    expect(extractCitations('No citations here.')).toEqual([]);
  });
});

describe('generateAnswer', () => {
  it('refuses WITHOUT calling the model when nothing was retrieved', async () => {
    const llm = fakeLlm('should never be used');
    const result = await generateAnswer({ question: 'how do I bake bread?', chunks: [], llm });

    expect(result.answer).toBe(REFUSAL);
    expect(result.refused).toBe(true);
    // The important assertion: no chunks means no API call, so an off-topic
    // question is free and cannot be answered from the model's own memory.
    expect(result.llmCalled).toBe(false);
    expect(llm.calls).toHaveLength(0);
  });

  it('returns the model answer and the citations it used', async () => {
    const llm = fakeLlm('A signal is a reactive value wrapper [1].');
    const result = await generateAnswer({ question: 'what is a signal?', chunks: CHUNKS, llm });

    expect(result.answer).toBe('A signal is a reactive value wrapper [1].');
    expect(result.citations).toEqual([1]);
    expect(result.refused).toBe(false);
  });

  it('passes both the system and user prompt to the model', async () => {
    const llm = fakeLlm('ok [1]');
    await generateAnswer({ question: 'q', chunks: CHUNKS, llm });

    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]).toHaveProperty('system');
    expect(llm.calls[0]).toHaveProperty('user');
  });

  it('strips citations that point outside the supplied passages', async () => {
    // Given 2 passages, [7] is a fabricated source. An unchecked citation is
    // worse than none, because it looks verified.
    const llm = fakeLlm('Signals are reactive [1]. Also see [7].');
    const result = await generateAnswer({ question: 'q', chunks: CHUNKS, llm });

    expect(result.answer).not.toContain('[7]');
    expect(result.answer).toContain('[1]');
    expect(result.citations).toEqual([1]);
    expect(result.droppedCitations).toEqual([7]);
  });

  it('keeps every valid citation when several are used', async () => {
    const llm = fakeLlm('Signals [1] live inside components [2].');
    const result = await generateAnswer({ question: 'q', chunks: CHUNKS, llm });
    expect(result.citations).toEqual([1, 2]);
    expect(result.droppedCitations).toEqual([]);
  });

  it('falls back to the refusal when the model returns nothing', async () => {
    const result = await generateAnswer({ question: 'q', chunks: CHUNKS, llm: fakeLlm('   ') });
    expect(result.answer).toBe(REFUSAL);
    expect(result.refused).toBe(true);
  });

  it('propagates model errors rather than inventing an answer', async () => {
    const llm = {
      complete: vi.fn().mockRejectedValue(new Error('rate limited')),
    };
    await expect(generateAnswer({ question: 'q', chunks: CHUNKS, llm })).rejects.toThrow(
      'rate limited',
    );
  });
});
