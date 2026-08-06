const path = require('path');
const fs = require('fs').promises;
const dotenv = require('dotenv');
const Fastify = require('fastify');
const cors = require('@fastify/cors');
const { OpenAI } = require('openai');
const {
  normalizeText,
  normalizeVector,
  selectChunks,
  generateAnswer,
  createOpenAiLlm,
  REFUSAL,
} = require('./rag');

dotenv.config();

// Retrieval tuning. Change these and re-run `npm run test:retrieval` to see the
// effect on hit@3 / MRR rather than guessing.
const TOP_K = 5;
const SCORE_FLOOR = 0.25;
const CHAT_MODEL = 'gpt-4o-mini';
const EMBEDDING_MODEL = 'text-embedding-3-small';

const app = Fastify({ logger: true });
const DOCS_ROOT = path.resolve(__dirname, '../docs/angular');
const STRUCTURE_FILE = path.join(DOCS_ROOT, 'structure.json');
const EMBEDDINGS_FILE = path.join(DOCS_ROOT, 'embeddings.json');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

let docsStructure = null;
let docsPages = null;
let vectorStore = null;

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
  if (!docsStructure) {
    const content = await fs.readFile(STRUCTURE_FILE, 'utf8');
    docsStructure = JSON.parse(content);
  }
  return docsStructure;
}

async function loadDocsPages() {
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
async function loadVectorStore() {
  if (vectorStore !== null) {
    return vectorStore;
  }

  try {
    const raw = JSON.parse(await fs.readFile(EMBEDDINGS_FILE, 'utf8'));
    const sourceChunks = raw.chunks || [];
    if (sourceChunks.length === 0) {
      vectorStore = undefined;
      return vectorStore;
    }

    const dimensions = sourceChunks[0].embedding.length;
    const vectors = new Float32Array(sourceChunks.length * dimensions);
    const chunks = [];

    for (let i = 0; i < sourceChunks.length; i += 1) {
      const chunk = sourceChunks[i];
      vectors.set(normalizeVector(chunk.embedding), i * dimensions);
      chunks.push({
        id: chunk.id,
        title: chunk.title,
        path: chunk.path,
        url: chunk.url,
        text: chunk.text,
      });
    }

    vectorStore = { model: raw.model, dimensions, chunks, vectors };
    app.log.info(`Vector store loaded: ${chunks.length} chunks x ${dimensions} dims`);
  } catch (error) {
    app.log.warn(`No usable vector store (${error.message}); lexical search only.`);
    vectorStore = undefined;
  }

  return vectorStore;
}

/** Embed a search query and unit-normalise it, ready for a dot product. */
async function embedQuery(text) {
  if (!openai) {
    throw new Error('OpenAI API key missing. Set OPENAI_API_KEY to use vector search.');
  }

  const response = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text,
  });

  const embedding = response.data?.[0]?.embedding;
  if (!embedding) {
    throw new Error('Invalid embedding response from OpenAI.');
  }

  return normalizeVector(embedding);
}

async function searchVectors(query, limit = TOP_K) {
  const store = await loadVectorStore();
  if (!store) return [];

  const queryVector = await embedQuery(query);
  return selectChunks(queryVector, store, { k: limit, floor: SCORE_FLOOR });
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
    if (openai && (await loadVectorStore())) {
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
  // Without a key we cannot write an answer, so be explicit rather than
  // pretending. Retrieval results are still returned so the UI stays useful.
  let answer;
  let citations = [];
  let usage;

  if (!openai) {
    answer =
      results.length > 0
        ? 'OPENAI_API_KEY is not set, so I can only list the documentation pages that look relevant - I cannot write an answer yet. Set the key in .env and restart the backend.'
        : REFUSAL;
  } else {
    const llm = createOpenAiLlm(openai, { model: CHAT_MODEL });
    try {
      const generated = await generateAnswer({
        question,
        // Lexical results carry `snippet`; vector results carry `text`.
        chunks: results.map((r) => ({ ...r, text: r.text || r.snippet || '' })),
        llm,
      });
      answer = generated.answer;
      citations = generated.citations;
      usage = llm.lastUsage;

      if (generated.droppedCitations?.length) {
        app.log.warn(`Dropped hallucinated citations: ${generated.droppedCitations.join(', ')}`);
      }
    } catch (error) {
      app.log.error(`Generation failed: ${error.message}`);
      reply.status(502);
      return { error: `Could not generate an answer: ${error.message}` };
    }
  }

  return {
    question,
    mode,
    model: openai ? CHAT_MODEL : null,
    answer,
    citations,
    usage,
    sources: results.map((result) => ({
      title: result.title,
      path: result.path,
      url: `/docs?path=${encodeURIComponent(result.path)}`,
      originalUrl: result.url,
    })),
    retrieved: results.map((result) => ({
      title: result.title,
      path: result.path,
      score: result.score,
      snippet: (result.snippet || result.text || '').slice(0, 400),
    })),
  };
});

// 3000, not 5173: 5173 is Vite's default dev-server port and reads as a
// frontend port in an Angular repo. Keep in sync with proxy.conf.json.
const PORT = process.env.PORT || 3000;
app.listen({ port: PORT, host: '0.0.0.0' }).then(() => {
  app.log.info(`Backend ready at http://localhost:${PORT}`);
});
