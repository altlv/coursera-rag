import { describe, it, expect, vi } from 'vitest';
import {
  buildPrompt,
  extractCitations,
  generateAnswer,
  REFUSAL,
  PARTIAL_ANSWER,
  NO_ANSWER_SENTINEL,
} from '../../server/rag.js';

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

  it('marks passage relevance so the model can weigh conflicting evidence', () => {
    /*
     * Without a relevance signal every passage carries equal authority, so a weak
     * rank-5 passage can contradict the best match on equal terms. Rank is used
     * rather than the raw score because scores sit in a narrow band that reads as
     * "all roughly equal", while ordinal position does not.
     */
    const { user } = buildPrompt('q', CHUNKS);
    expect(user).toContain('most relevant');
    expect(user).toContain('relevance rank 2');
  });

  it('instructs the model to surface conflicting passages rather than merge them', () => {
    /*
     * Passages are selected for similarity to the question and never for agreeing
     * with each other, so version drift or a deprecated API beside its replacement
     * can put contradictory claims in one prompt. A model told only to "answer
     * from the context" faithfully reproduces both and contradicts itself.
     *
     * The citation guard cannot catch this: it verifies a source was SUPPLIED,
     * not that the sources agree.
     */
    const { system } = buildPrompt('q', CHUNKS);
    expect(system).toMatch(/conflict/i);
    expect(system).toMatch(/cite both/i);
    expect(system).toMatch(/do not silently merge/i);
    // And it must know which passage to prefer when they disagree.
    expect(system).toMatch(/strongest first|prefer the earlier/i);
  });

  it('tells the model how to signal that the passages do not answer the question', () => {
    const { system } = buildPrompt('q', CHUNKS);
    expect(system).toContain(NO_ANSWER_SENTINEL);
    // Must be explicit that a merely-related passage is not good enough,
    // otherwise the model pads an answer out of adjacent material.
    expect(system).toMatch(/related topic/i);
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
    const result = await generateAnswer({ question: 'Got milk?', chunks: [], llm });

    expect(result.status).toBe('refused');
    expect(result.answer).toBe(REFUSAL);
    // The important assertion: no chunks means no API call, so an off-topic
    // question is free and cannot be answered from the model's own memory.
    expect(result.llmCalled).toBe(false);
    expect(llm.calls).toHaveLength(0);
  });

  it('returns the model answer and the citations it used', async () => {
    const llm = fakeLlm('A signal is a reactive value wrapper [1].');
    const result = await generateAnswer({ question: 'what is a signal?', chunks: CHUNKS, llm });

    expect(result.status).toBe('answered');
    expect(result.answer).toBe('A signal is a reactive value wrapper [1].');
    expect(result.citations).toEqual([1]);
  });

  it('reports "partial" when passages were found but none answer the question', async () => {
    /*
     * The "What does CSS stand for?" case. Retrieval cannot catch this on score
     * alone - those passages score 0.457, higher than several genuine Angular
     * questions, because the styling and security pages really are about CSS.
     * What is missing is a definition of the acronym. Only the model, reading the
     * passages, can tell - so it signals with the sentinel and we offer the
     * closest pages instead of an answer.
     */
    const llm = fakeLlm(NO_ANSWER_SENTINEL);
    const result = await generateAnswer({
      question: 'What does CSS stand for?',
      chunks: CHUNKS,
      llm,
    });

    expect(result.status).toBe('partial');
    expect(result.answer).toBe(PARTIAL_ANSWER);
    expect(result.citations).toEqual([]);
    // Distinct from 'refused': there ARE sources worth showing here.
    expect(result.refused).toBe(false);
    expect(result.llmCalled).toBe(true);
  });

  it('treats the sentinel as partial even with surrounding whitespace', async () => {
    const result = await generateAnswer({
      question: 'q',
      chunks: CHUNKS,
      llm: fakeLlm(`  ${NO_ANSWER_SENTINEL}\n`),
    });
    expect(result.status).toBe('partial');
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

  it('treats empty model output as partial rather than showing a blank answer', async () => {
    const result = await generateAnswer({ question: 'q', chunks: CHUNKS, llm: fakeLlm('   ') });
    expect(result.status).toBe('partial');
    expect(result.answer).toBe(PARTIAL_ANSWER);
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
