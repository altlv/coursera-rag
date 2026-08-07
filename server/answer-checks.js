/*
 * Checks applied to a generated answer, after the model has written it.
 *
 * The citation guard in rag.js verifies that [n] is in RANGE. That catches a model
 * citing [7] when it was given 4 passages, and nothing else. It does not check
 * that the claim in a sentence actually came from the passage that sentence
 * credits - so an answer can cite [1] for something it read in [3], or for
 * something no passage said at all, and look properly sourced either way.
 *
 * Why identifiers rather than prose
 * --------------------------------
 * Prose is legitimately paraphrased. "Signals hold a value that can change over
 * time" may be a faithful rendering of a passage that shares almost no words with
 * it, so lexical overlap on prose measures writing style more than grounding.
 *
 * API names are not paraphrased. `viewChild()` is either in the passage or it is
 * not, and a misattributed API name is precisely the case that misleads a reader
 * into trusting the wrong page. Measured on this corpus, 1,179 of 2,276 distinct
 * identifiers appear in exactly one passage - selective enough for presence to
 * mean something.
 *
 * This is a deliberate scope limit, not full attribution verification. An answer
 * can still misattribute a purely prose claim and pass.
 *
 * The asymmetry that shapes the two findings
 * -----------------------------------------
 * MISATTRIBUTED requires the identifier to be present in some supplied passage and
 * absent from the cited one. That makes it precise by construction: an invented
 * example variable is in no passage, so there is no "correct" passage to point at
 * and nothing is reported.
 *
 * UNSUPPORTED has no such protection. Every illustrative `handleClick()` a model
 * writes is absent from the passages, and reporting those would bury the real
 * signal. So an unsupported claim is only made for identifiers known to exist in
 * the corpus: if the API is real, and documented somewhere, and yet not in any
 * passage we supplied, the model produced it from its own memory. That is the
 * grounding failure worth knowing about.
 */

const { SUPERSEDED_APIS } = require('./api-pairs');

/*
 * Four shapes, chosen by probing the corpus rather than guessing. Each was checked
 * for what it drags in as well as what it catches:
 *
 *   decorator  @Component, @ViewChild          24 distinct in the corpus
 *   call       signal(), viewChild()           424
 *   camel      provideRouter, ngOnInit       1,146
 *   pascal     HttpClient, FormControl         682
 */
const IDENTIFIER_PATTERNS = [
  /@[A-Z][A-Za-z0-9]*/g,
  /\b[a-z][A-Za-z0-9]*\(\)/g,
  /\b[a-z]+[A-Z][A-Za-z0-9]*\b/g,
  /\b[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*\b/g,
];

/*
 * Matched by the PascalCase shape but not API claims. Left in, these would be
 * reported as unsupported on nearly every answer, because a model mentions the
 * language far more often than the passages happen to.
 */
const PROSE_STOPLIST = new Set([
  'typescript',
  'javascript',
  'webpack',
  'nodejs',
  'github',
  'stackblitz',
  'vscode',
  'webstorm',
  'intellij',
  'macos',
  'windows',
  'linux',
  'chromedevtools',
  'devtools',
]);

/**
 * Reduce an identifier to a comparable key: no `@`, no `()`, lowercased.
 *
 * Casing is flattened on purpose. `@component` versus `@Component` is a real
 * defect, but it belongs to code-sample validation - treating them as different
 * identifiers here would invent a misattribution out of a casing slip.
 */
function normalizeIdentifier(raw) {
  return raw.replace(/^@/, '').replace(/\(\)$/, '').toLowerCase();
}

/** Distinct normalised identifiers in a piece of text, in first-seen order. */
function extractIdentifiers(text) {
  const found = [];
  const seen = new Set();
  for (const pattern of IDENTIFIER_PATTERNS) {
    for (const match of (text || '').matchAll(pattern)) {
      const key = normalizeIdentifier(match[0]);
      if (key.length < 3 || PROSE_STOPLIST.has(key) || seen.has(key)) continue;
      seen.add(key);
      found.push(key);
    }
  }
  return found;
}

/** Does this passage mention the identifier at all? Word-boundary, case-insensitive. */
function passageMentions(text, identifier) {
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(text);
}

const CITATION_RE = /\[(\d+)\]/g;

function citationsIn(text) {
  const found = new Set();
  for (const m of text.matchAll(CITATION_RE)) found.add(Number(m[1]));
  return [...found].sort((a, b) => a - b);
}

/**
 * Break an answer into claims: sentences of prose, plus fenced code blocks whole.
 *
 * Two rules earn their place:
 *
 *  - Fenced code is never split. Sentence splitting on '. ' would tear a sample
 *    into fragments and scatter its identifiers across claims citing nothing.
 *  - A claim with no citation of its own inherits the most recent one. The
 *    citation for a code sample almost always sits in the prose lead-in
 *    ("As shown here [2]:"), so a code block that inherited nothing would be
 *    unattributable in the common case rather than the rare one.
 */
function splitClaims(answer) {
  const claims = [];
  const blocks = (answer || '').split(/(```[\s\S]*?```)/g);

  for (const block of blocks) {
    if (!block.trim()) continue;

    if (block.startsWith('```')) {
      claims.push({ text: block, citations: citationsIn(block), isCode: true });
      continue;
    }

    // Split on sentence enders, keeping any trailing citation with its sentence.
    for (const sentence of block.split(/(?<=[.!?:])\s+/)) {
      if (!sentence.trim()) continue;
      claims.push({ text: sentence, citations: citationsIn(sentence), isCode: false });
    }
  }

  // Inherit forward, so code blocks pick up the citation that introduced them.
  let inherited = [];
  for (const claim of claims) {
    if (claim.citations.length > 0) inherited = claim.citations;
    else if (claim.isCode) claim.citations = inherited;
  }

  return claims;
}

/**
 * Check that cited passages actually contain the identifiers credited to them.
 *
 * `knownIdentifiers` is the set of identifiers present anywhere in the corpus,
 * normalised. It is optional: without it the unsupported check is skipped rather
 * than guessed at, because there is no way to tell a real API the passages missed
 * from a variable the model made up for an example.
 */
function verifyAttribution({ answer, chunks = [], knownIdentifiers = null }) {
  const misattributed = [];
  const unsupported = [];
  let checked = 0;

  const claims = splitClaims(answer);

  for (const claim of claims) {
    // No claimed source means nothing to verify against. An uncited sentence is
    // the citation guard's concern, not attribution's.
    if (claim.citations.length === 0) continue;

    for (const identifier of extractIdentifiers(claim.text)) {
      // Which supplied passages actually mention it, as 1-based citation numbers.
      const actual = [];
      for (let i = 0; i < chunks.length; i++) {
        if (passageMentions(chunks[i].text, identifier)) actual.push(i + 1);
      }

      checked += 1;

      if (actual.length === 0) {
        // In no supplied passage. Only a finding if the corpus knows the name.
        if (knownIdentifiers?.has(identifier)) {
          unsupported.push({ identifier, cited: claim.citations, sentence: claim.text.trim() });
        }
        continue;
      }

      // Present somewhere, but not in anything this sentence credited.
      const citedCorrectly = claim.citations.some((n) => actual.includes(n));
      if (!citedCorrectly) {
        /*
         * Severity depends on whether the cited PAGE is right.
         *
         * The top-k allows 2 passages per page, so [1] and [2] are frequently two
         * paragraphs of the same document. Measured: 3 of 4 misattributions found on
         * llama-3.3-70b were of exactly that kind. Since the UI surfaces sources per
         * page, citing the wrong paragraph of the right page sends the reader
         * somewhere the claim genuinely is - cosmetic, not misleading.
         *
         * Citing a different PAGE is the real defect: the reader follows the link and
         * the claim is not there.
         */
        const citedPaths = new Set(
          claim.citations.map((n) => chunks[n - 1]?.path).filter(Boolean),
        );
        const actualPaths = new Set(actual.map((n) => chunks[n - 1]?.path).filter(Boolean));
        const samePage = [...actualPaths].some((p) => citedPaths.has(p));

        misattributed.push({
          identifier,
          cited: claim.citations,
          actual,
          samePage,
          sentence: claim.text.trim(),
        });
      }
    }
  }

  return {
    ok: misattributed.length === 0 && unsupported.length === 0,
    misattributed,
    unsupported,
    checked,
    claims,
  };
}

// ---------------------------------------------------------------------------
// Code sample validation
// ---------------------------------------------------------------------------

/*
 * For a documentation assistant the code is frequently the whole answer, so a
 * sample that does not compile is worse than prose that is merely vague. Two
 * defects were observed directly from real models:
 *
 *   1. '@component' in lowercase.
 *   2. '@Input()' and 'input()' mixed in one sample - both real APIs, but one
 *      supersedes the other, so using both together is incoherent.
 *
 * Casing is DERIVED from the corpus rather than curated. The docs already contain
 * the correct spellings, so a name the corpus only ever writes one way can be
 * checked without maintaining a list that goes stale as Angular evolves - the
 * explicit weakness of the hand-written SUPERSEDED_APIS table in api-pairs.js.
 *
 * Measured on this corpus: of 2,033 normalised names, 1,908 have exactly one
 * casing. The remaining 125 are genuinely ambiguous, and they are almost exactly
 * the legacy/modern pairs - 'ViewChild' the decorator versus 'viewChild()' the
 * function, 'Input' versus 'input'. Those are skipped here, because casing cannot
 * distinguish a legacy API from a modern one. The API-pair check below covers
 * precisely that blind spot, which is why both exist.
 */

/** Raw spellings, case PRESERVED - the whole point is comparing casing. */
const RAW_IDENTIFIER_PATTERNS = [
  /@[A-Za-z][A-Za-z0-9]*/g,
  /\b[A-Za-z][A-Za-z0-9]*\(\)/g,
  /\b[a-zA-Z]+[A-Z][A-Za-z0-9]*\b/g,
];

/** Strip the decoration but keep the casing: '@Component' and 'Component()' -> 'Component'. */
function bareSpelling(raw) {
  return raw.replace(/^@/, '').replace(/\(\)$/, '');
}

/** Fenced blocks only, without fences or language tag. Inline backticks are references, not samples. */
function extractCodeBlocks(answer) {
  const blocks = [];
  for (const match of (answer || '').matchAll(/```[a-zA-Z0-9]*\n?([\s\S]*?)```/g)) {
    blocks.push(match[1]);
  }
  return blocks;
}

/**
 * normalised name -> the corpus's single casing for it.
 *
 * Names spelled more than one way are OMITTED rather than resolved by frequency.
 * Picking the commoner casing would make the check confidently wrong on the very
 * names where both forms are real.
 */
function buildCanonicalSpellings(chunks = []) {
  const observed = new Map();

  for (const chunk of chunks) {
    for (const pattern of RAW_IDENTIFIER_PATTERNS) {
      for (const match of (chunk.text || '').matchAll(pattern)) {
        const spelling = bareSpelling(match[0]);
        const key = spelling.toLowerCase();
        if (key.length < 3 || PROSE_STOPLIST.has(key)) continue;
        if (!observed.has(key)) observed.set(key, new Set());
        observed.get(key).add(spelling);
      }
    }
  }

  const canonical = new Map();
  for (const [key, spellings] of observed) {
    if (spellings.size === 1) canonical.set(key, [...spellings][0]);
  }
  return canonical;
}

/**
 * Check the code blocks in an answer.
 *
 * Restricted to fenced blocks on purpose. In prose "a component" is ordinary
 * English, and checking casing there would flag nearly every answer - noise that
 * would bury the real findings.
 */
function validateCodeSamples({ answer, canonical = null, pairs = SUPERSEDED_APIS }) {
  const casing = [];
  const mixedApi = [];
  const blocks = extractCodeBlocks(answer);

  for (const block of blocks) {
    if (canonical) {
      const reported = new Set();
      for (const pattern of RAW_IDENTIFIER_PATTERNS) {
        for (const match of block.matchAll(pattern)) {
          const spelling = bareSpelling(match[0]);
          const key = spelling.toLowerCase();
          const expected = canonical.get(key);
          if (!expected || expected === spelling || reported.has(key)) continue;
          reported.add(key);
          casing.push({ found: spelling, expected, sample: block.trim().slice(0, 200) });
        }
      }
    }

    /*
     * Checked per block, not per answer. Showing the legacy form and then the
     * modern one in two separate samples is good teaching; only a mix WITHIN one
     * sample is incoherent.
     *
     * Note the legacy form ALONE is deliberately not reported. That is a currency
     * problem rather than an incoherence one, it is already handled by the prompt
     * note in api-pairs.js, and flagging it here would punish an answer that
     * faithfully reflects a page documenting only the old way.
     */
    for (const pair of pairs) {
      if (pair.pattern.test(block) && pair.replacementPattern.test(block)) {
        mixedApi.push({
          old: pair.old,
          replacement: pair.replacement,
          sample: block.trim().slice(0, 200),
        });
      }
    }
  }

  return {
    ok: casing.length === 0 && mixedApi.length === 0,
    casing,
    mixedApi,
    /** So "0 problems" is distinguishable from "no samples were examined". */
    blocks: blocks.length,
  };
}

module.exports = {
  IDENTIFIER_PATTERNS,
  PROSE_STOPLIST,
  normalizeIdentifier,
  extractIdentifiers,
  passageMentions,
  splitClaims,
  verifyAttribution,
  RAW_IDENTIFIER_PATTERNS,
  bareSpelling,
  extractCodeBlocks,
  buildCanonicalSpellings,
  validateCodeSamples,
};
