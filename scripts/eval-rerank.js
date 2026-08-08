/*
 * Does reranking actually move hit@1?
 *
 *   npm run eval:rerank                 # default provider, both sets
 *   npm run eval:rerank -- --only=openrouter
 *   npm run eval:rerank -- --candidates=20
 *   npm run eval:rerank -- --runs=3     # average, because generation is stochastic
 *
 * Built before deciding, and the decision is made on the held-out hit@1 alone.
 * Two principled retrieval changes have already measured WORSE in this project -
 * MMR took hit@3 from 93% to 80%, atomic code blocks took hit@1 from 73% to 53% -
 * so this exists to be capable of saying no.
 *
 * The ceiling was measured first, free and offline, before any of this was
 * written:
 *
 *   held-out recall@5  (production)   93%
 *   held-out recall@10                100%   <- perfect reranking would score this
 *   held-out hit@1                    73%
 *
 * Costs one generation call per question per run. About $0.01 for both sets.
 */
const fs = require('fs').promises;
const path = require('path');
const dotenv = require('dotenv');
const { selectChunksMultiQuery } = require('../server/rag');
const { rerank } = require('../server/rerank');
const { createLlm, listAvailable } = require('../server/llm-providers');

dotenv.config();

const DOCS_ROOT = path.resolve(__dirname, '../docs/angular');
const TOP_K = 5;
const SCORE_FLOOR = 0.25;
const MAX_PER_PAGE = 2;

const args = process.argv.slice(2);
const ONLY = (args.find((a) => a.startsWith('--only=')) || '').split('=')[1];
/*
 * 10 by default, not the 30-50 the usual advice suggests. Measured on this corpus,
 * recall is already 100% at 10 while the mean rank of the correct page drifts from
 * 1.9 to 2.7 by 50 - strictly more noise for the reranker, for no extra recall.
 */
const CANDIDATES = Number((args.find((a) => a.startsWith('--candidates=')) || '').split('=')[1]) || 10;
const RUNS = Math.max(1, Number((args.find((a) => a.startsWith('--runs=')) || '').split('=')[1]) || 1);

const pct = (v) => `${(v * 100).toFixed(0)}%`;
const line = (c = '-') => console.log(c.repeat(76));

async function loadStore() {
  const meta = JSON.parse(await fs.readFile(path.join(DOCS_ROOT, 'chunks.json'), 'utf8'));
  const buffer = await fs.readFile(path.join(DOCS_ROOT, 'vectors.bin'));
  const vectors = new Float32Array(
    buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  );
  return { ...meta, vectors };
}

async function loadVectors(file, store) {
  const f = JSON.parse(await fs.readFile(path.resolve(__dirname, '../test/fixtures', file), 'utf8'));
  if (f.model !== store.model || f.dimensions !== store.dimensions) {
    throw new Error(`fixture ${file} is from another embedding space - rebuild it`);
  }
  return new Map(f.questions.map((q) => [q.question, q.vector]));
}

/** hit@1 / hit@3 / MRR for a list of {question, rank} rows. */
function metrics(rows) {
  const n = rows.length || 1;
  return {
    hit1: rows.filter((r) => r.rank === 1).length / n,
    hit3: rows.filter((r) => r.rank > 0 && r.rank <= 3).length / n,
    mrr: rows.reduce((s, r) => s + (r.rank ? 1 / r.rank : 0), 0) / n,
  };
}

const rankOf = (results, acceptable) => {
  const i = results.findIndex((r) => acceptable.some((p) => r.path.startsWith(p)));
  return i < 0 ? 0 : i + 1;
};

async function run() {
  const store = await loadStore();
  const { GOLDEN_SET } = await import('../test/golden-set.mjs');
  const { HOLDOUT_SET } = await import('../test/holdout-set.mjs');

  const sets = [
    ['golden', GOLDEN_SET, await loadVectors('golden-vectors.json', store)],
    ['held-out', HOLDOUT_SET, await loadVectors('holdout-vectors.json', store)],
  ];

  const llm = createLlm({ provider: ONLY });

  line('=');
  console.log('Reranking - does it move hit@1?');
  line('=');
  console.log(`Reranker  : ${llm.providerLabel} (${llm.model})`);
  console.log(`Candidates: top ${CANDIDATES}, reranked to ${TOP_K}`);
  console.log(`Runs      : ${RUNS}\n`);

  for (const [name, set, vectors] of sets) {
    const answerable = set.filter((q) => (q.acceptablePaths ?? []).length > 0);

    const baseRows = [];
    const rerankedRows = [];
    const moved = [];

    for (const item of answerable) {
      const query = [{ vector: vectors.get(item.question), text: item.question, label: '' }];

      // Baseline: exactly what production does today.
      const base = selectChunksMultiQuery(query, store, {
        k: TOP_K,
        floor: SCORE_FLOOR,
        maxPerPage: MAX_PER_PAGE,
      });
      const baseRank = rankOf(base, item.acceptablePaths);
      baseRows.push({ question: item.question, rank: baseRank });

      // Candidates: the same retrieval, just wider.
      const candidates = selectChunksMultiQuery(query, store, {
        k: CANDIDATES,
        floor: SCORE_FLOOR,
        maxPerPage: MAX_PER_PAGE,
      });

      /*
       * Averaged over runs because the reranker is a language model and therefore
       * stochastic. A single pass would let one unlucky ordering read as a verdict.
       */
      let rankSum = 0;
      for (let i = 0; i < RUNS; i += 1) {
        const ordered = await rerank({ question: item.question, candidates, llm, topK: TOP_K });
        rankSum += rankOf(ordered, item.acceptablePaths);
      }
      const meanRank = rankSum / RUNS;
      rerankedRows.push({ question: item.question, rank: Math.round(meanRank) });

      if (Math.round(meanRank) !== baseRank) {
        moved.push({ question: item.question, from: baseRank, to: Math.round(meanRank) });
      }
    }

    const before = metrics(baseRows);
    const after = metrics(rerankedRows);
    const delta = (a, b) => `${a >= b ? ' ' : ''}${((b - a) * 100).toFixed(1)}pp`;

    line();
    console.log(`${name}  (${answerable.length} answerable questions)`);
    line();
    console.log(`  hit@1  ${pct(before.hit1)} -> ${pct(after.hit1)}   ${delta(before.hit1, after.hit1)}`);
    console.log(`  hit@3  ${pct(before.hit3)} -> ${pct(after.hit3)}   ${delta(before.hit3, after.hit3)}`);
    console.log(`  MRR    ${before.mrr.toFixed(3)} -> ${after.mrr.toFixed(3)}   ${(after.mrr - before.mrr >= 0 ? '+' : '') + (after.mrr - before.mrr).toFixed(3)}`);

    if (moved.length === 0) {
      console.log('\n  no question changed rank');
    } else {
      console.log('');
      for (const m of moved) {
        const verdict = m.to === 0 ? 'LOST' : m.from === 0 ? 'found' : m.to < m.from ? 'better' : 'worse';
        console.log(`  ${verdict.padEnd(7)} ${m.from || '-'} -> ${m.to || 'MISS'}  ${m.question}`);
      }
    }
    console.log('');
  }

  console.log('Decide on held-out hit@1. The golden set is saturated and cannot');
  console.log('distinguish two configurations - it reported nothing for the last three changes.');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
