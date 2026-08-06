import { describe, it, expect } from 'vitest';
import {
  capPerPage,
  tokenize,
  rankLexical,
  fuseRankings,
  selectChunksHybrid,
  normalizeVector,
} from '../../server/rag.js';

/*
 * Hybrid retrieval: the diversity cap, keyword ranking, and rank fusion.
 *
 * All pure functions over plain arrays, so none of this needs a vector store,
 * an API key or a network.
 */

describe('capPerPage', () => {
  const chunk = (path, score) => ({ path, score, text: path });

  it('limits how many chunks one page may contribute', () => {
    // Measured problem: "What does CSS stand for?" filled 2 of 5 slots with
    // duplicates from two pages, wasting 40% of the context window.
    //
    // k=3 with four distinct pages available, so the cap binds without the
    // top-up path below being involved.
    const sorted = [
      chunk('/a', 0.9),
      chunk('/a', 0.88),
      chunk('/a', 0.86),
      chunk('/b', 0.8),
      chunk('/c', 0.7),
      chunk('/d', 0.6),
    ];
    const picked = capPerPage(sorted, 3, 2);
    expect(picked.filter((c) => c.path === '/a')).toHaveLength(2);
    expect(picked.map((c) => c.path)).toEqual(['/a', '/a', '/b']);
  });

  it('keeps the highest-scoring chunks from a capped page', () => {
    const sorted = [chunk('/a', 0.9), chunk('/a', 0.88), chunk('/a', 0.5), chunk('/b', 0.4)];
    const picked = capPerPage(sorted, 3, 2);
    const aScores = picked.filter((c) => c.path === '/a').map((c) => c.score);
    expect(aScores).toEqual([0.9, 0.88]);
  });

  it('preserves score order overall', () => {
    const sorted = [chunk('/a', 0.9), chunk('/b', 0.8), chunk('/c', 0.7)];
    expect(capPerPage(sorted, 3, 2).map((c) => c.score)).toEqual([0.9, 0.8, 0.7]);
  });

  it('tops up from the held-back overflow rather than returning fewer than k', () => {
    // Only two pages available but k=4: returning 2 results would starve the
    // model of context for no reason.
    const sorted = [
      chunk('/a', 0.9),
      chunk('/a', 0.88),
      chunk('/a', 0.86),
      chunk('/b', 0.8),
      chunk('/b', 0.78),
      chunk('/b', 0.76),
    ];
    expect(capPerPage(sorted, 4, 2)).toHaveLength(4);
  });

  it('is a plain slice when the cap is disabled', () => {
    const sorted = [chunk('/a', 0.9), chunk('/a', 0.8), chunk('/a', 0.7)];
    expect(capPerPage(sorted, 2, 0)).toHaveLength(2);
  });
});

describe('tokenize', () => {
  it('lowercases, splits on punctuation and drops stop words', () => {
    expect(tokenize('How do I use the HttpClient?')).toEqual(['httpclient']);
  });

  it('drops single characters', () => {
    expect(tokenize('a b component')).toEqual(['component']);
  });

  it('handles empty input', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize(null)).toEqual([]);
  });
});

describe('rankLexical', () => {
  const chunks = [
    { title: 'Inputs', path: '/inputs', text: 'Accept data with the input function.' },
    { title: 'Overview', path: '/overview', text: 'Components render templates in the DOM.' },
    { title: 'Interceptors', path: '/interceptors', text: 'An interceptor sits in the pipeline.' },
  ];

  it('ranks the chunk containing the query term first', () => {
    const ranked = rankLexical('interceptor', chunks);
    expect(chunks[ranked[0].index].path).toBe('/interceptors');
  });

  it('ignores chunks with no query term at all', () => {
    const ranked = rankLexical('interceptor', chunks);
    expect(ranked.map((r) => chunks[r.index].path)).not.toContain('/overview');
  });

  it('weights rare terms above common ones', () => {
    // "input" appears in one chunk, "the" in all of them and is a stop word
    // anyway, so the rare term must decide the ranking.
    const ranked = rankLexical('the input', chunks);
    expect(chunks[ranked[0].index].path).toBe('/inputs');
  });

  it('matches on the title as well as the body', () => {
    const ranked = rankLexical('Inputs', chunks);
    expect(chunks[ranked[0].index].path).toBe('/inputs');
  });

  it('returns nothing for a query of only stop words', () => {
    expect(rankLexical('how do I use the', chunks)).toEqual([]);
  });
});

describe('fuseRankings', () => {
  it('rewards agreement across methods over one strong opinion', () => {
    // B is 2nd and 3rd; A is 1st but 20th. Consistent relevance should win.
    const a = [{ index: 1 }, { index: 2 }];
    const b = [{ index: 2 }, { index: 1 }];
    a.label = 'vector';
    b.label = 'lexical';

    // Push index 1 far down the second ranking.
    const deep = [{ index: 2 }, ...Array.from({ length: 18 }, (_, i) => ({ index: 100 + i })), { index: 1 }];
    deep.label = 'lexical';

    const fused = fuseRankings([a, deep]);
    expect(fused[0].index).toBe(2);
  });

  it('records the rank each method gave, for explainability', () => {
    const v = [{ index: 7 }];
    const l = [{ index: 7 }];
    v.label = 'vector';
    l.label = 'lexical';

    const [top] = fuseRankings([v, l]);
    expect(top.ranks).toEqual({ vector: 1, lexical: 1 });
  });

  it('uses position, not score, so incomparable scales cannot dominate', () => {
    // Cosine sits in ~0.25-0.65 while BM25 is unbounded. If scores were summed,
    // the lexical side would swamp the vector side entirely.
    const v = [{ index: 1, score: 0.6 }, { index: 2, score: 0.59 }];
    const l = [{ index: 2, score: 900 }, { index: 1, score: 1 }];
    v.label = 'vector';
    l.label = 'lexical';

    const fused = fuseRankings([v, l]);
    // Near-identical positions mean near-identical fused scores, despite the
    // 900x difference in raw lexical score.
    expect(Math.abs(fused[0].score - fused[1].score)).toBeLessThan
      (0.001);
  });
});

describe('selectChunksHybrid', () => {
  // Three orthogonal unit vectors so the vector ranking is unambiguous.
  const store = {
    dimensions: 3,
    chunks: [
      { id: 'a#1', title: 'Alpha', path: '/a', text: 'nothing relevant here' },
      { id: 'b#1', title: 'Beta', path: '/b', text: 'the interceptor pipeline' },
      { id: 'c#1', title: 'Gamma', path: '/c', text: 'unrelated words' },
    ],
    vectors: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
  };

  it('returns nothing when nothing clears the vector floor', () => {
    // The refusal guarantee: keyword matches must never rescue an off-topic
    // question, or a free refusal becomes a partial answer.
    const query = normalizeVector([1, 1, 1]); // ~0.577 to each
    expect(selectChunksHybrid(query, 'interceptor', store, { floor: 0.9 })).toEqual([]);
  });

  it('every result still carries a real similarity score above the floor', () => {
    const query = normalizeVector([1, 1, 1]);
    const results = selectChunksHybrid(query, 'interceptor', store, { floor: 0.3, k: 3 });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) expect(r.score).toBeGreaterThanOrEqual(0.3);
  });

  it('promotes a keyword match that vector search ranked lower', () => {
    // Vector favours /a slightly; the query term only appears in /b.
    const query = normalizeVector([0.62, 0.6, 0.5]);
    const vectorOnly = selectChunksHybrid(query, '', store, { floor: 0, k: 3 });
    const hybrid = selectChunksHybrid(query, 'interceptor pipeline', store, { floor: 0, k: 3 });

    const rankOfB = (rs) => rs.findIndex((r) => r.path === '/b') + 1;
    expect(rankOfB(hybrid)).toBeLessThanOrEqual(rankOfB(vectorOnly));
    expect(hybrid[0].path).toBe('/b');
  });

  it('reports the per-method ranks that produced the ordering', () => {
    const query = normalizeVector([1, 1, 1]);
    const [top] = selectChunksHybrid(query, 'interceptor', store, { floor: 0, k: 3 });
    expect(top.ranks).toHaveProperty('vector');
    expect(top.fusedScore).toBeGreaterThan(0);
  });

  it('applies the per-page cap', () => {
    const wide = {
      dimensions: 3,
      chunks: [
        { id: 'a#1', title: 'A', path: '/a', text: 'one' },
        { id: 'a#2', title: 'A', path: '/a', text: 'two' },
        { id: 'a#3', title: 'A', path: '/a', text: 'three' },
        { id: 'b#1', title: 'B', path: '/b', text: 'four' },
      ],
      vectors: new Float32Array([1, 0, 0, 0.99, 0.1, 0, 0.98, 0.1, 0, 0, 1, 0]),
    };
    const results = selectChunksHybrid(normalizeVector([1, 0, 0]), '', wide, {
      floor: 0,
      k: 3,
      maxPerPage: 2,
    });
    expect(results.filter((r) => r.path === '/a').length).toBeLessThanOrEqual(2);
  });
});
