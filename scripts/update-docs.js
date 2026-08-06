/*
 * Incrementally update the docs corpus and the vector store.
 *
 *   npm run docs:check    report only - no writes, no API calls, no cost
 *   npm run docs:update   apply changes and re-embed only what changed
 *
 * How change detection works, and why
 * ----------------------------------
 * Three signals are available, and they are good for different things:
 *
 *   1. Version (angular.dev + the npm registry) - tells you WHETHER anything
 *      might have changed, and gives a human-readable "you captured v22.1.0,
 *      latest is v22.2.0".
 *
 *   2. CHANGELOG.md - tells you what changed in the FRAMEWORK, grouped by
 *      package. Useful context, but it cannot decide which doc pages to fetch:
 *      a fix(compiler) may touch no documentation at all, and a docs-only
 *      correction never appears in a changelog.
 *
 *   3. Per-page content hashes - the ground truth for which pages actually
 *      changed.
 *
 * The economics decide the design: FETCHING pages is free, EMBEDDING them costs
 * money. So we always fetch and hash all of them (cheap and exact), and spend
 * the API budget only on pages whose text genuinely moved. Version and changelog
 * provide the narrative; hashes decide the work.
 */

const fs = require('fs').promises;
const path = require('path');
const dotenv = require('dotenv');
const { OpenAI } = require('openai');
const { chunkText, normalizeVector } = require('../server/rag');
const docs = require('./docs-source');

dotenv.config();

const CHUNKS_FILE = path.join(docs.DOCS_ROOT, 'chunks.json');
const VECTORS_FILE = path.join(docs.DOCS_ROOT, 'vectors.bin');

const EMBEDDING_MODEL = 'text-embedding-3-small';
const DIMENSIONS = 512;
const CHUNK_CHARS = 1200;
const CHUNK_OVERLAP = 150;
const BATCH_SIZE = 64;
const MAX_CHUNK_CHARS = 8000;

/** $0.02 per 1M tokens for text-embedding-3-small; ~4 chars per token. */
const USD_PER_1M_TOKENS = 0.02;
const estimateCost = (chars) => ((chars / 4) * USD_PER_1M_TOKENS) / 1_000_000;

const CHECK_ONLY = process.argv.includes('--check') || process.argv.includes('--dry-run');

const line = () => console.log('-'.repeat(64));

// ---------------------------------------------------------------------------

async function describeVersions(manifest) {
  const [docsVersion, latestRelease] = await Promise.all([
    docs.fetchDocsVersion(),
    docs.fetchLatestRelease(),
  ]);

  const captured = manifest?.angularVersion || null;

  console.log('Versions');
  console.log(`  corpus captured at : ${captured || '(unknown - no manifest yet)'}`);
  console.log(`  angular.dev now    : ${docsVersion || '(could not determine)'}`);
  console.log(`  latest npm release : ${latestRelease || '(could not determine)'}`);

  if (captured && docsVersion && docs.compareSemver(docsVersion, captured) > 0) {
    console.log(`  -> docs site has moved on from ${captured} to ${docsVersion}`);
  } else if (captured && docsVersion) {
    console.log('  -> same docs version; any differences will be edits within it');
  }

  return { docsVersion, latestRelease, captured };
}

async function describeChangelog(captured) {
  if (!captured) return;

  let releases;
  try {
    releases = await docs.fetchChangelogSince(captured);
  } catch (error) {
    console.log(`\nChangelog unavailable (${error.message})`);
    return;
  }

  console.log('');
  if (releases.length === 0) {
    console.log(`Changelog: no releases after ${captured}`);
    return;
  }

  console.log(`Changelog: ${releases.length} release(s) after ${captured}`);
  for (const release of releases.slice(0, 5)) {
    const packages = Object.keys(release.packages);
    console.log(`  ${release.version} (${release.date || 'no date'}) - ${packages.join(', ') || 'no packaged changes'}`);
  }
  if (releases.length > 5) console.log(`  ... and ${releases.length - 5} more`);

  const { sections, unmapped, docsCommits } = docs.sectionsForReleases(releases);

  if (docsCommits.length) {
    // The changelog's own `docs` section is the only entry that talks about
    // prose rather than code, so it is the strongest hint available here.
    console.log(`  ${docsCommits.length} documentation commit(s) in these releases:`);
    for (const commit of docsCommits.slice(0, 6)) {
      console.log(`    ${commit.version}  ${commit.type}: ${commit.description}`);
    }
    if (docsCommits.length > 6) console.log(`    ... and ${docsCommits.length - 6} more`);
  }

  if (sections.length) {
    console.log(`  sections plausibly affected by code changes: ${sections.join(', ')}`);
    console.log('  (hints only - the page hashes below are what actually decide)');
  }
  if (unmapped.length) {
    console.log(`  packages with no section mapping: ${unmapped.join(', ')}`);
  }
}

/** Compare what the sitemap offers against what we have on disk. */
function diffPages(remotePages, manifestPages, targetPaths) {
  const added = [];
  const changed = [];
  const unchanged = [];

  for (const page of remotePages) {
    const known = manifestPages[page.path];
    const hash = docs.hashContent(page);

    if (!known) added.push({ page, hash });
    else if (known.hash !== hash) changed.push({ page, hash, oldHash: known.hash });
    else unchanged.push({ page, hash });
  }

  // In the manifest but no longer offered by the sitemap, or no longer allowed.
  const targetSet = new Set(targetPaths);
  const removed = Object.keys(manifestPages).filter((p) => !targetSet.has(p));

  return { added, changed, unchanged, removed };
}

// ---------------------------------------------------------------------------
// Vector store
// ---------------------------------------------------------------------------

async function loadStore() {
  try {
    const meta = JSON.parse(await fs.readFile(CHUNKS_FILE, 'utf8'));
    const buffer = await fs.readFile(VECTORS_FILE);
    const vectors = new Float32Array(
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
    );

    if (vectors.length !== meta.chunks.length * meta.dimensions) {
      throw new Error('vectors.bin does not match chunks.json');
    }
    if (meta.dimensions !== DIMENSIONS || meta.model !== EMBEDDING_MODEL) {
      // Reusing vectors from a different model or dimension count would compare
      // points from two unrelated spaces and silently return nonsense.
      throw new Error(
        `store is ${meta.model}@${meta.dimensions}, this script builds ` +
          `${EMBEDDING_MODEL}@${DIMENSIONS} - a full rebuild is required`,
      );
    }

    return { meta, vectors };
  } catch (error) {
    return { meta: null, vectors: null, reason: error.message };
  }
}

function chunksForPage(page) {
  return chunkText(page.contentText || '', CHUNK_CHARS, CHUNK_OVERLAP).map((text, index) => ({
    id: `${page.path}#${index + 1}`,
    title: page.title,
    path: page.path,
    url: page.url,
    text: text.length > MAX_CHUNK_CHARS ? text.slice(0, MAX_CHUNK_CHARS) : text,
  }));
}

async function embedAll(client, chunks, label) {
  const vectors = new Float32Array(chunks.length * DIMENSIONS);

  for (let start = 0; start < chunks.length; start += BATCH_SIZE) {
    const batch = chunks.slice(start, start + BATCH_SIZE);
    const response = await client.embeddings.create({
      model: EMBEDDING_MODEL,
      dimensions: DIMENSIONS,
      input: batch.map((c) => c.text),
    });

    if (!response.data || response.data.length !== batch.length) {
      throw new Error('OpenAI returned an unexpected number of embeddings.');
    }

    response.data
      .sort((a, b) => a.index - b.index)
      .forEach((item, i) => {
        vectors.set(normalizeVector(item.embedding), (start + i) * DIMENSIONS);
      });

    process.stdout.write(
      `\r  ${label} ${Math.min(start + BATCH_SIZE, chunks.length)}/${chunks.length}`,
    );
  }

  if (chunks.length) console.log('');
  return vectors;
}

/**
 * Rebuild the store, reusing existing vectors for untouched pages.
 *
 * Chunk ids are `${path}#${n}`, so a page's chunks are identifiable by path.
 * Pages that did not change keep their vectors copied straight across; only the
 * changed and added pages are sent to the API.
 */
async function updateStore(client, { keepPages, embedPages, previous }) {
  const reusedChunks = [];
  const reusedRows = [];

  if (previous.meta) {
    const indexByChunkId = new Map(previous.meta.chunks.map((c, i) => [c.id, i]));

    for (const page of keepPages) {
      for (const chunk of previous.meta.chunks.filter((c) => c.path === page.path)) {
        reusedChunks.push(chunk);
        reusedRows.push(indexByChunkId.get(chunk.id));
      }
    }
  }

  const freshChunks = embedPages.flatMap(chunksForPage);

  console.log('');
  console.log(`  reusing  ${reusedChunks.length} existing chunk vectors`);
  console.log(`  embedding ${freshChunks.length} new/changed chunks`);

  const freshVectors = await embedAll(client, freshChunks, 'embedded');

  // Assemble: reused rows copied from the old buffer, fresh rows appended.
  const allChunks = [...reusedChunks, ...freshChunks];
  const vectors = new Float32Array(allChunks.length * DIMENSIONS);

  reusedRows.forEach((sourceRow, targetRow) => {
    vectors.set(
      previous.vectors.subarray(sourceRow * DIMENSIONS, (sourceRow + 1) * DIMENSIONS),
      targetRow * DIMENSIONS,
    );
  });
  vectors.set(freshVectors, reusedChunks.length * DIMENSIONS);

  return { chunks: allChunks, vectors };
}

// ---------------------------------------------------------------------------

async function run() {
  line();
  console.log(CHECK_ONLY ? 'Angular docs update - CHECK ONLY (no changes)' : 'Angular docs update');
  line();

  const manifest = await docs.readManifest();
  const localPages = await docs.loadLocalPages();

  // First run after the corpus was built without a manifest: derive it.
  const manifestPages = manifest?.pages || docs.manifestPagesFrom(localPages);
  if (!manifest) {
    console.log(`No manifest yet - deriving hashes from the ${localPages.length} pages on disk.\n`);
  }

  const versions = await describeVersions(manifest);
  await describeChangelog(versions.captured);

  console.log('');
  const { total, targets } = await docs.listTargetPaths();
  console.log(`Sitemap lists ${total} URLs; ${targets.length} match the allowlist.`);
  console.log('Fetching all of them to compare content (free - only embedding costs money)\n');

  const { pages: remotePages, failures } = await docs.fetchPages(targets, (done, all) =>
    process.stdout.write(`\r  fetched ${done}/${all}`),
  );
  console.log('\n');

  const diff = diffPages(remotePages, manifestPages, targets);

  line();
  console.log('Changes');
  line();
  console.log(`  added     ${String(diff.added.length).padStart(4)}`);
  console.log(`  changed   ${String(diff.changed.length).padStart(4)}`);
  console.log(`  removed   ${String(diff.removed.length).padStart(4)}`);
  console.log(`  unchanged ${String(diff.unchanged.length).padStart(4)}`);
  if (failures.length) console.log(`  failed    ${String(failures.length).padStart(4)}`);
  console.log('');

  for (const { page } of diff.added) console.log(`  + ${page.path}`);
  for (const { page, hash, oldHash } of diff.changed) {
    const before = manifestPages[page.path]?.chars ?? 0;
    const delta = page.contentText.length - before;
    console.log(
      `  ~ ${page.path}  ${oldHash} -> ${hash}  ${delta >= 0 ? '+' : ''}${delta} chars`,
    );
  }
  for (const p of diff.removed) console.log(`  - ${p}`);
  for (const f of failures) console.log(`  ! ${f.path}: ${f.message}`);

  const toEmbed = [...diff.added, ...diff.changed].map((d) => d.page);
  const embedChars = toEmbed.reduce((sum, p) => sum + p.contentText.length, 0);

  if (toEmbed.length === 0 && diff.removed.length === 0) {
    console.log('\nCorpus is already up to date. Nothing to do.');
    return;
  }

  console.log('');
  console.log(
    `Would re-embed ${toEmbed.length} page(s), ~${(embedChars / 1000).toFixed(0)}k chars, ` +
      `estimated cost $${estimateCost(embedChars).toFixed(4)}`,
  );

  if (CHECK_ONLY) {
    console.log('\nCheck only - nothing written. Run `npm run docs:update` to apply.');
    return;
  }

  // ---- apply -------------------------------------------------------------

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('\nOPENAI_API_KEY is not set, so the vector store cannot be updated.');
    console.error('Set it in .env, or run `npm run docs:check` to inspect without changes.');
    process.exit(1);
  }

  console.log('\nWriting pages...');
  for (const { page } of [...diff.added, ...diff.changed]) await docs.savePage(page);
  for (const p of diff.removed) await docs.deletePage(p);

  const pagesNow = await docs.loadLocalPages();
  await docs.writeStructure(pagesNow);
  console.log(`  ${pagesNow.length} pages on disk; structure.json rewritten`);

  const previous = await loadStore();
  if (!previous.meta) {
    console.log(`\nExisting vector store unusable (${previous.reason}).`);
    console.log('Run `npm run build-embeddings` for a full rebuild instead.');
    process.exit(1);
  }

  const changedPaths = new Set(toEmbed.map((p) => p.path));
  const removedPaths = new Set(diff.removed);
  const keepPages = pagesNow.filter(
    (p) => !changedPaths.has(p.path) && !removedPaths.has(p.path),
  );

  const client = new OpenAI({ apiKey });
  const { chunks, vectors } = await updateStore(client, {
    keepPages,
    embedPages: pagesNow.filter((p) => changedPaths.has(p.path)),
    previous,
  });

  await fs.writeFile(
    CHUNKS_FILE,
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        model: EMBEDDING_MODEL,
        dimensions: DIMENSIONS,
        chunkChars: CHUNK_CHARS,
        chunkOverlap: CHUNK_OVERLAP,
        normalized: true,
        pageCount: pagesNow.length,
        chunkCount: chunks.length,
        chunks,
      },
      null,
      2,
    ),
    'utf8',
  );
  await fs.writeFile(VECTORS_FILE, Buffer.from(vectors.buffer));

  await docs.writeManifest({
    angularVersion: versions.docsVersion || versions.captured,
    latestRelease: versions.latestRelease,
    updatedAt: new Date().toISOString(),
    pageCount: pagesNow.length,
    chunkCount: chunks.length,
    pages: docs.manifestPagesFrom(pagesNow),
  });

  line();
  console.log(`Done. ${chunks.length} chunks across ${pagesNow.length} pages.`);
  console.log(`Actual embedding cost: ~$${estimateCost(embedChars).toFixed(4)}`);
  console.log('Restart the backend to pick up the new store.');
  line();
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
