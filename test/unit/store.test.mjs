import fs from 'fs/promises';
import path from 'path';
import { describe, it, expect, beforeAll } from 'vitest';
import { dotProduct } from '../../server/rag.js';

/*
 * Validates the generated vector store.
 *
 * Replaces the old embeddings.test.mjs, which asserted the shape of a single
 * embeddings.json holding full float arrays. That format is gone: metadata now
 * lives in chunks.json and the vectors in raw Float32 in vectors.bin.
 *
 * The store is a build artifact and is gitignored, so these tests SKIP when it
 * is absent rather than failing. A fresh clone should be able to run the suite
 * before spending anything on embeddings. They still run in full locally and
 * after any `npm run build-embeddings`.
 */

const DOCS_ROOT = path.resolve('docs/angular');
const CHUNKS_FILE = path.join(DOCS_ROOT, 'chunks.json');
const VECTORS_FILE = path.join(DOCS_ROOT, 'vectors.bin');

const exists = async (file) =>
  await fs
    .stat(file)
    .then(() => true)
    .catch(() => false);

let meta = null;
let vectors = null;
let available = false;

beforeAll(async () => {
  available = (await exists(CHUNKS_FILE)) && (await exists(VECTORS_FILE));
  if (!available) return;

  meta = JSON.parse(await fs.readFile(CHUNKS_FILE, 'utf8'));
  const buffer = await fs.readFile(VECTORS_FILE);
  vectors = new Float32Array(
    buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  );
});

describe('vector store', () => {
  it('has the expected metadata', () => {
    if (!available) return;
    expect(typeof meta.model).toBe('string');
    expect(meta.dimensions).toBeGreaterThan(0);
    expect(meta.chunkCount).toBe(meta.chunks.length);
    expect(meta.chunks.length).toBeGreaterThan(0);
    expect(/\d{4}-\d{2}-\d{2}T/.test(meta.createdAt)).toBe(true);
  });

  it('vectors.bin length matches chunks x dimensions exactly', () => {
    if (!available) return;
    // A mismatch would still "work" and silently return nonsense, because chunk
    // i is read at offset i*dims. It has to be an error, not a surprise.
    expect(vectors.length).toBe(meta.chunks.length * meta.dimensions);
  });

  it('every chunk carries the metadata retrieval and citation need', () => {
    if (!available) return;
    for (const chunk of meta.chunks) {
      expect(typeof chunk.id).toBe('string');
      expect(typeof chunk.title).toBe('string');
      expect(chunk.path.startsWith('/')).toBe(true);
      expect(chunk.url).toContain('angular.dev');
      expect(chunk.text.length).toBeGreaterThan(0);
    }
  });

  it('respects the configured chunk size (the bug that made retrieval useless)', () => {
    if (!available) return;
    // Chunks used to reach 53,547 characters because the size limit was never
    // enforced. Allow a little slack for the trailing-word boundary.
    const longest = Math.max(...meta.chunks.map((c) => c.text.length));
    expect(longest).toBeLessThanOrEqual(meta.chunkChars + 100);
  });

  it('holds only finite numbers', () => {
    if (!available) return;
    for (let i = 0; i < vectors.length; i += 1) {
      if (!Number.isFinite(vectors[i])) {
        throw new Error(`non-finite value at index ${i}`);
      }
    }
  });

  it('stores unit-normalised vectors, which is what makes a dot product valid', () => {
    if (!available) return;
    const dims = meta.dimensions;
    // Sample rather than check all ~1,100; a build error would affect every row.
    for (const i of [0, 1, Math.floor(meta.chunks.length / 2), meta.chunks.length - 1]) {
      const row = vectors.subarray(i * dims, (i + 1) * dims);
      // A unit vector dotted with itself is 1. Float32 gives ~7 digits.
      expect(dotProduct(row, row)).toBeCloseTo(1, 5);
    }
  });

  it('covers the core guide sections, so real questions have somewhere to land', () => {
    if (!available) return;
    const paths = meta.chunks.map((c) => c.path);
    for (const section of [
      '/guide/signals',
      '/guide/components',
      '/guide/templates',
      '/guide/forms',
      '/guide/routing',
      '/guide/http',
      '/guide/di',
    ]) {
      expect(
        paths.some((p) => p.startsWith(section)),
        `no chunks found under ${section}`,
      ).toBe(true);
    }
  });
});
