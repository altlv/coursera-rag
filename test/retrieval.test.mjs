import fs from 'fs/promises';
import path from 'path';
import { describe, it, expect, beforeAll } from 'vitest';
import { selectChunksHybrid } from '../server/rag.js';
import { GOLDEN_SET, MATCH_QUESTIONS, SCORE_FLOOR, STRONG_SCORE } from './golden-set.mjs';

/*
 * Retrieval quality, measured. Free and offline.
 *
 * No language model is involved, so this isolates the retrieval half of RAG:
 * when an answer is bad, this tells you immediately which half broke. Question
 * vectors come from a committed fixture (npm run build-golden), so the only work
 * here is dot products against vectors.bin.
 *
 * Metrics, and why both:
 *   hit@k - did an acceptable page appear in the top k? The headline number.
 *   MRR   - mean reciprocal rank. Catches "right page, but ranked fifth",
 *           a degradation hit@k reports as a pass right up until it drops out
 *           of the window entirely.
 */

const DOCS_ROOT = path.resolve('docs/angular');
const CHUNKS_FILE = path.join(DOCS_ROOT, 'chunks.json');
const VECTORS_FILE = path.join(DOCS_ROOT, 'vectors.bin');
const FIXTURE_FILE = path.resolve('test/fixtures/golden-vectors.json');

const K = 5;
const MAX_PER_PAGE = 2;
const HIT_AT_3_TARGET = 0.8;

let store = null;
let fixture = null;
let ready = false;
let skipReason = '';

const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));

beforeAll(async () => {
  try {
    const meta = await readJson(CHUNKS_FILE);
    const buffer = await fs.readFile(VECTORS_FILE);
    const vectors = new Float32Array(
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
    );
    store = { ...meta, vectors };
    fixture = await readJson(FIXTURE_FILE);
  } catch (error) {
    skipReason = `${error.message} - run npm run build-embeddings and npm run build-golden`;
    return;
  }

  /*
   * Guard against the silent trap. Question vectors and chunk vectors must come
   * from the same embedding space. Compare vectors from two different models or
   * dimension counts and every score is meaningless - but still a plausible
   * number between -1 and 1, so nothing errors and the suite happily passes
   * while measuring nothing.
   */
  if (fixture.model !== store.model || fixture.dimensions !== store.dimensions) {
    throw new Error(
      `Embedding space mismatch: fixture is ${fixture.model}@${fixture.dimensions}, ` +
        `store is ${store.model}@${store.dimensions}. Re-run npm run build-golden.`,
    );
  }

  ready = true;
});

/**
 * Retrieve for a golden question using its cached vector.
 *
 * Uses the hybrid path, i.e. exactly what /api/chat runs. A golden set that
 * measured a different code path than production would report numbers nobody
 * could act on.
 */
function retrieve(question, { floor = SCORE_FLOOR, k = K, maxPerPage = MAX_PER_PAGE } = {}) {
  const entry = fixture.questions.find((q) => q.question === question);
  if (!entry) throw new Error(`No cached vector for "${question}". Run npm run build-golden.`);
  return selectChunksHybrid(entry.vector, question, store, { k, floor, maxPerPage });
}

/** 1-based rank of the first acceptable page, or 0 if absent. */
function rankOfFirstHit(results, acceptablePaths) {
  for (let i = 0; i < results.length; i += 1) {
    if (acceptablePaths.some((prefix) => results[i].path.startsWith(prefix))) return i + 1;
  }
  return 0;
}

describe('golden set fixture', () => {
  it('covers every question in the golden set', () => {
    if (!ready) return console.warn(`skipped: ${skipReason}`);
    for (const item of GOLDEN_SET) {
      expect(
        fixture.questions.some((q) => q.question === item.question),
        `"${item.question}" has no cached vector`,
      ).toBe(true);
    }
  });

  it('holds unit-length vectors from the store\'s embedding space', () => {
    if (!ready) return;
    expect(fixture.dimensions).toBe(store.dimensions);
    for (const q of fixture.questions) {
      expect(q.vector.length).toBe(store.dimensions);
      const magnitude = Math.sqrt(q.vector.reduce((s, v) => s + v * v, 0));
      expect(magnitude).toBeCloseTo(1, 5);
    }
  });
});

describe('real questions land on the right pages', () => {
  it(`hit@3 is at least ${HIT_AT_3_TARGET}`, () => {
    if (!ready) return console.warn(`skipped: ${skipReason}`);

    const rows = MATCH_QUESTIONS.map((item) => {
      const results = retrieve(item.question);
      return {
        question: item.question,
        rank: rankOfFirstHit(results, item.acceptablePaths),
        top: results[0]?.score ?? 0,
        topPath: results[0]?.path ?? '(nothing)',
      };
    });

    const hits3 = rows.filter((r) => r.rank > 0 && r.rank <= 3).length;
    const hitAt3 = hits3 / rows.length;
    const mrr = rows.reduce((sum, r) => sum + (r.rank ? 1 / r.rank : 0), 0) / rows.length;

    console.log(`\n  hit@3 ${hits3}/${rows.length} (${(hitAt3 * 100).toFixed(0)}%)   MRR ${mrr.toFixed(3)}`);
    for (const r of rows) {
      const mark = r.rank > 0 && r.rank <= 3 ? `hit@${r.rank}` : 'MISS  ';
      console.log(`  ${mark}  ${r.top.toFixed(3)}  ${r.question}`);
      if (!r.rank) console.log(`          got: ${r.topPath}`);
    }

    expect(hitAt3).toBeGreaterThanOrEqual(HIT_AT_3_TARGET);
  });

  it('ranks a confident match above the strong-score threshold', () => {
    if (!ready) return;
    // If real questions scored no better than adjacent ones, the score floor
    // could not separate them and "I don't know" would be unreachable.
    for (const item of MATCH_QUESTIONS) {
      const [top] = retrieve(item.question);
      expect(top, `"${item.question}" retrieved nothing`).toBeTruthy();
      expect(top.score, `"${item.question}" top score too low`).toBeGreaterThanOrEqual(
        STRONG_SCORE,
      );
    }
  });
});

describe('questions the corpus cannot answer', () => {
  it('returns nothing at all for an unrelated question', () => {
    if (!ready) return console.warn(`skipped: ${skipReason}`);

    for (const item of GOLDEN_SET.filter((q) => q.expect === 'none')) {
      const results = retrieve(item.question);
      console.log(`\n  "${item.question}" -> ${results.length} chunks above floor ${SCORE_FLOOR}`);

      // Zero results is what lets the server refuse WITHOUT calling the model:
      // the refusal is free, deterministic, and cannot be a guess.
      expect(results, `"${item.question}" should retrieve nothing`).toHaveLength(0);
    }
  });

  it('retrieves confidently for an adjacent question, proving score alone is not enough', () => {
    if (!ready) return;

    for (const item of GOLDEN_SET.filter((q) => q.expect === 'weak')) {
      const results = retrieve(item.question);
      const top = results[0]?.score ?? 0;
      console.log(`\n  "${item.question}" -> ${results.length} chunks, top ${top.toFixed(3)}`);
      if (results.length) console.log(`     ${results.map((r) => r.path).join('\n     ')}`);

      /*
       * Asserting the OPPOSITE of the original hypothesis, on purpose.
       *
       * This started life as "top score must stay below a weak ceiling", i.e. an
       * adjacent question should look visibly unsure. It does not: this scores
       * 0.457, above several genuine Angular questions, because the styling and
       * security pages really are about CSS. The similarity is correct; the
       * missing piece is a definition of the acronym.
       *
       * Pinning that fact here means a future change that quietly starts
       * treating these as answerable-by-score will fail loudly, rather than
       * shipping confident nonsense.
       */
      expect(results.length, `"${item.question}" should still retrieve something`).toBeGreaterThan(
        0,
      );
      expect(
        top,
        `"${item.question}" no longer scores confidently - the premise of the 'partial' ` +
          `response mode has changed and should be re-examined`,
      ).toBeGreaterThanOrEqual(SCORE_FLOOR);
    }
  });

  it('cannot separate adjacent questions from real ones by score, which is the finding', () => {
    if (!ready) return;

    const strong = MATCH_QUESTIONS.map((i) => retrieve(i.question)[0]?.score ?? 0);
    const weak = GOLDEN_SET.filter((q) => q.expect === 'weak').map(
      (i) => retrieve(i.question)[0]?.score ?? 0,
    );

    const worstStrong = Math.min(...strong);
    const bestWeak = Math.max(...weak);

    const margin = worstStrong - bestWeak;
    console.log(
      `\n  weakest real question ${worstStrong.toFixed(3)} vs ` +
        `strongest adjacent ${bestWeak.toFixed(3)}  ->  margin ${margin.toFixed(3)}`,
    );
    console.log('  The margin is far too thin to threshold on: a floor set to separate these');
    console.log("  would sit inside noise. Hence generation returns status 'partial' instead.");

    /*
     * Documents the overlap rather than pretending a clean split exists.
     *
     * The adjacent question outscores the floor comfortably, and lands within
     * ~0.02 of the weakest genuine question - so no usable threshold separates
     * the two classes. The similarity floor handles 'Got milk?' and nothing
     * subtler; everything else has to be caught by the model reading the
     * passages.
     */
    expect(bestWeak).toBeGreaterThan(SCORE_FLOOR);
    expect(Math.abs(margin)).toBeLessThan(0.1);
  });
});
