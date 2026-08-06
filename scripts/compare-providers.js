/*
 * Compare answer-generation providers on identical evidence.
 *
 *   npm run compare-providers
 *   npm run compare-providers -- --all        (every golden question)
 *   npm run compare-providers -- --only=gemini
 *
 * Why this is a clean experiment
 * ------------------------------
 * Retrieval runs ONCE per question, and every provider is then handed the exact
 * same passages in the same order with the same prompt. So any difference in the
 * output is attributable to the model alone - not to retrieval luck, not to
 * different context, not to ordering.
 *
 * That isolation is the whole point. Comparing two providers that each did their
 * own retrieval would confound the writer with the evidence, and you would learn
 * nothing about either.
 *
 * The three behaviours worth watching, which the golden set encodes:
 *   'match'  - does it answer, and does it cite?
 *   'weak'   - does it ADMIT the passages don't answer the question, or does it
 *              pad an answer out of adjacent material? This is where models
 *              differ most.
 *   'none'   - never reaches a model: zero passages clear the floor, so the
 *              refusal is free. Shown for completeness.
 */

const fs = require('fs').promises;
const path = require('path');
const dotenv = require('dotenv');
const { OpenAI } = require('openai');
const {
  selectChunksHybrid,
  normalizeVector,
  generateAnswer,
  assessConfidence,
} = require('../server/rag');
const { listAvailable, createLlm } = require('../server/llm-providers');

dotenv.config();

const DOCS_ROOT = path.resolve(__dirname, '../docs/angular');
const CHUNKS_FILE = path.join(DOCS_ROOT, 'chunks.json');
const VECTORS_FILE = path.join(DOCS_ROOT, 'vectors.bin');
const FIXTURE_FILE = path.resolve(__dirname, '../test/fixtures/golden-vectors.json');

const TOP_K = 5;
const SCORE_FLOOR = 0.25;
const MAX_PER_PAGE = 2;

const args = process.argv.slice(2);
const RUN_ALL = args.includes('--all');
const ONLY = (args.find((a) => a.startsWith('--only=')) || '').split('=')[1];

/** A representative subset: one per behaviour, plus two ordinary questions. */
const DEFAULT_QUESTIONS = [
  'what are signals?',
  'how do I add an HTTP interceptor?',
  'how do I pass data into a component?',
  'What does CSS stand for?',
  'Got milk?',
];

const line = (char = '-') => console.log(char.repeat(72));

async function loadStore() {
  const meta = JSON.parse(await fs.readFile(CHUNKS_FILE, 'utf8'));
  const buffer = await fs.readFile(VECTORS_FILE);
  const vectors = new Float32Array(
    buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  );
  return { ...meta, vectors };
}

/**
 * Get a query vector, preferring the cached golden fixture.
 *
 * Reusing the fixture keeps the comparison free for golden questions AND removes
 * embedding variation as a confounder - every provider sees passages retrieved by
 * a byte-identical query vector.
 */
async function makeEmbedder(store) {
  let fixture = null;
  try {
    fixture = JSON.parse(await fs.readFile(FIXTURE_FILE, 'utf8'));
    if (fixture.model !== store.model || fixture.dimensions !== store.dimensions) fixture = null;
  } catch {
    fixture = null;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  const client = apiKey ? new OpenAI({ apiKey }) : null;

  return async function embed(question) {
    const cached = fixture?.questions.find((q) => q.question === question);
    if (cached) return { vector: cached.vector, cached: true };

    if (!client) throw new Error('OPENAI_API_KEY needed to embed a non-golden question');
    const response = await client.embeddings.create({
      model: store.model,
      dimensions: store.dimensions,
      input: question,
    });
    return { vector: normalizeVector(response.data[0].embedding), cached: false };
  };
}

async function run() {
  const providers = (ONLY ? [ONLY] : listAvailable()).filter(Boolean);

  if (providers.length === 0) {
    console.error('No provider keys found. Set OPENAI_API_KEY and/or GEMINI_API_KEY in .env');
    process.exit(1);
  }

  const store = await loadStore();
  const embed = await makeEmbedder(store);

  const { GOLDEN_SET } = await import('../test/golden-set.mjs');
  const questions = RUN_ALL
    ? GOLDEN_SET.map((q) => q.question)
    : DEFAULT_QUESTIONS.filter((q) => GOLDEN_SET.some((g) => g.question === q));

  const expectations = new Map(GOLDEN_SET.map((q) => [q.question, q.expect]));

  line('=');
  console.log('Provider comparison - identical passages, different writer');
  line('=');
  console.log(`Providers : ${providers.join(', ')}`);
  console.log(`Questions : ${questions.length}${RUN_ALL ? ' (all golden)' : ' (representative subset)'}`);
  console.log(`Store     : ${store.chunkCount} passages, ${store.model} @ ${store.dimensions} dims`);
  console.log(`Calls     : up to ${providers.length * questions.length} generation requests\n`);

  const llms = new Map();
  for (const name of providers) {
    try {
      llms.set(name, createLlm({ provider: name }));
    } catch (error) {
      console.log(`  skipping ${name}: ${error.message}`);
    }
  }

  const summary = [];

  for (const question of questions) {
    const expected = expectations.get(question) || '?';

    // Retrieve ONCE. Every provider gets exactly this.
    const { vector } = await embed(question);
    const results = selectChunksHybrid(vector, question, store, {
      k: TOP_K,
      floor: SCORE_FLOOR,
      maxPerPage: MAX_PER_PAGE,
    });

    line();
    console.log(`Q: ${question}`);
    console.log(`   expected behaviour: ${expected}   |   passages retrieved: ${results.length}`);
    if (results.length) {
      console.log(`   top: ${results[0].score.toFixed(3)}  ${results[0].path}`);
    }
    line();

    if (results.length === 0) {
      // Never reaches a model, so every provider behaves identically here.
      console.log('   No passages cleared the floor -> free refusal, no model called.\n');
      for (const name of llms.keys()) {
        summary.push({ question, provider: name, status: 'refused', llmCalled: false, ms: 0 });
      }
      continue;
    }

    for (const [name, llm] of llms) {
      const started = Date.now();
      try {
        const generated = await generateAnswer({
          question,
          chunks: results.map((r) => ({ ...r, text: r.text || r.snippet || '' })),
          llm,
        });
        const ms = Date.now() - started;
        const confidence = assessConfidence({
          status: generated.status,
          results,
          citations: generated.citations,
        });

        console.log(`  [${name} / ${llm.model}]`);
        console.log(`    status ${generated.status}  confidence ${confidence.level}  ` +
          `cites [${generated.citations.join(',')}]  ${ms}ms  ` +
          `${llm.lastUsage?.total_tokens ?? '?'} tokens`);
        if (generated.droppedCitations?.length) {
          console.log(`    dropped invented citations: ${generated.droppedCitations.join(', ')}`);
        }
        console.log(`    ${generated.answer.replace(/\s+/g, ' ').slice(0, 220)}`);
        console.log('');

        summary.push({
          question,
          expected,
          provider: name,
          status: generated.status,
          citations: generated.citations.length,
          dropped: generated.droppedCitations?.length || 0,
          confidence: confidence.level,
          ms,
          tokens: llm.lastUsage?.total_tokens,
          chars: generated.answer.length,
        });
      } catch (error) {
        console.log(`  [${name}] FAILED: ${error.message}\n`);
        summary.push({ question, expected, provider: name, status: 'error', error: error.message });
      }
    }
  }

  // ---- summary -----------------------------------------------------------

  line('=');
  console.log('Summary');
  line('=');

  for (const name of llms.keys()) {
    const rows = summary.filter((s) => s.provider === name && s.status !== 'refused');
    if (rows.length === 0) continue;

    const errors = rows.filter((r) => r.status === 'error').length;
    const dropped = rows.reduce((sum, r) => sum + (r.dropped || 0), 0);
    const uncited = rows.filter((r) => r.status === 'answered' && r.citations === 0).length;
    const avgMs = Math.round(rows.reduce((s, r) => s + (r.ms || 0), 0) / rows.length);
    const avgChars = Math.round(rows.reduce((s, r) => s + (r.chars || 0), 0) / rows.length);

    // Did it admit ignorance where it should have?
    const weakRows = rows.filter((r) => r.expected === 'weak');
    const admitted = weakRows.filter((r) => r.status === 'partial').length;

    console.log(`\n${name}`);
    console.log(`  answered / partial : ${rows.filter((r) => r.status === 'answered').length} / ${rows.filter((r) => r.status === 'partial').length}`);
    console.log(`  admitted ignorance : ${admitted}/${weakRows.length} on 'weak' questions ` +
      `${weakRows.length && admitted < weakRows.length ? '<- padded an answer instead' : ''}`);
    console.log(`  answers with no citation : ${uncited}`);
    console.log(`  invented citations stripped : ${dropped}`);
    console.log(`  errors : ${errors}`);
    console.log(`  avg latency ${avgMs}ms   avg answer ${avgChars} chars`);
  }

  console.log('');
  console.log('Retrieval was identical for every provider, so all differences above are');
  console.log('attributable to the model that wrote the answer.');
  line('=');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
