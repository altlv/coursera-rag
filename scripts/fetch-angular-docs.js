/*
 * Download a slice of the Angular documentation for the RAG corpus.
 *
 * Why this reads sitemap.xml instead of the sidebar
 * -------------------------------------------------
 * The previous version parsed the docs sidebar out of the static HTML of
 * /overview. That silently missed almost everything: angular.dev renders
 * collapsed nav sections as a <button> with NO child <ul> (Angular expands them
 * lazily in the browser), so a scraper reading the raw HTML sees the section's
 * NAME but none of its pages.
 *
 * The result was a corpus of 23 pages in which Signals, Components, Templates,
 * Directives, Forms, Routing, HTTP and DI - i.e. everything anyone actually asks
 * about - were absent, plus 28 nav entries with no path that rendered in the UI
 * as dead links to /docs?path=undefined.
 *
 * sitemap.xml is the site's own machine-readable index. It needs no JavaScript,
 * cannot silently omit lazily-rendered branches, and is what angular.dev
 * publishes for exactly this purpose.
 *
 * Scope is controlled by SECTION_ALLOWLIST below. Widening or narrowing the
 * corpus is a one-line edit there.
 */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const BASE_URL = 'https://angular.dev';
const SITEMAP_URL = `${BASE_URL}/sitemap.xml`;
const ROOT_DIR = path.resolve(__dirname, '../docs/angular');
const STRUCTURE_PATH = path.join(ROOT_DIR, 'structure.json');

/** Be a polite client: a few parallel requests, with a small pause between batches. */
const CONCURRENCY = 4;
const BATCH_DELAY_MS = 250;

/*
 * Which parts of the docs to index.
 *
 * `prefix` is matched against the start of the URL path. `section` groups pages
 * in the sidebar. Order here is the order shown in the UI.
 *
 * Deliberately excluded: /api (1,119 reference pages - huge, and reference stubs
 * retrieve poorly), /errors, /cli, /reference, and the i18n/aria/animations
 * guides. Add a line to pull any of them in.
 */
const SECTION_ALLOWLIST = [
  { section: 'Getting started', prefix: '/overview', exact: true },
  { section: 'Getting started', prefix: '/installation', exact: true },
  { section: 'Getting started', prefix: '/essentials' },
  { section: 'Signals', prefix: '/guide/signals' },
  { section: 'Components', prefix: '/guide/components' },
  { section: 'Templates', prefix: '/guide/templates' },
  { section: 'Directives', prefix: '/guide/directives' },
  { section: 'Dependency injection', prefix: '/guide/di' },
  { section: 'Forms', prefix: '/guide/forms' },
  { section: 'Routing', prefix: '/guide/routing' },
  { section: 'HTTP client', prefix: '/guide/http' },
  { section: 'Pipes', prefix: '/guide/pipes' },
  { section: 'Best practices', prefix: '/best-practices' },
  { section: 'Style guide', prefix: '/style-guide', exact: true },
];

// ---------------------------------------------------------------------------

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'coursera-rag-docs-fetcher/2.0 (learning project)',
      Accept: 'text/html,application/xhtml+xml,application/xml',
    },
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }

  return await response.text();
}

/** Pull every <loc> out of the sitemap and reduce it to same-origin paths. */
function parseSitemap(xml) {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)]
    .map((match) => match[1])
    .filter((url) => url.startsWith(BASE_URL))
    .map((url) => url.slice(BASE_URL.length).split('#')[0].split('?')[0])
    .map((p) => (p.endsWith('/') && p.length > 1 ? p.slice(0, -1) : p))
    .filter((p) => p.startsWith('/'));
}

/** First allowlist rule matching this path, or null. */
function matchRule(pagePath) {
  return (
    SECTION_ALLOWLIST.find((rule) =>
      rule.exact
        ? pagePath === rule.prefix
        : pagePath === rule.prefix || pagePath.startsWith(`${rule.prefix}/`),
    ) || null
  );
}

/**
 * Extract the readable article from a docs page.
 *
 * <script> and <style> are removed at source. The article body is later injected
 * into the docs viewer via innerHTML with bypassSecurityTrustHtml, so stripping
 * executable content here means the app is never handed any to begin with.
 * Navigation chrome is dropped too, so it doesn't pollute the embeddings with
 * text repeated identically on all 127 pages.
 */
function extractPage(html, pagePath) {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const main = doc.querySelector('main') || doc.body;

  main
    .querySelectorAll(
      'script, style, noscript, nav, aside, adev-secondary-navigation, .docs-toc, docs-breadcrumb, button.docs-copy-source-code',
    )
    .forEach((node) => node.remove());

  const heading = main.querySelector('h1');
  const title = (heading?.textContent || doc.title || pagePath).trim().replace(/\s+/g, ' ');

  /*
   * contentText keeps newlines. That matters: chunking splits on blank lines, so
   * flattening whitespace here would collapse each page into one giant chunk -
   * which is exactly the bug that made the first corpus useless.
   */
  const contentText = (main.textContent || '')
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return {
    title,
    path: pagePath,
    url: `${BASE_URL}${pagePath}`,
    contentHtml: main.innerHTML.trim(),
    contentText,
  };
}

async function savePage(page) {
  const dir = path.join(ROOT_DIR, page.path.slice(1));
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(
    path.join(dir, 'index.json'),
    JSON.stringify(page, null, 2),
    'utf8',
  );
}

/**
 * Build the sidebar tree.
 *
 * Every node carries a real `path`, because a node without one renders as a link
 * to /docs?path=undefined. Section groups are titles only, and the docs
 * component skips any node lacking a path.
 */
function buildStructure(pages) {
  const bySection = new Map();

  for (const rule of SECTION_ALLOWLIST) {
    if (!bySection.has(rule.section)) bySection.set(rule.section, []);
  }

  for (const page of pages) {
    const rule = matchRule(page.path);
    if (!rule) continue;
    bySection.get(rule.section).push({ title: page.title, path: page.path });
  }

  const children = [];
  for (const [section, items] of bySection) {
    if (items.length === 0) continue;
    items.sort((a, b) => a.path.localeCompare(b.path));
    children.push({ title: section, children: items });
  }

  return { title: 'Angular Docs', children };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run() {
  await fs.promises.mkdir(ROOT_DIR, { recursive: true });

  console.log(`Fetching sitemap: ${SITEMAP_URL}`);
  const allPaths = parseSitemap(await fetchText(SITEMAP_URL));
  console.log(`  sitemap lists ${allPaths.length} URLs`);

  const targets = [...new Set(allPaths.filter((p) => matchRule(p)))].sort();
  console.log(`  ${targets.length} match the allowlist\n`);

  const pages = [];
  const failures = [];

  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const batch = targets.slice(i, i + CONCURRENCY);

    await Promise.all(
      batch.map(async (pagePath) => {
        try {
          const page = extractPage(await fetchText(`${BASE_URL}${pagePath}`), pagePath);
          if (!page.contentText) throw new Error('no text extracted');
          await savePage(page);
          pages.push(page);
        } catch (error) {
          failures.push({ pagePath, message: error.message });
        }
      }),
    );

    const done = Math.min(i + CONCURRENCY, targets.length);
    process.stdout.write(`\r  downloaded ${done}/${targets.length}`);
    if (done < targets.length) await sleep(BATCH_DELAY_MS);
  }

  console.log('\n');

  pages.sort((a, b) => a.path.localeCompare(b.path));
  await fs.promises.writeFile(
    STRUCTURE_PATH,
    JSON.stringify(buildStructure(pages), null, 2),
    'utf8',
  );

  const totalChars = pages.reduce((sum, p) => sum + p.contentText.length, 0);
  console.log(`Saved ${pages.length} pages (${(totalChars / 1000).toFixed(0)}k chars of text)`);
  console.log(`Structure written to ${STRUCTURE_PATH}`);

  if (failures.length) {
    console.log(`\n${failures.length} page(s) failed:`);
    for (const f of failures) console.log(`  ${f.pagePath}: ${f.message}`);
  }

  console.log('\nNext: npm run build-embeddings');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
