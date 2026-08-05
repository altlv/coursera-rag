import fs from 'fs/promises';
import path from 'path';
import { describe, it, expect } from 'vitest';

const DOCS_ROOT = path.resolve('docs/angular');
const EMBEDDINGS_FILE = path.join(DOCS_ROOT, 'embeddings.json');

describe('embeddings.json structure', () => {
  it('exists and parses as JSON with expected shape', async () => {
    const stat = await fs.stat(EMBEDDINGS_FILE);
    expect(stat.isFile()).toBe(true);

    const content = await fs.readFile(EMBEDDINGS_FILE, 'utf8');
    const store = JSON.parse(content);

    expect(store).toHaveProperty('createdAt');
    expect(typeof store.createdAt).toBe('string');
    expect(/\d{4}-\d{2}-\d{2}T/.test(store.createdAt)).toBe(true);

    expect(store).toHaveProperty('model');
    expect(typeof store.model).toBe('string');

    expect(store).toHaveProperty('chunkCount');
    expect(typeof store.chunkCount).toBe('number');

    expect(store).toHaveProperty('chunks');
    expect(Array.isArray(store.chunks)).toBe(true);
    expect(store.chunks.length).toBe(store.chunkCount);
    expect(store.chunks.length).toBeGreaterThan(0);

    for (let i = 0; i < Math.min(5, store.chunks.length); i += 1) {
      const chunk = store.chunks[i];
      expect(chunk).toHaveProperty('id');
      expect(typeof chunk.id).toBe('string');
      expect(chunk).toHaveProperty('text');
      expect(typeof chunk.text).toBe('string');
      expect(chunk).toHaveProperty('embedding');
      expect(Array.isArray(chunk.embedding)).toBe(true);
      expect(chunk.embedding.length).toBeGreaterThan(0);
      for (const value of chunk.embedding) {
        expect(typeof value).toBe('number');
        expect(Number.isFinite(value)).toBe(true);
      }
    }
  });
});
