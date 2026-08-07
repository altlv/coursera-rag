import { Injectable, signal } from '@angular/core';

export interface DocsTreeNode {
  title: string;
  path?: string;
  children?: DocsTreeNode[];
}

export interface DocPage {
  title: string;
  path: string;
  url: string;
  contentHtml: string;
}

export interface DocsIndexItem {
  title: string;
  path: string;
  /** Canonical angular.dev URL. */
  url: string;
  section: string;
  /** Passages this page contributes to the vector store. */
  passages: number;
  /** Times this page has appeared in a retrieval. */
  retrievals: number;
  chars: number;
}

export interface DocsIndex {
  pageCount: number;
  passageCount: number;
  /** Null when nothing has been logged, so usage columns can be hidden. */
  totalRetrievals: number | null;
  model: string | null;
  items: DocsIndexItem[];
}

/**
 * Docs data, fetched once and cached.
 *
 * The component used to fetch the tree directly on every construction, so every
 * visit to /docs re-requested the whole structure. Root-scoped caching here means
 * one request per session, and the same instance serves the index view.
 *
 * Individual pages are cached too: navigating back to a page already read should
 * not hit the network again.
 */
@Injectable({ providedIn: 'root' })
export class DocsService {
  private structurePromise: Promise<DocsTreeNode[]> | null = null;
  private indexPromise: Promise<DocsIndex> | null = null;
  private readonly pageCache = new Map<string, DocPage>();

  /** Exposed so the index view can render without a second load state. */
  readonly index = signal<DocsIndex | null>(null);

  async structure(): Promise<DocsTreeNode[]> {
    // The promise itself is cached, not just the result, so two concurrent callers
    // share one request rather than racing.
    this.structurePromise ??= fetch('/api/docs/structure')
      .then((response) => {
        if (!response.ok) throw new Error(`Failed to load structure: ${response.status}`);
        return response.json();
      })
      .then((data) => data.children || [])
      .catch((error) => {
        // Clear the cache so a later attempt can retry rather than replaying a
        // rejected promise forever.
        this.structurePromise = null;
        throw error;
      });

    return this.structurePromise;
  }

  async loadIndex(): Promise<DocsIndex> {
    this.indexPromise ??= fetch('/api/docs/list')
      .then((response) => {
        if (!response.ok) throw new Error(`Failed to load index: ${response.status}`);
        return response.json();
      })
      .then((data: DocsIndex) => {
        this.index.set(data);
        return data;
      })
      .catch((error) => {
        this.indexPromise = null;
        throw error;
      });

    return this.indexPromise;
  }

  async page(path: string): Promise<DocPage> {
    const cached = this.pageCache.get(path);
    if (cached) return cached;

    const response = await fetch(`/api/docs/page?path=${encodeURIComponent(path)}`);
    if (!response.ok) {
      throw new Error((await response.text()) || `Failed to load page ${path}`);
    }

    const page = (await response.json()) as DocPage;
    this.pageCache.set(path, page);
    return page;
  }
}
