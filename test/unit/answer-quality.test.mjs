import { describe, it, expect } from 'vitest';
import {
  expectedStatusFor,
  mentionsAny,
  scoreAnswer,
  aggregate,
} from '../../server/answer-quality.js';

/*
 * Measuring ANSWER quality, not retrieval quality.
 *
 * Everything measured so far stops at "did the right page rank". Generation was
 * only ever tested by contract - statuses, citation handling, prompt structure -
 * with a fake model. Nothing scored whether the prose was any good, which is why a
 * single thumbs-down found a defect that every automatic signal had rated
 * `answered` with high confidence.
 *
 * The problem: answer quality is not deterministic, so it cannot be a gating test.
 * The response is to score it with a SCRIPT over the eval sets, on metrics that are
 * themselves deterministic given an answer. The stochastic part is confined to
 * producing the answer; scoring it is exact and free.
 *
 * Four metrics, in descending order of how much they tell you:
 *
 *   1. status accuracy   - did the system answer / refuse / hedge as it should?
 *                          This measures the three-outcome design directly, and it
 *                          is the one that catches confident nonsense.
 *   2. must-mention      - does a correct answer name the thing it has to name?
 *                          A human-authored rubric per question. Objective, but
 *                          only as good as the rubric.
 *   3. citation coverage - does an answered answer cite anything at all?
 *   4. refusal purity    - does a refusal invent citations? It must not.
 *
 * Deliberately NOT an LLM judge. That would make the measurement itself stochastic
 * and provider-dependent, so a change in the judge would look like a change in the
 * system - the failure this project has already been bitten by three times.
 */

describe('expectedStatusFor', () => {
  it('maps the eval set outcome types onto server statuses', () => {
    expect(expectedStatusFor('match')).toBe('answered');
    expect(expectedStatusFor('none')).toBe('refused');
    // 'weak' - retrieval finds pages, but none answer the question.
    expect(expectedStatusFor('weak')).toBe('partial');
  });

  it('returns null for an unknown type rather than guessing', () => {
    expect(expectedStatusFor('something-else')).toBeNull();
  });
});

describe('mentionsAny', () => {
  it('matches on a word boundary, case-insensitively', () => {
    expect(mentionsAny('Use the signal() function.', ['signal'])).toBe(true);
    expect(mentionsAny('Use SIGNAL to do it.', ['signal'])).toBe(true);
  });

  it('does not match a substring of a longer word', () => {
    // Otherwise "signalling" would satisfy a requirement to mention "signal".
    expect(mentionsAny('the signalling protocol', ['signal'])).toBe(false);
  });

  it('accepts any one of several alternatives', () => {
    /*
     * Requirements are alternative-groups because a correct answer may legitimately
     * phrase a thing differently. Demanding one exact spelling would score correct
     * answers as failures, which is the same mistake as asserting exact pages
     * instead of acceptable path sets.
     */
    const alternatives = ['signal()', 'signal function'];
    expect(mentionsAny('created with the signal function', alternatives)).toBe(true);
    expect(mentionsAny('created with signal()', alternatives)).toBe(true);
    expect(mentionsAny('created with a store', alternatives)).toBe(false);
  });

  it('handles regex metacharacters in a requirement', () => {
    // '@Input()' and 'signal()' contain characters that would otherwise be parsed.
    expect(mentionsAny('use @Input() here', ['@Input()'])).toBe(true);
    expect(mentionsAny('nothing relevant', ['@Input()'])).toBe(false);
  });
});

describe('scoreAnswer', () => {
  const chunks = [
    { path: '/guide/signals', text: 'Signals are created with the signal() function.' },
    { path: '/guide/signals', text: 'Use computed() to derive a value.' },
  ];

  it('scores a good answer as correct on every metric', () => {
    const r = scoreAnswer({
      expect: 'match',
      mustMention: [['signal()']],
      status: 'answered',
      answer: 'Create one with signal() [1].',
      citations: [1],
      chunks,
    });
    expect(r.statusCorrect).toBe(true);
    expect(r.mentioned).toBe(1);
    expect(r.required).toBe(1);
    expect(r.citesSomething).toBe(true);
    expect(r.ok).toBe(true);
  });

  it('catches the case that matters most: answering when it should refuse', () => {
    // Confident nonsense. Retrieval metrics cannot see this at all.
    const r = scoreAnswer({
      expect: 'none',
      status: 'answered',
      answer: 'Milk is a dairy product [1].',
      citations: [1],
      chunks,
    });
    expect(r.statusCorrect).toBe(false);
    expect(r.ok).toBe(false);
  });

  it('catches refusing when it should have answered', () => {
    const r = scoreAnswer({
      expect: 'match',
      mustMention: [['signal()']],
      status: 'refused',
      answer: 'Not in these docs.',
      citations: [],
      chunks,
    });
    expect(r.statusCorrect).toBe(false);
  });

  it('reports a partial answer as correct for an adjacent question', () => {
    // "What does CSS stand for?" - pages clear the floor, none answer it.
    const r = scoreAnswer({
      expect: 'weak',
      status: 'partial',
      answer: 'I could not find an answer, but these pages came closest.',
      citations: [],
      chunks,
    });
    expect(r.statusCorrect).toBe(true);
    expect(r.ok).toBe(true);
  });

  it('does not require citations from a refusal', () => {
    // A refusal has nothing to cite; demanding coverage would penalise it.
    const r = scoreAnswer({
      expect: 'none', status: 'refused', answer: 'Not in these docs.',
      citations: [], chunks: [],
    });
    expect(r.citesSomething).toBeNull();
    expect(r.ok).toBe(true);
  });

  it('flags a refusal that invented citations', () => {
    // Nothing was retrieved, so any citation at all is fabricated.
    const r = scoreAnswer({
      expect: 'none', status: 'refused', answer: 'Nothing here [1].',
      citations: [1], chunks: [],
    });
    expect(r.refusalPure).toBe(false);
    expect(r.ok).toBe(false);
  });

  it('counts a partly-complete answer honestly rather than pass/fail', () => {
    /*
     * Two of three requirements met is real information - it says the answer was
     * on topic but incomplete. Collapsing that to "failed" would throw away the
     * distinction between incomplete and wrong.
     */
    const r = scoreAnswer({
      expect: 'match',
      mustMention: [['signal()'], ['computed()'], ['effect()']],
      status: 'answered',
      answer: 'Use signal() and computed() [1][2].',
      citations: [1, 2],
      chunks,
    });
    expect(r.mentioned).toBe(2);
    expect(r.required).toBe(3);
    expect(r.missing).toEqual([['effect()']]);
    expect(r.ok).toBe(false);
  });

  /*
   * Judging generation on what retrieval actually handed it.
   *
   * The first real run marked a question as failing - expected `answered`, got
   * `partial` - on the one question retrieval misses. The passages genuinely did
   * not contain the answer, so hedging was correct and honest behaviour. The
   * metric was blaming generation for retrieval's failure, which is exactly the
   * conflation that makes RAG feel unmeasurable.
   */
  describe('when retrieval missed', () => {
    it('accepts a hedge as the correct outcome', () => {
      const r = scoreAnswer({
        expect: 'match',
        mustMention: [['hostDirectives']],
        retrievalHit: false,
        status: 'partial',
        answer: 'I could not find an answer, but these pages came closest.',
        citations: [],
        chunks,
      });
      expect(r.statusCorrect).toBe(true);
      expect(r.retrievalMissed).toBe(true);
      expect(r.ok).toBe(true);
    });

    it('accepts a refusal too, since either is honest', () => {
      const r = scoreAnswer({
        expect: 'match', retrievalHit: false, status: 'refused',
        answer: 'Not in these docs.', citations: [], chunks: [],
      });
      expect(r.statusCorrect).toBe(true);
    });

    it('still fails an answer invented from nothing', () => {
      // The defect that matters: retrieval gave it nothing and it answered anyway.
      const r = scoreAnswer({
        expect: 'match', retrievalHit: false, status: 'answered',
        answer: 'Use hostDirectives [1].', citations: [1], chunks,
      });
      expect(r.statusCorrect).toBe(false);
      expect(r.ok).toBe(false);
    });

    it('does not score the content rubric at all', () => {
      /*
       * Nothing supplied could have satisfied it, so counting it would depress
       * must-mention recall for a reason generation could not act on.
       */
      const r = scoreAnswer({
        expect: 'match',
        mustMention: [['hostDirectives'], ['directive composition']],
        retrievalHit: false,
        status: 'partial', answer: 'Could not find it.', citations: [], chunks,
      });
      expect(r.required).toBe(0);
      expect(r.hasRubric).toBe(false);
      expect(r.missing).toEqual([]);
    });

    it('scores normally when retrieval succeeded', () => {
      const r = scoreAnswer({
        expect: 'match', mustMention: [['signal()']], retrievalHit: true,
        status: 'answered', answer: 'Use signal() [1].', citations: [1], chunks,
      });
      expect(r.retrievalMissed).toBe(false);
      expect(r.required).toBe(1);
      expect(r.ok).toBe(true);
    });

    it('is inert when retrieval success is unknown', () => {
      // Callers that cannot determine it must get the old behaviour, not a
      // silently different standard.
      const r = scoreAnswer({
        expect: 'match', mustMention: [['signal()']],
        status: 'answered', answer: 'Use signal() [1].', citations: [1], chunks,
      });
      expect(r.retrievalMissed).toBe(false);
      expect(r.required).toBe(1);
    });
  });

  it('treats a question with no rubric as unscored, not as passing', () => {
    // Otherwise questions nobody wrote requirements for inflate the score.
    const r = scoreAnswer({
      expect: 'match', status: 'answered', answer: 'Something.', citations: [1], chunks,
    });
    expect(r.required).toBe(0);
    expect(r.mentioned).toBe(0);
    expect(r.hasRubric).toBe(false);
  });
});

describe('aggregate', () => {
  const results = [
    { statusCorrect: true, hasRubric: true, required: 2, mentioned: 2, citesSomething: true, refusalPure: true },
    { statusCorrect: false, hasRubric: true, required: 2, mentioned: 1, citesSomething: true, refusalPure: true },
    { statusCorrect: true, hasRubric: false, required: 0, mentioned: 0, citesSomething: null, refusalPure: true },
  ];

  it('reports status accuracy across every question', () => {
    expect(aggregate(results).statusAccuracy).toBeCloseTo(2 / 3);
  });

  it('computes must-mention recall over requirements, not questions', () => {
    // 3 of 4 required terms across the two questions that have a rubric.
    expect(aggregate(results).mentionRecall).toBeCloseTo(3 / 4);
  });

  it('reports how many questions actually had a rubric', () => {
    /*
     * The same discipline as every other check here: a score computed over 2 of 3
     * questions must not look like a score over all 3.
     */
    const a = aggregate(results);
    expect(a.scored).toBe(2);
    expect(a.total).toBe(3);
  });

  it('excludes questions with nothing to cite from citation coverage', () => {
    expect(aggregate(results).citationCoverage).toBeCloseTo(1);
  });

  it('survives an empty result set without dividing by zero', () => {
    const a = aggregate([]);
    expect(a.statusAccuracy).toBe(0);
    expect(a.mentionRecall).toBe(0);
    expect(a.total).toBe(0);
  });
});
