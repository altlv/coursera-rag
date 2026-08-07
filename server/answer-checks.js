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
        misattributed.push({
          identifier,
          cited: claim.citations,
          actual,
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

module.exports = {
  IDENTIFIER_PATTERNS,
  PROSE_STOPLIST,
  normalizeIdentifier,
  extractIdentifiers,
  passageMentions,
  splitClaims,
  verifyAttribution,
};
