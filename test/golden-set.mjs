/*
 * The golden set: fixed questions with the retrieval outcome each should produce.
 *
 * Single source of truth, read by both
 *   scripts/build-golden-fixture.js  (embeds the questions once)
 *   test/retrieval.test.mjs          (asserts against the cached vectors)
 *
 * Three outcome types, because a set of only positive cases does not cover the
 * ground. A retriever that returns its five least-bad chunks for EVERY question
 * would score perfectly on positives alone while being useless in practice - the
 * ability to return nothing is as important as the ability to return the right
 * thing.
 *
 *   'match' - a real Angular question. At least one acceptable page must appear
 *             in the top 3, and the top score must clear STRONG_SCORE.
 *
 *   'none'  - nothing to do with the corpus. NO chunk may clear the floor, so the
 *             server refuses without ever calling the language model.
 *
 *   'weak'  - superficially related to something in the docs, but not actually
 *             answered by them. Chunks DO clear the floor, so retrieval alone
 *             cannot catch this; the generation layer has to.
 *
 * Paths are prefixes, not exact pages. "How do I make an HTTP request?" is
 * legitimately answered by /guide/http or /guide/http/making-requests, and
 * demanding one exact page would punish correct behaviour.
 *
 * A hypothesis this suite disproved
 * ---------------------------------
 * The 'weak' case was originally asserted as a SCORE BAND: adjacent questions
 * would retrieve something, but score low enough to be distinguishable from a
 * real match. That turned out to be false, and the test caught it.
 *
 * "What does CSS stand for?" scores 0.457 - higher than several genuine Angular
 * questions - because /guide/components/styling and /best-practices/security
 * really are about CSS. Retrieval is behaving correctly. What's missing is the
 * definition of an acronym, which is a fact about the world rather than about
 * Angular, and no similarity threshold can express that difference.
 *
 * So no threshold is tuned to make this pass. The suite instead asserts the true
 * shape of the problem: these questions retrieve confidently, which is exactly
 * why the prompt-level grounding is load-bearing rather than a nicety. The
 * server answers them with status 'partial' - "I could not find an answer, but
 * these pages came closest".
 */

/** Retrieval settings under test. Keep in sync with server/index.js. */
export const SCORE_FLOOR = 0.25;

/** A confident match should clear this. Observed strong matches sit near 0.47. */
export const STRONG_SCORE = 0.38;

export const GOLDEN_SET = [
  // ---- real questions ---------------------------------------------------
  {
    question: 'what are signals?',
    expect: 'match',
    acceptablePaths: ['/guide/signals', '/essentials/signals'],
  },
  {
    question: 'how do I react to a signal changing?',
    expect: 'match',
    acceptablePaths: ['/guide/signals/effect', '/guide/signals'],
  },
  {
    /*
     * KNOWN MISS, left failing on purpose.
     *
     * /guide/components/inputs is retrieved, but at rank 5 - outside the top 3.
     * Ranks 1-4 are generic component-overview pages, led by
     * /essentials/components at 0.533.
     *
     * It would be easy to "fix" by adding /essentials/components to the
     * acceptable list, and wrong: that page mentions "input" exactly once, in
     * the sense of handling USER input, and never covers @Input or input().
     * It does not answer the question.
     *
     * The real cause is vocabulary mismatch - the question says "pass data",
     * the page says "input" - which pure vector search handles poorly. The
     * genuine fixes are hybrid lexical+vector retrieval or reranking, both of
     * which are candidates in the roadmap. Until then this stays a documented
     * miss rather than a widened expectation.
     */
    question: 'how do I pass data into a component?',
    expect: 'match',
    acceptablePaths: ['/guide/components/inputs', '/guide/signals/inputs'],
    knownMiss: 'retrieved at rank 5; generic component pages outrank it',
  },
  {
    question: 'how do I loop over a list in a template?',
    expect: 'match',
    acceptablePaths: ['/guide/templates/control-flow'],
  },
  {
    question: 'how does two-way binding work?',
    expect: 'match',
    acceptablePaths: ['/guide/templates/two-way-binding'],
  },
  {
    question: 'how do I validate a form?',
    expect: 'match',
    acceptablePaths: ['/guide/forms/form-validation', '/guide/forms/signals/validation'],
  },
  {
    question: 'what are reactive forms?',
    expect: 'match',
    acceptablePaths: ['/guide/forms/reactive-forms', '/guide/forms'],
  },
  {
    question: 'how do I protect a route from unauthorised users?',
    expect: 'match',
    acceptablePaths: ['/guide/routing/route-guards'],
  },
  {
    question: 'how do I make an HTTP request?',
    expect: 'match',
    acceptablePaths: ['/guide/http', '/guide/http/making-requests'],
  },
  {
    question: 'how do I add an HTTP interceptor?',
    expect: 'match',
    acceptablePaths: ['/guide/http/interceptors'],
  },
  {
    question: 'how do I create an injectable service?',
    expect: 'match',
    acceptablePaths: ['/guide/di', '/essentials/dependency-injection'],
  },
  {
    question: 'what is content projection?',
    expect: 'match',
    acceptablePaths: ['/guide/components/content-projection', '/guide/templates/ng-content'],
  },
  {
    question: 'what is a structural directive?',
    expect: 'match',
    acceptablePaths: ['/guide/directives/structural-directives', '/guide/directives'],
  },

  // ---- nothing to do with Angular --------------------------------------
  {
    question: 'Got milk?',
    expect: 'none',
    why: 'No overlap with the corpus at all. Every chunk must fall below the floor so the server refuses without calling the model.',
  },

  // ---- adjacent but not answered ---------------------------------------
  {
    question: 'What does CSS stand for?',
    expect: 'weak',
    why: 'The docs discuss component styling and CSS injection at length, so passages clear the floor with a confident 0.457 - but none define the acronym. Retrieval cannot catch this; the model has to notice and return status "partial", offering the closest pages instead of an answer.',
  },
];

export const MATCH_QUESTIONS = GOLDEN_SET.filter((q) => q.expect === 'match');
