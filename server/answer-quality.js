/*
 * Scoring the ANSWER, not the retrieval.
 *
 * Everything measured until now stopped at "did the right page rank". Generation
 * was tested only by contract - statuses, citation handling, prompt structure -
 * against a fake model. Nothing scored whether the prose was any good, and that
 * gap is why a single thumbs-down found a defect every automatic signal had rated
 * `answered` with high confidence.
 *
 * Why this is a script and not a test
 * -----------------------------------
 * Producing an answer is stochastic and costs money, so it cannot gate a commit.
 * But SCORING an answer, once you have it, is deterministic and free. So the
 * stochastic part is confined to generation and everything here is exact - which
 * also means these functions are unit-testable without a network.
 *
 * Why not an LLM judge
 * --------------------
 * Because it would make the measurement itself stochastic and provider-dependent.
 * A change in the judge would then be indistinguishable from a change in the
 * system, and this project has already been bitten three times by a measurement
 * that was the broken thing. A human-authored rubric is weaker in coverage and far
 * stronger in interpretability: when the number moves you know exactly why.
 *
 * The honest limitation: must-mention is only as good as the rubric someone wrote,
 * and it says nothing about whether the prose is clear, well-ordered or pleasant.
 * It catches wrong and incomplete, not ugly.
 */

/**
 * The eval sets already carry the outcome each question should produce. Reusing
 * that rather than adding a second field keeps one source of truth - the retrieval
 * suite and the answer suite cannot disagree about what a question is.
 */
const STATUS_BY_EXPECTATION = {
  match: 'answered', // a real question the docs cover
  none: 'refused', // nothing clears the floor; the model is never called
  weak: 'partial', // pages clear the floor, none answer the question
};

function expectedStatusFor(expectation) {
  return STATUS_BY_EXPECTATION[expectation] ?? null;
}

/**
 * Does the text contain any one of these alternatives, as a whole word?
 *
 * Alternatives exist because a correct answer may legitimately phrase something
 * differently - "the signal function" versus "signal()". Demanding one exact
 * spelling would score correct answers as failures, the same mistake as asserting
 * one exact page instead of a set of acceptable ones.
 */
function mentionsAny(text, alternatives) {
  const haystack = text || '';
  return alternatives.some((raw) => {
    const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    /*
     * \b is only meaningful next to a word character. '@Input()' ends in ')', so a
     * trailing \b would never match - hence the boundaries are applied
     * conditionally on what the requirement actually starts and ends with.
     */
    const left = /^\w/.test(raw) ? '\\b' : '';
    const right = /\w$/.test(raw) ? '\\b' : '';
    return new RegExp(`${left}${escaped}${right}`, 'i').test(haystack);
  });
}

/**
 * Score one answer.
 *
 * `mustMention` is a list of alternative-GROUPS: every group must be satisfied by
 * at least one of its alternatives. Reported as a count rather than pass/fail,
 * because "two of three requirements met" says the answer was on topic but
 * incomplete, and collapsing that to "failed" throws away the difference between
 * incomplete and wrong.
 */
function scoreAnswer({
  expect: expectation,
  mustMention = [],
  status,
  answer = '',
  citations = [],
  chunks = [],
  retrievalHit = null,
}) {
  /*
   * Judge generation on what it was GIVEN.
   *
   * The first run of this scorer marked "how do I attach a directive without
   * putting it in the template?" as a failure: expected `answered`, got `partial`.
   * But that is the one question retrieval misses - the passages genuinely did not
   * contain the answer, so `partial` was correct and honest. The metric was
   * blaming generation for retrieval's failure, which is precisely the conflation
   * that makes RAG feel unmeasurable.
   *
   * So when retrieval missed, the standard inverts: refusing or hedging is RIGHT,
   * answering anyway is the defect, and the content rubric is not scored at all
   * because nothing supplied could have satisfied it.
   */
  const retrievalMissed = expectation === 'match' && retrievalHit === false;

  const expectedStatus = retrievalMissed ? 'partial' : expectedStatusFor(expectation);
  const statusCorrect =
    expectedStatus === null
      ? null
      : retrievalMissed
        // Either honest outcome is acceptable; only inventing an answer is not.
        ? status === 'partial' || status === 'refused'
        : status === expectedStatus;

  const scoredRubric = retrievalMissed ? [] : mustMention;
  const missing = scoredRubric.filter((group) => !mentionsAny(answer, group));
  const mentioned = scoredRubric.length - missing.length;

  /*
   * Citation coverage only applies where there was something to cite. A refusal
   * has no passages, so demanding a citation would penalise correct behaviour;
   * null means "not applicable" rather than "failed".
   */
  const citesSomething = status === 'answered' && chunks.length > 0 ? citations.length > 0 : null;

  // A refusal must not invent sources. Nothing was retrieved, so any citation is
  // fabricated by definition.
  const refusalPure = status === 'refused' ? citations.length === 0 : true;

  return {
    statusCorrect,
    expectedStatus,
    actualStatus: status,
    /** True when generation was judged for hedging after retrieval failed it. */
    retrievalMissed,
    hasRubric: scoredRubric.length > 0,
    required: scoredRubric.length,
    mentioned,
    missing,
    citesSomething,
    refusalPure,
    ok:
      statusCorrect !== false &&
      refusalPure &&
      citesSomething !== false &&
      missing.length === 0,
  };
}

/**
 * Roll per-question results into metrics.
 *
 * Every rate reports its denominator alongside it. A score computed over 2 of 3
 * questions must not be presentable as a score over all 3 - the same discipline
 * that turned "0 problems found" into "0 problems found, 19 claims checked".
 */
function aggregate(results) {
  const total = results.length;
  if (total === 0) {
    return {
      total: 0, scored: 0, statusAccuracy: 0, mentionRecall: 0,
      citationCoverage: 0, refusalPurity: 0, requirements: 0, met: 0,
    };
  }

  const statusJudged = results.filter((r) => r.statusCorrect !== null);
  const withRubric = results.filter((r) => r.hasRubric);
  const citable = results.filter((r) => r.citesSomething !== null);

  const requirements = withRubric.reduce((n, r) => n + r.required, 0);
  const met = withRubric.reduce((n, r) => n + r.mentioned, 0);

  const rate = (n, d) => (d === 0 ? 0 : n / d);

  return {
    total,
    scored: withRubric.length,
    statusJudged: statusJudged.length,
    statusAccuracy: rate(statusJudged.filter((r) => r.statusCorrect).length, statusJudged.length),
    requirements,
    met,
    mentionRecall: rate(met, requirements),
    citationCoverage: rate(citable.filter((r) => r.citesSomething).length, citable.length),
    refusalPurity: rate(results.filter((r) => r.refusalPure).length, total),
  };
}

module.exports = { STATUS_BY_EXPECTATION, expectedStatusFor, mentionsAny, scoreAnswer, aggregate };
