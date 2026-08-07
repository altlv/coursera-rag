/*
 * Measure whether the attribution check catches anything real.
 *
 *   npm run check-attribution              # default provider, both eval sets
 *   npm run check-attribution -- --all     # every configured provider
 *   npm run check-attribution -- --only=openrouter
 *
 * This exists because a check that never fires is indistinguishable from a check
 * that works, and both look like "0 problems found". So the script reports three
 * numbers, not one: how many identifier claims were CHECKED, how many were
 * flagged, and the answers involved - so a human can judge each flag as a true or
 * false positive. A high flag rate is as suspicious as a zero one.
 *
 * It runs against both eval sets and, when asked, more than one provider. The
 * weakest supported model sets the real behaviour here, exactly as it did for
 * prompt injection - a strong model may attribute carefully while a small one
 * scatters citations, and testing only the default would miss that entirely.
 *
 * Costs real money: one generation call per question per provider.
 */
const fs = require('fs').promises;
const path = require('path');
const dotenv = require('dotenv');
const { OpenAI } = require('openai');
const {
  selectChunksMultiQuery,
  normalizeVector,
  generateAnswer,
  assessConfidence,
} = require('../server/rag');
const { extractIdentifiers } = require('../server/answer-checks');
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
/** Substring filter, so a single flagged question can be re-run for inspection. */
const MATCH = (args.find((a) => a.startsWith('--question=')) || '').split('=')[1];

const line = (char = '-') => console.log(char.repeat(76));

async function loadStore() {
  const meta = JSON.parse(await fs.readFile(path.join(DOCS_ROOT, 'chunks.json'), 'utf8'));
  const buffer = await fs.readFile(path.join(DOCS_ROOT, 'vectors.bin'));
  const vectors = new Float32Array(
    buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  );
  return { ...meta, vectors };
}

/** Cached fixture vectors where possible, so only novel questions cost anything. */
async function makeEmbedder(store) {
  const fixtures = [];
  for (const name of ['golden-vectors.json', 'holdout-vectors.json']) {
    try {
      const f = JSON.parse(
        await fs.readFile(path.resolve(__dirname, '../test/fixtures', name), 'utf8'),
      );
      if (f.model === store.model && f.dimensions === store.dimensions) fixtures.push(f);
    } catch {
      /* fixture absent or from another embedding space - fall back to the API */
    }
  }

  const apiKey = process.env.OPENAI_API_KEY;
  const client = apiKey ? new OpenAI({ apiKey }) : null;

  return async function embed(question) {
    for (const f of fixtures) {
      const hit = f.questions.find((q) => q.question === question);
      if (hit) return hit.vector;
    }
    if (!client) throw new Error('OPENAI_API_KEY needed to embed a question outside the fixtures');
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

  // The corpus-wide identifier set: what makes an "unsupported" finding possible
  // to distinguish from an invented example variable.
  const knownIdentifiers = new Set();
  for (const chunk of store.chunks) {
    for (const id of extractIdentifiers(chunk.text)) knownIdentifiers.add(id);
  }

  const { GOLDEN_SET } = await import('../test/golden-set.mjs');
  const { HOLDOUT_SET } = await import('../test/holdout-set.mjs');
  const questions = [...GOLDEN_SET, ...HOLDOUT_SET]
    .map((q) => q.question)
    .filter((q) => !MATCH || q.toLowerCase().includes(MATCH.toLowerCase()));

  const providers = (ONLY ? [ONLY] : RUN_ALL ? listAvailable() : [undefined]).filter(
    (p) => p !== null,
  );

  line('=');
  console.log('Attribution check - does it catch anything real?');
  line('=');
  console.log(`Store      : ${store.chunkCount} passages, ${knownIdentifiers.size} identifiers`);
  console.log(`Questions  : ${questions.length} (golden + held-out)`);
  console.log(`Providers  : ${providers.map((p) => p || 'default').join(', ')}\n`);

  for (const provider of providers) {
    let llm;
    try {
      llm = createLlm({ provider });
    } catch (error) {
      console.log(`skipping ${provider}: ${error.message}\n`);
      continue;
    }

    let checked = 0;
    let answers = 0;
    const misattributed = [];
    const unsupported = [];
    const downgraded = [];

    for (const question of questions) {
      let results;
      try {
        const vector = await embed(question);
        results = selectChunksMultiQuery(
          [{ vector, text: question, label: '' }],
          store,
          { k: TOP_K, floor: SCORE_FLOOR, maxPerPage: MAX_PER_PAGE },
        );
      } catch (error) {
        console.log(`  retrieval failed on "${question}": ${error.message}`);
        continue;
      }

      if (results.length === 0) continue; // Refused for free; nothing to attribute.

      let generated;
      try {
        generated = await generateAnswer({
          question,
          chunks: results.map((r) => ({ ...r, text: r.text || r.snippet || '' })),
          llm,
          knownIdentifiers,
        });
      } catch (error) {
        console.log(`  generation failed on "${question}": ${error.message}`);
        continue;
      }

      if (generated.status !== 'answered') continue;
      answers += 1;

      if (MATCH) {
        // Inspecting one question: show everything needed to judge a flag by hand.
        console.log(`\nQ: ${question}`);
        console.log(`\n${generated.answer}\n`);
        results.forEach((r, i) => console.log(`  [${i + 1}] ${r.path}  (${r.score.toFixed(3)})`));
      }
      checked += generated.attribution?.checked ?? 0;

      for (const m of generated.attribution?.misattributed ?? []) {
        misattributed.push({ question, ...m });
      }
      for (const u of generated.attribution?.unsupported ?? []) {
        unsupported.push({ question, ...u });
      }

      // Does the finding actually change what the user is told?
      const withCheck = assessConfidence({
        status: generated.status,
        results,
        citations: generated.citations,
        attribution: generated.attribution,
      });
      const without = assessConfidence({
        status: generated.status,
        results,
        citations: generated.citations,
      });
      if (withCheck.level !== without.level) {
        downgraded.push({ question, from: without.level, to: withCheck.level });
      }
    }

    line();
    console.log(`${llm.providerLabel} (${llm.model})`);
    line();
    console.log(`  answers                : ${answers}`);
    console.log(`  identifier claims      : ${checked}`);
    console.log(`  misattributed          : ${misattributed.length}`);
    console.log(`  ungrounded (known API) : ${unsupported.length}`);
    console.log(`  confidence downgraded  : ${downgraded.length}`);

    if (checked === 0) {
      console.log('\n  Nothing was checked. That is a finding about the CHECK, not the answers.');
    }

    for (const m of misattributed) {
      console.log(`\n  MISATTRIBUTED  "${m.identifier}"`);
      console.log(`    question : ${m.question}`);
      console.log(`    cited    : [${m.cited.join('][')}]`);
      console.log(`    actually : [${m.actual.join('][')}]`);
      if (VERBOSE) console.log(`    sentence : ${m.sentence}`);
    }

    for (const u of unsupported) {
      console.log(`\n  UNGROUNDED  "${u.identifier}"  (cited [${u.cited.join('][')}])`);
      console.log(`    question : ${u.question}`);
      if (VERBOSE) console.log(`    sentence : ${u.sentence}`);
    }

    for (const d of downgraded) {
      console.log(`\n  confidence ${d.from} -> ${d.to}: ${d.question}`);
    }
    console.log('');
  }

  console.log('Judge each flag yourself: a false positive here is worse than a miss,');
  console.log('because it tells a user a correct answer is badly sourced.');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
