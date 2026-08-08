import { describe, it, expect } from 'vitest';
import { buildRerankPrompt, parseRanking, rerank } from '../../server/rerank.js';

/*
 * Reranking.
 *
 * The bi-encoder embeds question and passage SEPARATELY, so it never sees the two
 * together - it compares two summaries made in isolation. A reranker scores the
 * pair jointly, which is far more accurate and far too slow to run over the whole
 * corpus. Hence: retrieve cheaply and widely, rerank expensively and narrowly.
 *
 * The ceiling was measured before any of this was written, free and offline:
 *
 *   held-out recall@5  (production)   93%
 *   held-out recall@10                100%     <- the right page is ALWAYS here
 *   held-out hit@1                    73%
 *
 * So the correct page is in the top 10 for every held-out question, and first for
 * only 73% of them. That 27-point gap is pure ordering, which is exactly what a
 * reranker addresses - and it is the whole reason this was worth building.
 *
 * The measurement also killed the conventional advice. Widening to k=30 or k=50
 * gains no recall (already 100%) while pushing the mean rank of the correct page
 * from 1.9 to 2.7 - more noise for the reranker to sift, for nothing.
 *
 * The structural property these tests exist to protect: anything the reranker
 * fails to place keeps its original relative order and follows what it did place.
 * A total parse failure therefore degrades to the baseline ordering, so the
 * reranker can never do worse than not having one.
 */

const candidate = (n, text) => ({ id: n, title: `P${n}`, path: `/p/${n}`, text, score: 0.5 });
const candidates = [
  candidate(1, 'Signals hold a value.'),
  candidate(2, 'Computed derives from signals.'),
  candidate(3, 'Effects run on change.'),
];

/** An llm whose completion is fixed. */
const fakeLlm = (reply) => ({
  model: 'fake',
  calls: 0,
  async complete(prompt) {
    this.calls += 1;
    this.lastPrompt = prompt;
    return reply;
  },
});

describe('buildRerankPrompt', () => {
  it('numbers the passages so the model can refer to them', () => {
    const { user } = buildRerankPrompt('what are signals?', candidates);
    expect(user).toContain('[1]');
    expect(user).toContain('[2]');
    expect(user).toContain('[3]');
    expect(user).toContain('what are signals?');
  });

  it('truncates passages, because reranking needs the gist not the whole text', () => {
    // A reranker reads 10 passages per question. Sending them in full triples the
    // token cost to decide an ordering that a few hundred characters settles.
    const long = candidate(1, 'x'.repeat(5000));
    const { user } = buildRerankPrompt('q', [long]);
    expect(user.length).toBeLessThan(2000);
  });

  it('includes the page path, which is often the strongest signal', () => {
    const { user } = buildRerankPrompt('q', candidates);
    expect(user).toContain('/p/1');
  });
});

describe('parseRanking', () => {
  it('reads a plain list of indices', () => {
    expect(parseRanking('2, 1, 3', 3)).toEqual([2, 1, 3]);
  });

  it('reads bracketed indices', () => {
    expect(parseRanking('[3] [1] [2]', 3)).toEqual([3, 1, 2]);
  });

  it('ignores prose around the answer', () => {
    // Models add commentary however firmly you ask them not to.
    expect(parseRanking('The most relevant are: 2, 3, 1. Hope that helps!', 3)).toEqual([2, 3, 1]);
  });

  it('drops indices outside the candidate range', () => {
    // A model inventing a passage number must not produce an undefined entry.
    expect(parseRanking('1, 9, 2', 3)).toEqual([1, 2]);
    expect(parseRanking('0, 1', 3)).toEqual([1]);
  });

  it('drops duplicates, keeping the first placement', () => {
    expect(parseRanking('2, 2, 1', 3)).toEqual([2, 1]);
  });

  it('returns an empty list for output with no usable numbers', () => {
    // Signals "I could not rank this", which the caller turns into "keep the
    // original order" rather than into an exception.
    expect(parseRanking('I am unable to help with that.', 3)).toEqual([]);
    expect(parseRanking('', 3)).toEqual([]);
  });
});

describe('rerank', () => {
  it('reorders the candidates as the model ranked them', async () => {
    const result = await rerank({ question: 'q', candidates, llm: fakeLlm('3, 1, 2') });
    expect(result.map((c) => c.id)).toEqual([3, 1, 2]);
  });

  it('appends anything the model did not rank, in its original order', async () => {
    /*
     * The structural guarantee. A partial ranking must not silently drop
     * passages - they keep their retrieval order behind the ranked ones.
     */
    const result = await rerank({ question: 'q', candidates, llm: fakeLlm('3') });
    expect(result.map((c) => c.id)).toEqual([3, 1, 2]);
  });

  it('falls back to the original order when the model returns nothing usable', async () => {
    // The property that makes this safe to ship: a reranker that fails behaves
    // exactly like not having one.
    const result = await rerank({ question: 'q', candidates, llm: fakeLlm('sorry, no') });
    expect(result.map((c) => c.id)).toEqual([1, 2, 3]);
  });

  it('falls back to the original order when the model throws', async () => {
    const llm = {
      model: 'fake',
      async complete() {
        throw new Error('provider down');
      },
    };
    const result = await rerank({ question: 'q', candidates, llm });
    expect(result.map((c) => c.id)).toEqual([1, 2, 3]);
  });

  it('does not call the model when there is nothing to reorder', async () => {
    // One candidate has only one possible ordering, so the call is pure cost.
    const llm = fakeLlm('1');
    await rerank({ question: 'q', candidates: candidates.slice(0, 1), llm });
    expect(llm.calls).toBe(0);

    await rerank({ question: 'q', candidates: [], llm });
    expect(llm.calls).toBe(0);
  });

  it('trims to topK after reordering, not before', async () => {
    /*
     * The entire point: a passage the retriever ranked 3rd must be able to reach
     * the final top 2. Trimming first would make reranking a no-op.
     */
    const result = await rerank({ question: 'q', candidates, llm: fakeLlm('3, 2, 1'), topK: 2 });
    expect(result.map((c) => c.id)).toEqual([3, 2]);
  });

  it('preserves the retrieval score for display', async () => {
    // The UI shows similarity, and a reranked answer should still explain where
    // its passages came from.
    const result = await rerank({ question: 'q', candidates, llm: fakeLlm('2, 1, 3') });
    expect(result[0].score).toBe(0.5);
  });
});
