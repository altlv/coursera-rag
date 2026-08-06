/*
 * Build the vector store from the downloaded docs corpus.
 *
 * Output is two files:
 *   docs/angular/chunks.json  - metadata (id, title, path, url, text)
 *   docs/angular/vectors.bin  - raw Float32, row-major, unit-normalised
 *
 * Why not one JSON file, as before
 * -------------------------------
 * A 1536-float array serialises to roughly 30-45 KB of JSON text. The old store
 * held 23 chunks and was already 1.2 MB. Once chunking was fixed and the corpus
 * grew to ~950 chunks, the same format would have produced a ~45 MB file that
 * had to be JSON.parsed on every server start.
 *
 * Raw Float32 is 4 bytes per dimension with no parsing at all - just read the
 * buffer. At 512 dimensions that is ~2 MB, and loading is a file read rather
 * than a parse.
 *
 * Two further decisions worth knowing about:
 *
 *  - `dimensions: 512` uses the embedding model's Matryoshka property: the
 *    vectors are trained so a truncated prefix is still a valid embedding.
 *    512 instead of 1536 costs about 1% retrieval quality for a third of the
 *    space and a third of the work per comparison.
 *
 *  - Vectors are unit-normalised here, once. Cosine similarity between unit
 *    vectors is exactly their dot product, so query time needs no square roots.
 */

const dotenv = require('dotenv');
const fs = require('fs').promises;
const path = require('path');
const { OpenAI } = require('openai');
const { chunkText, normalizeVector } = require('./rag');

dotenv.config();

const DOCS_ROOT = path.resolve(__dirname, '../docs/angular');
const CHUNKS_FILE = path.join(DOCS_ROOT, 'chunks.json');
const VECTORS_FILE = path.join(DOCS_ROOT, 'vectors.bin');

const EMBEDDING_MODEL = 'text-embedding-3-small';
const DIMENSIONS = 512;
const CHUNK_CHARS = 1200;
const CHUNK_OVERLAP = 150;

/*
 * Chunks are ~1200 chars (~300 tokens), so 64 per request is ~19k tokens - well
 * inside the API's per-request limit, and far fewer round trips than the old
 * batch size of 10.
 */
const BATCH_SIZE = 64;

/*
 * Hard ceiling per chunk, as a safety net rather than a routine path. Chunking
 * already guarantees <= CHUNK_CHARS; this only catches a pathological page.
 *
 * Crucially, the truncation is applied ONCE and the truncated string is what we
 * both embed AND store. The previous version truncated only the text sent to the
 * API while storing the full original, so for large pages the stored snippet did
 * not correspond to its own vector.
 */
const MAX_CHUNK_CHARS = 8000;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY. Copy .env.sample to .env and set it.');
  process.exit(1);
}

const client = new OpenAI({ apiKey: OPENAI_API_KEY });

async function loadDocsPages() {
  const pages = [];

  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.name === 'index.json') {
        pages.push(JSON.parse(await fs.readFile(full, 'utf8')));
      }
    }
  }

  await walk(DOCS_ROOT);
  pages.sort((a, b) => a.path.localeCompare(b.path));
  return pages;
}

function buildChunks(pages) {
  const chunks = [];

  for (const page of pages) {
    const pieces = chunkText(page.contentText || '', CHUNK_CHARS, CHUNK_OVERLAP);

    pieces.forEach((text, index) => {
      chunks.push({
        id: `${page.path}#${index + 1}`,
        title: page.title,
        path: page.path,
        url: page.url,
        // Truncate once, then embed and store this exact string.
        text: text.length > MAX_CHUNK_CHARS ? text.slice(0, MAX_CHUNK_CHARS) : text,
      });
    });
  }

  return chunks;
}

async function embedBatch(texts) {
  const response = await client.embeddings.create({
    model: EMBEDDING_MODEL,
    dimensions: DIMENSIONS,
    input: texts,
  });

  if (!response.data || response.data.length !== texts.length) {
    throw new Error('OpenAI returned an unexpected number of embeddings.');
  }

  // Keep API order, not response order, explicit.
  return response.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

async function build() {
  const pages = await loadDocsPages();
  if (pages.length === 0) {
    throw new Error('No pages found. Run `npm run download-docs` first.');
  }

  const chunks = buildChunks(pages);
  if (chunks.length === 0) {
    throw new Error('No chunks produced from the downloaded documentation.');
  }

  const lengths = chunks.map((c) => c.text.length);
  console.log(`Pages   : ${pages.length}`);
  console.log(`Chunks  : ${chunks.length}`);
  console.log(
    `Sizes   : min ${Math.min(...lengths)}, max ${Math.max(...lengths)}, ` +
      `avg ${Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length)} chars`,
  );
  console.log(`Model   : ${EMBEDDING_MODEL} @ ${DIMENSIONS} dims\n`);

  const vectors = new Float32Array(chunks.length * DIMENSIONS);

  for (let start = 0; start < chunks.length; start += BATCH_SIZE) {
    const batch = chunks.slice(start, start + BATCH_SIZE);
    const embeddings = await embedBatch(batch.map((c) => c.text));

    embeddings.forEach((embedding, i) => {
      if (embedding.length !== DIMENSIONS) {
        throw new Error(`Expected ${DIMENSIONS} dims, got ${embedding.length}.`);
      }
      // Normalise on the way in, so retrieval is a bare dot product.
      vectors.set(normalizeVector(embedding), (start + i) * DIMENSIONS);
    });

    process.stdout.write(
      `\r  embedded ${Math.min(start + BATCH_SIZE, chunks.length)}/${chunks.length}`,
    );
  }

  console.log('\n');

  await fs.writeFile(
    CHUNKS_FILE,
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        model: EMBEDDING_MODEL,
        dimensions: DIMENSIONS,
        chunkChars: CHUNK_CHARS,
        chunkOverlap: CHUNK_OVERLAP,
        normalized: true,
        pageCount: pages.length,
        chunkCount: chunks.length,
        chunks,
      },
      null,
      2,
    ),
    'utf8',
  );

  await fs.writeFile(VECTORS_FILE, Buffer.from(vectors.buffer));

  const chunkKb = (await fs.stat(CHUNKS_FILE)).size / 1024;
  const vectorKb = (await fs.stat(VECTORS_FILE)).size / 1024;
  console.log(`chunks.json : ${chunkKb.toFixed(0)} KB`);
  console.log(`vectors.bin : ${vectorKb.toFixed(0)} KB`);
  console.log('\nRestart the backend to pick up the new store.');
}

build().catch((error) => {
  console.error(error);
  process.exit(1);
});
