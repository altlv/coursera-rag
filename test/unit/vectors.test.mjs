import { describe, it, expect } from 'vitest';
import { dotProduct, normalizeVector, cosineSimilarity, selectChunks } from '../../server/rag.js';

/*
 * Why a dot product instead of cosine similarity at query time:
 *
 * cosine(a,b) = dot(a,b) / (|a| * |b|)
 *
 * If both vectors are already unit length then |a| = |b| = 1, so cosine
 * collapses to dot(a,b). We normalise once at build time, which removes two
 * square roots and 2N multiplications from every single comparison. The old
 * code recomputed both magnitudes on every chunk, every query.
 */

/*
 * Precision note: vectors are stored as Float32Array, which carries about 7
 * decimal digits. That is deliberate - it halves memory versus Float64 and the
 * loss is far below anything that affects ranking. So these assertions use 6
 * decimal places; asserting 10 would be testing IEEE-754 rather than our code.
 */
const FLOAT32_PRECISION = 6;

describe('normalizeVector', () => {
  it('produces a unit-length vector', () => {
    const v = normalizeVector([3, 4]); // magnitude 5
    expect(v[0]).toBeCloseTo(0.6, FLOAT32_PRECISION);
    expect(v[1]).toBeCloseTo(0.8, FLOAT32_PRECISION);
    const magnitude = Math.hypot(...v);
    expect(magnitude).toBeCloseTo(1, FLOAT32_PRECISION);
  });

  it('leaves an already-normalised vector unchanged', () => {
    const v = normalizeVector([1, 0, 0]);
    expect(Array.from(v)).toEqual([1, 0, 0]);
  });

  it('returns zeros for a zero vector instead of dividing by zero', () => {
    const v = normalizeVector([0, 0, 0]);
    expect(Array.from(v)).toEqual([0, 0, 0]);
    expect(v.every(Number.isFinite)).toBe(true);
  });
});

describe('dotProduct', () => {
  it('computes the dot product', () => {
    expect(dotProduct([1, 2, 3], [4, 5, 6])).toBe(32);
  });

  it('is 1.0 for a unit vector against itself', () => {
    const v = normalizeVector([0.3, 0.9, 0.1, 0.4]);
    expect(dotProduct(v, v)).toBeCloseTo(1, FLOAT32_PRECISION);
  });

  it('is 0 for orthogonal vectors', () => {
    expect(dotProduct([1, 0], [0, 1])).toBe(0);
  });

  it('is negative for opposing vectors', () => {
    expect(dotProduct([1, 0], [-1, 0])).toBe(-1);
  });

  it('equals cosineSimilarity when both inputs are normalised', () => {
    const a = normalizeVector([0.2, 0.5, 0.9]);
    const b = normalizeVector([0.7, 0.1, 0.3]);
    expect(dotProduct(a, b)).toBeCloseTo(cosineSimilarity(a, b), FLOAT32_PRECISION);
  });

  it('works across Array and Float32Array', () => {
    const a = new Float32Array([1, 2, 3]);
    expect(dotProduct(a, [4, 5, 6])).toBeCloseTo(32, 5);
  });
});

describe('selectChunks', () => {
  // Three orthogonal unit vectors make the expected ranking unambiguous.
  const store = {
    dimensions: 3,
    chunks: [
      { id: 'a#1', title: 'A', path: '/a', text: 'alpha' },
      { id: 'b#1', title: 'B', path: '/b', text: 'beta' },
      { id: 'c#1', title: 'C', path: '/c', text: 'gamma' },
    ],
    vectors: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
  };

  it('ranks by similarity, best first', () => {
    // Closest to chunk B, then A.
    const query = normalizeVector([0.4, 0.9, 0]);
    const results = selectChunks(query, store, { k: 3, floor: 0 });
    expect(results.map((r) => r.path)).toEqual(['/b', '/a', '/c']);
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it('respects k', () => {
    const query = normalizeVector([1, 0, 0]);
    expect(selectChunks(query, store, { k: 2, floor: 0 })).toHaveLength(2);
  });

  it('drops chunks below the score floor', () => {
    const query = normalizeVector([1, 0, 0]);
    const results = selectChunks(query, store, { k: 3, floor: 0.5 });
    expect(results).toHaveLength(1);
    expect(results[0].path).toBe('/a');
  });

  it('returns nothing when everything is below the floor (off-topic question)', () => {
    // Equidistant from all three basis vectors, so every score is 1/sqrt(3)
    // (about 0.577). A floor of 0.9 is above that, so nothing qualifies - which
    // is how an off-topic question earns an honest "not in these docs".
    const query = normalizeVector([1, 1, 1]);
    const results = selectChunks(query, store, { k: 3, floor: 0.9 });
    expect(results).toEqual([]);

    // Sanity check that the same query does match with a permissive floor,
    // proving the empty result came from the floor and not a broken query.
    expect(selectChunks(query, store, { k: 3, floor: 0 })).toHaveLength(3);
  });

  it('attaches the score and preserves chunk metadata', () => {
    const query = normalizeVector([1, 0, 0]);
    const [top] = selectChunks(query, store, { k: 1, floor: 0 });
    expect(top).toMatchObject({ id: 'a#1', title: 'A', path: '/a', text: 'alpha' });
    expect(top.score).toBeCloseTo(1, 6);
  });

  it('returns an empty array for an empty store', () => {
    const empty = { dimensions: 3, chunks: [], vectors: new Float32Array() };
    expect(selectChunks([1, 0, 0], empty, { k: 5, floor: 0 })).toEqual([]);
  });
});
