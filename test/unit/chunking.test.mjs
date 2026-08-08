import { describe, it, expect } from 'vitest';
import { normalizeText, chunkText, splitFencedBlock } from '../../server/rag.js';

/*
 * These tests pin down the bug that made retrieval useless.
 *
 * The original build script did:
 *     normalizeText()  -> replace(/\s+/g, ' ')   // destroys every newline
 *     chunkText()      -> split(/\n{2,}/)        // can now never match
 *
 * so every page collapsed into exactly one chunk (up to 53,547 characters) and
 * the maxChars limit was never enforced. Paragraph structure must survive
 * normalisation for chunking to work at all.
 */

describe('normalizeText', () => {
  it('collapses spaces and tabs but preserves paragraph breaks', () => {
    const input = 'First   para\twith\tspaces.\n\nSecond para.';
    expect(normalizeText(input)).toBe('First para with spaces.\n\nSecond para.');
  });

  it('collapses 3+ newlines down to a single paragraph break', () => {
    expect(normalizeText('a\n\n\n\n\nb')).toBe('a\n\nb');
  });

  it('keeps a single newline as a newline, not a space', () => {
    expect(normalizeText('line one\nline two')).toContain('\n');
  });

  it('does not lowercase (casing matters for display snippets)', () => {
    expect(normalizeText('Angular Signals')).toBe('Angular Signals');
  });

  it('handles null and undefined without throwing', () => {
    expect(normalizeText(null)).toBe('');
    expect(normalizeText(undefined)).toBe('');
  });
});

describe('chunkText', () => {
  it('returns a single chunk for short text', () => {
    const chunks = chunkText('Short paragraph.', 1200, 150);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe('Short paragraph.');
  });

  it('never emits a chunk longer than maxChars (the original bug)', () => {
    // One giant paragraph with no blank lines - the exact shape that used to
    // slip through as a single 53k-character chunk.
    const giant = 'word '.repeat(20_000);
    const chunks = chunkText(giant, 1200, 150);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(1200);
    }
  });

  it('splits a realistic multi-paragraph page into several chunks', () => {
    const page = Array.from({ length: 20 }, (_, i) => `Paragraph ${i} ${'x'.repeat(200)}`).join(
      '\n\n',
    );
    const chunks = chunkText(page, 1200, 150);
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(1200);
    }
  });

  it('packs small paragraphs together rather than one chunk each', () => {
    const page = ['alpha', 'beta', 'gamma', 'delta'].join('\n\n');
    expect(chunkText(page, 1200, 150)).toHaveLength(1);
  });

  it('overlaps consecutive chunks so meaning is not cut at a boundary', () => {
    const giant = 'word '.repeat(2000);
    const chunks = chunkText(giant, 1200, 150);
    expect(chunks.length).toBeGreaterThan(1);
    // The start of chunk N+1 must already appear inside chunk N.
    const head = chunks[1].slice(0, 40);
    expect(chunks[0].includes(head)).toBe(true);
  });

  it('drops empty and whitespace-only input', () => {
    expect(chunkText('', 1200, 150)).toEqual([]);
    expect(chunkText('   \n\n   ', 1200, 150)).toEqual([]);
  });

  it('always makes forward progress (no infinite loop on odd input)', () => {
    // A single unbroken token longer than maxChars has no space to split on.
    const chunks = chunkText('x'.repeat(5000), 1200, 150);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(1200);
    }
  });
});

/*
 * Fenced code blocks.
 *
 * The corpus arrived with 1,307 code samples flattened into surrounding prose -
 * `main.textContent` does not distinguish a <pre> from a paragraph, so a sample ran
 * straight into the next sentence and nothing downstream could see a boundary.
 *
 * Note where the fix lives. "Code-block-aware chunking" sounds like a chunking
 * change, but the boundary was already gone by the time chunking ran: there was
 * nothing to be aware of. The scraper fences code at extraction time; these tests
 * cover what chunking then does with the fences.
 */
describe('normalizeText with fenced code', () => {
  it('preserves indentation inside a fence', () => {
    // The prose collapse would unindent every line, and the indentation IS the
    // structure of a code sample.
    const text = '```ts\nclass A {\n  method() {\n    return 1;\n  }\n}\n```';
    expect(normalizeText(text)).toContain('  method() {');
    expect(normalizeText(text)).toContain('    return 1;');
  });

  it('still collapses whitespace in the prose around a fence', () => {
    const out = normalizeText('Some     prose.\n\n```ts\nconst  a = 1;\n```\n\nMore     prose.');
    expect(out).toContain('Some prose.');
    expect(out).toContain('More prose.');
    // Inside the fence, the double space survives.
    expect(out).toContain('const  a = 1;');
  });

  it('strips trailing whitespace inside a fence but keeps leading', () => {
    const out = normalizeText('```ts\n  const a = 1;   \n```');
    expect(out).toContain('  const a = 1;');
    expect(out).not.toContain('1;   ');
  });
});

describe('chunkText with fenced code', () => {
  it('keeps a code block whole even though it contains blank lines', () => {
    /*
     * The defect this fixes. A blank line inside a sample is not a paragraph
     * break, but the splitter could not tell - so an 80-line example became two
     * passages each holding an incomplete sample.
     */
    const code = '```ts\nconst a = 1;\n\nconst b = 2;\n\nconst c = 3;\n```';
    const chunks = chunkText(`Intro paragraph.\n\n${code}\n\nClosing paragraph.`, 1200, 150);
    const holding = chunks.filter((c) => c.includes('const a = 1;'));
    expect(holding).toHaveLength(1);
    expect(holding[0]).toContain('const c = 3;');
  });

  it('never emits a chunk with an unbalanced fence', () => {
    // An odd number of fence markers means a sample was cut in half.
    const code = '```ts\n' + Array.from({ length: 40 }, (_, i) => `const v${i} = ${i};`).join('\n') + '\n```';
    for (const chunk of chunkText(`Lead in.\n\n${code}\n\nAfter.`, 1200, 150)) {
      expect((chunk.match(/```/g) || []).length % 2).toBe(0);
    }
  });

  it('divides an oversized block at line boundaries, re-fencing each part', () => {
    const body = Array.from({ length: 200 }, (_, i) => `const value${i} = ${i};`).join('\n');
    const chunks = chunkText('```ts\n' + body + '\n```', 1200, 150);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect((chunk.match(/```/g) || []).length % 2).toBe(0);
      // No line was cut mid-statement.
      for (const line of chunk.split('\n')) {
        if (line.startsWith('const value')) expect(line).toMatch(/;$/);
      }
    }
  });

  it('carries the language tag onto every part of a divided block', () => {
    // Losing it on later parts would leave the model guessing at the language.
    const body = Array.from({ length: 200 }, (_, i) => `const value${i} = ${i};`).join('\n');
    for (const part of splitFencedBlock('```ts\n' + body + '\n```', 600)) {
      expect(part.startsWith('```ts')).toBe(true);
      expect(part.endsWith('```')).toBe(true);
    }
  });

  it('leaves prose-only text behaving exactly as before', () => {
    // The fence path must not change the no-code case, which is most of the corpus.
    const prose = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.';
    expect(chunkText(prose, 1200, 150)).toEqual(['First paragraph.\n\nSecond paragraph.\n\nThird paragraph.']);
  });

  it('handles an unterminated fence without hanging or losing the text', () => {
    // Malformed input from a scrape must degrade, not throw.
    const chunks = chunkText('Intro.\n\n```ts\nconst a = 1;', 1200, 150);
    expect(chunks.join('\n')).toContain('const a = 1;');
  });
});
