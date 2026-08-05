const dotenv = require('dotenv');
const fs = require('fs').promises;
const path = require('path');
const { OpenAI } = require('openai');

dotenv.config();

const DOCS_ROOT = path.resolve(__dirname, '../docs/angular');
const EMBEDDINGS_FILE = path.join(DOCS_ROOT, 'embeddings.json');
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY environment variable.');
  process.exit(1);
}

const client = new OpenAI({ apiKey: OPENAI_API_KEY });

function normalizeText(value) {
  return (value || '').replace(/\s+/g, ' ').trim();
}

function chunkText(text, maxChars = 800, overlap = 100) {
  const clean = normalizeText(text);
  const paragraphs = clean.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];

  let current = '';
  for (const paragraph of paragraphs) {
    if (!current) {
      current = paragraph;
      continue;
    }

    if (current.length + 1 + paragraph.length <= maxChars) {
      current = `${current} ${paragraph}`;
      continue;
    }

    chunks.push(current);
    current = paragraph;

    while (current.length > maxChars) {
      const slice = current.slice(0, maxChars);
      const lastSpace = slice.lastIndexOf(' ');
      const chunk = current.slice(0, lastSpace > 0 ? lastSpace : maxChars).trim();
      chunks.push(chunk);
      current = current.slice(chunk.length - overlap).trim();
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks.filter(Boolean);
}

async function loadDocsPages() {
  const pages = [];

  async function walkDir(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walkDir(fullPath);
      } else if (entry.isFile() && entry.name === 'index.json') {
        const pageContent = await fs.readFile(fullPath, 'utf8');
        pages.push(JSON.parse(pageContent));
      }
    }
  }

  await walkDir(DOCS_ROOT);
  return pages;
}

async function buildEmbeddings() {
  const pages = await loadDocsPages();
  const chunks = [];

  for (const page of pages) {
    const text = normalizeText(page.contentText || page.contentHtml || '');
    if (!text) {
      continue;
    }

    const pageChunks = chunkText(text, 800, 100);
    for (let index = 0; index < pageChunks.length; index += 1) {
      chunks.push({
        id: `${page.path}#${index + 1}`,
        title: page.title,
        path: page.path,
        url: page.url,
        text: pageChunks[index],
      });
    }
  }

  if (!chunks.length) {
    throw new Error('No chunks were created from the downloaded documentation.');
  }

  console.log(`Building embeddings for ${chunks.length} chunks...`);

  const inputs = chunks.map((chunk) => chunk.text);
  const batchSize = 10;
  const vectorChunks = [];

  for (let start = 0; start < inputs.length; start += batchSize) {
      const batch = inputs.slice(start, start + batchSize).map((s) => {
        // Safety: truncate any input that is unexpectedly large to avoid API token limits.
        const MAX_INPUT_CHARS = 6000; // conservative char-based cap
        if (s.length > MAX_INPUT_CHARS) {
          return s.slice(0, MAX_INPUT_CHARS);
        }
        return s;
      });

      // Use smaller batches to reduce chance of hitting request limits
      const response = await client.embeddings.create({
        model: 'text-embedding-3-small',
        input: batch,
      });

    if (!response.data || !Array.isArray(response.data)) {
      throw new Error('OpenAI returned an invalid embeddings response.');
    }

    for (let i = 0; i < response.data.length; i += 1) {
      vectorChunks.push({
        ...chunks[start + i],
        embedding: response.data[i].embedding,
      });
    }
  }

  const store = {
    createdAt: new Date().toISOString(),
    model: 'text-embedding-3-small',
    chunkCount: vectorChunks.length,
    chunks: vectorChunks,
  };

  await fs.writeFile(EMBEDDINGS_FILE, JSON.stringify(store, null, 2), 'utf8');
  console.log(`Saved embeddings to ${EMBEDDINGS_FILE}`);
}

buildEmbeddings().catch((error) => {
  console.error(error);
  process.exit(1);
});
