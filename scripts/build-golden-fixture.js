/*
 * Embed the golden-set questions once and cache the vectors.
 *
 *   npm run build-golden
 *
 * Why cache them
 * --------------
 * Searching requires embedding the QUESTION, which is an API call. A retrieval
 * test that embeds its questions on every run costs money each time, needs the
 * network, and cannot run in CI - so in practice it would not get run, which
 * defeats the point of having it.
 *
 * The golden questions are fixed, so their vectors are computed once here and
 * committed. test/retrieval.test.mjs then reads them and does nothing but dot
 * products against vectors.bin: free, offline, milliseconds.
 *
 * A second benefit: this PINS the vectors. Embedding endpoints are not
 * guaranteed to return bit-identical output forever - providers update models.
 * Cached vectors mean the test measures changes to OUR retrieval rather than
 * drift on the provider's side.
 *
 * Re-run only when the questions change or the embedding model changes.
 * Cost: ~15 short questions, roughly 150 tokens, about $0.000003.
 */

const fs = require('fs').promises;
const path = require('path');
const dotenv = require('dotenv');
const { OpenAI } = require('openai');
const { normalizeVector } = require('../server/rag');

dotenv.config();

const FIXTURE_DIR = path.resolve(__dirname, '../test/fixtures');
const FIXTURE_PATH = path.join(FIXTURE_DIR, 'golden-vectors.json');
const CHUNKS_FILE = path.resolve(__dirname, '../docs/angular/chunks.json');

async function run() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('Missing OPENAI_API_KEY. Copy .env.sample to .env and set it.');
    process.exit(1);
  }

  // The question list lives in an ESM module shared with the test.
  const { GOLDEN_SET } = await import('../test/golden-set.mjs');

  /*
   * Read the model and dimensions from the store rather than hardcoding them.
   * Question vectors must come from the SAME embedding space as the chunk
   * vectors; otherwise every comparison is meaningless while still producing
   * plausible-looking numbers.
   */
  const store = JSON.parse(await fs.readFile(CHUNKS_FILE, 'utf8'));
  const { model, dimensions } = store;

  console.log(`Store  : ${store.chunkCount} chunks, ${model} @ ${dimensions} dims`);
  console.log(`Golden : ${GOLDEN_SET.length} questions\n`);

  const client = new OpenAI({ apiKey });
  const questions = GOLDEN_SET.map((q) => q.question);

  const response = await client.embeddings.create({
    model,
    dimensions,
    input: questions,
  });

  if (!response.data || response.data.length !== questions.length) {
    throw new Error('OpenAI returned an unexpected number of embeddings.');
  }

  const ordered = response.data.sort((a, b) => a.index - b.index);

  const entries = GOLDEN_SET.map((item, i) => ({
    question: item.question,
    expect: item.expect,
    acceptablePaths: item.acceptablePaths || [],
    // Normalised here so the test needs no maths beyond a dot product.
    vector: Array.from(normalizeVector(ordered[i].embedding)),
  }));

  await fs.mkdir(FIXTURE_DIR, { recursive: true });
  await fs.writeFile(
    FIXTURE_PATH,
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        model,
        dimensions,
        normalized: true,
        questionCount: entries.length,
        questions: entries,
      },
      null,
      2,
    ),
    'utf8',
  );

  const kb = ((await fs.stat(FIXTURE_PATH)).size / 1024).toFixed(0);
  const tokens = Math.ceil(questions.join(' ').length / 4);
  console.log(`Wrote ${FIXTURE_PATH}`);
  console.log(`  ${entries.length} vectors, ${kb} KB`);
  console.log(`  ~${tokens} tokens embedded, roughly $${((tokens * 0.02) / 1e6).toFixed(6)}`);
  console.log('\nNow run: npm run test:retrieval');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
