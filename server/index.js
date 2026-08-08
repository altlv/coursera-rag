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
  streamAnswer,
  toSources,
  rewriteQuestion,
  HISTORY_EXCHANGES,
  REFUSAL,
} = require('./rag');
const { extractIdentifiers, buildCanonicalSpellings } = require('./answer-checks');
const { createLlm, listAvailable, resolveProvider } = require('./llm-providers');
const { createHealthTracker } = require('./provider-health');
const { createQuestionLog } = require('./question-log');
const { rerank } = require('./rerank');
const { resolveStyle, listStyles, DEFAULT_STYLE } = require('./answer-styles');
const { createRateLimiter } = require('./rate-limit');
const { createSpendLimiter } = require('./spend-limit');
const fsSync = require('fs');

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

/*
 * Two independent controls on cost, because they bound different things.
 *
 * Rate limiting bounds how FAST the balance can be spent. The spend ceiling bounds
 * the TOTAL - twenty questions a minute all day is still a large bill, so a rate
 * limit alone is not a budget.
 *
 * Both default to off-ish values that suit localhost and are meant to be set for
 * anything exposed. RATE_LIMIT_PER_MINUTE=0 disables the limiter; DAILY_SPEND_USD
 * unset or 0 disables the ceiling.
 */
const RATE_LIMIT_PER_MINUTE = Number(process.env.RATE_LIMIT_PER_MINUTE ?? 20);
const RATE_LIMIT_BURST = Number(process.env.RATE_LIMIT_BURST ?? 5);
const DAILY_SPEND_USD = Number(process.env.DAILY_SPEND_USD ?? 0);

const rateLimiter = createRateLimiter({
  enabled: RATE_LIMIT_PER_MINUTE > 0,
  perMinute: RATE_LIMIT_PER_MINUTE,
  burst: RATE_LIMIT_BURST,
});

/*
 * The ledger lives beside the question log, and is gitignored for the same reason.
 * Persisting it matters: without it the ceiling is bypassable by restarting, and a
 * crash loop would reset the budget continuously.
 */
const SPEND_LEDGER = path.resolve(__dirname, '../data/spend.json');

const spendLimiter = createSpendLimiter({
  dailyUsd: DAILY_SPEND_USD,
  load: () => JSON.parse(fsSync.readFileSync(SPEND_LEDGER, 'utf8')),
  save: (state) => {
    fsSync.mkdirSync(path.dirname(SPEND_LEDGER), { recursive: true });
    // Write-then-rename, so a crash mid-write cannot leave a truncated ledger
    // that reads as "nothing spent today".
    const tmp = `${SPEND_LEDGER}.tmp`;
    fsSync.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fsSync.renameSync(tmp, SPEND_LEDGER);
  },
});

let docsStructure = null;
let docsPages = null;
let vectorStore = null;

/*
 * The ungrounded-mention check: implemented, measured, and OFF.
 *
 * The idea was to flag a real Angular API that appears in no supplied passage -
 * evidence the model answered from its own memory rather than the docs. Telling
 * that apart from a variable invented for an example needs some notion of "this
 * name is a real API", and corpus membership was the obvious proxy.
 *
 * Measured over 30 questions it produced 2 findings, BOTH false positives:
 * `mySignal` and `DataService`. Both are example names - and both are in the
 * corpus, because Angular's docs use example names too, so the proxy does not
 * separate what it was supposed to.
 *
 * Distinct-page count was the obvious repair and it does not work either. Real
 * APIs span 2-11 pages (`signal`, `takeUntilDestroyed` and `@HostListener` all
 * sit at 2), while both false positives sit at 3 - above three genuine APIs. The
 * distributions overlap, so no threshold exists. Same shape as the paraphrase
 * threshold in question-log.js, and rejected for the same reason.
 *
 * So it is off, not deleted: the machinery is sound and a corpus that does not
 * riddle its documentation with example names would benefit. Set this to true and
 * run `npm run check-attribution` to see the false positives for yourself.
 *
 * The misattribution check is unaffected and stays on. It is precise by
 * construction - it requires the identifier to be present in some supplied
 * passage - and it found a genuine defect: an *ngIf claim credited to a
 * content-projection passage, none of whose 7 passages mention ngIf.
 */
const UNGROUNDED_CHECK_ENABLED = false;

/** Every code identifier appearing anywhere in the corpus. Cleared with the other caches. */
let corpusIdentifiers = null;

/*
 * normalised name -> the single casing the corpus uses for it, for code-sample
 * validation. Derived rather than curated: the docs already contain the correct
 * spellings, so this needs no maintenance as Angular evolves - unlike the
 * hand-written table in api-pairs.js. Names the corpus spells more than one way
 * are omitted, since neither casing is authoritative.
 */
let canonicalSpellings = null;

function getCanonicalSpellings(store) {
  if (canonicalSpellings) return canonicalSpellings;
  canonicalSpellings = buildCanonicalSpellings(store?.chunks ?? []);
  return canonicalSpellings;
}

function getCorpusIdentifiers(store) {
  if (corpusIdentifiers) return corpusIdentifiers;
  corpusIdentifiers = new Set();
  for (const chunk of store?.chunks ?? []) {
    for (const identifier of extractIdentifiers(chunk.text)) corpusIdentifiers.add(identifier);
  }
  return corpusIdentifiers;
}

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
      corpusIdentifiers = null;
      canonicalSpellings = null;
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

  /*
   * Embedding the query is cheap - roughly 1/1000th of a generation call - but it
   * is not free, and a loop hammering the endpoint pays it every time. Counting it
   * keeps the ledger honest about total spend rather than only the expensive half.
   */
  spendLimiter.record(store?.model || EMBEDDING_MODEL, response.usage);

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
/**
 * A flat, browsable index of everything the assistant can answer from.
 *
 * More useful than a nav tree, because it answers questions the tree cannot:
 * how many passages each page contributes, which pages actually get retrieved,
 * and which have never been retrieved at all. That last group is either genuinely
 * irrelevant content or content that is unreachable - and the second case is a
 * retrieval bug hiding in plain sight.
 */
app.get('/api/docs/list', async () => {
  const [pages, store, retrievals] = await Promise.all([
    loadDocsPages(),
    loadVectorStore(),
    questionLog.pathStats(),
  ]);

  // Passages per page, from the store rather than recomputed.
  const passages = new Map();
  for (const chunk of store?.chunks || []) {
    passages.set(chunk.path, (passages.get(chunk.path) || 0) + 1);
  }

  const structure = await loadDocsStructure();
  const sectionOf = new Map();
  for (const section of structure.children || []) {
    for (const child of section.children || []) sectionOf.set(child.path, section.title);
  }

  const items = [...pages.values()]
    .map((page) => ({
      title: page.title,
      path: page.path,
      url: page.url,
      section: sectionOf.get(page.path) || 'Other',
      passages: passages.get(page.path) || 0,
      /** Times this page has appeared in a retrieval. Absent when logging is off. */
      retrievals: retrievals.get(page.path) || 0,
      chars: page.contentText.length,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));

  return {
    pageCount: items.length,
    passageCount: store?.chunks.length || 0,
    /** Null when nothing has been logged, so the UI can hide usage columns. */
    totalRetrievals: [...retrievals.values()].reduce((sum, n) => sum + n, 0) || null,
    model: store?.model || null,
    items,
  };
});

/**
 * Rate an answer.
 *
 * Question logs say what was asked, not whether the answer was good. This is the
 * half that turns a bad answer into a candidate regression test - and a thumbs-down
 * on a question asked repeatedly is the strongest signal available about what to
 * fix next.
 */
app.post('/api/feedback', async (request, reply) => {
  const { questionId, question, rating, note } = request.body || {};

  if (!['up', 'down'].includes(rating)) {
    reply.status(400);
    return { error: "rating must be 'up' or 'down'" };
  }
  if (!questionId && !question) {
    reply.status(400);
    return { error: 'questionId or question is required' };
  }

  await questionLog.rate({ questionId, question, rating, note });
  return { ok: true };
});

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
    /*
     * Reported so the ceiling is observable BEFORE it fires. A budget you only
     * learn about by hitting it is a worse experience than no budget at all - and
     * an estimate nobody can see is an estimate nobody can sanity-check against
     * their provider's actual invoice.
     */
    budget: (() => {
      const state = spendLimiter.check();
      return {
        enabled: state.enabled,
        limitUsd: state.limitUsd,
        spentUsd: Number(state.spentUsd.toFixed(4)),
        remainingUsd: state.enabled ? Number(state.remainingUsd.toFixed(4)) : null,
        inputTokens: state.inputTokens,
        outputTokens: state.outputTokens,
        day: state.day,
        /** Prices drift and vary per provider; the token counts are the exact part. */
        note: 'Cost is estimated from a static price table. Token counts are exact.',
      };
    })(),
    /*
     * Offered to the UI so the style can be switched without a restart. Purely
     * presentational: no style changes what the assistant is allowed to claim.
     */
    styles: { available: listStyles(), active: ANSWER_STYLE },
    rateLimit: {
      enabled: RATE_LIMIT_PER_MINUTE > 0,
      perMinute: RATE_LIMIT_PER_MINUTE,
      burst: RATE_LIMIT_BURST,
    },
  };
});

/**
 * Guards and input validation, shared by /api/chat and /api/chat/stream.
 *
 * Extracted rather than duplicated because these are the CO ST controls. Two
 * copies would drift, and the way they drift is that one endpoint quietly stops
 * enforcing a limit - which is exactly the failure a spend ceiling exists to
 * prevent.
 *
 * Returns `{ error: { status, body } }` for a rejection, or the validated inputs.
 * The status and body are returned rather than written, because the two endpoints
 * report failure differently: one as JSON, one as an SSE event.
 */
function guardChatRequest(request) {
  const limit = rateLimiter.check(request.ip);
  if (!limit.allowed) {
    return {
      error: {
        status: 429,
        retryAfterSeconds: Math.ceil(limit.retryAfterMs / 1000),
        body: {
          error: 'Too many questions in a short time. Wait a moment and try again.',
          /*
           * Distinct from the provider's own 'rate-limit'. That one is worth
           * suggesting a different provider for; this one is our limit, so
           * switching would not help and saying so would be misleading advice.
           */
          errorKind: 'too-many-requests',
          retryAfterMs: limit.retryAfterMs,
        },
      },
    };
  }

  const budget = spendLimiter.check();
  if (!budget.allowed) {
    /*
     * Two decimals for a normal limit, more for a sub-cent one - otherwise a
     * limit of $0.0001 reads as "the limit of $0.00 has been reached", which
     * looks like a bug rather than a setting.
     */
    const money = (n) => (n >= 0.01 ? n.toFixed(2) : n.toPrecision(2));
    return {
      error: {
        // 402, not 429: this is not "slow down", it is "the budget for today is
        // gone". The client should not retry, and the code says so.
        status: 402,
        body: {
          error:
            `The daily spend limit of $${money(budget.limitUsd)} has been reached ` +
            `(estimated $${money(budget.spentUsd)} used). It resets at midnight UTC.`,
          errorKind: 'spend-limit',
          permanent: true,
          spentUsd: Number(budget.spentUsd.toFixed(4)),
          limitUsd: budget.limitUsd,
        },
      },
    };
  }

  const { question } = request.body || {};
  if (!question || typeof question !== 'string' || !question.trim()) {
    return { error: { status: 400, body: { error: 'question is required' } } };
  }

  /*
   * Reject an over-long question rather than embedding it. Only a non-empty
   * string was checked once, so a 50,000-character body went straight into an
   * embedding call and then the prompt - a cost and context blowout with nothing
   * to stop it.
   */
  if (question.length > MAX_QUESTION_CHARS) {
    return {
      error: {
        status: 413,
        body: {
          error: `Question is too long (${question.length} characters, limit ${MAX_QUESTION_CHARS}). Ask something shorter.`,
        },
      },
    };
  }

  return { question };
}

/**
 * History arrives from the client, so it is bounded here rather than trusted.
 * The frontend sends only the last 3 exchanges, but a request can claim anything -
 * an unbounded history is the same prompt-blowout risk as an unbounded question,
 * reached through a different field.
 */
function boundHistory(body) {
  return (Array.isArray(body?.history) ? body.history : [])
    .filter(
      (turn) =>
        turn && typeof turn.text === 'string' && (turn.role === 'user' || turn.role === 'assistant'),
    )
    .slice(-MAX_HISTORY_TURNS)
    .map((turn) => ({
      role: turn.role,
      text: turn.text.slice(0, MAX_HISTORY_TURN_CHARS),
      ...(typeof turn.provider === 'string' ? { provider: turn.provider.slice(0, 40) } : {}),
      ...(Array.isArray(turn.paths)
        ? { paths: turn.paths.filter((p) => typeof p === 'string').slice(0, 10) }
        : {}),
    }));
}

/*
 * Reranking.
 *
 * Measured on the held-out set before being switched on, and again over three runs
 * to be sure it was not one lucky ordering:
 *
 *   hit@1  73% -> 87%     hit@3  93% -> 100%     MRR  0.822 -> 0.922
 *
 * The ceiling was measured first, free and offline: the correct page is in the top
 * 10 for EVERY held-out question but first for only 73% of them, so the whole loss
 * was ordering - exactly what a reranker fixes. That same measurement set the
 * candidate count at 10 rather than the conventional 30-50, which on this corpus
 * adds no recall and pushes the correct page's mean rank from 1.9 to 2.7.
 *
 * PINNED to one provider, deliberately, for the same reason as embeddings and the
 * query rewriter: this changes RETRIEVAL. If it followed CHAT_PROVIDER, the
 * passages would change with the model and comparing providers on identical
 * evidence would stop meaning anything.
 *
 * RERANK=off disables it. The cost is one extra model call per question - about
 * $0.0002, and a delay before the first token of a streamed answer.
 */
/*
 * How answers are WRITTEN. Presentation only - the grounding rules are identical
 * across every style and a test enforces that, because a friendlier prompt that
 * quietly paraphrases further from its sources produces answers that feel better
 * and are less true.
 */
const ANSWER_STYLE = resolveStyle(process.env.ANSWER_STYLE ?? DEFAULT_STYLE);

const RERANK_ENABLED = process.env.RERANK !== 'off';
const RERANK_CANDIDATES = Number(process.env.RERANK_CANDIDATES ?? 10);

/** Rewrite a follow-up into a standalone question, and retrieve for it. */
async function retrieveFor(question, history) {
  let searchQuestion = question;
  let rewrite = null;

  if (history.length && chatProvider.name) {
    try {
      const rewriter = createLlm({ provider: process.env.REWRITE_PROVIDER || 'openai' });
      const result = await rewriteQuestion({ question, history, llm: rewriter });
      spendLimiter.record(rewriter.model, rewriter.lastUsage);
      searchQuestion = result.question;
      if (result.rewritten) {
        rewrite = { original: result.original, rewritten: result.question };
        app.log.info(`Rewrote "${result.original}" -> "${result.question}"`);
      }
    } catch (error) {
      app.log.warn(`Query rewrite failed, using the question as typed: ${error.message}`);
    }
  }

  let results = [];
  let mode = 'lexical';
  /*
   * Retrieve wider when reranking, so a passage the bi-encoder ranked 7th can
   * still reach the prompt. Trimming to TOP_K before reranking would make the
   * whole exercise a no-op.
   */
  const wanted = RERANK_ENABLED && chatProvider.name ? RERANK_CANDIDATES : TOP_K;

  try {
    if (embeddingClient && (await loadVectorStore())) {
      const formulations = searchQuestion === question ? [question] : [question, searchQuestion];
      results = await searchVectors(formulations, wanted);
      mode = 'vector';
    }
  } catch (error) {
    app.log.warn(`Vector search failed, falling back to lexical: ${error.message}`);
  }
  if (!results.length && mode !== 'vector') {
    results = await searchDocs(searchQuestion, wanted);
    mode = 'lexical';
  }

  let reranked = false;
  if (RERANK_ENABLED && chatProvider.name && results.length > 1) {
    try {
      const reranker = createLlm({ provider: process.env.RERANK_PROVIDER || 'openai' });
      const ordered = await rerank({
        // The SEARCH question, not the one as typed: for a follow-up, the
        // standalone form is what the passages should be judged against.
        question: searchQuestion,
        candidates: results,
        llm: reranker,
        topK: TOP_K,
      });
      spendLimiter.record(reranker.model, reranker.lastUsage);
      reranked = true;
      // queryVector rides on the array for the question log, so it is carried over.
      ordered.queryVector = results.queryVector;
      results = ordered;
    } catch (error) {
      /*
       * A reranker outage must never cost an answer. Falling through leaves the
       * retrieval ordering, which is what the system did before reranking existed.
       */
      app.log.warn(`Rerank failed, using retrieval order: ${error.message}`);
      results = results.slice(0, TOP_K);
    }
  } else if (results.length > TOP_K) {
    results = results.slice(0, TOP_K);
  }

  return { results, mode, rewrite, searchQuestion, reranked };
}

app.post('/api/chat', async (request, reply) => {
  const startedAt = Date.now();

  /*
   * Both cost controls are enforced HERE, before embedding, retrieval or
   * generation. Checking after the fact means the request that breached the
   * ceiling has already been paid for.
   */
  const guarded = guardChatRequest(request);
  if (guarded.error) {
    reply.status(guarded.error.status);
    if (guarded.error.retryAfterSeconds) {
      reply.header('Retry-After', guarded.error.retryAfterSeconds);
    }
    return guarded.error.body;
  }
  const { question } = guarded;

  /*
   * ---- Working memory and retrieval --------------------------------------
   *
   * A follow-up like "what about effects?" carries almost nothing searchable, so
   * it is rewritten into a standalone question BEFORE retrieval. The rewriter is
   * PINNED to one provider, independent of CHAT_PROVIDER - the same reasoning as
   * embeddings. If it followed the chat provider, retrieval would change with the
   * model and comparing providers on identical passages would be meaningless.
   */
  const history = boundHistory(request.body);
  const { results, mode, rewrite } = await retrieveFor(question, history);

  // ---- Stage 5: generate -------------------------------------------------
  // Without any provider key we cannot write an answer, so say so plainly rather
  // than pretending. Retrieval results are still returned so the UI stays useful.
  let answer;
  let citations = [];
  let usage;
  let status;
  let attribution = null;
  let codeSamples = null;
  let llmInfo = null;

  // A per-request override, so providers can be compared without a restart:
  //   curl ... -d '{"question":"...","provider":"gemini"}'
  const requestedProvider = typeof request.body?.provider === 'string' ? request.body.provider : undefined;
  /*
   * Per-request style override, resolved through the same allowlist as the env
   * setting - so an unknown value falls back rather than reaching the prompt.
   */
  const style = resolveStyle(
    typeof request.body?.style === 'string' ? request.body.style : ANSWER_STYLE,
  );

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
        style,
        knownIdentifiers:
          UNGROUNDED_CHECK_ENABLED && vectorStore ? getCorpusIdentifiers(vectorStore) : null,
        canonicalSpellings: vectorStore ? getCanonicalSpellings(vectorStore) : null,
      });
      status = generated.status;
      answer = generated.answer;
      citations = generated.citations;
      attribution = generated.attribution ?? null;
      usage = llm.lastUsage;
      /*
       * Record what was actually spent, from the provider's own token counts.
       * Recorded on the way out rather than estimated on the way in, so the ledger
       * reflects reality including retries.
       */
      spendLimiter.record(llm.model, usage);
      health.markOk(llm.provider);

      if (generated.droppedCitations?.length) {
        app.log.warn(`Dropped hallucinated citations: ${generated.droppedCitations.join(', ')}`);
      }

      /*
       * Logged rather than silently folded into confidence, because these are the
       * cases worth reading later: a misattribution names both the passage the
       * model credited and the one that actually contains the API.
       */
      for (const claim of attribution?.misattributed ?? []) {
        app.log.warn(
          `Misattributed citation: "${claim.identifier}" credited to [${claim.cited.join('][')}] but present in [${claim.actual.join('][')}]`,
        );
      }
      for (const claim of attribution?.unsupported ?? []) {
        app.log.warn(`Ungrounded API mention: "${claim.identifier}" is in no supplied passage`);
      }

      codeSamples = generated.codeSamples ?? null;
      for (const issue of codeSamples?.casing ?? []) {
        app.log.warn(`Miscased API in a code sample: "${issue.found}" should be "${issue.expected}"`);
      }
      for (const issue of codeSamples?.mixedApi ?? []) {
        app.log.warn(
          `Code sample mixes ${issue.old} with its replacement ${issue.replacement} in one snippet`,
        );
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
  const sources = status === 'refused' ? [] : toSources(results);

  /*
   * Log the question. NOT awaited: logging must never add latency to an answer,
   * and its failures are already swallowed internally.
   */
  const confidence = assessConfidence({ status, results, citations, attribution, codeSamples });

  /*
   * Awaited only to obtain the event id, so the client can attach a rating to this
   * specific answer. Logging still swallows its own failures, so a slow or broken
   * log degrades to "no id" rather than a failed request.
   */
  const questionId = await questionLog.record({
    question,
    rewritten: rewrite?.rewritten,
    // The query vector already exists from retrieval, so semantic grouping costs
    // nothing extra.
    vector: results.queryVector,
    status,
    confidence: confidence?.level,
    /*
     * Counts only, not the offending sentences: the log deliberately stores
     * metadata rather than answer text, and a sentence is answer text.
     */
    misattributed: attribution?.misattributed?.length || undefined,
    ungrounded: attribution?.unsupported?.length || undefined,
    codeIssues:
      (codeSamples?.casing?.length ?? 0) + (codeSamples?.mixedApi?.length ?? 0) || undefined,
    provider: llmInfo?.provider,
    model: llmInfo?.model,
    retrieved: results,
    tokens: usage?.total_tokens,
    ms: Date.now() - startedAt,
  });

  return {
    question,
    /** Identifies this answer, so a rating can be attached to it. */
    questionId,
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
    /*
     * Reported rather than acted on. The answer text is never rewritten to "fix" a
     * citation: the check is a heuristic, and silently moving a citation to the
     * passage that happens to contain the word would manufacture the appearance of
     * grounding rather than verify it.
     */
    attribution,
    /*
     * Reported, never corrected. Rewriting '@component' to '@Component' would hide
     * that the model produced code it could not be trusted to get right.
     */
    codeSamples,
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

/**
 * The same answer, streamed.
 *
 * Server-Sent Events rather than a WebSocket: the traffic is one-directional and
 * short-lived, SSE is plain HTTP so the dev proxy needs no special handling, and
 * the browser reconnect logic that makes EventSource awkward is avoided by using
 * fetch with a ReadableStream on the client.
 *
 * Every event is one JSON object on a `data:` line:
 *
 *   {"type":"delta","text":"..."}     zero or more, as the model writes
 *   {"type":"final", ...}             exactly one, with the VALIDATED answer
 *   {"type":"error","message":"..."}  instead of final, if generation failed
 *
 * The client must replace what it has displayed with `final.answer`, because the
 * deltas are unvalidated - see streamAnswer in rag.js for why that matters and
 * what it costs.
 */
app.post('/api/chat/stream', async (request, reply) => {
  const startedAt = Date.now();

  // Identical guards to /api/chat, from the same function - see guardChatRequest
  // for why these are shared rather than copied.
  const guarded = guardChatRequest(request);
  if (guarded.error) {
    reply.status(guarded.error.status);
    if (guarded.error.retryAfterSeconds) {
      reply.header('Retry-After', guarded.error.retryAfterSeconds);
    }
    return guarded.error.body;
  }
  const { question } = guarded;

  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    // Nginx and similar buffer by default, which would defeat the entire point.
    'X-Accel-Buffering': 'no',
  });

  const send = (event) => reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);

  const history = boundHistory(request.body);
  const { results, mode, rewrite } = await retrieveFor(question, history);

  const sources = toSources(results);

  if (!chatProvider.name) {
    send({
      type: 'final',
      status: results.length ? 'partial' : 'refused',
      answer: results.length
        ? 'No model provider key is set, so I can only list the documentation pages that look relevant.'
        : REFUSAL,
      citations: [],
      sources: results.length ? sources : [],
    });
    reply.raw.end();
    return reply;
  }

  const requestedProvider =
    typeof request.body?.provider === 'string' ? request.body.provider : undefined;
  const style = resolveStyle(
    typeof request.body?.style === 'string' ? request.body.style : ANSWER_STYLE,
  );
  const llm = createLlm({ provider: requestedProvider });

  // Sent up front so the UI can label the bubble before any text arrives.
  send({ type: 'start', provider: llm.provider, providerLabel: llm.providerLabel, model: llm.model, mode, rewrite });

  let final = null;
  try {
    for await (const event of streamAnswer({
      question,
      chunks: results.map((r) => ({ ...r, text: r.text || r.snippet || '' })),
      llm,
      history,
      provider: llm.provider,
      style,
      knownIdentifiers:
        UNGROUNDED_CHECK_ENABLED && vectorStore ? getCorpusIdentifiers(vectorStore) : null,
      canonicalSpellings: vectorStore ? getCanonicalSpellings(vectorStore) : null,
    })) {
      if (event.type === 'final') final = event;
      send(event);
      if (event.type === 'error') health.markFailed(llm.provider, new Error(event.message));
    }
  } catch (error) {
    const classified = health.markFailed(llm.provider, error);
    send({ type: 'error', message: `${llm.providerLabel} could not answer: ${classified.hint}` });
    reply.raw.end();
    return reply;
  }

  if (final) {
    spendLimiter.record(llm.model, llm.lastUsage);
    health.markOk(llm.provider);

    const confidence = assessConfidence({
      status: final.status,
      results,
      citations: final.citations ?? [],
      attribution: final.attribution ?? null,
      codeSamples: final.codeSamples ?? null,
    });

    /*
     * Sent as its own event AFTER final, rather than folded into it. The answer
     * text is what the user is waiting for; confidence, sources and the retrieval
     * trace are supporting detail, and holding the answer back until the log has
     * been written would give away the latency streaming just bought.
     */
    const questionId = await questionLog.record({
      question,
      rewritten: rewrite?.rewritten,
      vector: results.queryVector,
      status: final.status,
      confidence: confidence?.level,
      misattributed: final.attribution?.misattributed?.length || undefined,
      ungrounded: final.attribution?.unsupported?.length || undefined,
      provider: llm.provider,
      model: llm.model,
      retrieved: results,
      tokens: llm.lastUsage?.total_tokens,
      ms: Date.now() - startedAt,
      streamed: true,
    });

    send({
      type: 'meta',
      questionId,
      confidence,
      sources: final.status === 'refused' ? [] : sources,
      usage: llm.lastUsage,
      retrieved: results.map((result) => ({
        title: result.title,
        path: result.path,
        score: result.score,
        ranks: result.ranks,
        snippet: (result.snippet || result.text || '').slice(0, 400),
      })),
    });
  }

  reply.raw.end();
  return reply;
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
