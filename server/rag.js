/*
 * The RAG pipeline, as pure and testable functions.
 *
 * Everything here is deliberately free of Fastify, filesystem and network
 * concerns so it can be unit-tested without a server or an API key. index.js
 * wires these into HTTP routes; build-vector-store.js reuses the same chunking
 * so the text that gets embedded is byte-identical to the text that gets stored.
 *
 * The five RAG stages and where they live:
 *   1. scrape   -> scripts/fetch-angular-docs.js
 *   2. chunk    -> normalizeText + chunkText            (this file)
 *   3. embed    -> server/build-vector-store.js
 *   4. retrieve -> normalizeVector + dotProduct + selectChunks  (this file)
 *   5. generate -> buildPrompt + generateAnswer         (this file)
 */

// ---------------------------------------------------------------------------
// Stage 2: chunking
// ---------------------------------------------------------------------------

/**
 * Collapse runs of spaces/tabs, and runs of 3+ newlines down to one paragraph
 * break. Paragraph breaks MUST survive: chunkText splits on them.
 *
 * The original version used /\s+/ -> ' ', which also ate every newline. Chunking
 * then split on /\n{2,}/, which could never match, so every page became a single
 * chunk of up to 53,547 characters and maxChars was silently ignored.
 */
function normalizeText(value) {
  return (value || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Hard-split a single oversized paragraph into windows of at most maxChars,
 * each overlapping the previous by `overlap` characters.
 *
 * Overlap matters because a fact can straddle a boundary. Without it, "signals
 * are created with" / "the signal() function" become two chunks that each
 * answer nothing.
 */
function splitOversized(text, maxChars, overlap) {
  const pieces = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(start + maxChars, text.length);

    // Prefer breaking on a word boundary, but only if it isn't so early that
    // we'd waste half the window.
    if (end < text.length) {
      const lastSpace = text.slice(start, end).lastIndexOf(' ');
      if (lastSpace > maxChars * 0.5) {
        end = start + lastSpace;
      }
    }

    const piece = text.slice(start, end).trim();
    if (piece) pieces.push(piece);
    if (end >= text.length) break;

    // Step back by `overlap`, but never backwards or in place - otherwise a
    // paragraph with no spaces would loop forever.
    const nextStart = end - overlap;
    start = nextStart > start ? nextStart : end;
  }

  return pieces;
}

/**
 * Split page text into embedding-sized chunks.
 *
 * ~1200 characters is roughly 300 tokens: big enough to hold a complete thought,
 * small enough that a retrieved chunk is mostly signal rather than a whole page.
 */
function chunkText(text, maxChars = 1200, overlap = 150) {
  const clean = normalizeText(text);
  if (!clean) return [];

  const paragraphs = clean
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  // Pre-split anything too large, so the packing loop below only ever deals
  // with pieces that already fit.
  const pieces = [];
  for (const paragraph of paragraphs) {
    if (paragraph.length <= maxChars) {
      pieces.push(paragraph);
    } else {
      pieces.push(...splitOversized(paragraph, maxChars, overlap));
    }
  }

  // Pack neighbouring pieces together so we don't emit a chunk per short line.
  const chunks = [];
  let current = '';
  for (const piece of pieces) {
    if (!current) {
      current = piece;
    } else if (current.length + 2 + piece.length <= maxChars) {
      current = `${current}\n\n${piece}`;
    } else {
      chunks.push(current);
      current = piece;
    }
  }
  if (current) chunks.push(current);

  return chunks.filter(Boolean);
}

// ---------------------------------------------------------------------------
// Stage 4: retrieval
// ---------------------------------------------------------------------------

/** Scale a vector to unit length. Returns zeros for a zero vector. */
function normalizeVector(vector) {
  let sumSquares = 0;
  for (let i = 0; i < vector.length; i += 1) sumSquares += vector[i] * vector[i];

  const magnitude = Math.sqrt(sumSquares);
  const out = new Float32Array(vector.length);
  if (magnitude === 0) return out;

  for (let i = 0; i < vector.length; i += 1) out[i] = vector[i] / magnitude;
  return out;
}

/** Sum of elementwise products. */
function dotProduct(a, b) {
  let total = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) total += a[i] * b[i];
  return total;
}

/**
 * Full cosine similarity, kept for reference and for the test that proves it
 * equals dotProduct once both inputs are normalised. Not used at query time.
 */
function cosineSimilarity(a, b) {
  const magA = Math.sqrt(dotProduct(a, a));
  const magB = Math.sqrt(dotProduct(b, b));
  if (magA === 0 || magB === 0) return 0;
  return dotProduct(a, b) / (magA * magB);
}

/**
 * Rank stored chunks against a query vector and return the best `k`.
 *
 * `store.vectors` is one flat Float32Array holding every chunk's vector back to
 * back, so chunk i occupies [i*dims, (i+1)*dims). One contiguous allocation
 * instead of thousands of little arrays.
 *
 * Both the query and the stored vectors are unit length, so a dot product IS
 * the cosine similarity - see the comment in test/unit/vectors.test.mjs.
 *
 * `floor` is what makes "I don't know" possible. Without it, the top result is
 * simply the least-bad chunk, and an off-topic question still gets four
 * confident-looking citations.
 */
function selectChunks(queryVector, store, { k = 5, floor = 0.25 } = {}) {
  if (!store || !store.chunks || store.chunks.length === 0) return [];

  const dims = store.dimensions;
  const scored = [];

  for (let i = 0; i < store.chunks.length; i += 1) {
    const offset = i * dims;
    let score = 0;
    for (let d = 0; d < dims; d += 1) {
      score += queryVector[d] * store.vectors[offset + d];
    }
    if (score >= floor) {
      scored.push({ ...store.chunks[i], score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

// ---------------------------------------------------------------------------
// Stage 5: generation
// ---------------------------------------------------------------------------

/*
 * Sentinel the model emits when the retrieved passages don't answer the question.
 *
 * An explicit signal beats inferring it. The alternative - "the answer cited
 * nothing, so it must have failed" - is a heuristic that breaks the moment a
 * model answers correctly without citing, and it cannot distinguish "not in
 * these docs" from "answered from general knowledge".
 */
const NO_ANSWER_SENTINEL = 'NO_ANSWER_IN_DOCS';

const SYSTEM_PROMPT = `You are an assistant that answers questions about the Angular web framework.

Rules:
- Answer ONLY using the numbered context passages provided. They are excerpts from the official Angular documentation.
- Cite the passages you used with bracketed numbers, e.g. [1] or [2][3]. Cite only numbers that appear in the context.
- Never invent APIs, options or version numbers.
- Prefer short, concrete explanations. Include a small code example when the context contains one.
- Do not mention "context", "passages" or "documents" in your answer. Just answer the question.
- If the passages do NOT contain the information needed to answer, reply with exactly ${NO_ANSWER_SENTINEL} and nothing else. Do not apologise, explain, or answer from your own knowledge. This applies even when the passages are on a related topic.`;

/** Nothing cleared the similarity floor: there is nothing to show. */
const REFUSAL =
  "I could not find anything about that in the Angular documentation I have indexed. Try rephrasing, or ask about a topic covered by the local docs corpus.";

/** Passages were found, but none of them answer the question. */
const PARTIAL_ANSWER =
  "I could not find an answer to that in the Angular documentation I have indexed. These pages came closest - they may be near what you are looking for:";

/**
 * Assemble the model input from a question plus retrieved chunks.
 *
 * Numbering is 1-based and matches the order of `chunks`, which is what makes
 * the citation check in generateAnswer possible.
 */
function buildPrompt(question, chunks) {
  const context = chunks
    .map((chunk, index) => `[${index + 1}] ${chunk.title} (${chunk.path})\n${chunk.text}`)
    .join('\n\n---\n\n');

  return {
    system: SYSTEM_PROMPT,
    user: `Context passages:\n\n${context}\n\n---\n\nQuestion: ${question}`,
  };
}

/** Every distinct [n] referenced in the answer text. */
function extractCitations(answer) {
  const found = new Set();
  for (const match of answer.matchAll(/\[(\d+)\]/g)) {
    found.add(Number(match[1]));
  }
  return [...found].sort((a, b) => a - b);
}

/**
 * Turn retrieved chunks into a written answer.
 *
 * `llm` is injected rather than imported so tests can pass a fake. It is any
 * object with `complete({ system, user }) -> Promise<string>`.
 *
 * Returns one of three statuses, because "did we find anything" and "does what
 * we found answer the question" are genuinely different outcomes:
 *
 *   'answered' - the passages covered it. Real answer, with citations.
 *   'partial'  - passages cleared the similarity floor but none answer the
 *                question. Say so, and offer them as the closest thing found.
 *   'refused'  - nothing cleared the floor. There is nothing to offer.
 *
 * Why 'partial' has to exist: retrieval cannot detect this case on score alone.
 * "What does CSS stand for?" scores 0.457 against the styling and security
 * pages - higher than several genuine Angular questions - because those pages
 * really are about CSS. Retrieval is behaving correctly; what's missing is a
 * definition of the acronym, which is a fact about the world rather than about
 * Angular. Only the model, looking at the passages, can tell.
 *
 * Two further guards:
 *  - No chunks means the refusal is returned WITHOUT calling the model. Cheaper,
 *    deterministic, and it removes any chance of answering from the model's own
 *    memory rather than from the docs.
 *  - Citations pointing outside the supplied range are stripped. A model citing
 *    [7] when given 4 passages is inventing a source, and an unchecked citation
 *    is worse than none because it looks verified.
 */
async function generateAnswer({ question, chunks, llm }) {
  if (!chunks || chunks.length === 0) {
    return {
      status: 'refused',
      answer: REFUSAL,
      citations: [],
      refused: true,
      llmCalled: false,
    };
  }

  const prompt = buildPrompt(question, chunks);
  const raw = await llm.complete(prompt);
  const text = (raw || '').trim();

  // Empty output is treated as "could not answer" rather than shown as a blank.
  if (!text || text.includes(NO_ANSWER_SENTINEL)) {
    return {
      status: 'partial',
      answer: PARTIAL_ANSWER,
      citations: [],
      refused: false,
      llmCalled: true,
    };
  }

  const cited = extractCitations(text);
  const valid = cited.filter((n) => n >= 1 && n <= chunks.length);
  const invalid = cited.filter((n) => !valid.includes(n));

  // Remove citations that don't correspond to a supplied passage.
  const answer = invalid
    .reduce((acc, n) => acc.replaceAll(`[${n}]`, ''), text)
    .replace(/[ \t]{2,}/g, ' ');

  return {
    status: 'answered',
    answer: answer.trim(),
    citations: valid,
    droppedCitations: invalid,
    refused: false,
    llmCalled: true,
  };
}

/**
 * Adapter turning an OpenAI client into the minimal `llm` shape above. Keeping
 * this separate is what lets the tests avoid the network entirely.
 */
function createOpenAiLlm(client, { model = 'gpt-4o-mini', temperature = 0.2 } = {}) {
  return {
    model,
    async complete({ system, user }) {
      const response = await client.chat.completions.create({
        model,
        temperature,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      });
      this.lastUsage = response.usage;
      return response.choices?.[0]?.message?.content || '';
    },
  };
}

module.exports = {
  normalizeText,
  chunkText,
  splitOversized,
  normalizeVector,
  dotProduct,
  cosineSimilarity,
  selectChunks,
  buildPrompt,
  extractCitations,
  generateAnswer,
  createOpenAiLlm,
  SYSTEM_PROMPT,
  REFUSAL,
  PARTIAL_ANSWER,
  NO_ANSWER_SENTINEL,
};
