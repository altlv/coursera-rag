import { describe, it, expect } from 'vitest';
import {
  needsRewrite,
  buildRewritePrompt,
  rewriteQuestion,
  buildPrompt,
  HISTORY_EXCHANGES,
} from '../../server/rag.js';

/*
 * Working memory: making follow-up questions retrievable.
 *
 * The problem: every question is embedded on its own, so "what about effects?"
 * carries almost nothing searchable and matches near-randomly.
 *
 * The fix is query rewriting rather than concatenating the history - a vector
 * averaged across several topics matches none of them well.
 *
 * The design constraint that shapes everything here: retrieval must NOT depend on
 * which model is active. So the rewrite is built from the user's own questions
 * plus the doc paths already retrieved, never from model prose.
 */

const CHUNKS = [
  { title: 'Signals', path: '/guide/signals', text: 'A signal is a wrapper around a value.' },
];

const HISTORY = [
  { role: 'user', text: 'what are signals?' },
  { role: 'assistant', text: 'A signal is a reactive wrapper [1].', provider: 'openai', paths: ['/guide/signals'] },
];

function fakeLlm(reply) {
  const calls = [];
  return { calls, async complete(prompt) { calls.push(prompt); return reply; } };
}

describe('needsRewrite', () => {
  it('is false with no history, however dependent the question looks', () => {
    // Nothing to resolve against on the very first turn.
    expect(needsRewrite('what about that?', [])).toBe(false);
  });

  it('detects "what about X" continuations', () => {
    expect(needsRewrite('what about effects?', HISTORY)).toBe(true);
    expect(needsRewrite('how about computed?', HISTORY)).toBe(true);
  });

  it('detects anaphora', () => {
    expect(needsRewrite('can I use it in a template?', HISTORY)).toBe(true);
    expect(needsRewrite('is that the same as a getter?', HISTORY)).toBe(true);
  });

  it('detects reformulation requests', () => {
    expect(needsRewrite('explain more simply', HISTORY)).toBe(true);
    expect(needsRewrite('shorter please', HISTORY)).toBe(true);
  });

  it('detects very short questions', () => {
    expect(needsRewrite('effects?', HISTORY)).toBe(true);
  });

  it('is FALSE for a question that already stands alone', () => {
    /*
     * The important negative case. Rewriting a clear question can make retrieval
     * worse - "what are signals?" reworded shifts the embedding and may retrieve
     * different, worse passages. Not rewriting is the cheapest way to avoid that
     * regression, and it saves a model call.
     */
    expect(needsRewrite('how do I create a reactive form in Angular?', HISTORY)).toBe(false);
    expect(needsRewrite('what is dependency injection?', HISTORY)).toBe(false);
  });

  it('handles empty input', () => {
    expect(needsRewrite('', HISTORY)).toBe(false);
    expect(needsRewrite(null, HISTORY)).toBe(false);
  });
});

describe('buildRewritePrompt', () => {
  it('includes the user\'s earlier questions', () => {
    const { user } = buildRewritePrompt('what about effects?', HISTORY);
    expect(user).toContain('what are signals?');
    expect(user).toContain('Follow-up question: what about effects?');
  });

  it('includes doc paths already retrieved', () => {
    // Paths are facts about retrieval, not model opinions, so they are safe.
    expect(buildRewritePrompt('what about effects?', HISTORY).user).toContain('/guide/signals');
  });

  it('EXCLUDES previous model answers', () => {
    /*
     * The decisive test for provider independence. If model prose fed the
     * rewrite, switching provider would change what gets retrieved - and the
     * whole point of comparing providers on identical passages would collapse.
     */
    const { user } = buildRewritePrompt('what about effects?', HISTORY);
    expect(user).not.toContain('A signal is a reactive wrapper');
  });

  it('instructs the model to output only the question', () => {
    const { system } = buildRewritePrompt('q', HISTORY);
    expect(system).toMatch(/only the rewritten question/i);
    expect(system).toMatch(/do not answer/i);
  });

  it(`keeps at most ${HISTORY_EXCHANGES} earlier questions`, () => {
    const long = Array.from({ length: 10 }, (_, i) => ({ role: 'user', text: `question ${i}` }));
    const { user } = buildRewritePrompt('what about that?', long);
    expect(user).not.toContain('question 0');
    expect(user).toContain('question 9');
  });
});

describe('rewriteQuestion', () => {
  it('does not call the model when the question stands alone', async () => {
    const llm = fakeLlm('should not be used');
    const result = await rewriteQuestion({
      question: 'how do I create a reactive form in Angular?',
      history: HISTORY,
      llm,
    });

    expect(result.rewritten).toBe(false);
    expect(llm.calls).toHaveLength(0);
  });

  it('rewrites a dependent follow-up into a standalone question', async () => {
    const llm = fakeLlm('What are effects in Angular signals?');
    const result = await rewriteQuestion({ question: 'what about effects?', history: HISTORY, llm });

    expect(result.rewritten).toBe(true);
    expect(result.question).toBe('What are effects in Angular signals?');
    expect(result.original).toBe('what about effects?');
  });

  it('strips quotes and takes only the first line', async () => {
    const llm = fakeLlm('"What are effects in Angular signals?"\nHere is why...');
    const result = await rewriteQuestion({ question: 'what about effects?', history: HISTORY, llm });
    expect(result.question).toBe('What are effects in Angular signals?');
  });

  it('falls back to the original when the model rambles instead of rewriting', async () => {
    // A model that answers rather than rewrites must not poison retrieval.
    const llm = fakeLlm('x'.repeat(400));
    const result = await rewriteQuestion({ question: 'what about effects?', history: HISTORY, llm });

    expect(result.rewritten).toBe(false);
    expect(result.question).toBe('what about effects?');
    expect(result.reason).toMatch(/implausible/);
  });

  it('falls back when the model returns nothing', async () => {
    const result = await rewriteQuestion({
      question: 'what about effects?',
      history: HISTORY,
      llm: fakeLlm('   '),
    });
    expect(result.rewritten).toBe(false);
    expect(result.question).toBe('what about effects?');
  });

  it('reports no rewrite when the output matches the input', async () => {
    const result = await rewriteQuestion({
      question: 'what about effects?',
      history: HISTORY,
      llm: fakeLlm('what about effects?'),
    });
    expect(result.rewritten).toBe(false);
  });
});

describe('buildPrompt with history', () => {
  it('omits the conversation block when there is no history', () => {
    expect(buildPrompt('q', CHUNKS).user).not.toMatch(/Conversation so far/);
  });

  it('includes recent turns for resolving references', () => {
    const { user } = buildPrompt('explain that more simply', CHUNKS, {
      history: HISTORY,
      provider: 'openai',
    });
    expect(user).toContain('Conversation so far');
    expect(user).toContain('User: what are signals?');
  });

  it('marks the history as context, not as a citable source', () => {
    // Otherwise a model may cite its own earlier prose as evidence.
    const { user } = buildPrompt('q', CHUNKS, { history: HISTORY, provider: 'openai' });
    expect(user).toMatch(/do not treat it as a source/i);
  });

  it('does NOT label answers from the same provider', () => {
    const { user } = buildPrompt('q', CHUNKS, { history: HISTORY, provider: 'openai' });
    expect(user).toContain('Assistant: A signal is a reactive wrapper');
    expect(user).not.toContain('answered by openai');
  });

  it('LABELS answers written by a different provider', () => {
    /*
     * The cross-model case. Without the label, Llama reads gpt-4o-mini's answer
     * as its own previous turn and inherits it - defending a claim, or standing
     * by a refusal, it never made.
     */
    const { user } = buildPrompt('are you sure?', CHUNKS, {
      history: HISTORY,
      provider: 'openrouter',
    });
    expect(user).toContain('answered by openai');
  });

  it(`truncates to the last ${HISTORY_EXCHANGES} exchanges`, () => {
    const long = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      text: `turn ${i}`,
      provider: 'openai',
    }));
    const { user } = buildPrompt('q', CHUNKS, { history: long, provider: 'openai' });

    expect(user).not.toContain('turn 0');
    expect(user).toContain('turn 19');
  });

  it('still includes the passages and the question', () => {
    const { user } = buildPrompt('what about effects?', CHUNKS, {
      history: HISTORY,
      provider: 'openai',
    });
    expect(user).toContain('[1] Signals (/guide/signals)');
    expect(user).toContain('Question: what about effects?');
  });
});
