import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';

/*
 * Every CSS custom property a stylesheet uses must be defined somewhere.
 *
 * An undefined custom property is invalid at computed-value time, so the WHOLE
 * declaration is discarded - silently. The build succeeds, every test passes, and
 * the rule simply does not exist.
 *
 * That is not hypothetical: a `max-height: calc(100vh - var(--space-8))` shipped
 * doing nothing, because the spacing scale stops at 6. Nothing caught it, because
 * there was nothing looking.
 *
 * Lives in the node suite rather than beside the components: it reads files off
 * disk and has nothing to do with rendering.
 */

const ROOT = process.cwd();
const GLOBAL_CSS = path.join(ROOT, 'src/styles.css');
const APP_DIR = path.join(ROOT, 'src/app');

const declarationsIn = (css) =>
  new Set([...css.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gim)].map((m) => m[1]));

const global = declarationsIn(fs.readFileSync(GLOBAL_CSS, 'utf8'));

const stylesheets = fs
  .readdirSync(APP_DIR)
  .filter((f) => f.endsWith('.css'))
  .map((f) => ({ name: f, css: fs.readFileSync(path.join(APP_DIR, f), 'utf8') }));

describe('design tokens', () => {
  it('finds the global scale, so the checks below mean something', () => {
    // Guards the guard: if styles.css moves, these tests must fail loudly rather
    // than pass by having nothing to compare against.
    expect(global.size).toBeGreaterThan(10);
    expect(stylesheets.length).toBeGreaterThan(0);
  });

  it('every stylesheet uses only tokens that exist', () => {
    const missing = [];

    for (const { name, css } of stylesheets) {
      const local = declarationsIn(css);
      for (const match of css.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) {
        const token = match[1];
        if (!global.has(token) && !local.has(token)) missing.push(`${name}: ${token}`);
      }
    }

    expect([...new Set(missing)]).toEqual([]);
  });

  it('the global stylesheet does not reference tokens it never defines', () => {
    const css = fs.readFileSync(GLOBAL_CSS, 'utf8');
    const missing = [...css.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)]
      .map((m) => m[1])
      .filter((t) => !global.has(t));
    expect([...new Set(missing)]).toEqual([]);
  });
});
