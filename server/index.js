const path = require('path');
const fs = require('fs').promises;
const dotenv = require('dotenv');
const Fastify = require('fastify');
const cors = require('@fastify/cors');
const { OpenAI } = require('openai');
const {
  normalizeVector,
  selectChunksHybrid,
  assessConfidence,
  generateAnswer,
  REFUSAL,
} = require('./rag');
const { createLlm, listAvailable, resolveProvider } = require('./llm-providers');
const { createHealthTracker } = require('./provider-health');

dotenv.config();

// Retrieval tuning. Change these and re-run `npm run test:retrieval` to see the
// effect on hit@3 / MRR rather than guessing.
const TOP_K = 5;
const SCORE_FLOOR = 0.25;
/*
 * At most 2 passages from any single page. Without this the top-k collapses onto
 * one well-matched page: "What does CSS stand for?" spent 2 of 5 slots on
 * duplicates, and adjacent chunks overlap by 150 characters anyway.
 */
const MAX_PER_PAGE = 2;
/*
 * Which model writes the answers is resolved per request from CHAT_PROVIDER, so
 * switching providers needs only a restart - not a code change and not a rebuild
 * of the vector store. See server/llm-providers.js for why embeddings are the
 * opposite: a rebuild rather than a switch.
 */
const EMBEDDING_MODEL = 'text-embedding-3-small';

const app = Fastify({ logger: true });
const DOCS_ROOT = path.resolve(__dirname, '../docs/angular');
const STRUCTURE_FILE = path.join(DOCS_ROOT, 'structure.json');
const CHUNKS_FILE = path.join(DOCS_ROOT, 'chunks.json');
const VECTORS_FILE = path.join(DOCS_ROOT, 'vectors.bin');
/** Rewritten by every scrape, so its mtime signals a corpus change. */
const MANIFEST_FILE = path.join(DOCS_ROOT, 'manifest.json');

/*
 * Embeddings are pinned to OpenAI, deliberately and independently of
 * CHAT_PROVIDER. The vector store was built in text-embedding-3-small's
 * 512-dimension space; embedding a QUERY with a different provider would compare
 * two unrelated spaces and return confident nonsense.
 */
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const embeddingClient = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

/** Which provider will answer, given the keys actually present. */
const chatProvider = resolveProvider(undefined, process.env);

/*
 * Liveness, tracked separately from "has a key".
 *
 * A key can be present and still unusable - xAI returned 403 "no credits or
 * licenses yet", Gemini returned 429 on a fresh free-tier key. Permanent failures
 * stop a provider being offered; transient ones only mark it degraded.
 */
const health = createHealthTracker();

let docsStructure = null;
let docsPages = null;
let vectorStore = null;

/*
 * Caches are invalidated when the corpus changes on disk.
 *
 * Without this, `npm run download-docs` or `docs:update` appears to do nothing:
 * the pages and vectors are rewritten, but a running server keeps serving what it
 * loaded at boot. That cost real confusion - a fixed duplicate-heading bug looked
 * unfixed because the old HTML was still cached in memory.
 *
 * Every scrape rewrites manifest.json, so its mtime is a reliable change signal.
 * Stat calls are cheap, but not free, so the check is throttled.
 */
let lastCorpusCheck = 0;
let lastCorpusStamp = null;
const CORPUS_CHECK_INTERVAL_MS = 2_000;

async function invalidateIfCorpusChanged() {
  const now = Date.now();
  if (now - lastCorpusCheck < CORPUS_CHECK_INTERVAL_MS) return;
  lastCorpusCheck = now;

  try {
    const stat = await fs.stat(MANIFEST_FILE);
    const stamp = `${stat.mtimeMs}`;

    if (lastCorpusStamp === null) {
      lastCorpusStamp = stamp;
      return;
    }

    if (stamp !== lastCorpusStamp) {
      lastCorpusStamp = stamp;
      docsStructure = null;
      docsPages = null;
      vectorStore = null;
      app.log.info('Corpus changed on disk - caches cleared, reloading on next request.');
    }
  } catch {
    // No manifest (e.g. a corpus built before manifests existed). Nothing to do.
  }
}

/*
 * Lowercased, whitespace-flattened text for the LEXICAL fallback only.
 *
 * Note this is NOT rag.js's normalizeText: that one preserves paragraph breaks
 * because chunking depends on them. Lexical matching wants the opposite - a
 * single flat lowercase haystack for substring counting. The two used to share
 * a name across two files while behaving differently, which is exactly how the
 * chunking bug hid for so long.
 */
function normalizeForLexical(value) {
  return (value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

async function loadDocsStructure() {
  await invalidateIfCorpusChanged();
  if (!docsStructure) {
    const content = await fs.readFile(STRUCTURE_FILE, 'utf8');
    docsStructure = JSON.parse(content);
  }
  return docsStructure;
}

async function loadDocsPages() {
  await invalidateIfCorpusChanged();
  if (docsPages) {
    return docsPages;
  }

  docsPages = new Map();

  async function walkDir(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walkDir(fullPath);
      } else if (entry.isFile() && entry.name === 'index.json') {
        const pageContent = await fs.readFile(fullPath, 'utf8');
        const page = JSON.parse(pageContent);
        docsPages.set(page.path, {
          title: page.title,
          path: page.path,
          url: page.url,
          contentText: normalizeForLexical(page.contentText),
          contentHtml: page.contentHtml,
        });
      }
    }
  }

  await walkDir(DOCS_ROOT);
  return docsPages;
}

/*
 * Load the vector store into the flat layout selectChunks expects:
 *
 *   { model, dimensions, chunks: [metadata], vectors: Float32Array }
 *
 * All vectors live in ONE contiguous Float32Array, so chunk i occupies
 * [i*dims, (i+1)*dims). One allocation instead of thousands of small arrays.
 *
 * Vectors are unit-normalised here, once, at load. That is what allows query
 * time to be a plain dot product instead of a full cosine similarity.
 */
/*
 * Load the vector store: metadata from chunks.json, vectors from vectors.bin.
 *
 * vectors.bin is raw Float32, row-major, so chunk i occupies
 * [i*dims, (i+1)*dims). Reading it is a file read and a typed-array view over
 * the buffer - no JSON parsing of ~950 x 512 numbers.
 *
 * The vectors were unit-normalised at build time, which is what lets
 * selectChunks() use a plain dot product instead of a full cosine similarity.
 */
async function loadVectorStore() {
  await invalidateIfCorpusChanged();
  if (vectorStore !== null) {
    return vectorStore;
  }

  try {
    const meta = JSON.parse(await fs.readFile(CHUNKS_FILE, 'utf8'));
    const buffer = await fs.readFile(VECTORS_FILE);
    const { dimensions, chunks } = meta;

    const expectedBytes = chunks.length * dimensions * Float32Array.BYTES_PER_ELEMENT;
    if (buffer.byteLength !== expectedBytes) {
      // The two files must have come from the same build. Mismatched vectors
      // would still "work" and quietly return nonsense, so fail loudly instead.
      throw new Error(
        `vectors.bin is ${buffer.byteLength} bytes but chunks.json implies ` +
          `${expectedBytes} (${chunks.length} chunks x ${dimensions} dims). ` +
          `Re-run: npm run build-embeddings`,
      );
    }

    const vectors = new Float32Array(
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
    );

    vectorStore = { model: meta.model, dimensions, chunks, vectors };
    app.log.info(
      `Vector store: ${chunks.length} chunks x ${dimensions} dims from ${meta.pageCount} pages ` +
        `(${meta.model})`,
    );
  } catch (error) {
    app.log.warn(`No usable vector store (${error.message}); lexical search only.`);
    vectorStore = undefined;
  }

  return vectorStore;
}

/**
 * Embed a search query and unit-normalise it, ready for a dot product.
 *
 * Always OpenAI, whatever CHAT_PROVIDER says: the query vector has to live in the
 * same space as the stored passage vectors.
 */
async function embedQuery(text) {
  if (!embeddingClient) {
    throw new Error('OPENAI_API_KEY missing. It is required for vector search regardless of CHAT_PROVIDER.');
  }

  /*
   * Read the model and dimensions from the STORE, not from a local constant.
   *
   * These used to be declared here as well as in build-vector-store.js. Two
   * copies of the same fact is how the chunking bug survived: change one and the
   * query gets embedded by a different model than the passages, which returns
   * plausible numbers and no error at all.
   */
  const store = await loadVectorStore();
  const response = await embeddingClient.embeddings.create({
    model: store?.model || EMBEDDING_MODEL,
    dimensions: store?.dimensions,
    input: text,
  });

  const embedding = response.data?.[0]?.embedding;
  if (!embedding) {
    throw new Error('Invalid embedding response from OpenAI.');
  }

  return normalizeVector(embedding);
}

/*
 * Retrieve with vector similarity AND keyword matching, fused by rank.
 *
 * Vector search alone missed a measured case: "how do I pass data into a
 * component?" ranked /guide/components/inputs only 5th, because the question
 * says "pass data" while the page says "input". Embeddings match meaning but can
 * skate over exact terminology; BM25-style keyword scoring catches the literal
 * term. Fusing by RANK rather than score is what makes them combinable at all -
 * cosine sits in ~0.25-0.65 while BM25 is unbounded.
 */
async function searchVectors(query, limit = TOP_K) {
  const store = await loadVectorStore();
  if (!store) return [];

  const queryVector = await embedQuery(query);
  return selectChunksHybrid(queryVector, query, store, {
    k: limit,
    floor: SCORE_FLOOR,
    maxPerPage: MAX_PER_PAGE,
  });
}

function buildSnippet(contentText, query) {
  const queryTokens = query.split(/\s+/).filter(Boolean);
  if (!queryTokens.length) {
    return contentText.slice(0, 300) + '...';
  }

  const index = queryTokens.reduce((bestIndex, token) => {
    const idx = contentText.indexOf(token);
    if (idx === -1) {
      return bestIndex;
    }
    if (bestIndex === -1 || idx < bestIndex) {
      return idx;
    }
    return bestIndex;
  }, -1);

  if (index === -1) {
    return contentText.slice(0, 300) + '...';
  }

  const start = Math.max(0, index - 120);
  const end = Math.min(contentText.length, index + 220);
  return `${start > 0 ? '... ' : ''}${contentText.slice(start, end).trim()}${end < contentText.length ? ' ...' : ''}`;
}

async function searchDocs(query, limit = 5) {
  const pages = await loadDocsPages();
  const normalizedQuery = normalizeForLexical(query);
  const queryTokens = normalizedQuery.split(/\s+/).filter(Boolean);

  if (!queryTokens.length) {
    return [];
  }

  const scores = [];
  for (const page of pages.values()) {
    let score = 0;
    for (const token of queryTokens) {
      if (!token) continue;
      if (page.contentText.includes(token)) {
        score += 1;
      }
      const occurrences = page.contentText.split(token).length - 1;
      score += Math.min(occurrences, 3);
    }
    if (page.title.toLowerCase().includes(normalizedQuery)) {
      score += 3;
    }
    if (score > 0) {
      scores.push({
        ...page,
        score,
        snippet: buildSnippet(page.contentText, normalizedQuery),
      });
    }
  }

  scores.sort((a, b) => b.score - a.score);
  return scores.slice(0, limit);
}

app.register(cors, {
  origin: ['http://localhost:4200'],
});

app.get('/api/docs/page', async (request, reply) => {
  const pagePath = request.query.path;
  if (!pagePath || typeof pagePath !== 'string') {
    reply.status(400);
    return { error: 'path query parameter is required' };
  }

  const pages = await loadDocsPages();
  const normalizedPath = pagePath.startsWith('/') ? pagePath : `/${pagePath}`;
  const page = pages.get(normalizedPath);
  if (!page) {
    reply.status(404);
    return { error: 'Doc page not found' };
  }

  return page;
});

app.get('/api/docs/structure', async () => {
  return await loadDocsStructure();
});

/**
 * Which providers are usable right now, so the UI can offer a switch and the
 * comparison script can skip what isn't configured. Reports names only - never
 * key values.
 */
app.get('/api/providers', async () => {
  const configured = listAvailable();

  const all = configured.map((name) => {
    const llm = createLlm({ provider: name });
    const state = health.get(name);
    return {
      name,
      label: llm.providerLabel,
      model: llm.model,
      status: state.status,
      /** Why it is unusable, when it is. Safe to show a user. */
      hint: state.hint,
      kind: state.kind,
    };
  });

  return {
    /*
     * Only offerable providers. A provider that has permanently failed - no
     * credits, revoked key, nonexistent model - is reported separately rather
     * than presented as a working choice.
     */
    available: all.filter((p) => p.status !== 'unavailable'),
    unavailable: all.filter((p) => p.status === 'unavailable'),
    active: chatProvider.name,
    reason: chatProvider.reason,
    /*
     * Embeddings are pinned separately: the vector store fixes the embedding
     * space, so this is not switchable at runtime.
     */
    embeddings: {
      provider: 'openai',
      model: vectorStore?.model ?? 'text-embedding-3-small',
      switchable: false,
      note: 'Changing this requires npm run build-embeddings and npm run build-golden',
    },
  };
});

app.post('/api/chat', async (request, reply) => {
  const { question } = request.body || {};
  if (!question || typeof question !== 'string' || !question.trim()) {
    reply.status(400);
    return { error: 'question is required' };
  }

  // ---- Stage 4: retrieve -------------------------------------------------
  let results = [];
  let mode = 'lexical';

  try {
    if (embeddingClient && (await loadVectorStore())) {
      results = await searchVectors(question, TOP_K);
      mode = 'vector';
    }
  } catch (error) {
    app.log.warn(`Vector search failed, falling back to lexical: ${error.message}`);
  }

  if (!results.length && mode !== 'vector') {
    results = await searchDocs(question, TOP_K);
    mode = 'lexical';
  }

  // ---- Stage 5: generate -------------------------------------------------
  // Without any provider key we cannot write an answer, so say so plainly rather
  // than pretending. Retrieval results are still returned so the UI stays useful.
  let answer;
  let citations = [];
  let usage;
  let status;
  let llmInfo = null;

  // A per-request override, so providers can be compared without a restart:
  //   curl ... -d '{"question":"...","provider":"gemini"}'
  const requestedProvider = typeof request.body?.provider === 'string' ? request.body.provider : undefined;

  if (!chatProvider.name) {
    status = results.length > 0 ? 'partial' : 'refused';
    answer =
      results.length > 0
        ? 'No model provider key is set, so I can only list the documentation pages that look relevant - I cannot write an answer yet. Set OPENAI_API_KEY or GEMINI_API_KEY in .env and restart the backend.'
        : REFUSAL;
  } else {
    const llm = createLlm({ provider: requestedProvider });
    llmInfo = { provider: llm.provider, providerLabel: llm.providerLabel, model: llm.model };
    try {
      const generated = await generateAnswer({
        question,
        // Lexical results carry `snippet`; vector results carry `text`.
        chunks: results.map((r) => ({ ...r, text: r.text || r.snippet || '' })),
        llm,
      });
      status = generated.status;
      answer = generated.answer;
      citations = generated.citations;
      usage = llm.lastUsage;
      health.markOk(llm.provider);

      if (generated.droppedCitations?.length) {
        app.log.warn(`Dropped hallucinated citations: ${generated.droppedCitations.join(', ')}`);
      }
    } catch (error) {
      /*
       * Record WHY it failed so the provider can be demoted appropriately: a
       * permanent failure (no credits, bad key) removes it from the offered list,
       * while a rate limit only marks it degraded.
       */
      const classified = health.markFailed(llm.provider, error);
      app.log.error(
        `Generation failed on ${llm.provider} [${classified.kind}]: ${error.message}`,
      );

      reply.status(502);
      return {
        error: `${llm.providerLabel} could not answer: ${classified.hint}`,
        provider: llm.provider,
        errorKind: classified.kind,
        permanent: classified.permanent,
        detail: error.message,
      };
    }
  }

  /*
   * On 'refused' there is nothing worth showing, so sources are omitted. On
   * 'partial' the sources ARE the useful part of the response - the answer text
   * says as much - so they are still returned.
   */
  const sources =
    status === 'refused'
      ? []
      : results.map((result) => ({
          title: result.title,
          path: result.path,
          url: `/docs?path=${encodeURIComponent(result.path)}`,
          originalUrl: result.url,
        }));

  return {
    question,
    mode,
    status,
    model: llmInfo?.model ?? null,
    provider: llmInfo?.provider ?? null,
    providerLabel: llmInfo?.providerLabel ?? null,
    answer,
    citations,
    usage,
    // Composite, deliberately not derived from similarity alone - see
    // assessConfidence() for why a score-based badge would mislead.
    confidence: assessConfidence({ status, results, citations }),
    sources,
    retrieved: results.map((result) => ({
      title: result.title,
      path: result.path,
      score: result.score,
      /** Where each retrieval method placed this chunk, for explainability. */
      ranks: result.ranks,
      snippet: (result.snippet || result.text || '').slice(0, 400),
    })),
  };
});

// 3000, not 5173: 5173 is Vite's default dev-server port and reads as a
// frontend port in an Angular repo. Keep in sync with proxy.conf.json.
const PORT = process.env.PORT || 3000;
app.listen({ port: PORT, host: '0.0.0.0' }).then(() => {
  app.log.info(`Backend ready at http://localhost:${PORT}`);

  const available = listAvailable();
  app.log.info(`Providers with a key: ${available.join(', ') || 'none'}`);
  if (chatProvider.name) {
    app.log.info(`Answering with: ${chatProvider.name} (${chatProvider.reason})`);
  } else {
    app.log.warn('No provider key set - retrieval will work, but no answers can be written.');
  }
  if (chatProvider.fellBack && chatProvider.name) {
    app.log.warn(`CHAT_PROVIDER fell back: ${chatProvider.reason}`);
  }
});
