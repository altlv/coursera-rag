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
function selectChunks(queryVector, store, { k = 5, floor = 0.25, maxPerPage = 2 } = {}) {
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
  return capPerPage(scored, k, maxPerPage);
}

/**
 * Take the best `k`, allowing at most `maxPerPage` chunks from any one page.
 *
 * Without this the top-k collapses onto whichever page happens to match well.
 * Measured: "What does CSS stand for?" filled 2 of its 5 slots with duplicates -
 * /best-practices/security twice and /guide/components/styling twice - so 40% of
 * the context window went to material the model had already seen.
 *
 * Adjacent chunks from the same page also overlap by design (150 characters), so
 * consecutive ones are partly the same text. Spending slots on near-duplicates
 * costs breadth exactly when the question needs it.
 */
function capPerPage(sortedChunks, k, maxPerPage) {
  if (!maxPerPage || maxPerPage < 1) return sortedChunks.slice(0, k);

  const perPage = new Map();
  const picked = [];
  const overflow = [];

  for (const chunk of sortedChunks) {
    const used = perPage.get(chunk.path) || 0;
    if (used < maxPerPage) {
      perPage.set(chunk.path, used + 1);
      picked.push(chunk);
      if (picked.length === k) return picked;
    } else {
      overflow.push(chunk);
    }
  }

  // Not enough distinct pages to fill k: rather than return fewer results than
  // asked for, top up with the best of what the cap held back.
  for (const chunk of overflow) {
    if (picked.length === k) break;
    picked.push(chunk);
  }

  return picked;
}

// ---------------------------------------------------------------------------
// Stage 4b: hybrid retrieval
// ---------------------------------------------------------------------------

/** Words too common to carry signal in a docs corpus. */
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'do', 'does',
  'for', 'from', 'how', 'i', 'in', 'is', 'it', 'of', 'on', 'or', 'that', 'the',
  'to', 'use', 'using', 'what', 'when', 'where', 'which', 'why', 'with', 'you',
  'your', 'my', 'me', 'we', 'this', 'these', 'those', 'there', 'they',
]);

function tokenize(text) {
  return (text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

/**
 * Rank chunks by keyword overlap, BM25-style.
 *
 * Why this exists alongside vector search: embeddings match on meaning but can
 * miss exact terminology. Measured case - "how do I pass data into a component?"
 * ranked /guide/components/inputs only 5th, because the question says "pass
 * data" while the page says "input". Keyword scoring catches the literal term
 * that the embedding glossed over.
 *
 * IDF weighting means a rare word like "interceptor" counts for far more than a
 * common one like "component", and length normalisation stops long chunks from
 * winning on sheer word count.
 */
function rankLexical(query, chunks, { k1 = 1.2, b = 0.75 } = {}) {
  const queryTokens = [...new Set(tokenize(query))];
  if (queryTokens.length === 0 || chunks.length === 0) return [];

  const docTokens = chunks.map((chunk) => tokenize(`${chunk.title} ${chunk.text}`));
  const avgLength = docTokens.reduce((sum, t) => sum + t.length, 0) / docTokens.length;

  // Document frequency per query token.
  const df = new Map();
  for (const token of queryTokens) {
    df.set(token, docTokens.reduce((count, tokens) => count + (tokens.includes(token) ? 1 : 0), 0));
  }

  const scored = [];
  for (let i = 0; i < chunks.length; i += 1) {
    const tokens = docTokens[i];
    if (tokens.length === 0) continue;

    const counts = new Map();
    for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1);

    let score = 0;
    for (const token of queryTokens) {
      const tf = counts.get(token) || 0;
      if (tf === 0) continue;

      const n = df.get(token) || 0;
      const idf = Math.log(1 + (chunks.length - n + 0.5) / (n + 0.5));
      score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (tokens.length / avgLength))));
    }

    if (score > 0) scored.push({ index: i, score });
  }

  scored.sort((a, b2) => b2.score - a.score);
  return scored;
}

/**
 * Reciprocal Rank Fusion: combine several rankings using position, not score.
 *
 *   fused(d) = sum over rankings of 1 / (rrfK + rank(d))
 *
 * Positions are the point. Cosine similarity lands around 0.25-0.65 while BM25
 * is unbounded and corpus-dependent, so the two scores cannot be added or
 * averaged in any principled way - one would silently dominate. Ranks are
 * directly comparable, which is why RRF is the standard choice here.
 *
 * rrfK = 60 is the conventional value. It flattens the curve so a document
 * ranked 1st by one method and 10th by the other still beats one ranked 5th by
 * both, rewarding agreement across methods over a single strong opinion.
 */
function fuseRankings(rankings, { rrfK = 60 } = {}) {
  const fused = new Map();

  for (const ranking of rankings) {
    ranking.forEach((entry, position) => {
      const current = fused.get(entry.index) || { index: entry.index, score: 0, ranks: {} };
      current.score += 1 / (rrfK + position + 1);
      current.ranks[ranking.label || 'unnamed'] = position + 1;
      fused.set(entry.index, current);
    });
  }

  return [...fused.values()].sort((a, b) => b.score - a.score);
}

/**
 * Retrieve using vector similarity AND keyword matching, fused by rank.
 *
 * Keyword scoring is applied ONLY to chunks that already cleared the vector
 * floor, which makes this a reranker rather than a recall expander. That is a
 * deliberate trade:
 *
 *   - It preserves the free-refusal guarantee. If nothing is semantically close,
 *     nothing is returned, and the server never calls the model. Letting keyword
 *     matches in from below the floor would mean "Got milk?" could drag in a
 *     chunk containing the word "milk" and turn a free refusal into a partial
 *     answer.
 *
 *   - It is enough for the problem actually measured. /guide/components/inputs
 *     scored 0.505, comfortably above the floor - it was simply ranked 5th. That
 *     is a RANKING failure, not a recall failure, and reranking fixes it.
 *
 * The cost of the trade: a chunk with strong exact-term overlap but weak semantic
 * similarity can still never be recalled. Fixing that would mean a second,
 * lower floor for the lexical pool, and a way to stop it undermining refusals.
 */
function selectChunksHybrid(queryVector, query, store, options = {}) {
  const { k = 5, floor = 0.25, maxPerPage = 2, rrfK = 60 } = options;

  if (!store || !store.chunks || store.chunks.length === 0) return [];

  const dims = store.dimensions;

  // Vector ranking over everything above the floor.
  const vectorScores = [];
  for (let i = 0; i < store.chunks.length; i += 1) {
    const offset = i * dims;
    let score = 0;
    for (let d = 0; d < dims; d += 1) score += queryVector[d] * store.vectors[offset + d];
    if (score >= floor) vectorScores.push({ index: i, score });
  }
  vectorScores.sort((a, b) => b.score - a.score);

  // Nothing semantically close: refuse, and do not let keywords rescue it.
  if (vectorScores.length === 0) return [];

  const vectorRanking = vectorScores;
  vectorRanking.label = 'vector';

  // Lexical ranking over the SAME candidate set, so every fused result is
  // guaranteed to have a real similarity score above the floor.
  const candidates = vectorScores.map((v) => store.chunks[v.index]);
  const lexicalRanking = rankLexical(query, candidates).map((entry) => ({
    index: vectorScores[entry.index].index,
    score: entry.score,
  }));
  lexicalRanking.label = 'lexical';

  const similarityByIndex = new Map(vectorScores.map((v) => [v.index, v.score]));
  const fused = fuseRankings([vectorRanking, lexicalRanking], { rrfK });

  const results = fused.map((entry) => ({
    ...store.chunks[entry.index],
    // `score` stays the cosine similarity so the floor, the golden set and every
    // threshold keep meaning the same thing. Fusion score is reported separately.
    score: similarityByIndex.get(entry.index) ?? 0,
    fusedScore: entry.score,
    ranks: entry.ranks,
  }));

  return capPerPage(results, k, maxPerPage);
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

// ---------------------------------------------------------------------------
// Answer confidence
// ---------------------------------------------------------------------------

/**
 * How much to trust an answer, as a composite signal.
 *
 * The tempting implementation is "confidence = top similarity score". It would
 * be actively misleading, and this repo has the measurement to prove it:
 *
 *   "What does CSS stand for?"                 top score 0.457  <- unanswerable
 *   "how do I loop over a list in a template?" top score 0.475  <- correct answer
 *
 * A 0.018 gap. Similarity measures topical closeness, NOT whether the answer is
 * present in the passages, so a score-based badge would rate an unanswerable
 * question as highly as a real one.
 *
 * Four signals instead, in descending order of usefulness:
 *
 *   1. status - by far the strongest. The model has read the passages and said
 *      whether they answer the question. Nothing derived from scores beats that.
 *   2. citation coverage - an answer citing nothing is unsupported prose, even if
 *      retrieval scored well.
 *   3. score gap between the top hit and the rest - a distinctive match stands
 *      out; uniformly flat scores mean the corpus had no strong opinion.
 *   4. distinct pages - agreement across several pages is corroboration, whereas
 *      everything from one page may just be one well-matched paragraph.
 *
 * Reported as high/medium/low with the reasons attached. Deliberately not a
 * percentage: the inputs do not support that kind of precision, and a number
 * like "73% confident" invites trust it has not earned.
 */
function assessConfidence({ status, results = [], citations = [] }) {
  const signals = {
    status,
    topScore: results[0]?.score ?? 0,
    scoreGap: 0,
    distinctPages: new Set(results.map((r) => r.path)).size,
    citationCount: citations.length,
  };

  if (results.length > 1) {
    const rest = results.slice(1).reduce((sum, r) => sum + (r.score || 0), 0) / (results.length - 1);
    signals.scoreGap = Number((signals.topScore - rest).toFixed(4));
  }

  // Nothing was found, or nothing found answered the question. Neither is a
  // confident state, whatever the scores looked like.
  if (status === 'refused') {
    return { level: 'none', reasons: ['Nothing in the indexed docs matched'], signals };
  }
  if (status === 'partial') {
    return {
      level: 'low',
      reasons: ['Pages were found but none answered the question'],
      signals,
    };
  }

  const reasons = [];
  let points = 0;

  if (signals.citationCount >= 2) {
    points += 2;
    reasons.push(`Cites ${signals.citationCount} passages`);
  } else if (signals.citationCount === 1) {
    points += 1;
    reasons.push('Cites 1 passage');
  } else {
    reasons.push('Answer cites no passage');
  }

  if (signals.topScore >= 0.5) {
    points += 2;
    reasons.push('Strong top match');
  } else if (signals.topScore >= 0.4) {
    points += 1;
    reasons.push('Moderate top match');
  } else {
    reasons.push('Weak top match');
  }

  if (signals.distinctPages >= 3) {
    points += 1;
    reasons.push(`Corroborated across ${signals.distinctPages} pages`);
  }

  if (signals.scoreGap >= 0.06) {
    points += 1;
    reasons.push('Top match stands clearly above the rest');
  }

  const level = points >= 4 ? 'high' : points >= 2 ? 'medium' : 'low';
  return { level, reasons, signals };
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
  capPerPage,
  tokenize,
  rankLexical,
  fuseRankings,
  selectChunksHybrid,
  assessConfidence,
  buildPrompt,
  extractCitations,
  generateAnswer,
  createOpenAiLlm,
  SYSTEM_PROMPT,
  REFUSAL,
  PARTIAL_ANSWER,
  NO_ANSWER_SENTINEL,
};
