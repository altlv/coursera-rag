import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { sanitizeElement, ALLOWED_ATTRIBUTES, extractText } from '../../scripts/docs-source.js';

/*
 * HTML sanitisation of scraped documentation.
 *
 * This markup is injected into the docs viewer with bypassSecurityTrustHtml, so
 * anything executable that survives scraping will run in the browser.
 *
 * An audit of the current 114 pages found no live event handlers or javascript:
 * URLs - angular.dev's own XSS examples are escaped inside <code> blocks, so they
 * are inert text. But "the source happens to be safe" is not a defence. One
 * interactive demo upstream, one widened allowlist, or one different corpus, and an
 * onerror= would execute. These tests pin the allowlist so that cannot happen.
 */

const sanitize = (html) => {
  const dom = new JSDOM(`<div id="root">${html}</div>`);
  const root = dom.window.document.getElementById('root');
  const removed = sanitizeElement(root);
  return { html: root.innerHTML, removed, root };
};

describe('sanitizeElement', () => {
  it('removes inline event handlers', () => {
    const { html } = sanitize('<img src="/a.png" onerror="alert(1)" alt="x">');
    expect(html).not.toMatch(/onerror/i);
    // The legitimate attributes survive.
    expect(html).toContain('src="/a.png"');
    expect(html).toContain('alt="x"');
  });

  it('removes every on* handler, not just the ones we thought of', () => {
    // The allowlist means an unanticipated handler is dropped by default rather
    // than needing to be enumerated.
    const { html } = sanitize(
      '<div onclick="x" onmouseover="y" onfocus="z" onanimationstart="w">text</div>',
    );
    expect(html).not.toMatch(/on[a-z]+=/i);
    expect(html).toContain('text');
  });

  it('neutralises javascript: URLs', () => {
    const { html } = sanitize('<a href="javascript:alert(1)">click</a>');
    expect(html).not.toMatch(/javascript:/i);
    // The element and its text stay; only the dangerous attribute goes.
    expect(html).toContain('click');
  });

  it('neutralises data:text/html URLs', () => {
    const { html } = sanitize('<a href="data:text/html;base64,PHNjcmlwdD4=">x</a>');
    expect(html).not.toMatch(/data:text\/html/i);
  });

  it('keeps ordinary links and relative paths', () => {
    const { html } = sanitize(
      '<a href="https://angular.dev/guide">docs</a><a href="/guide/signals">rel</a><a href="#anchor">a</a>',
    );
    expect(html).toContain('https://angular.dev/guide');
    expect(html).toContain('/guide/signals');
    expect(html).toContain('#anchor');
  });

  it('removes script, iframe, object, embed and form entirely', () => {
    const { html } = sanitize(
      '<p>keep</p><script>evil()</script><iframe src="x"></iframe><object></object><embed><form><input></form>',
    );
    expect(html).toContain('keep');
    for (const tag of ['script', 'iframe', 'object', 'embed', 'form', 'input']) {
      expect(html).not.toMatch(new RegExp(`<${tag}`, 'i'));
    }
  });

  it('removes style elements, which can exfiltrate and deface', () => {
    const { html } = sanitize('<style>body{display:none}</style><p>keep</p>');
    expect(html).not.toMatch(/<style/i);
    expect(html).toContain('keep');
  });

  it('drops inline style attributes', () => {
    // Not on the allowlist: style can be used to overlay or hide page content.
    const { html } = sanitize('<p style="position:fixed;inset:0">x</p>');
    expect(html).not.toMatch(/style=/i);
  });

  it('leaves escaped examples untouched, since they are text not markup', () => {
    /*
     * Exactly the case that produced a false positive during the audit. Inside a
     * code block only < and > are escaped, so href="javascript:" appears literally
     * in the source while being inert. Parsing rather than pattern-matching is what
     * tells the difference.
     */
    const escaped = '<code>&lt;img alt="" onerror="..."&gt;</code>';
    const { html, removed } = sanitize(escaped);
    expect(removed).toBe(0);
    expect(html).toContain('onerror');
  });

  it('preserves the structure documentation needs', () => {
    const { html } = sanitize(
      '<h2 id="x">T</h2><pre><code class="language-ts">const a = 1;</code></pre>' +
        '<table><tr><th scope="col" colspan="2">h</th></tr></table><ul><li>i</li></ul>',
    );
    expect(html).toContain('<h2 id="x">');
    expect(html).toContain('class="language-ts"');
    expect(html).toContain('colspan="2"');
    expect(html).toContain('<li>i</li>');
  });

  it('reports how much it removed', () => {
    expect(sanitize('<img onerror="x"><script>y</script>').removed).toBeGreaterThan(0);
    expect(sanitize('<p>clean</p>').removed).toBe(0);
  });

  it('has an allowlist that excludes anything executable', () => {
    for (const risky of ['onerror', 'onclick', 'style', 'srcdoc', 'formaction', 'xlink:href']) {
      expect(ALLOWED_ATTRIBUTES.has(risky)).toBe(false);
    }
  });

  it('pins the exact allowlist, because widening it is a security decision', () => {
    /*
     * LEARN-RAG.md and roadmap.data.ts both quote this list. Pinning it means
     * adding an attribute fails a test - which forces the question "is this one
     * executable?" - rather than quietly making the documentation wrong.
     */
    expect([...ALLOWED_ATTRIBUTES].sort()).toEqual(
      [
        'alt', 'class', 'colspan', 'datetime', 'dir', 'height', 'href', 'id',
        'lang', 'loading', 'rowspan', 'scope', 'src', 'start', 'title', 'type',
        'width',
      ].sort(),
    );
  });
});

/*
 * Text extraction, with code fenced.
 *
 * `main.textContent` cannot distinguish a <pre> from a paragraph, so 1,307 code
 * samples across 103 of 114 pages arrived glued to the prose around them - one ran
 * straight into the following sentence as "...class ParentComponent {}The fix is".
 * Nothing downstream could see where code began or ended.
 */
// fenceCode is opt-in: it is OFF in production, having measured worse. These
// tests cover the capability, so they enable it explicitly.
const extract = (html, opts = { fenceCode: true }) => {
  const dom = new JSDOM(`<main id="m">${html}</main>`);
  return extractText(dom.window.document.getElementById('m'), opts);
};

describe('extractText', () => {
  it('fences a code block so a boundary exists at all', () => {
    const text = extract('<p>Before.</p><pre><code>const a = 1;</code></pre><p>After.</p>');
    expect(text).toMatch(/```/);
    expect(text).toContain('const a = 1;');
  });

  it('separates code from the sentence that follows it', () => {
    // The exact defect: '{}' ran into 'The fix is straightforward'.
    const text = extract('<pre><code>class A {}</code></pre><p>The fix is straightforward.</p>');
    expect(text).not.toContain('class A {}The fix');
  });

  it('preserves indentation, which prose normalisation would destroy', () => {
    const text = extract('<pre><code>class A {\n  method() {\n    return 1;\n  }\n}</code></pre>');
    expect(text).toContain('  method() {');
    expect(text).toContain('    return 1;');
  });

  it('carries the language through from the class attribute', () => {
    // Tells the model whether it is reading TypeScript or a template.
    const text = extract('<pre class="language-ts"><code>const a = 1;</code></pre>');
    expect(text).toContain('```ts');
  });

  it('emits a bare fence when the source gives no language, as angular.dev does', () => {
    /*
     * Measured, not assumed: angular.dev highlights with Shiki, so its class is
     * 'shiki shiki-themes github-light github-dark' and the language is resolved at
     * build time and discarded. Every fence in this corpus is therefore untagged,
     * and the branch above is inert here - worth pinning so nobody reads the
     * feature as working.
     */
    const text = extract(
      '<pre class="shiki shiki-themes github-light github-dark"><code>const a = 1;</code></pre>',
    );
    expect(text).toContain('```\nconst a = 1;');
  });

  it('still collapses whitespace in prose', () => {
    expect(extract('<p>Some     spaced     prose.</p>')).toContain('Some spaced prose.');
  });

  it('keeps the newlines chunking splits on', () => {
    /*
     * Worth being precise about where paragraph breaks come from: textContent does
     * NOT insert one at a block boundary, so '<p>One.</p><p>Two.</p>' with no
     * whitespace between the tags really does yield 'One.Two.'. The breaks in the
     * corpus come from newlines in the served HTML.
     *
     * That makes chunking dependent on how the source happens to be formatted -
     * fragile, but pre-existing and currently true (114 pages yield 1,122 chunks).
     * Fencing code removes the dependency for the part that matters most, since a
     * fence is an explicit boundary rather than an incidental one.
     */
    expect(extract('<p>One.</p>\n<p>Two.</p>')).toMatch(/One\.\s*\n\s*Two\./);
    expect(extract('<p>One.</p><p>Two.</p>')).toBe('One.Two.');
  });

  it('ignores an empty pre rather than emitting a bare fence', () => {
    const text = extract('<p>Text.</p><pre></pre>');
    expect(text).not.toMatch(/```/);
  });

  it('handles several blocks without mixing them up', () => {
    const text = extract(
      '<pre><code>first();</code></pre><p>Then:</p><pre><code>second();</code></pre>',
    );
    expect(text).toContain('first();');
    expect(text).toContain('second();');
    expect((text.match(/```/g) || []).length).toBe(4);
  });
});

describe('code fencing is off by default', () => {
  /*
   * Measured on the held-out set, and rejected:
   *
   *   baseline (no fencing)             hit@1 73%   MRR 0.822
   *   fenced, code blocks atomic        hit@1 53%   MRR 0.700
   *   fenced + lead-in prose at embed   hit@1 60%   MRR 0.733
   *
   * Making a sample atomic turns a large one into a passage of pure code, and
   * 'title + raw TypeScript' has almost no natural-language signal for a question
   * to match. The golden set reported no change at either step, being saturated.
   *
   * Pinned as a test because the default is the decision. A flag flipped without
   * re-running the eval would quietly cost 13 points of hit@1.
   */
  it('leaves code unfenced unless explicitly asked', () => {
    const dom = new JSDOM('<main id="m"><p>Before.</p><pre><code>const a = 1;</code></pre></main>');
    const text = extractText(dom.window.document.getElementById('m'));
    expect(text).not.toMatch(/```/);
    expect(text).toContain('const a = 1;');
  });
});
