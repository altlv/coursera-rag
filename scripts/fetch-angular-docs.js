const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const BASE_URL = 'https://angular.dev';
const START_PATH = '/overview';
const ROOT_DIR = path.resolve(__dirname, '../docs/angular');
const STRUCTURE_PATH = path.join(ROOT_DIR, 'structure.json');

async function fetchHtml(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Angular-docs-fetcher/1.0',
      Accept: 'text/html,application/xhtml+xml',
    },
  });

  if (!response.ok) {
    throw new Error(`Request failed for ${url}: ${response.status} ${response.statusText}`);
  }

  return await response.text();
}

function normalizePath(href) {
  if (!href || !href.startsWith('/')) {
    return null;
  }
  const fragments = href.split('#')[0].split('?')[0];
  return fragments.replace(/\/+/g, '/').replace(/\\/g, '/');
}

function getText(node) {
  return node?.textContent?.trim().replace(/\s+/g, ' ') || '';
}

function parseNavItem(li) {
  const link = li.querySelector(':scope > a');
  const button = li.querySelector(':scope > button');
  const header = li.querySelector(':scope > div.docs-secondary-nav-header');
  const childUl = li.querySelector(':scope > ul');

  if (link) {
    const href = normalizePath(link.getAttribute('href'));
    if (!href) return null;
    const title = getText(link.querySelector('.docs-faceted-list-item-text') || link);
    return { title, path: href };
  }

  const titleNode = header || button;
  const title = titleNode ? getText(titleNode.querySelector('.docs-faceted-list-item-text') || titleNode) : null;
  const children = childUl ? parseNavList(childUl) : [];

  if (!title && children.length === 1) {
    return children[0];
  }

  return children.length || title ? { title: title || 'Documentation', children } : null;
}

function parseNavList(ul) {
  return Array.from(ul.children)
    .map((li) => parseNavItem(li))
    .filter(Boolean);
}

function collectPagePaths(tree, pages) {
  if (!tree) return;
  if (tree.path) {
    pages.set(tree.path, { title: tree.title || tree.path, path: tree.path });
  }
  if (tree.children) {
    tree.children.forEach((child) => collectPagePaths(child, pages));
  }
}

async function extractPageContent(pagePath) {
  const url = `${BASE_URL}${pagePath}`;
  const html = await fetchHtml(url);
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  const main = doc.querySelector('main') || doc.body;
  const title = getText(main.querySelector('h1') || doc.querySelector('title')) || pagePath;
  const contentHtml = main.innerHTML.trim();
  const contentText = getText(main);

  return { title, path: pagePath, url, contentHtml, contentText };
}

async function savePage(page) {
  const pageDir = path.join(ROOT_DIR, page.path.slice(1));
  await fs.promises.mkdir(pageDir, { recursive: true });
  const filePath = path.join(pageDir, 'index.json');
  await fs.promises.writeFile(filePath, JSON.stringify(page, null, 2), 'utf8');
  console.log(`Saved ${page.path} -> ${filePath}`);
}

async function run() {
  await fs.promises.mkdir(ROOT_DIR, { recursive: true });
  console.log(`Fetching navigation from ${BASE_URL}${START_PATH}`);

  const overviewHtml = await fetchHtml(`${BASE_URL}${START_PATH}`);
  const dom = new JSDOM(overviewHtml);
  const doc = dom.window.document;

  const nav = doc.querySelector('adev-secondary-navigation') || doc.querySelector('nav');
  if (!nav) {
    throw new Error('Failed to locate the docs navigation element.');
  }

  const topList = nav.querySelector('ul.docs-faceted-list');
  if (!topList) {
    throw new Error('Failed to locate the docs navigation list on the page.');
  }

  const structure = parseNavList(topList);
  const pages = new Map();
  collectPagePaths({ title: 'Angular Docs', children: structure }, pages);
  pages.set(START_PATH, { title: 'What is Angular?', path: START_PATH });

  const uniquePages = [...pages.values()].map((page) => page.path);
  console.log(`Found ${uniquePages.length} pages to download.`);

  const tree = { title: 'Angular Docs', path: START_PATH, children: structure };
  await fs.promises.writeFile(STRUCTURE_PATH, JSON.stringify(tree, null, 2), 'utf8');
  console.log(`Saved docs structure to ${STRUCTURE_PATH}`);

  for (const pagePath of uniquePages) {
    const content = await extractPageContent(pagePath);
    await savePage(content);
  }

  console.log('Angular docs download completed.');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
