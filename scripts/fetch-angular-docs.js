/*
 * Full rebuild of the docs corpus from scratch.
 *
 *   npm run download-docs
 *
 * Downloads every page matching SECTION_ALLOWLIST, replacing whatever is on
 * disk, and writes structure.json plus manifest.json. It does NOT touch the
 * vector store - follow with `npm run build-embeddings`.
 *
 * For routine maintenance prefer `npm run docs:update`, which fetches the same
 * pages but only re-embeds the ones whose content actually changed. Use this
 * script for a first run, or after widening the allowlist enough that a clean
 * slate is simpler.
 *
 * Why this reads sitemap.xml rather than the sidebar
 * -------------------------------------------------
 * The original version parsed the docs sidebar out of the static HTML of
 * /overview, which silently missed almost everything: angular.dev renders
 * collapsed nav sections as a <button> with NO child <ul>, because Angular
 * expands them lazily in the browser. A scraper reading raw HTML therefore sees
 * each section's NAME but none of its pages.
 *
 * That produced a 23-page corpus with Signals, Components, Templates,
 * Directives, Forms, Routing, HTTP and DI all absent - so "what is a signal?"
 * retrieved AI-tooling pages that merely contained the word - plus 28 nav
 * entries with no path, which rendered as dead links to /docs?path=undefined.
 *
 * sitemap.xml is the site's own machine-readable index: no JavaScript needed,
 * and it cannot silently omit lazily-rendered branches.
 *
 * Shared logic lives in scripts/docs-source.js so this and update-docs.js
 * cannot disagree about the allowlist or how a page is extracted.
 */

const docs = require('./docs-source');

async function run() {
  console.log('Fetching sitemap...');
  const { total, targets } = await docs.listTargetPaths();
  console.log(`  sitemap lists ${total} URLs`);
  console.log(`  ${targets.length} match the allowlist\n`);

  const version = await docs.fetchDocsVersion();
  if (version) console.log(`angular.dev reports v${version}\n`);

  const { pages, failures, skipped } = await docs.fetchPages(targets, (done, all) =>
    process.stdout.write(`\r  downloaded ${done}/${all}`),
  );
  console.log('\n');

  /*
   * Report skipped redirect shells, and whether their target was captured.
   * Silently dropping them would hide a real gap: if a target falls outside
   * SECTION_ALLOWLIST, that topic is missing from the corpus entirely.
   */
  if (skipped.length) {
    const captured = new Set(pages.map((p) => p.path));
    const stubTargets = new Map(skipped.map((s) => [s.path, s.target]));

    /*
     * Redirects CHAIN. /guide/components/importing points at
     * /guide/components/anatomy-of-components, which is itself a shell pointing at
     * /guide/components. Checking only one hop reports a false gap, because the
     * intermediate hop was skipped too.
     */
    const resolve = (from) => {
      const seen = new Set();
      let current = stubTargets.get(from);
      while (current && stubTargets.has(current) && !seen.has(current)) {
        seen.add(current);
        current = stubTargets.get(current);
      }
      return current;
    };

    const chains = skipped.filter((s) => s.target && stubTargets.has(s.target)).length;
    const gaps = skipped
      .map((s) => ({ ...s, resolved: resolve(s.path) }))
      .filter((s) => s.resolved && !captured.has(s.resolved));

    console.log(`Skipped ${skipped.length} redirect shell(s) - their content lives at the target.`);
    if (chains) console.log(`  ${chains} of them chained through another shell.`);

    if (gaps.length) {
      console.log(`  WARNING: ${gaps.length} target(s) are NOT in the corpus:`);
      for (const gap of gaps) console.log(`    ${gap.path} -> ${gap.resolved}`);
      console.log('  Add them to SECTION_ALLOWLIST or that topic is unanswerable.');
    } else {
      console.log('  All targets resolve to pages that are present.');
    }
    console.log('');
  }

  for (const page of pages) await docs.savePage(page);
  await docs.writeStructure(pages);

  await docs.writeManifest({
    angularVersion: version,
    latestRelease: await docs.fetchLatestRelease(),
    updatedAt: new Date().toISOString(),
    pageCount: pages.length,
    pages: docs.manifestPagesFrom(pages),
  });

  const chars = pages.reduce((sum, p) => sum + p.contentText.length, 0);
  console.log(`Saved ${pages.length} pages (${(chars / 1000).toFixed(0)}k chars of text)`);
  console.log('Wrote structure.json and manifest.json');

  if (failures.length) {
    console.log(`\n${failures.length} page(s) failed:`);
    for (const f of failures) console.log(`  ${f.path}: ${f.message}`);
  }

  console.log('\nNext: npm run build-embeddings');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
