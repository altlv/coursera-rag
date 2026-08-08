import fs from 'fs/promises';
import path from 'path';
import { describe, it, expect, beforeAll } from 'vitest';
import { ANSWER_RUBRICS, rubricFor } from '../answer-rubrics.mjs';
import { GOLDEN_SET } from '../golden-set.mjs';
import { HOLDOUT_SET } from '../holdout-set.mjs';
import { mentionsAny } from '../../server/answer-quality.js';

/*
 * Keeping the answer rubrics honest.
 *
 * A rubric is a claim about what a correct answer must say. If a required term
 * never appears in the corpus, the model CANNOT satisfy it from the documents -
 * and a grounded system is supposed to refuse rather than invent. So the score
 * would be measuring an impossibility and blaming the model for it.
 *
 * That is the same failure this project keeps meeting from the other direction: a
 * measurement that is itself the broken thing. These tests pin the rubrics to the
 * corpus so a bad requirement fails here rather than quietly depressing a metric
 * nobody can move.
 */

const DOCS_ROOT = path.resolve(__dirname, '../../docs/angular');

let store = null;

beforeAll(async () => {
  try {
    store = JSON.parse(await fs.readFile(path.join(DOCS_ROOT, 'chunks.json'), 'utf8'));
  } catch {
    store = null; // no corpus built - the corpus-dependent tests skip
  }
});

const ALL = [...GOLDEN_SET, ...HOLDOUT_SET];

describe('answer rubrics', () => {
  it('covers every question the docs are expected to answer', () => {
    const missing = ALL.filter((q) => (q.expect ?? 'match') === 'match')
      .filter((q) => rubricFor(q.question).length === 0)
      .map((q) => q.question);
    expect(missing, 'a match question has no rubric, so its answer is unscored').toEqual([]);
  });

  it('leaves the refusal and partial cases unscored, deliberately', () => {
    /*
     * A correct response to "Got milk?" mentions nothing in particular - it is
     * scored on STATUS. Inventing requirements here would be scoring prose we do
     * not want the model to produce at all.
     */
    for (const q of ALL.filter((q) => q.expect === 'none' || q.expect === 'weak')) {
      expect(rubricFor(q.question), `${q.question} should have no rubric`).toEqual([]);
    }
  });

  it('has no rubric for a question that is not in either eval set', () => {
    // A stale key would silently score nothing while looking like coverage.
    const known = new Set(ALL.map((q) => q.question));
    const orphans = Object.keys(ANSWER_RUBRICS).filter((q) => !known.has(q));
    expect(orphans, 'rubric refers to a question no eval set contains').toEqual([]);
  });

  it('requires nothing the corpus never says', () => {
    if (!store) return console.warn('skipped: no corpus - run npm run build-embeddings');

    const corpus = store.chunks.map((c) => c.text).join('\n');
    const impossible = [];

    for (const [question, groups] of Object.entries(ANSWER_RUBRICS)) {
      for (const group of groups) {
        if (!mentionsAny(corpus, group)) impossible.push(`${question} -> ${group.join(' | ')}`);
      }
    }

    expect(impossible, 'a rubric demands a term that appears nowhere in the corpus').toEqual([]);
  });

  it('warns about a requirement the corpus barely uses', () => {
    /*
     * Existence is not enough, and this test exists because the weaker version
     * passed a bad rubric. 'signal()' with empty parentheses appears twice in the
     * whole corpus, while 'signal(0)' and 'signal(false)' appear twelve times
     * each - so requiring 'signal()' technically pointed at something real and
     * still failed a correct answer that wrote `signal(0)`.
     *
     * A requirement is a bet on the vocabulary a grounded answer will use. If the
     * documents hardly ever use it, the bet is bad.
     */
    if (!store) return;

    const corpus = store.chunks.map((c) => c.text).join('\n');
    const rare = [];

    for (const [question, groups] of Object.entries(ANSWER_RUBRICS)) {
      for (const group of groups) {
        // Frequency of the whole group: any alternative being common is enough.
        const total = group.reduce((n, term) => {
          const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const left = /^\w/.test(term) ? '\\b' : '';
          const right = /\w$/.test(term) ? '\\b' : '';
          return n + (corpus.match(new RegExp(`${left}${escaped}${right}`, 'gi')) || []).length;
        }, 0);
        if (total < 3) rare.push(`${group.join(' | ')} (${total}x)  <- ${question}`);
      }
    }

    if (rare.length) {
      console.warn(`\n  ${rare.length} rarely-used requirement(s):\n    ${rare.join('\n    ')}\n`);
    }
    expect(rare.length, 'too many requirements the corpus barely uses').toBeLessThanOrEqual(3);
  });

  it('requires terms that appear on the pages meant to answer the question', () => {
    /*
     * Stronger than the corpus-wide check above, and the one that catches a lazy
     * rubric: a term may exist somewhere in the docs while being absent from every
     * page retrieval is expected to return. The model would then have to answer
     * from memory to satisfy it.
     *
     * Reported rather than asserted, because an answer can legitimately draw on a
     * neighbouring page - the acceptable paths bound retrieval, not knowledge.
     */
    if (!store) return;

    const offPage = [];
    for (const q of ALL) {
      const groups = rubricFor(q.question);
      if (groups.length === 0) continue;

      const pages = store.chunks
        .filter((c) => (q.acceptablePaths ?? []).some((p) => c.path.startsWith(p)))
        .map((c) => c.text)
        .join('\n');
      if (!pages) continue;

      for (const group of groups) {
        if (!mentionsAny(pages, group)) offPage.push(`${q.question} -> ${group.join(' | ')}`);
      }
    }

    if (offPage.length) {
      console.warn(
        `\n  ${offPage.length} requirement(s) not on the expected pages ` +
          `- satisfiable only from a neighbouring page:\n    ${offPage.join('\n    ')}\n`,
      );
    }
    // Bounded, not zero: a few are acceptable, a lot means the rubrics drifted.
    expect(offPage.length).toBeLessThanOrEqual(5);
  });
});
