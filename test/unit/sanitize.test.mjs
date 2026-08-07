import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { sanitizeElement, ALLOWED_ATTRIBUTES } from '../../scripts/docs-source.js';

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
