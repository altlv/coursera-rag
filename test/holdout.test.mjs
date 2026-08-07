import fs from 'fs/promises';
import path from 'path';
import { describe, it, expect, beforeAll } from 'vitest';
import { selectChunksMultiQuery } from '../server/rag.js';
import { HOLDOUT_SET } from './holdout-set.mjs';

/*
 * The held-out set: retrieval quality on questions never used for tuning.
 *
 * The golden set reports hit@3 13/13 and MRR 1.000, and that number is not
 * trustworthy - hybrid retrieval, the diversity cap and the score floor were all
 * tuned while watching it. It is also saturated, so it cannot detect a change in
 * either direction. Contextual chunking proved that: the golden set reported
 * IDENTICAL numbers before and after, while this set showed hit@1 rising from 67%
 * to 73% and MRR from 0.789 to 0.822.
 *
 * These thresholds are REGRESSION GUARDS, set below current performance. They are
 * not targets. Tuning anything until this suite goes green would destroy the only
 * unbiased measurement in the project and turn it into a second golden set.
 *
 * Current, at the time of writing: hit@1 73%, hit@3 93%, MRR 0.822.
 */

const DOCS_ROOT = path.resolve('docs/angular');
const CHUNKS_FILE = path.join(DOCS_ROOT, 'chunks.json');
const VECTORS_FILE = path.join(DOCS_ROOT, 'vectors.bin');
const FIXTURE_FILE = path.resolve('test/fixtures/holdout-vectors.json');

const K = 5;
const SCORE_FLOOR = 0.25;
const MAX_PER_PAGE = 2;

/** Deliberately below the measured values, so this catches regressions only. */
const HIT_AT_3_FLOOR = 0.85;
const MRR_FLOOR = 0.75;

let store = null;
let fixture = null;
let ready = false;
let skipReason = '';

beforeAll(async () => {
  try {
    const meta = JSON.parse(await fs.readFile(CHUNKS_FILE, 'utf8'));
    const buffer = await fs.readFile(VECTORS_FILE);
    store = {
      ...meta,
      vectors: new Float32Array(
        buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
      ),
    };
    fixture = JSON.parse(await fs.readFile(FIXTURE_FILE, 'utf8'));
  } catch (error) {
    skipReason = `${error.message} - run npm run eval to build the fixture`;
    return;
  }

  // Same guard as the golden suite: comparing across embedding spaces returns
  // plausible numbers while measuring nothing.
  if (fixture.model !== store.model || fixture.dimensions !== store.dimensions) {
    throw new Error(
      `Embedding space mismatch: fixture is ${fixture.model}@${fixture.dimensions}, ` +
        `store is ${store.model}@${store.dimensions}.`,
    );
  }

  ready = true;
});

function retrieve(question) {
  const entry = fixture.questions.find((q) => q.question === question);
  if (!entry) throw new Error(`No cached vector for "${question}". Run npm run eval.`);
  return selectChunksMultiQuery([{ vector: entry.vector, text: question, label: '' }], store, {
    k: K,
    floor: SCORE_FLOOR,
    maxPerPage: MAX_PER_PAGE,
  });
}

function rankOfFirstHit(results, acceptablePaths) {
  for (let i = 0; i < results.length; i += 1) {
    if (acceptablePaths.some((prefix) => results[i].path.startsWith(prefix))) return i + 1;
  }
  return 0;
}

describe('held-out retrieval quality', () => {
  it('covers every held-out question', () => {
    if (!ready) return console.warn(`skipped: ${skipReason}`);
    for (const item of HOLDOUT_SET) {
      expect(
        fixture.questions.some((q) => q.question === item.question),
        `"${item.question}" has no cached vector`,
      ).toBe(true);
    }
  });

  it(`holds hit@3 at or above ${HIT_AT_3_FLOOR} and MRR at or above ${MRR_FLOOR}`, () => {
    if (!ready) return console.warn(`skipped: ${skipReason}`);

    const rows = HOLDOUT_SET.map((item) => {
      const results = retrieve(item.question);
      return {
        question: item.question,
        rank: rankOfFirstHit(results, item.acceptablePaths),
        top: results[0]?.score ?? 0,
        topPath: results[0]?.path ?? '(nothing)',
      };
    });

    const n = rows.length;
    const hit1 = rows.filter((r) => r.rank === 1).length / n;
    const hit3 = rows.filter((r) => r.rank > 0 && r.rank <= 3).length / n;
    const mrr = rows.reduce((s, r) => s + (r.rank ? 1 / r.rank : 0), 0) / n;

    console.log(
      `\n  HELD-OUT: hit@1 ${(hit1 * 100).toFixed(0)}%  hit@3 ${(hit3 * 100).toFixed(0)}%  MRR ${mrr.toFixed(3)}`,
    );
    console.log('  (the golden set reports 100% / 1.000 - these are the honest figures)');
    for (const row of rows) {
      const mark = row.rank === 0 ? 'MISS  ' : `hit@${row.rank}`;
      console.log(`  ${mark}  ${row.top.toFixed(3)}  ${row.question}`);
      if (!row.rank) console.log(`          got: ${row.topPath}`);
    }

    expect(hit3).toBeGreaterThanOrEqual(HIT_AT_3_FLOOR);
    expect(mrr).toBeGreaterThanOrEqual(MRR_FLOOR);
  });

  it('is a genuinely harder set than the golden one', async () => {
    if (!ready) return;
    /*
     * A held-out set that scored 100% too would be useless - it has to have
     * headroom to detect a change. This asserts the set is still doing its job,
     * and would fail if someone "fixed" it by making the questions easier.
     */
    const rows = HOLDOUT_SET.map((item) =>
      rankOfFirstHit(retrieve(item.question), item.acceptablePaths),
    );
    const hit1 = rows.filter((r) => r === 1).length / rows.length;
    expect(hit1).toBeLessThan(1);
  });
});
