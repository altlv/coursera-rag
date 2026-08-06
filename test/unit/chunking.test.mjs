import { describe, it, expect } from 'vitest';
import { normalizeText, chunkText } from '../../server/rag.js';

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
