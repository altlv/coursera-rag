import { Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { DocsService, type DocPage, type DocsIndexItem, type DocsTreeNode } from './docs.service';

@Component({
  standalone: true,
  selector: 'docs-page',
  imports: [RouterLink, FormsModule],
  templateUrl: './docs.component.html',
  styleUrls: ['./docs.component.css'],
})
export class DocsComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly docs = inject(DocsService);

  protected readonly structure = signal<DocsTreeNode[] | null>(null);
  protected readonly page = signal<DocPage | null>(null);
  protected readonly pageContent = signal<SafeHtml | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly loading = signal(false);

  /** Index of everything indexed, shown when no page is selected. */
  protected readonly index = this.docs.index;
  protected readonly filter = signal('');
  protected readonly sortBy = signal<'path' | 'retrievals' | 'passages'>('path');

  constructor() {
    void this.loadStructure();
    void this.docs.loadIndex().catch(() => {
      // Non-fatal: the tree and pages still work without the index.
    });

    /*
     * takeUntilDestroyed: without it this handler outlives the component. Every
     * visit to /docs would leave another live listener writing to dead signals.
     */
    this.route.queryParamMap.pipe(takeUntilDestroyed()).subscribe((params) => {
      const path = params.get('path');
      if (path) void this.loadPage(path);
      else {
        this.page.set(null);
        this.pageContent.set(null);
        this.error.set(null);
      }
    });
  }

  /** Index grouped by section, filtered and sorted. */
  protected readonly sections = computed(() => {
    const data = this.index();
    if (!data) return [];

    const needle = this.filter().trim().toLowerCase();
    const matches = (item: DocsIndexItem) =>
      !needle ||
      item.title.toLowerCase().includes(needle) ||
      item.path.toLowerCase().includes(needle);

    const sort = this.sortBy();
    const grouped = new Map<string, DocsIndexItem[]>();

    for (const item of data.items) {
      if (!matches(item)) continue;
      if (!grouped.has(item.section)) grouped.set(item.section, []);
      grouped.get(item.section)!.push(item);
    }

    return [...grouped.entries()]
      .map(([name, items]) => ({
        name,
        items: [...items].sort((a, b) =>
          sort === 'path' ? a.path.localeCompare(b.path) : b[sort] - a[sort],
        ),
        passages: items.reduce((sum, i) => sum + i.passages, 0),
        retrievals: items.reduce((sum, i) => sum + i.retrievals, 0),
      }))
      .sort((a, b) => (sort === 'path' ? a.name.localeCompare(b.name) : b[sort] - a[sort]));
  });

  /*
   * Usage data needs a floor before it means anything.
   *
   * After ten questions, "100 of 114 pages never retrieved" is arithmetic, not a
   * finding - most pages simply have not had the chance. Reporting it as a problem
   * would invent one. 50 retrievals is a rough floor at which a never-touched page
   * starts to be worth asking about.
   */
  private readonly MIN_RETRIEVALS_FOR_USAGE = 50;

  protected readonly hasEnoughUsageData = computed(
    () => (this.index()?.totalRetrievals ?? 0) >= this.MIN_RETRIEVALS_FOR_USAGE,
  );

  /**
   * Pages never retrieved, once there is enough traffic to mean something.
   *
   * Either genuinely irrelevant content, or relevant content that is unreachable -
   * and the second case is a retrieval bug hiding in plain sight.
   */
  protected readonly neverRetrieved = computed(() => {
    const data = this.index();
    if (!data || !this.hasEnoughUsageData()) return [];
    return data.items.filter((i) => i.retrievals === 0);
  });

  protected setSort(by: 'path' | 'retrievals' | 'passages') {
    this.sortBy.set(by);
  }

  private async loadStructure() {
    try {
      this.structure.set(await this.docs.structure());
    } catch {
      this.error.set('Failed to load docs structure.');
    }
  }

  private async loadPage(path: string) {
    this.loading.set(true);
    this.error.set(null);
    this.pageContent.set(null);

    try {
      const page = await this.docs.page(path);
      this.page.set(page);
      /*
       * Scraped angular.dev markup. <script> and <style> are stripped at scrape
       * time, so nothing executable reaches here - see scripts/docs-source.js.
       */
      this.pageContent.set(this.sanitizer.bypassSecurityTrustHtml(page.contentHtml || ''));
    } catch (error) {
      this.page.set(null);
      this.error.set(error instanceof Error ? error.message : 'Failed to load page.');
    } finally {
      this.loading.set(false);
    }
  }
}
