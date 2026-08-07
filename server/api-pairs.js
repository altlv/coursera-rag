/*
 * Angular APIs that have been superseded, and what replaced them.
 *
 * Why this exists
 * ---------------
 * Asked "how do I get a reference to a child component?", the assistant taught
 * @ViewChild and never mentioned viewChild(). A user marked it unhelpful.
 *
 * Two retrieval-side fixes were tried and BOTH measured worse:
 *
 *   MMR reranking for diversity    hit@3 93% -> 80-87%
 *   raising maxPerPage             hit@3 93% -> 87%
 *
 * Looking at the corpus explained why. /guide/components/queries holds 15 passages:
 * 5 mention @ViewChild, exactly 1 mentions viewChild(). With two slots per page the
 * modern API rarely wins, and no page-level ranking change can reach imbalance
 * INSIDE a page.
 *
 * So the fix is not a cleverer ranker. It is telling the model a fact the corpus
 * states inconsistently: that one of these APIs supersedes the other. That fact is
 * stable, small, and checkable - unlike a similarity threshold.
 *
 * Honest limitations
 * ------------------
 * This is a hand-maintained list. It does not generalise to another corpus, and it
 * will go stale as Angular evolves. Both are mitigated rather than solved:
 * test/unit/api-pairs.test.mjs asserts every replacement named here actually
 * appears in the corpus, so an entry that stops being true fails a test rather than
 * quietly misinforming users.
 *
 * The alternative - inferring supersession from deprecation language in the text -
 * was rejected because the passages that mention @ViewChild mostly do not say it is
 * superseded. The corpus does not reliably state the thing we need.
 */

const SUPERSEDED_APIS = [
  {
    old: '@ViewChild',
    pattern: /@ViewChild\b/,
    replacement: 'viewChild()',
    replacementPattern: /\bviewChild\(/,
    note: 'the signal-based viewChild() query',
  },
  {
    old: '@ViewChildren',
    pattern: /@ViewChildren\b/,
    replacement: 'viewChildren()',
    replacementPattern: /\bviewChildren\(/,
    note: 'the signal-based viewChildren() query',
  },
  {
    old: '@ContentChild',
    pattern: /@ContentChild\b/,
    replacement: 'contentChild()',
    replacementPattern: /\bcontentChild\(/,
    note: 'the signal-based contentChild() query',
  },
  {
    old: '@Input()',
    pattern: /@Input\(/,
    replacement: 'input()',
    replacementPattern: /\binput\(/,
    note: 'the signal-based input() function',
  },
  {
    old: '@Output()',
    pattern: /@Output\(/,
    replacement: 'output()',
    replacementPattern: /\boutput\(/,
    note: 'the output() function',
  },
  {
    old: '@HostListener',
    pattern: /@HostListener\b/,
    replacement: 'the host object',
    replacementPattern: /host:\s*\{/,
    note: "the `host` property on @Component or @Directive",
  },
  {
    old: '@HostBinding',
    pattern: /@HostBinding\b/,
    replacement: 'the host object',
    replacementPattern: /host:\s*\{/,
    note: "the `host` property on @Component or @Directive",
  },
];

/**
 * Which superseded APIs appear in these passages, and whether their replacement
 * appears too.
 *
 * `alsoHasReplacement` is the important distinction. When both are present the
 * model already has what it needs and only requires the instruction to mention
 * both - which the conflict rules in SYSTEM_PROMPT already cover. When only the
 * legacy API is present, the model cannot know a replacement exists at all, and
 * that is the case that produced a wrong answer.
 */
function detectSupersededApis(chunks) {
  const combined = (chunks || []).map((c) => c.text || '').join('\n');
  if (!combined) return [];

  return SUPERSEDED_APIS.filter((api) => api.pattern.test(combined)).map((api) => ({
    old: api.old,
    replacement: api.replacement,
    note: api.note,
    alsoHasReplacement: api.replacementPattern.test(combined),
  }));
}

/**
 * A prompt fragment naming the supersessions the passages do not state themselves.
 *
 * Only emitted for APIs whose replacement is absent from the retrieved passages.
 * Adding a note when both are already present would be noise, and would risk the
 * model repeating a caveat the passages already make.
 */
function supersededApiNote(chunks) {
  const missing = detectSupersededApis(chunks).filter((api) => !api.alsoHasReplacement);
  if (missing.length === 0) return null;

  const lines = missing.map(
    (api) => `- ${api.old} still works, but modern Angular prefers ${api.note}.`,
  );

  return [
    'Known API changes relevant to these passages (the passages themselves may not mention this):',
    ...lines,
    'If your answer uses one of the older forms above, say that the modern form exists and is preferred. Do not invent details about the modern form beyond naming it.',
  ].join('\n');
}

module.exports = { SUPERSEDED_APIS, detectSupersededApis, supersededApiNote };
