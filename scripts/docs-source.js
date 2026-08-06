/*
 * Shared plumbing for the docs corpus: where pages come from, how they're
 * parsed, hashed and stored, and how we find out which Angular version we have.
 *
 * Both scripts import from here so the extraction and the allowlist can never
 * drift apart:
 *   scripts/fetch-angular-docs.js  - full rebuild from scratch
 *   scripts/update-docs.js         - incremental update of what changed
 */

const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const { JSDOM } = require('jsdom');

const BASE_URL = 'https://angular.dev';
const SITEMAP_URL = `${BASE_URL}/sitemap.xml`;
const NPM_LATEST_URL = 'https://registry.npmjs.org/@angular/core/latest';
const CHANGELOG_URL = 'https://raw.githubusercontent.com/angular/angular/main/CHANGELOG.md';

const DOCS_ROOT = path.resolve(__dirname, '../docs/angular');
const STRUCTURE_PATH = path.join(DOCS_ROOT, 'structure.json');
const MANIFEST_PATH = path.join(DOCS_ROOT, 'manifest.json');

const CONCURRENCY = 4;
const BATCH_DELAY_MS = 250;

/*
 * Which parts of the docs to index. `prefix` matches the start of the URL path;
 * `section` groups pages in the sidebar; order here is the order shown in the UI.
 *
 * Deliberately excluded: /api (1,119 reference pages, and reference stubs
 * retrieve poorly), /errors, /cli, /reference, plus the i18n, aria and
 * animations guides. Add a line to pull any of them in.
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

/*
 * Maps Angular changelog package names onto the doc sections they plausibly
 * affect. This is a HINT for the human reading the report, not a decision input:
 * a fix(compiler) may touch no documentation at all, and a docs-only correction
 * appears in no changelog. Content hashes remain the ground truth.
 */
const PACKAGE_TO_SECTIONS = {
  core: ['Signals', 'Components', 'Templates', 'Dependency injection'],
  forms: ['Forms'],
  'forms/signals': ['Forms', 'Signals'],
  router: ['Routing'],
  common: ['HTTP client', 'Pipes', 'Templates'],
  http: ['HTTP client'],
  compiler: ['Templates'],
  'compiler-cli': ['Templates'],
  'platform-browser': ['Best practices'],

  // Known packages that map to nothing in this corpus. Listed explicitly so
  // they don't show up as "unmapped" noise on every run.
  docs: [], // handled separately - see DOCS_PACKAGE below
  migrations: [], // codemods, not prose
  animations: [],
  localize: [],
  upgrade: [],
  'language-service': [],
  'language-server': [],
  'platform-server': [],
  'service-worker': [],
  devtools: [],
  bazel: [],
  benchpress: [],
  elements: [],
  'zone.js': [],
};

/*
 * Angular's changelog has its own `docs` section for documentation commits.
 * That is the one changelog signal that speaks directly about prose rather than
 * code, so it is worth calling out separately in the report.
 */
const DOCS_PACKAGE = 'docs';

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'coursera-rag-docs-fetcher/2.1 (learning project)',
      Accept: 'text/html,application/xhtml+xml,application/xml,text/plain',
    },
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }

  return await response.text();
}

/** Every <loc> in the sitemap, reduced to same-origin paths. */
function parseSitemap(xml) {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)]
    .map((m) => m[1])
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

async function listTargetPaths() {
  const all = parseSitemap(await fetchText(SITEMAP_URL));
  return { total: all.length, targets: [...new Set(all.filter(matchRule))].sort() };
}

// ---------------------------------------------------------------------------
// Version discovery
// ---------------------------------------------------------------------------

/**
 * The version angular.dev itself reports.
 *
 * The docs pages carry it in the page chrome (the version selector), which is
 * outside <main> and therefore stripped from what we store - so it has to be
 * read from the raw HTML before extraction.
 */
async function fetchDocsVersion() {
  try {
    const html = await fetchText(`${BASE_URL}/overview`);
    const versions = [...html.matchAll(/v(\d+\.\d+\.\d+)/g)].map((m) => m[1]);
    if (versions.length === 0) return null;

    // Highest wins: the page also links to older release notes.
    return versions.sort(compareSemver).at(-1);
  } catch {
    return null;
  }
}

/** The canonical latest release, straight from the npm registry. */
async function fetchLatestRelease() {
  try {
    return JSON.parse(await fetchText(NPM_LATEST_URL)).version || null;
  } catch {
    return null;
  }
}

/** Numeric semver comparison. Pre-release suffixes sort below their release. */
function compareSemver(a, b) {
  const parse = (v) => {
    const [core, pre] = String(v).split('-');
    const parts = core.split('.').map((n) => Number(n) || 0);
    return { parts, pre: pre || '' };
  };
  const A = parse(a);
  const B = parse(b);

  for (let i = 0; i < 3; i += 1) {
    if ((A.parts[i] || 0) !== (B.parts[i] || 0)) return (A.parts[i] || 0) - (B.parts[i] || 0);
  }
  if (A.pre === B.pre) return 0;
  if (!A.pre) return 1; // a release outranks a pre-release of the same numbers
  if (!B.pre) return -1;
  return A.pre < B.pre ? -1 : 1;
}

/**
 * Parse CHANGELOG.md into releases newer than `sinceVersion`.
 *
 * Format is a series of:
 *   <a name="22.2.0"></a>
 *   # 22.2.0 (2026-07-29)
 *   ### forms
 *   | Commit | Type | Description |
 */
async function fetchChangelogSince(sinceVersion, { includePrerelease = false } = {}) {
  const md = await fetchText(CHANGELOG_URL);
  const blocks = [...md.matchAll(/<a name="([^"]+)"><\/a>\s*\n#\s*([^\n]*)\n([\s\S]*?)(?=<a name="|$)/g)];

  const releases = [];
  for (const [, version, heading, body] of blocks) {
    if (!includePrerelease && /-(next|rc|beta|alpha)/.test(version)) continue;
    if (sinceVersion && compareSemver(version, sinceVersion) <= 0) continue;

    const date = (heading.match(/\(([\d-]+)\)/) || [])[1] || null;
    const packages = {};

    for (const [, name, section] of body.matchAll(/###\s+([^\n]+)\n([\s\S]*?)(?=###\s|$)/g)) {
      const rows = [...section.matchAll(/^\|\s*\[[^\]]+\]\([^)]+\)\s*\|\s*(\w+)\s*\|\s*([^|]+)\|/gm)];
      if (rows.length === 0) continue;
      packages[name.trim()] = rows.map((r) => ({
        type: r[1].trim(),
        description: r[2].trim(),
      }));
    }

    releases.push({ version, date, packages });
  }

  return releases.sort((a, b) => compareSemver(b.version, a.version));
}

/**
 * Doc sections plausibly touched by a set of changelog releases.
 *
 * Also counts commits under the changelog's own `docs` package, which is the
 * only changelog signal that refers to prose rather than code.
 */
function sectionsForReleases(releases) {
  const sections = new Set();
  const unmapped = new Set();
  const docsCommits = [];

  for (const release of releases) {
    for (const [pkg, commits] of Object.entries(release.packages)) {
      if (pkg === DOCS_PACKAGE) {
        docsCommits.push(...commits.map((c) => ({ ...c, version: release.version })));
        continue;
      }
      const mapped = PACKAGE_TO_SECTIONS[pkg];
      if (mapped === undefined) unmapped.add(pkg);
      else mapped.forEach((s) => sections.add(s));
    }
  }

  return {
    sections: [...sections].sort(),
    unmapped: [...unmapped].sort(),
    docsCommits,
  };
}

// ---------------------------------------------------------------------------
// Page extraction and storage
// ---------------------------------------------------------------------------

/**
 * Extract the readable article from a docs page.
 *
 * <script> and <style> are removed at source: the article body is later injected
 * into the docs viewer with bypassSecurityTrustHtml, so stripping executable
 * content here means the app is never handed any. Navigation chrome goes too,
 * or text repeated identically on every page would pollute the embeddings.
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

  const title = (main.querySelector('h1')?.textContent || doc.title || pagePath)
    .trim()
    .replace(/\s+/g, ' ');

  /*
   * contentText keeps newlines. Chunking splits on blank lines, so flattening
   * whitespace here would collapse each page into one giant chunk - the exact
   * bug that made the first corpus useless.
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

/**
 * Fingerprint a page for change detection.
 *
 * Hashes contentText only, deliberately NOT contentHtml, because contentText is
 * exactly what gets embedded. The hash is used to decide whether to spend money
 * re-embedding, so it should track the input to that process and nothing else.
 *
 * If angular.dev restructures its markup - renames a wrapper class, nests a div
 * differently - while the prose stays identical, the resulting vectors would be
 * bit-for-bit the same, so re-embedding would be pure waste. Hashing the HTML
 * would trigger it anyway.
 *
 * (Measured: both hashes are currently stable across repeated fetches, so this
 * is about which signal is CORRECT for the decision, not about the HTML being
 * observably noisy. The docs viewer still gets fresh contentHtml on every
 * update; it just doesn't get a vote on re-embedding.)
 */
function hashContent(page) {
  return crypto.createHash('sha256').update(page.contentText, 'utf8').digest('hex').slice(0, 16);
}

function pageDir(pagePath) {
  return path.join(DOCS_ROOT, pagePath.slice(1));
}

async function savePage(page) {
  await fs.mkdir(pageDir(page.path), { recursive: true });
  await fs.writeFile(
    path.join(pageDir(page.path), 'index.json'),
    JSON.stringify(page, null, 2),
    'utf8',
  );
}

async function deletePage(pagePath) {
  await fs.rm(pageDir(pagePath), { recursive: true, force: true });
}

async function loadLocalPages() {
  const pages = [];

  async function walk(directory) {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name === 'index.json') pages.push(JSON.parse(await fs.readFile(full, 'utf8')));
    }
  }

  await walk(DOCS_ROOT);
  pages.sort((a, b) => a.path.localeCompare(b.path));
  return pages;
}

/**
 * Build the sidebar tree.
 *
 * Every leaf carries a real `path`. A node without one renders in the UI as a
 * link to /docs?path=undefined, which is what produced 28 dead links before.
 */
function buildStructure(pages) {
  const bySection = new Map(SECTION_ALLOWLIST.map((r) => [r.section, []]));

  for (const page of pages) {
    const rule = matchRule(page.path);
    if (rule) bySection.get(rule.section).push({ title: page.title, path: page.path });
  }

  const children = [];
  for (const [section, items] of bySection) {
    if (items.length === 0) continue;
    items.sort((a, b) => a.path.localeCompare(b.path));
    children.push({ title: section, children: items });
  }

  return { title: 'Angular Docs', children };
}

async function writeStructure(pages) {
  await fs.writeFile(STRUCTURE_PATH, JSON.stringify(buildStructure(pages), null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// Manifest: what we have, and when
// ---------------------------------------------------------------------------

async function readManifest() {
  try {
    return JSON.parse(await fs.readFile(MANIFEST_PATH, 'utf8'));
  } catch {
    return null;
  }
}

async function writeManifest(manifest) {
  await fs.writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf8');
}

/** Rebuild manifest page entries from what is on disk. */
function manifestPagesFrom(pages) {
  const entries = {};
  for (const page of pages) {
    entries[page.path] = {
      title: page.title,
      hash: hashContent(page),
      chars: page.contentText.length,
    };
  }
  return entries;
}

// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Fetch and extract many pages with a small concurrency cap. */
async function fetchPages(paths, onProgress) {
  const pages = [];
  const failures = [];

  for (let i = 0; i < paths.length; i += CONCURRENCY) {
    const batch = paths.slice(i, i + CONCURRENCY);

    await Promise.all(
      batch.map(async (pagePath) => {
        try {
          const page = extractPage(await fetchText(`${BASE_URL}${pagePath}`), pagePath);
          if (!page.contentText) throw new Error('no text extracted');
          pages.push(page);
        } catch (error) {
          failures.push({ path: pagePath, message: error.message });
        }
      }),
    );

    if (onProgress) onProgress(Math.min(i + CONCURRENCY, paths.length), paths.length);
    if (i + CONCURRENCY < paths.length) await sleep(BATCH_DELAY_MS);
  }

  pages.sort((a, b) => a.path.localeCompare(b.path));
  return { pages, failures };
}

module.exports = {
  BASE_URL,
  DOCS_ROOT,
  STRUCTURE_PATH,
  MANIFEST_PATH,
  SECTION_ALLOWLIST,
  PACKAGE_TO_SECTIONS,
  DOCS_PACKAGE,
  fetchText,
  parseSitemap,
  matchRule,
  listTargetPaths,
  fetchDocsVersion,
  fetchLatestRelease,
  fetchChangelogSince,
  sectionsForReleases,
  compareSemver,
  extractPage,
  hashContent,
  savePage,
  deletePage,
  loadLocalPages,
  buildStructure,
  writeStructure,
  readManifest,
  writeManifest,
  manifestPagesFrom,
  fetchPages,
};
