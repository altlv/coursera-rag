/*
 * What people actually ask, and which questions the assistant is failing.
 *
 *   npm run questions                 summary
 *   npm run questions -- --gaps       only the clusters worth fixing
 *   npm run questions -- --rebuild    re-derive the index from the event log
 *   npm run questions -- --threshold=0.9 --rebuild
 *
 * The eval sets are 30 questions someone invented. This is the only source of what
 * users genuinely ask, and more importantly of the phrasings that FAIL - which are
 * exactly the cases worth adding to the held-out set.
 *
 * Re-clustering at a different threshold is non-destructive: the JSONL event log is
 * the source of truth and the index is derived, so nothing is lost by trying a
 * different value.
 */

const path = require('path');
const dotenv = require('dotenv');
const { createQuestionLog, buildIndex, DEFAULT_SIMILARITY_THRESHOLD } = require('../server/question-log');

dotenv.config();

const args = process.argv.slice(2);
const GAPS_ONLY = args.includes('--gaps');
const REBUILD = args.includes('--rebuild');
/*
 * Semantic clustering is off by default, because measuring it showed no threshold
 * separates paraphrases from genuinely different questions - see the note in
 * server/question-log.js. Pass --threshold=0.5 to experiment; it is non-destructive,
 * since the event log keeps every vector.
 */
const thresholdArg = (args.find((a) => a.startsWith('--threshold=')) || '').split('=')[1];
const THRESHOLD = thresholdArg ? Number(thresholdArg) : DEFAULT_SIMILARITY_THRESHOLD;

const bar = (n, max, width = 24) => '#'.repeat(Math.max(1, Math.round((n / max) * width)));

async function run() {
  const log = createQuestionLog({ threshold: THRESHOLD });
  const events = await log.read();

  if (events.length === 0) {
    console.log('No questions logged yet.');
    console.log(`Expected at: ${log.eventsFile}`);
    console.log('\nAsk the assistant a few questions, then run this again.');
    console.log('(Logging is on by default; disable with QUESTION_LOG=off)');
    return;
  }

  const clusters = buildIndex(events, { threshold: THRESHOLD });

  if (REBUILD) {
    const result = await log.rebuild();
    console.log(`Rebuilt index: ${result.events} events -> ${result.clusters} clusters\n`);
  }

  const total = events.length;
  const statuses = events.reduce((acc, e) => {
    acc[e.status || 'unknown'] = (acc[e.status || 'unknown'] || 0) + 1;
    return acc;
  }, {});

  console.log('='.repeat(70));
  console.log(`${total} questions asked, ${clusters.length} distinct topics`);
  console.log(`clustering threshold: ${THRESHOLD}`);
  console.log('='.repeat(70));

  console.log('\nOutcomes');
  for (const [status, count] of Object.entries(statuses).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${status.padEnd(10)} ${String(count).padStart(4)}  ${((count / total) * 100).toFixed(0)}%`);
  }

  /*
   * The useful part: clusters that are asked repeatedly and answered badly.
   * A topic asked once and refused may be off-topic; one asked ten times and
   * refused is a gap in the corpus or in retrieval.
   */
  /*
   * A thumbs-down outranks every automatic signal.
   *
   * `status` says whether the system THOUGHT it answered; a rating says whether it
   * actually did. An answer marked helpful is fine however low its confidence, and
   * one marked unhelpful is a problem however confident it looked - which is
   * exactly the case no automatic metric can catch.
   */
  const rated = clusters
    .map((c) => ({ ...c, down: c.ratings?.down || 0, up: c.ratings?.up || 0 }))
    .filter((c) => c.down > 0)
    .sort((a, b) => b.down - a.down || b.total - a.total);

  if (rated.length) {
    console.log('\nMarked UNHELPFUL by a user - the strongest signal available');
    console.log('-'.repeat(70));
    for (const c of rated.slice(0, 10)) {
      console.log(`  ${c.down} down / ${c.up} up  of ${c.total} asks   "${c.canonical}"`);
      const topPaths = Object.entries(c.paths).sort((a, b) => b[1] - a[1]).slice(0, 3);
      if (topPaths.length) console.log(`     retrieved: ${topPaths.map(([p]) => p).join(', ')}`);
      for (const note of (c.notes || []).slice(0, 2)) console.log(`     note: "${note}"`);
    }
    console.log('\n  -> add these to test/holdout-set.mjs with the pages they SHOULD find');
  }

  const gaps = clusters
    .map((c) => {
      const bad = (c.statuses.partial || 0) + (c.statuses.refused || 0);
      return { ...c, bad, badRatio: c.total ? bad / c.total : 0 };
    })
    .filter((c) => c.bad > 0)
    .sort((a, b) => b.bad - a.bad || b.total - a.total);

  if (gaps.length) {
    console.log('\nAsked but not answered well - candidates for the held-out set');
    console.log('-'.repeat(70));
    for (const c of gaps.slice(0, 15)) {
      console.log(`  ${c.bad}/${c.total} unanswered  "${c.canonical}"`);
      if (c.variants.length > 1) {
        console.log(`     also asked as: ${c.variants.slice(1, 4).map((v) => `"${v.text}"`).join(', ')}`);
      }
      const topPaths = Object.entries(c.paths).sort((a, b) => b[1] - a[1]).slice(0, 3);
      if (topPaths.length) console.log(`     retrieved: ${topPaths.map(([p]) => p).join(', ')}`);
    }
  } else if (!rated.length) {
    console.log('\nNo clusters with partial, refused or down-rated answers.');
  }

  if (GAPS_ONLY) return;

  const max = clusters[0]?.total || 1;
  console.log('\nMost asked');
  console.log('-'.repeat(70));
  for (const c of clusters.slice(0, 15)) {
    console.log(`  ${String(c.total).padStart(3)} ${bar(c.total, max)}  ${c.canonical}`);
    if (c.variants.length > 1) {
      // Phrasings are kept deliberately: they are what real logs offer over
      // invented questions, and each is an eval-set candidate.
      console.log(`      ${c.variants.length} phrasings`);
    }
  }

  const withTokens = events.filter((e) => e.tokens);
  if (withTokens.length) {
    const avg = Math.round(withTokens.reduce((s, e) => s + e.tokens, 0) / withTokens.length);
    const avgMs = Math.round(
      events.filter((e) => e.ms).reduce((s, e) => s + e.ms, 0) / (events.filter((e) => e.ms).length || 1),
    );
    console.log(`\nAverage ${avg} tokens, ${avgMs}ms per question`);
  }

  console.log(`\nEvents: ${log.eventsFile}`);
  console.log(`Index:  ${log.indexFile}`);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
