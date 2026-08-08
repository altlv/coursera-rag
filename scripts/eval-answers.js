/*
 * Score the ANSWERS, not the retrieval.
 *
 *   npm run eval:answers                  # default provider
 *   npm run eval:answers -- --all         # every configured provider
 *   npm run eval:answers -- --only=openrouter
 *   npm run eval:answers -- --verbose     # show every answer
 *
 * `npm run eval` measures whether the right page ranked. Nothing measured whether
 * the resulting ANSWER was any good, and that gap is why a single thumbs-down
 * found a defect every automatic signal had rated `answered` with high confidence.
 *
 * Producing an answer is stochastic and costs money, so this is a script rather
 * than a gating test. Scoring one, given the answer, is deterministic and free -
 * which is why server/answer-quality.js is unit-tested without a network.
 *
 * Four metrics, in descending order of what they tell you:
 *
 *   status accuracy    did it answer / refuse / hedge as it should? This measures
 *                      the three-outcome design directly and is the one that
 *                      catches confident nonsense.
 *   must-mention       does a correct answer name the thing it has to name?
 *   citation coverage  does an answered answer cite anything at all?
 *   refusal purity     does a refusal invent citations? It must not.
 *
 * Costs one generation call per question per provider - roughly $0.02 for 30
 * questions on gpt-4o-mini.
 */
const fs = require('fs').promises;
const path = require('path');
const dotenv = require('dotenv');
const { OpenAI } = require('openai');
const { selectChunksMultiQuery, normalizeVector, generateAnswer } = require('../server/rag');
const { buildCanonicalSpellings } = require('../server/answer-checks');
const { scoreAnswer, aggregate } = require('../server/answer-quality');
const { listAvailable, createLlm } = require('../server/llm-providers');

dotenv.config();

const DOCS_ROOT = path.resolve(__dirname, '../docs/angular');
const TOP_K = 5;
const SCORE_FLOOR = 0.25;
const MAX_PER_PAGE = 2;

const args = process.argv.slice(2);
const RUN_ALL = args.includes('--all');
const ONLY = (args.find((a) => a.startsWith('--only=')) || '').split('=')[1];
const VERBOSE = args.includes('--verbose');
/*
 * Generation is stochastic, so a single pass is a noisy estimate. Measured here:
 * "what are reactive forms?" failed its rubric on one run and passed on the next,
 * same question and same passages. Reading one pass as a regression would be a
 * mistake, so repeats are averaged and the spread is reported.
 */
const RUNS = Math.max(1, Number((args.find((a) => a.startsWith('--runs=')) || '').split('=')[1]) || 1);
/** Substring filter, so one flagged question can be re-run and read in full. */
const MATCH = (args.find((a) => a.startsWith('--question=')) || '').split('=')[1];

const pct = (n) => `${Math.round(n * 100)}%`;
const line = (char = '-') => console.log(char.repeat(78));

async function loadStore() {
  const meta = JSON.parse(await fs.readFile(path.join(DOCS_ROOT, 'chunks.json'), 'utf8'));
  const buffer = await fs.readFile(path.join(DOCS_ROOT, 'vectors.bin'));
  const vectors = new Float32Array(
    buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  );
  return { ...meta, vectors };
}

/** Cached fixture vectors, so retrieval is byte-identical across providers. */
async function makeEmbedder(store) {
  const fixtures = [];
  for (const name of ['golden-vectors.json', 'holdout-vectors.json']) {
    try {
      const f = JSON.parse(
        await fs.readFile(path.resolve(__dirname, '../test/fixtures', name), 'utf8'),
      );
      if (f.model === store.model && f.dimensions === store.dimensions) fixtures.push(f);
    } catch {
      /* absent, or from another embedding space - fall back to the API */
    }
  }

  const apiKey = process.env.OPENAI_API_KEY;
  const client = apiKey ? new OpenAI({ apiKey }) : null;

  return async (question) => {
    for (const f of fixtures) {
      const hit = f.questions.find((q) => q.question === question);
      if (hit) return hit.vector;
    }
    if (!client) throw new Error('OPENAI_API_KEY needed for a question outside the fixtures');
    const res = await client.embeddings.create({
      model: store.model,
      dimensions: store.dimensions,
      input: question,
    });
    return normalizeVector(res.data[0].embedding);
  };
}

async function run() {
  const store = await loadStore();
  const embed = await makeEmbedder(store);
  const canonicalSpellings = buildCanonicalSpellings(store.chunks);

  const { GOLDEN_SET } = await import('../test/golden-set.mjs');
  const { HOLDOUT_SET } = await import('../test/holdout-set.mjs');
  const { rubricFor } = await import('../test/answer-rubrics.mjs');

  const questions = [
    ...GOLDEN_SET.map((q) => ({ ...q, set: 'golden' })),
    ...HOLDOUT_SET.map((q) => ({ ...q, set: 'held-out' })),
  ].filter((q) => !MATCH || q.question.toLowerCase().includes(MATCH.toLowerCase()));

  const providers = (ONLY ? [ONLY] : RUN_ALL ? listAvailable() : [undefined]).filter(
    (p) => p !== null,
  );

  line('=');
  console.log('Answer quality - what the model SAID, not what retrieval found');
  line('=');
  console.log(`Store     : ${store.chunkCount} passages`);
  console.log(`Questions : ${questions.length} (golden + held-out)`);
  console.log(`Rubrics   : ${questions.filter((q) => rubricFor(q.question).length).length} scored\n`);

  for (const provider of providers) {
    let llm;
    try {
      llm = createLlm({ provider });
    } catch (error) {
      console.log(`skipping ${provider}: ${error.message}\n`);
      continue;
    }

    const results = [];
    const failures = [];
    /** question -> how many runs it passed, for spotting the unstable ones. */
    const passesByQuestion = new Map();

    for (const q of [].concat(...Array.from({ length: RUNS }, () => questions))) {
      let results_ = [];
      try {
        const vector = await embed(q.question);
        results_ = selectChunksMultiQuery([{ vector, text: q.question, label: '' }], store, {
          k: TOP_K,
          floor: SCORE_FLOOR,
          maxPerPage: MAX_PER_PAGE,
        });
      } catch (error) {
        console.log(`  retrieval failed on "${q.question}": ${error.message}`);
        continue;
      }

      let generated;
      try {
        generated = await generateAnswer({
          question: q.question,
          chunks: results_.map((r) => ({ ...r, text: r.text || r.snippet || '' })),
          llm,
          canonicalSpellings,
        });
      } catch (error) {
        console.log(`  generation failed on "${q.question}": ${error.message}`);
        continue;
      }

      /*
       * Did retrieval hand generation anything it could answer from? Without this
       * the score blames generation for retrieval's misses - and hedging after a
       * retrieval miss is correct behaviour, not a defect.
       */
      const retrievalHit =
        (q.acceptablePaths ?? []).length === 0
          ? null
          : results_.some((r) => q.acceptablePaths.some((p) => r.path.startsWith(p)));

      const scored = scoreAnswer({
        expect: q.expect ?? 'match',
        mustMention: rubricFor(q.question),
        status: generated.status,
        answer: generated.answer,
        citations: generated.citations,
        chunks: results_,
        retrievalHit,
      });

      results.push({ ...scored, set: q.set });
      const seen = passesByQuestion.get(q.question) ?? { pass: 0, runs: 0 };
      passesByQuestion.set(q.question, {
        pass: seen.pass + (scored.ok ? 1 : 0),
        runs: seen.runs + 1,
      });
      if (!scored.ok) failures.push({ q, scored, generated });

      if (VERBOSE || MATCH) {
        console.log(`\n[${scored.ok ? 'ok' : 'XX'}] ${q.question}`);
        if (MATCH) {
          // Inspecting one question: print enough to judge the rubric by hand.
          console.log(`\n${generated.answer}\n`);
          results_.forEach((r, i) => console.log(`  [${i + 1}] ${r.path} (${r.score.toFixed(3)})`));
          console.log(`  retrievalHit: ${retrievalHit}`);
        } else {
          console.log(`     ${generated.answer.slice(0, 240).replace(/\n/g, ' ')}`);
        }
      }
    }

    const all = aggregate(results);
    const golden = aggregate(results.filter((r) => r.set === 'golden'));
    const holdout = aggregate(results.filter((r) => r.set === 'held-out'));

    line();
    console.log(`${llm.providerLabel} (${llm.model})`);
    line();
    const row = (label, m) =>
      console.log(
        `  ${label.padEnd(10)} status ${pct(m.statusAccuracy).padStart(4)}` +
          `   mentions ${pct(m.mentionRecall).padStart(4)} (${m.met}/${m.requirements})` +
          `   cites ${pct(m.citationCoverage).padStart(4)}` +
          `   refusals clean ${pct(m.refusalPurity).padStart(4)}`,
      );
    row('golden', golden);
    row('held-out', holdout);
    row('ALL', all);
    console.log(`\n  scored ${all.scored} of ${all.total} questions against a rubric`);

    if (RUNS > 1) {
      /*
       * The questions that pass sometimes are the interesting ones. A question
       * failing every run is a real gap; one failing half the time is variance,
       * and treating the two the same is how a noisy metric gets over-read.
       */
      const unstable = [...passesByQuestion.entries()].filter(([, v]) => v.pass > 0 && v.pass < v.runs);
      const always = [...passesByQuestion.entries()].filter(([, v]) => v.pass === 0);
      console.log(`\n  over ${RUNS} runs: ${always.length} always fail, ${unstable.length} unstable`);
      for (const [q, v] of unstable) console.log(`    unstable  ${v.pass}/${v.runs}  ${q}`);
      for (const [q] of always) console.log(`    always    0/${RUNS}  ${q}`);
    }

    for (const f of RUNS > 1 ? [] : failures) {
      console.log(`\n  FAIL  ${f.q.question}`);
      if (f.scored.statusCorrect === false) {
        console.log(`    status   : expected ${f.scored.expectedStatus}, got ${f.scored.actualStatus}`);
      }
      for (const group of f.scored.missing) {
        console.log(`    missing  : ${group.join(' | ')}`);
      }
      if (f.scored.citesSomething === false) console.log('    citations: answered but cited nothing');
      if (!f.scored.refusalPure) console.log('    citations: refusal invented a citation');
    }
    console.log('');
  }

  console.log('Status accuracy is the one to watch: it measures whether the system');
  console.log('answers, refuses or hedges correctly - which no retrieval metric can see.');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
