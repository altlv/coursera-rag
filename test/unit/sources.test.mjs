import { describe, it, expect } from 'vitest';
import { toSources } from '../../server/rag.js';

/*
 * The sources list shown under an answer.
 *
 * Retrieval works in PASSAGES and the reader thinks in PAGES. With maxPerPage: 2,
 * two passages from one document are a completely normal and desirable result -
 * and mapping them straight to links printed the same page twice, which reads as
 * a bug even though retrieval was behaving exactly as designed.
 *
 * The lesson this encodes: a correct pipeline can still produce wrong OUTPUT,
 * because presentation has its own requirements. Nothing upstream was broken.
 */

const passage = (path, title, url = `https://angular.dev${path}`) => ({ path, title, url });

describe('toSources', () => {
  it('lists one entry per page, not per passage', () => {
    const sources = toSources([
      passage('/guide/di', 'Dependency injection in Angular'),
      passage('/guide/di', 'Dependency injection in Angular'),
      passage('/guide/di/providers', 'Defining dependency providers'),
    ]);

    expect(sources).toHaveLength(2);
    expect(sources.map((s) => s.path)).toEqual(['/guide/di', '/guide/di/providers']);
  });

  it('keeps the order of first appearance', () => {
    // Rank order is meaningful - it is the reranked ordering - so the best page
    // must stay at the top rather than being re-sorted by anything else.
    const sources = toSources([
      passage('/b', 'B'),
      passage('/a', 'A'),
      passage('/b', 'B'),
    ]);
    expect(sources.map((s) => s.path)).toEqual(['/b', '/a']);
  });

  it('builds an in-app link and keeps the canonical one', () => {
    const [source] = toSources([passage('/guide/signals', 'Angular Signals')]);
    expect(source.url).toBe('/docs?path=%2Fguide%2Fsignals');
    expect(source.originalUrl).toBe('https://angular.dev/guide/signals');
    expect(source.title).toBe('Angular Signals');
  });

  it('returns nothing for nothing', () => {
    expect(toSources([])).toEqual([]);
    expect(toSources(undefined)).toEqual([]);
  });

  it('ignores a passage with no path rather than emitting a broken link', () => {
    // A link to /docs?path=undefined is worse than one fewer source.
    const sources = toSources([{ title: 'Orphan' }, passage('/a', 'A')]);
    expect(sources.map((s) => s.path)).toEqual(['/a']);
  });
});
