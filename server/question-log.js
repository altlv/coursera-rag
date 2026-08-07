/*
 * Question logging: what people actually ask.
 *
 * The eval sets are 30 questions someone invented. Real usage is the only source
 * of what users genuinely ask, including the phrasings that fail - which is the
 * whole reason this exists.
 *
 * Two files, and the split matters
 * --------------------------------
 *   questions.jsonl        append-only event log - THE SOURCE OF TRUTH
 *   questions.index.json   derived clusters and counts - REBUILDABLE
 *
 * Deduplicating at write time would be irreversible: pick a similarity threshold,
 * run for a month, discover it was merging genuinely different questions, and the
 * original data is gone. Keeping raw events means the threshold can change and the
 * index simply gets re-derived.
 *
 * Clustering keeps every variant
 * ------------------------------
 * Near-duplicates are grouped under a canonical question, but each distinct
 * phrasing is kept with its own count. The phrasings ARE the data: collapsing
 * "what are signals?", "explain Angular signals" and "whats a signal" into one row
 * destroys exactly the signal that makes real logs better than invented questions,
 * and each variant is a candidate for the eval sets.
 *
 * Semantic dedup is nearly free because the question vector already exists - it was
 * computed for retrieval - so grouping is one dot product per stored canonical.
 */

const fs = require('fs').promises;
const path = require('path');
const { randomUUID } = require('crypto');

/** Schema version. The log outlives the code that wrote it. */
const SCHEMA_VERSION = 1;

/*
 * Automatic semantic merging is OFF by default, because it was measured and it
 * does not work for this task.
 *
 * The plan was to group paraphrases by cosine similarity between question vectors.
 * Measuring across 30 known-distinct eval questions (435 pairs) plus real logged
 * paraphrases showed the two distributions OVERLAP COMPLETELY:
 *
 *   two genuinely DIFFERENT questions, max   0.712
 *     "how do I validate a form?" vs
 *     "how do I write a test that checks a form control became invalid?"
 *
 *   a genuine PARAPHRASE                      0.478
 *     "what are signals?" vs "explain Angular signals to me"
 *
 * A distinct question can be MORE similar than a paraphrase, so no threshold
 * separates them: above 0.712 nothing merges, below 0.478 unrelated questions do.
 *
 * The one pair that did score highly - "what are signals?" vs "What are signals??"
 * at 0.930 - is identical text differing only in punctuation, which
 * normalizeQuestion already catches for free. So semantic merging adds nothing at
 * any safe threshold.
 *
 * Why the intuition failed: this threshold was ported from question-to-PASSAGE
 * matching, where a strong match sits near 0.47 against a floor of 0.25.
 * Question-to-QUESTION similarity is a different distribution entirely - short
 * texts, and no long passage to anchor the comparison.
 *
 * Set a value to experiment. Vectors are kept in the event log, so re-clustering is
 * always possible and nothing is lost by the default being off.
 */
const DEFAULT_SIMILARITY_THRESHOLD = null;

/** Similarity worth showing a human as "these might be the same question". */
const SUGGESTION_THRESHOLD = 0.45;

/** Stored vectors are rounded: 5 decimals is far below anything that changes a match. */
const VECTOR_PRECISION = 5;

/*
 * Patterns that must never be written to disk.
 *
 * Questions are free text, so a user can paste anything into them - including a
 * key. This is not hypothetical: a key was pasted into a chat during this
 * project's own development. Redaction happens before anything is written.
 */
const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}/g, // OpenAI-style
  /\bAIza[0-9A-Za-z_-]{20,}/g, // Google API keys
  /\bghp_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /\bxoxb-[A-Za-z0-9-]{20,}/g, // Slack
  /\bBearer\s+[A-Za-z0-9._-]{20,}/gi,
  /\bAQ\.[A-Za-z0-9._-]{20,}/g, // Google OAuth-style
];

/** Replace anything key-shaped with a marker. */
function redactSecrets(text) {
  return SECRET_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, '[REDACTED]'), text || '');
}

/**
 * Canonical form for exact-match grouping.
 *
 * Catches the cheap duplicates - casing, spacing, a trailing question mark -
 * before any vector maths is needed.
 */
function normalizeQuestion(text) {
  return (
    (text || '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      // Trim BEFORE stripping trailing punctuation: the $ anchor cannot match
      // when the string still ends in a space, so "signals?? " would keep its
      // question marks.
      .trim()
      .replace(/[?!.,;:]+$/, '')
      .trim()
  );
}

function dot(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let total = 0;
  for (let i = 0; i < a.length; i += 1) total += a[i] * b[i];
  return total;
}

const round = (vector) =>
  Array.from(vector, (v) => Number(v.toFixed(VECTOR_PRECISION)));

/**
 * Group events into clusters of semantically-similar questions.
 *
 * Pure and synchronous, so the clustering rules are testable without touching the
 * filesystem - and re-runnable over the whole event log whenever the threshold
 * changes.
 */
function buildIndex(events, { threshold = DEFAULT_SIMILARITY_THRESHOLD } = {}) {
  const clusters = [];
  const byNormalized = new Map();
  const clusterById = new Map();

  /*
   * Ratings arrive as separate append-only events, so they are folded in after the
   * questions they refer to have been clustered. Doing it in one pass would fail
   * whenever a rating appears before its question in iteration order.
   */
  const ratings = [];

  for (const event of events) {
    if (event.kind === 'rating') {
      ratings.push(event);
      continue;
    }

    const normalized = normalizeQuestion(event.question);
    if (!normalized) continue;

    // 1. Exact match on the normalised form.
    let cluster = byNormalized.get(normalized);

    /*
     * 2. Semantic match, only when a threshold is explicitly configured.
     *
     * The null check is load-bearing: `score >= null` coerces to `score >= 0`, so
     * omitting it would merge every question into one cluster.
     */
    if (!cluster && event.vector && typeof threshold === 'number') {
      let best = null;
      let bestScore = threshold;
      for (const candidate of clusters) {
        if (!candidate.vector) continue;
        const score = dot(event.vector, candidate.vector);
        if (score >= bestScore) {
          best = candidate;
          bestScore = score;
        }
      }
      cluster = best;
    }

    // 3. Otherwise a new cluster.
    if (!cluster) {
      cluster = {
        canonical: event.question,
        vector: event.vector || null,
        total: 0,
        variants: [],
        firstSeen: event.at,
        lastSeen: event.at,
        statuses: {},
        paths: {},
        ratings: { up: 0, down: 0 },
        notes: [],
      };
      clusters.push(cluster);
    }

    byNormalized.set(normalized, cluster);
    if (event.id) clusterById.set(event.id, cluster);

    cluster.total += 1;
    cluster.lastSeen = event.at;
    if (event.status) cluster.statuses[event.status] = (cluster.statuses[event.status] || 0) + 1;
    for (const p of event.paths || []) cluster.paths[p] = (cluster.paths[p] || 0) + 1;

    // Every distinct phrasing is kept, with its own count.
    const variant = cluster.variants.find((v) => normalizeQuestion(v.text) === normalized);
    if (variant) variant.count += 1;
    else cluster.variants.push({ text: event.question, count: 1 });
  }

  /*
   * Fold ratings in. Matched by id where possible; otherwise by normalised text, so
   * a rating still lands somewhere useful if the id is missing.
   */
  for (const rating of ratings) {
    const cluster =
      clusterById.get(rating.questionId) || byNormalized.get(normalizeQuestion(rating.question));
    if (!cluster) continue;

    cluster.ratings[rating.rating] = (cluster.ratings[rating.rating] || 0) + 1;
    if (rating.note) cluster.notes.push(rating.note);
  }

  clusters.sort((a, b) => b.total - a.total);
  return clusters;
}

/**
 * Filesystem-backed logger.
 *
 * Every method swallows its own errors. A logging failure - full disk, permissions,
 * anything - must never stop the chatbot answering a question.
 */
function createQuestionLog({
  dir = process.env.QUESTION_LOG_DIR || path.resolve(__dirname, '../data'),
  enabled = process.env.QUESTION_LOG !== 'off',
  threshold = DEFAULT_SIMILARITY_THRESHOLD,
  logger = console,
} = {}) {
  const eventsFile = path.join(dir, 'questions.jsonl');
  const indexFile = path.join(dir, 'questions.index.json');

  let clusters = null;

  async function readEvents() {
    try {
      const raw = await fs.readFile(eventsFile, 'utf8');
      return raw
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            // One corrupt line must not lose the rest of the log.
            return null;
          }
        })
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  async function writeIndex() {
    // Write-then-rename, so a crash mid-write cannot leave a truncated index.
    const temp = `${indexFile}.tmp`;
    const payload = {
      version: SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      threshold,
      clusterCount: clusters.length,
      totalQuestions: clusters.reduce((sum, c) => sum + c.total, 0),
      clusters,
    };
    await fs.writeFile(temp, JSON.stringify(payload, null, 2), 'utf8');
    await fs.rename(temp, indexFile);
  }

  return {
    eventsFile,
    indexFile,
    enabled,

    /** Re-derive the index from the event log. Safe to call any time. */
    async rebuild() {
      const events = await readEvents();
      clusters = buildIndex(events, { threshold });
      await writeIndex();
      return { events: events.length, clusters: clusters.length };
    },

    /**
     * Record one question. Fire-and-forget: never awaited on the request path,
     * never throws.
     */
    async record({ question, rewritten, vector, status, confidence, provider, model, retrieved = [], tokens, ms }) {
      if (!enabled || !question) return;

      try {
        await fs.mkdir(dir, { recursive: true });

        const event = {
          v: SCHEMA_VERSION,
          /** Lets a later rating event refer back to this exact answer. */
          id: randomUUID(),
          at: new Date().toISOString(),
          question: redactSecrets(question),
          ...(rewritten ? { rewritten: redactSecrets(rewritten) } : {}),
          status,
          confidence,
          provider,
          model,
          // Paths and scores, not the answer prose: enough to reconstruct the
          // retrieval decision without storing the largest and most sensitive field.
          paths: retrieved.map((r) => r.path),
          scores: retrieved.map((r) => Number((r.score ?? 0).toFixed(4))),
          tokens,
          ms,
          ...(vector ? { vector: round(vector) } : {}),
        };

        await fs.appendFile(eventsFile, `${JSON.stringify(event)}\n`, 'utf8');

        // Re-derive the index from the whole log. Cheap at this scale, and it keeps
        // one code path for both incremental writes and a full rebuild.
        clusters = buildIndex(await readEvents(), { threshold });
        await writeIndex();

        return event.id;
      } catch (error) {
        // Deliberately swallowed - see the note on createQuestionLog.
        logger.warn?.(`Question logging failed (continuing): ${error.message}`);
        return undefined;
      }
    },

    /**
     * Attach a user verdict to a question already logged.
     *
     * Written as its own event rather than by editing the original. The log is
     * append-only, so a rating is a new fact about an existing one - which keeps
     * the file crash-safe and preserves the order things actually happened in.
     *
     * Logs alone say what was asked, not whether the answer was any good. This is
     * the half that turns a failure into a regression test.
     */
    async rate({ questionId, question, rating, note }) {
      if (!enabled || !['up', 'down'].includes(rating)) return;

      try {
        await fs.mkdir(dir, { recursive: true });
        await fs.appendFile(
          eventsFile,
          `${JSON.stringify({
            v: SCHEMA_VERSION,
            kind: 'rating',
            at: new Date().toISOString(),
            questionId,
            question: redactSecrets(question || ''),
            rating,
            ...(note ? { note: redactSecrets(note).slice(0, 500) } : {}),
          })}\n`,
          'utf8',
        );
      } catch (error) {
        logger.warn?.(`Rating failed (continuing): ${error.message}`);
      }
    },

    async read() {
      return readEvents();
    },
  };
}

module.exports = {
  SCHEMA_VERSION,
  DEFAULT_SIMILARITY_THRESHOLD,
  redactSecrets,
  normalizeQuestion,
  buildIndex,
  createQuestionLog,
};
