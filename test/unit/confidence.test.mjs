import { describe, it, expect } from 'vitest';
import { assessConfidence } from '../../server/rag.js';

/*
 * Confidence is a COMPOSITE signal, and these tests exist mainly to stop it
 * regressing into "confidence = top similarity score".
 *
 * That version would be actively misleading, and this repo measured why:
 *
 *   "What does CSS stand for?"                 top 0.457  <- unanswerable
 *   "how do I loop over a list in a template?" top 0.475  <- correct answer
 *
 * A 0.018 gap. Similarity measures topical closeness, not whether the answer is
 * actually present, so the model's own verdict (status) has to outrank it.
 */

const results = (...scores) =>
  scores.map((score, i) => ({ path: `/page-${i}`, score, text: 't' }));

describe('assessConfidence', () => {
  it('reports none when nothing was retrieved', () => {
    const c = assessConfidence({ status: 'refused', results: [], citations: [] });
    expect(c.level).toBe('none');
  });

  it('reports low for a partial answer regardless of how well it scored', () => {
    // The decisive case. These scores would look excellent on their own, but the
    // model has already said the passages do not answer the question.
    const c = assessConfidence({
      status: 'partial',
      results: results(0.62, 0.6, 0.58),
      citations: [],
    });
    expect(c.level).toBe('low');
    expect(c.reasons.join(' ')).toMatch(/none answered/i);
  });

  it('never lets a high score outrank the model verdict', () => {
    const partial = assessConfidence({
      status: 'partial',
      results: results(0.9, 0.89, 0.88),
      citations: [],
    });
    const answered = assessConfidence({
      status: 'answered',
      results: results(0.42),
      citations: [1],
    });
    // A weak-but-answered result must beat a strong-but-unanswered one.
    expect(partial.level).toBe('low');
    expect(['medium', 'high']).toContain(answered.level);
  });

  it('reports high for a well-cited, well-corroborated answer', () => {
    const c = assessConfidence({
      status: 'answered',
      results: results(0.58, 0.42, 0.4, 0.39),
      citations: [1, 2],
    });
    expect(c.level).toBe('high');
    expect(c.reasons.join(' ')).toMatch(/cites 2 passages/i);
  });

  it('drops to low when an answer cites nothing', () => {
    // Uncited prose is unsupported, however well retrieval scored.
    const c = assessConfidence({
      status: 'answered',
      results: results(0.44, 0.43),
      citations: [],
    });
    expect(c.level).toBe('low');
    expect(c.reasons.join(' ')).toMatch(/cites no passage/i);
  });

  it('rewards corroboration across several distinct pages', () => {
    const spread = assessConfidence({
      status: 'answered',
      results: [
        { path: '/a', score: 0.52 },
        { path: '/b', score: 0.45 },
        { path: '/c', score: 0.44 },
      ],
      citations: [1],
    });
    const singlePage = assessConfidence({
      status: 'answered',
      results: [
        { path: '/a', score: 0.52 },
        { path: '/a', score: 0.45 },
        { path: '/a', score: 0.44 },
      ],
      citations: [1],
    });
    expect(spread.signals.distinctPages).toBe(3);
    expect(singlePage.signals.distinctPages).toBe(1);
    expect(spread.reasons.join(' ')).toMatch(/corroborated/i);
    expect(singlePage.reasons.join(' ')).not.toMatch(/corroborated/i);
  });

  it('computes the gap between the top hit and the rest', () => {
    const c = assessConfidence({
      status: 'answered',
      results: results(0.6, 0.3, 0.3),
      citations: [1],
    });
    // 0.6 - mean(0.3, 0.3) = 0.3
    expect(c.signals.scoreGap).toBeCloseTo(0.3, 4);
    expect(c.reasons.join(' ')).toMatch(/stands clearly above/i);
  });

  it('exposes its inputs so the verdict can be inspected', () => {
    const c = assessConfidence({
      status: 'answered',
      results: results(0.5, 0.4),
      citations: [1],
    });
    expect(c.signals).toMatchObject({
      status: 'answered',
      topScore: 0.5,
      distinctPages: 2,
      citationCount: 1,
    });
    expect(Array.isArray(c.reasons)).toBe(true);
  });

  it('always returns one of the documented levels', () => {
    for (const status of ['answered', 'partial', 'refused']) {
      for (const citations of [[], [1], [1, 2]]) {
        const c = assessConfidence({ status, results: results(0.5, 0.3), citations });
        expect(['none', 'low', 'medium', 'high']).toContain(c.level);
      }
    }
  });

  /*
   * Attribution is the one signal that only ever subtracts, and it CAPS the level
   * rather than deducting a point. The reasoning: the other signals describe how
   * well retrieval went, whereas a misattributed citation means the badge is
   * vouching for a source that does not support the claim - which is the specific
   * thing a confidence indicator invites someone to rely on.
   */
  describe('attribution lowers confidence', () => {
    // Deliberately an otherwise-perfect answer: strong score, wide gap, several
    // pages, two citations. Everything says 'high' except attribution.
    const strong = {
      status: 'answered',
      results: results(0.62, 0.3, 0.28, 0.27),
      citations: [1, 2],
    };

    it('rates a well-supported answer high when attribution is clean', () => {
      const c = assessConfidence({
        ...strong,
        attribution: { misattributed: [], unsupported: [] },
      });
      expect(c.level).toBe('high');
    });

    it('caps an otherwise-high answer at low when a citation is misattributed', () => {
      const c = assessConfidence({
        ...strong,
        attribution: { misattributed: [{ identifier: 'viewchild' }], unsupported: [] },
      });
      expect(c.level).toBe('low');
      expect(c.reasons.join(' ')).toMatch(/wrong passage/i);
    });

    it('only steps down one level for an ungrounded API mention', () => {
      // Weaker finding than misattribution: the model named a real API the
      // passages never mentioned. Suggestive of memory rather than a wrong source.
      const c = assessConfidence({
        ...strong,
        attribution: { misattributed: [], unsupported: [{ identifier: 'takeuntildestroyed' }] },
      });
      expect(c.level).toBe('medium');
      expect(c.reasons.join(' ')).toMatch(/not present in the cited passages/i);
    });

    it('reports misattribution rather than the weaker finding when both occur', () => {
      const c = assessConfidence({
        ...strong,
        attribution: {
          misattributed: [{ identifier: 'viewchild' }],
          unsupported: [{ identifier: 'takeuntildestroyed' }],
        },
      });
      expect(c.level).toBe('low');
      expect(c.reasons.join(' ')).toMatch(/wrong passage/i);
      expect(c.reasons.join(' ')).not.toMatch(/not present in the cited passages/i);
    });

    it('behaves exactly as before when no attribution is supplied', () => {
      // The parameter is optional, so an older caller must not be penalised for
      // omitting it - absence of evidence is not a finding.
      expect(assessConfidence(strong).level).toBe('high');
      expect(assessConfidence(strong).signals.misattributed).toBe(0);
    });
  });
});
