const path = require('path');
const fs = require('fs').promises;
const Fastify = require('fastify');
const cors = require('@fastify/cors');
const { OpenAI } = require('openai');

const app = Fastify({ logger: true });
const DOCS_ROOT = path.resolve(__dirname, '../docs/angular');
const STRUCTURE_FILE = path.join(DOCS_ROOT, 'structure.json');
const EMBEDDINGS_FILE = path.join(DOCS_ROOT, 'embeddings.json');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

let docsStructure = null;
let docsPages = null;
let vectorStore = null;

function normalizeText(value) {
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
          contentText: normalizeText(page.contentText),
          contentHtml: page.contentHtml,
        });
      }
    }
  }

  await walkDir(DOCS_ROOT);
  return docsPages;
}

async function loadVectorStore() {
  if (vectorStore) {
    return vectorStore;
  }

  try {
    const content = await fs.readFile(EMBEDDINGS_FILE, 'utf8');
    vectorStore = JSON.parse(content);
  } catch (error) {
    vectorStore = null;
  }
  return vectorStore;
}

function cosineSimilarity(a, b) {
  const dot = a.reduce((sum, value, index) => sum + value * b[index], 0);
  const magA = Math.sqrt(a.reduce((sum, value) => sum + value * value, 0));
  const magB = Math.sqrt(b.reduce((sum, value) => sum + value * value, 0));
  if (magA === 0 || magB === 0) {
    return 0;
  }
  return dot / (magA * magB);
}

async function embedText(text) {
  if (!openai) {
    throw new Error('OpenAI API key missing. Set OPENAI_API_KEY to use vector search.');
  }

  const response = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text,
  });

  if (!response.data || !Array.isArray(response.data) || !response.data[0]?.embedding) {
    throw new Error('Invalid embedding response from OpenAI.');
  }

  return response.data[0].embedding;
}

async function searchVectors(query, limit = 4) {
  const store = await loadVectorStore();
  if (!store || !store.chunks?.length) {
    return [];
  }

  const queryEmbedding = await embedText(query);
  const scores = store.chunks.map((chunk) => ({
    ...chunk,
    score: cosineSimilarity(queryEmbedding, chunk.embedding),
  }));

  scores.sort((a, b) => b.score - a.score);
  return scores.slice(0, limit);
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
  const normalizedQuery = normalizeText(query);
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

app.get('/api/docs/structure', async () => {
  return await loadDocsStructure();
});

app.post('/api/chat', async (request, reply) => {
  const { question } = request.body || {};
  if (!question || typeof question !== 'string' || !question.trim()) {
    reply.status(400);
    return { error: 'question is required' };
  }

  let results = [];
  let answer = '';
  let mode = 'lexical';

  try {
    const store = await loadVectorStore();
    if (store && openai) {
      mode = 'vector';
      results = await searchVectors(question, 4);
      answer = results.length
        ? `I found ${results.length} relevant Angular docs chunks using vector search. The most relevant chunk comes from "${results[0].title}".`
        : 'I did not find a matching document chunk in the local Angular docs vector store yet.';
    }
  } catch (error) {
    app.log.warn(`Vector search failed: ${error.message}`);
  }

  if (!results.length) {
    mode = 'lexical';
    results = await searchDocs(question, 4);
    answer = results.length
      ? `I found ${results.length} relevant Angular docs pages using lexical search. The most relevant page is "${results[0].title}".`
      : 'I did not find a matching page in the local Angular docs corpus yet.';
  }

  return {
    question,
    mode,
    answer,
    sources: results.map((result) => ({ title: result.title, path: result.path, url: result.url })),
    retrieved: results.map((result) => ({ title: result.title, path: result.path, snippet: result.snippet || result.text || '' })),
  };
});

const PORT = process.env.PORT || 5173;
app.listen({ port: PORT, host: '0.0.0.0' }).then(() => {
  app.log.info(`Backend ready at http://localhost:${PORT}`);
});
