import { describe, it, expect } from 'vitest';
import {
  extractIdentifiers,
  normalizeIdentifier,
  passageMentions,
  splitClaims,
  verifyAttribution,
} from '../../server/answer-checks.js';

/*
 * Citation attribution.
 *
 * The existing guard in generateAnswer checks that [n] is in RANGE - that a model
 * given 4 passages did not cite [7]. It says nothing about whether the claim in
 * that sentence actually came from passage n. A model can cite [1] for something
 * it read in [3], and the answer looks perfectly sourced.
 *
 * Attribution is checked on CODE IDENTIFIERS rather than prose, deliberately.
 * Prose is legitimately paraphrased, so lexical overlap proves little; API names
 * are not paraphrased, and a misattributed API name is the case that actually
 * misleads someone. Measured on this corpus, 1,179 of 2,276 distinct identifiers
 * appear in exactly one passage, which is what makes the check meaningful.
 *
 * The asymmetry that shapes the design: a MISATTRIBUTION claim requires the
 * identifier to be present in some supplied passage but absent from the cited
 * one, so it cannot be triggered by an invented example variable. An UNSUPPORTED
 * claim has no such protection, so it is only made for identifiers known to
 * exist in the corpus - otherwise every `handleClick()` in an illustrative
 * snippet would be reported as a hallucination.
 */

const chunk = (id, text) => ({ id, title: `Page ${id}`, path: `/p/${id}`, url: '', text });

describe('extractIdentifiers', () => {
  it('finds decorators, calls, camelCase and PascalCase', () => {
    const found = extractIdentifiers(
      'Use @Component with viewChild() and inject the HttpClient via provideRouter.',
    );
    expect(found).toContain('component');
    expect(found).toContain('viewchild');
    expect(found).toContain('httpclient');
    expect(found).toContain('providerouter');
  });

  it('normalises to a bare lowercase name', () => {
    // Casing and punctuation are flattened: '@component' vs '@Component' is a real
    // defect, but it belongs to code-sample validation. Treating them as different
    // identifiers here would invent a misattribution out of a casing slip.
    expect(normalizeIdentifier('@Component')).toBe('component');
    expect(normalizeIdentifier('signal()')).toBe('signal');
    expect(normalizeIdentifier('viewChild')).toBe('viewchild');
  });

  it('does not treat a single capitalised word as an identifier', () => {
    // 'Component' has no internal capital, so PascalCase does not match it - and
    // must not. Extracting every capitalised word would pull in the first word of
    // every sentence.
    expect(extractIdentifiers('Component lifecycle hooks run in order.')).toEqual([]);
  });

  it('ignores ordinary prose', () => {
    const found = extractIdentifiers(
      'Angular components render templates and the framework updates the DOM.',
    );
    expect(found).toEqual([]);
  });

  it('ignores language and tooling names that are not API claims', () => {
    // The PascalCase pattern matches these, but they are prose. Left in, they
    // would be reported as unsupported claims on almost every answer.
    const found = extractIdentifiers('Written in TypeScript, not JavaScript.');
    expect(found).toEqual([]);
  });
});

describe('extraction is conservative, matching is liberal', () => {
  /*
   * This asymmetry is the design, not an accident. Extraction only accepts shapes
   * that are unmistakably code, so prose does not become a claim. Matching accepts
   * any word-boundary mention, so a passage that writes "the Component decorator"
   * still counts as containing '@Component'.
   *
   * Both errors are possible; they are not equally bad. Missing a claim means one
   * fewer thing verified. Inventing one means telling a user a correct answer is
   * misattributed - so the check is built to under-report.
   */
  it('matches a bare mention in a passage for a decorator claim', () => {
    expect(passageMentions('Annotate it with the Component decorator.', 'component')).toBe(true);
  });

  it('matches regardless of case or call parentheses in the passage', () => {
    expect(passageMentions('Call ViewChild to query.', 'viewchild')).toBe(true);
    expect(passageMentions('created by signal()', 'signal')).toBe(true);
  });

  it('does not match a substring of a longer word', () => {
    // 'signal' must not be found inside 'signalling', or nearly every passage
    // would appear to contain nearly every claim.
    expect(passageMentions('the signalling protocol', 'signal')).toBe(false);
  });
});

describe('splitClaims', () => {
  it('pairs each sentence with the citations it carries', () => {
    const claims = splitClaims('Signals are reactive [1]. Effects run on change [2][3].');
    expect(claims).toHaveLength(2);
    expect(claims[0].citations).toEqual([1]);
    expect(claims[1].citations).toEqual([2, 3]);
  });

  it('does not split inside a fenced code block', () => {
    // Sentence splitting on '. ' would tear a code sample into fragments and
    // scatter its identifiers across claims that cite nothing.
    const claims = splitClaims('Use it like this [1]:\n\n```ts\nconst a = x.y();\nconst b = 2;\n```');
    const code = claims.filter((c) => c.isCode);
    expect(code).toHaveLength(1);
    expect(code[0].text).toContain('const b = 2;');
  });

  it('attributes a code block to the citation that introduced it', () => {
    // The citation nearly always sits in the prose lead-in, not in the code.
    const claims = splitClaims('As shown here [2]:\n\n```ts\nviewChild();\n```');
    const code = claims.find((c) => c.isCode);
    expect(code.citations).toEqual([2]);
  });

  it('leaves uncited sentences with no citations rather than guessing', () => {
    const claims = splitClaims('Signals are reactive [1]. Something unsourced.');
    expect(claims[1].citations).toEqual([]);
  });
});

describe('verifyAttribution', () => {
  const chunks = [
    chunk(1, 'Signals are created with the signal() function and read by calling them.'),
    chunk(2, 'Use computed() to derive a value from other signals.'),
    chunk(3, 'The viewChild() query returns a signal for a child element.'),
  ];

  it('passes an answer whose identifiers are in the passages it cites', () => {
    const result = verifyAttribution({
      answer: 'Create one with signal() [1]. Derive with computed() [2].',
      chunks,
    });
    expect(result.ok).toBe(true);
    expect(result.misattributed).toEqual([]);
  });

  it('catches a claim cited to the wrong passage', () => {
    // viewChild() is in passage 3, but the sentence credits passage 1.
    const result = verifyAttribution({
      answer: 'Get a child reference with viewChild() [1].',
      chunks,
    });
    expect(result.ok).toBe(false);
    expect(result.misattributed).toHaveLength(1);
    expect(result.misattributed[0]).toMatchObject({
      identifier: 'viewchild',
      cited: [1],
      actual: [3],
    });
  });

  it('does not flag an identifier the cited passage genuinely contains', () => {
    // signal() appears in passage 1 AND passage 3. Citing either is correct, and
    // a check that demanded the *best* passage would fire on a true statement.
    const result = verifyAttribution({ answer: 'Signals come from signal() [1].', chunks });
    expect(result.misattributed).toEqual([]);
  });

  it('ignores an invented example name rather than calling it misattributed', () => {
    // handleClick() is in no passage, so there is no "correct" passage to point
    // at. Without a known-identifier list this must stay silent.
    const result = verifyAttribution({
      answer: 'Wire it to handleClick() [1] using signal() [1].',
      chunks,
    });
    expect(result.misattributed).toEqual([]);
    expect(result.unsupported).toEqual([]);
  });

  it('reports an unsupported identifier only when it is known to the corpus', () => {
    // takeUntilDestroyed is a real Angular API absent from every supplied
    // passage - so the model produced it from its own memory, not the docs.
    const result = verifyAttribution({
      answer: 'Clean up with takeUntilDestroyed() [1].',
      chunks,
      knownIdentifiers: new Set(['takeuntildestroyed']),
    });
    expect(result.unsupported).toHaveLength(1);
    expect(result.unsupported[0].identifier).toBe('takeuntildestroyed');
    expect(result.ok).toBe(false);
  });

  it('checks identifiers inside code blocks against the introducing citation', () => {
    const result = verifyAttribution({
      answer: 'Like so [1]:\n\n```ts\nconst ref = viewChild();\n```',
      chunks,
    });
    expect(result.misattributed).toHaveLength(1);
    expect(result.misattributed[0].identifier).toBe('viewchild');
  });

  it('says nothing about a sentence that cites nothing', () => {
    // An uncited sentence is the citation guard's problem, not attribution's:
    // there is no claimed source to check against.
    const result = verifyAttribution({ answer: 'You can use viewChild() somewhere.', chunks });
    expect(result.misattributed).toEqual([]);
    expect(result.checked).toBe(0);
  });

  it('reports how many identifier claims it actually checked', () => {
    // Without this, "0 problems" is indistinguishable between a clean answer and
    // a check that examined nothing - the failure mode this whole project keeps
    // running into.
    const result = verifyAttribution({
      answer: 'Use signal() and computed() [1][2].',
      chunks,
    });
    expect(result.checked).toBe(2);
  });

  it('handles an empty answer and no chunks without throwing', () => {
    expect(verifyAttribution({ answer: '', chunks: [] }).ok).toBe(true);
    expect(verifyAttribution({ answer: 'x [1].', chunks: [] }).ok).toBe(true);
  });

  it('makes no unsupported finding without a known-identifier set', () => {
    /*
     * The production wiring passes null here on purpose - see UNGROUNDED_CHECK_ENABLED
     * in index.js. This test pins that omitting the set means "do not guess",
     * rather than falling back to flagging every unfamiliar name.
     */
    const result = verifyAttribution({
      answer: 'Clean up with takeUntilDestroyed() [1].',
      chunks,
    });
    expect(result.unsupported).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe('the ungrounded-mention check, and why it is off', () => {
  /*
   * Measured over 30 questions it produced 2 findings, both FALSE POSITIVES:
   * 'mySignal' and 'DataService'. Both are example names, and both are in the
   * corpus - because Angular's own docs use example names - so "known to the
   * corpus" does not separate a real API from an invented variable.
   *
   * The obvious repair, requiring an identifier to appear on several distinct
   * pages, fails too. These are the measured page counts. They are recorded as a
   * test so the idea is not quietly retried: reading the numbers is faster than
   * re-running the experiment, and the conclusion is a property of the corpus.
   */
  const PAGES_PER_IDENTIFIER = {
    // Genuine APIs, including the rarest ones.
    signal: 2,
    takeuntildestroyed: 2,
    hostlistener: 2,
    computed: 3,
    viewchild: 11,
    httpclient: 11,
    // Flagged by the check, but example names rather than APIs.
    mysignal: 3,
    dataservice: 3,
  };

  const realApis = ['signal', 'takeuntildestroyed', 'hostlistener', 'computed', 'viewchild'];
  const exampleNames = ['mysignal', 'dataservice'];

  it('has no page-count threshold that keeps every API and drops the example names', () => {
    for (const min of [2, 3, 4, 5]) {
      const keepsAllApis = realApis.every((id) => PAGES_PER_IDENTIFIER[id] >= min);
      const dropsExamples = exampleNames.every((id) => PAGES_PER_IDENTIFIER[id] < min);
      expect(
        keepsAllApis && dropsExamples,
        `a threshold of ${min} pages was expected to fail, and did not`,
      ).toBe(false);
    }
  });

  it('overlaps because the rarest real APIs are rarer than the example names', () => {
    const rarestApi = Math.min(...realApis.map((id) => PAGES_PER_IDENTIFIER[id]));
    const commonestExample = Math.max(...exampleNames.map((id) => PAGES_PER_IDENTIFIER[id]));
    expect(rarestApi).toBeLessThan(commonestExample);
  });
});
