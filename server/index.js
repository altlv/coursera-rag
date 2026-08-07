const path = require('path');
const fs = require('fs').promises;
const dotenv = require('dotenv');
const Fastify = require('fastify');
const cors = require('@fastify/cors');
const { OpenAI } = require('openai');
const {
  normalizeVector,
  selectChunksMultiQuery,
  assessConfidence,
  generateAnswer,
  rewriteQuestion,
  HISTORY_EXCHANGES,
  REFUSAL,
} = require('./rag');
const { createLlm, listAvailable, resolveProvider } = require('./llm-providers');
const { createHealthTracker } = require('./provider-health');
const { createQuestionLog } = require('./question-log');

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
/** A genuine question about Angular fits well inside this; longer is a paste or abuse. */
const MAX_QUESTION_CHARS = 2000;
/** History is client-supplied, so it is bounded server-side too. */
const MAX_HISTORY_TURNS = HISTORY_EXCHANGES * 2;
const MAX_HISTORY_TURN_CHARS = 4000;
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

/*
 * What people actually ask.
 *
 * The eval sets are 30 invented questions; real usage is the only way to learn the
 * phrasings that fail. Writes are fire-and-forget and every failure is swallowed -
 * a full disk must never stop the chatbot answering. Disable with QUESTION_LOG=off.
 */
const questionLog = createQuestionLog({ logger: app.log });

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
/**
 * @param {string[]} queries One or more formulations of the same question.
 *
 * When a follow-up was rewritten, BOTH the original and the rewritten form are
 * searched and their rankings fused. Rewriting is a large improvement on some
 * questions and a regression on others - "what about validation?" retrieves
 * /guide/forms/form-validation at rank 1 as typed, and loses it once rewritten -
 * and nothing reliably predicts which will win. Fusing both removes the need to
 * guess, at the cost of one extra embedding call.
 */
async function searchVectors(queries, limit = TOP_K) {
  const store = await loadVectorStore();
  if (!store) return [];

  const list = (Array.isArray(queries) ? queries : [queries]).filter(Boolean);
  const embedded = await Promise.all(
    list.map(async (text, index) => ({
      text,
      vector: await embedQuery(text),
      label: index === 0 ? 'asked' : 'rewritten',
    })),
  );

  const results = selectChunksMultiQuery(embedded, store, {
    k: limit,
    floor: SCORE_FLOOR,
    maxPerPage: MAX_PER_PAGE,
  });

  /*
   * Hand back the vector of the question AS ASKED, so question logging can group
   * semantically-similar questions without a second embedding call. Retrieval has
   * already paid for it.
   */
  results.queryVector = embedded[0]?.vector;
  return results;
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
  const startedAt = Date.now();
  const { question } = request.body || {};
  if (!question || typeof question !== 'string' || !question.trim()) {
    reply.status(400);
    return { error: 'question is required' };
  }

  /*
   * Reject an over-long question rather than embedding it.
   *
   * Only a non-empty string was checked before, so a 50,000-character body went
   * straight into an embedding call and then into the prompt - a cost and context
   * blowout with nothing to stop it. A real question about Angular does not need
   * 2,000 characters, and anything longer is either a paste accident or abuse.
   */
  if (question.length > MAX_QUESTION_CHARS) {
    reply.status(413);
    return {
      error: `Question is too long (${question.length} characters, limit ${MAX_QUESTION_CHARS}). Ask something shorter.`,
    };
  }

  /*
   * ---- Working memory ----------------------------------------------------
   *
   * A follow-up like "what about effects?" carries almost nothing searchable, so
   * it is rewritten into a standalone question BEFORE retrieval.
   *
   * The rewriter is PINNED to one provider, deliberately independent of
   * CHAT_PROVIDER - the same reasoning as embeddings. If it followed the chat
   * provider, retrieval would change with the model, and comparing providers on
   * identical passages would no longer be possible.
   */
  /*
   * History arrives from the client, so it is bounded here rather than trusted.
   * The frontend already sends only the last 3 exchanges, but a request can claim
   * anything - and an unbounded history is the same prompt-blowout risk as an
   * unbounded question, just via a different field.
   */
  const history = (Array.isArray(request.body?.history) ? request.body.history : [])
    .filter((turn) => turn && typeof turn.text === 'string' && (turn.role === 'user' || turn.role === 'assistant'))
    .slice(-MAX_HISTORY_TURNS)
    .map((turn) => ({
      role: turn.role,
      text: turn.text.slice(0, MAX_HISTORY_TURN_CHARS),
      ...(typeof turn.provider === 'string' ? { provider: turn.provider.slice(0, 40) } : {}),
      ...(Array.isArray(turn.paths)
        ? { paths: turn.paths.filter((p) => typeof p === 'string').slice(0, 10) }
        : {}),
    }));
  let searchQuestion = question;
  let rewrite = null;

  if (history.length && chatProvider.name) {
    try {
      const rewriter = createLlm({ provider: process.env.REWRITE_PROVIDER || 'openai' });
      const result = await rewriteQuestion({ question, history, llm: rewriter });
      searchQuestion = result.question;
      if (result.rewritten) {
        rewrite = { original: result.original, rewritten: result.question };
        app.log.info(`Rewrote "${result.original}" -> "${result.question}"`);
      }
    } catch (error) {
      // A failed rewrite must never block an answer: searching the raw question
      // is worse than searching a resolved one, but far better than an error.
      app.log.warn(`Query rewrite failed, using the question as typed: ${error.message}`);
    }
  }

  // ---- Stage 4: retrieve -------------------------------------------------
  let results = [];
  let mode = 'lexical';

  try {
    if (embeddingClient && (await loadVectorStore())) {
      // Both formulations when a rewrite happened; just the one otherwise.
      const formulations =
        searchQuestion === question ? [question] : [question, searchQuestion];
      results = await searchVectors(formulations, TOP_K);
      mode = 'vector';
    }
  } catch (error) {
    app.log.warn(`Vector search failed, falling back to lexical: ${error.message}`);
  }

  if (!results.length && mode !== 'vector') {
    results = await searchDocs(searchQuestion, TOP_K);
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
        // The question AS TYPED, so the answer addresses what was actually asked.
        // Only retrieval uses the rewritten form.
        question,
        // Lexical results carry `snippet`; vector results carry `text`.
        chunks: results.map((r) => ({ ...r, text: r.text || r.snippet || '' })),
        llm,
        history,
        provider: llm.provider,
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

  /*
   * Log the question. NOT awaited: logging must never add latency to an answer,
   * and its failures are already swallowed internally.
   */
  const confidence = assessConfidence({ status, results, citations });

  void questionLog.record({
    question,
    rewritten: rewrite?.rewritten,
    // The query vector already exists from retrieval, so semantic grouping costs
    // nothing extra.
    vector: results.queryVector,
    status,
    confidence: confidence?.level,
    provider: llmInfo?.provider,
    model: llmInfo?.model,
    retrieved: results,
    tokens: usage?.total_tokens,
    ms: Date.now() - startedAt,
  });

  return {
    question,
    /** Set only when the follow-up was rewritten, so the UI can show what was searched. */
    rewrite,
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
    confidence,
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
