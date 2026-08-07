/*
 * Score a vector store against the golden and held-out sets.
 *
 *   npm run eval                       both sets, current store
 *   npm run eval -- --holdout          held-out only
 *   npm run eval -- --compare=DIR      A/B the current store against another
 *
 * The --compare form is the point. Retrieval changes are easy to reason about and
 * hard to verify, so the honest way to evaluate one is to score the same questions
 * against both stores and print the difference. Without that, "it should help" is
 * all you have - which is exactly how contextual chunking nearly shipped
 * unmeasured.
 *
 * Question vectors come from the committed fixture where possible, so scoring is
 * free and deterministic.
 */

const fs = require('fs').promises;
const path = require('path');
const dotenv = require('dotenv');
const { OpenAI } = require('openai');
const { selectChunksMultiQuery, normalizeVector } = require('../server/rag');

dotenv.config();

const DOCS_ROOT = path.resolve(__dirname, '../docs/angular');
const FIXTURE_DIR = path.resolve(__dirname, '../test/fixtures');
const GOLDEN_FIXTURE = path.join(FIXTURE_DIR, 'golden-vectors.json');
const HOLDOUT_FIXTURE = path.join(FIXTURE_DIR, 'holdout-vectors.json');

const TOP_K = 5;
const SCORE_FLOOR = 0.25;
const MAX_PER_PAGE = 2;

const args = process.argv.slice(2);
const COMPARE_DIR = (args.find((a) => a.startsWith('--compare=')) || '').split('=')[1];
const HOLDOUT_ONLY = args.includes('--holdout');
const GOLDEN_ONLY = args.includes('--golden');

async function loadStore(dir) {
  const meta = JSON.parse(await fs.readFile(path.join(dir, 'chunks.json'), 'utf8'));
  const buffer = await fs.readFile(path.join(dir, 'vectors.bin'));
  const vectors = new Float32Array(
    buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  );
  return { ...meta, vectors };
}

/** Cached question vectors, embedding any that are missing. */
async function loadQuestionVectors(fixturePath, questions, store) {
  let fixture = null;
  try {
    fixture = JSON.parse(await fs.readFile(fixturePath, 'utf8'));
    if (fixture.model !== store.model || fixture.dimensions !== store.dimensions) fixture = null;
  } catch {
    fixture = null;
  }

  const cached = new Map((fixture?.questions || []).map((q) => [q.question, q.vector]));
  const missing = questions.filter((q) => !cached.has(q.question));

  if (missing.length) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        `${missing.length} question(s) have no cached vector and OPENAI_API_KEY is not set.`,
      );
    }

    console.log(`  embedding ${missing.length} new question(s)...`);
    const client = new OpenAI({ apiKey });
    const response = await client.embeddings.create({
      model: store.model,
      dimensions: store.dimensions,
      input: missing.map((q) => q.question),
    });

    response.data
      .sort((a, b) => a.index - b.index)
      .forEach((item, i) => {
        cached.set(missing[i].question, Array.from(normalizeVector(item.embedding)));
      });

    await fs.mkdir(FIXTURE_DIR, { recursive: true });
    await fs.writeFile(
      fixturePath,
      JSON.stringify(
        {
          createdAt: new Date().toISOString(),
          model: store.model,
          dimensions: store.dimensions,
          normalized: true,
          questionCount: questions.length,
          questions: questions.map((q) => ({
            question: q.question,
            acceptablePaths: q.acceptablePaths || [],
            vector: cached.get(q.question),
          })),
        },
        null,
        2,
      ),
      'utf8',
    );
  }

  return cached;
}

/** hit@1, hit@3 and MRR for one set against one store. */
function score(questions, vectors, store) {
  const rows = questions.map((item) => {
    const results = selectChunksMultiQuery(
      [{ vector: vectors.get(item.question), text: item.question, label: '' }],
      store,
      { k: TOP_K, floor: SCORE_FLOOR, maxPerPage: MAX_PER_PAGE },
    );

    let rank = 0;
    for (let i = 0; i < results.length; i += 1) {
      if (item.acceptablePaths.some((p) => results[i].path.startsWith(p))) {
        rank = i + 1;
        break;
      }
    }

    return {
      question: item.question,
      rank,
      top: results[0]?.score ?? 0,
      topPath: results[0]?.path ?? '(nothing)',
    };
  });

  const n = rows.length;
  return {
    rows,
    hit1: rows.filter((r) => r.rank === 1).length / n,
    hit3: rows.filter((r) => r.rank > 0 && r.rank <= 3).length / n,
    mrr: rows.reduce((s, r) => s + (r.rank ? 1 / r.rank : 0), 0) / n,
  };
}

const pct = (v) => `${(v * 100).toFixed(0)}%`;

function report(label, result) {
  console.log(`\n  ${label}`);
  console.log(
    `    hit@1 ${pct(result.hit1)}   hit@3 ${pct(result.hit3)}   MRR ${result.mrr.toFixed(3)}`,
  );
  for (const row of result.rows) {
    const mark = row.rank === 0 ? 'MISS  ' : `hit@${row.rank}`;
    console.log(`    ${mark}  ${row.top.toFixed(3)}  ${row.question}`);
    if (!row.rank) console.log(`            got: ${row.topPath}`);
  }
}

function compare(label, before, after) {
  const delta = (a, b) => {
    const d = b - a;
    const sign = d > 0 ? '+' : d < 0 ? '' : ' ';
    return `${sign}${(d * 100).toFixed(1)}pp`;
  };

  console.log(`\n  ${label}`);
  console.log(`    hit@1  ${pct(before.hit1)} -> ${pct(after.hit1)}   ${delta(before.hit1, after.hit1)}`);
  console.log(`    hit@3  ${pct(before.hit3)} -> ${pct(after.hit3)}   ${delta(before.hit3, after.hit3)}`);
  console.log(`    MRR    ${before.mrr.toFixed(3)} -> ${after.mrr.toFixed(3)}   ${(after.mrr - before.mrr >= 0 ? '+' : '') + (after.mrr - before.mrr).toFixed(3)}`);

  const changed = after.rows
    .map((row, i) => ({ q: row.question, from: before.rows[i].rank, to: row.rank }))
    .filter((c) => c.from !== c.to);

  if (changed.length === 0) {
    console.log('    no rank changed - this set cannot distinguish the two stores');
    return;
  }

  console.log('    rank changes:');
  for (const c of changed) {
    const dir = c.to === 0 ? 'LOST' : c.from === 0 ? 'GAINED' : c.to < c.from ? 'better' : 'worse';
    console.log(`      ${dir.padEnd(7)} ${c.from || 'miss'} -> ${c.to || 'miss'}  ${c.q}`);
  }
}

async function run() {
  const { GOLDEN_SET } = await import('../test/golden-set.mjs');
  const { HOLDOUT_SET } = await import('../test/holdout-set.mjs');

  const golden = GOLDEN_SET.filter((q) => q.expect === 'match');
  const sets = [];
  if (!HOLDOUT_ONLY) sets.push({ name: 'Golden set (TUNED against - read with suspicion)', questions: golden, fixture: GOLDEN_FIXTURE });
  if (!GOLDEN_ONLY) sets.push({ name: 'Held-out set (never tuned against)', questions: HOLDOUT_SET, fixture: HOLDOUT_FIXTURE });

  const current = await loadStore(DOCS_ROOT);
  console.log('='.repeat(72));
  console.log(`Current store: ${current.chunkCount} passages, ${current.model} @ ${current.dimensions} dims`);
  if (current.contextualized) console.log('  page titles ARE prepended before embedding');
  console.log('='.repeat(72));

  const other = COMPARE_DIR ? await loadStore(path.resolve(COMPARE_DIR)) : null;
  if (other) {
    console.log(`Comparing against: ${COMPARE_DIR}`);
    console.log(`  ${other.chunkCount} passages, titles prepended: ${Boolean(other.contextualized)}`);
    console.log('='.repeat(72));
  }

  for (const set of sets) {
    const vectors = await loadQuestionVectors(set.fixture, set.questions, current);

    if (other) {
      compare(set.name, score(set.questions, vectors, other), score(set.questions, vectors, current));
    } else {
      report(set.name, score(set.questions, vectors, current));
    }
  }

  console.log('');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
