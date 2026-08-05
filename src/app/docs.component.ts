import { CommonModule } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { ActivatedRoute, RouterLink } from '@angular/router';

interface DocsTreeNode {
  title: string;
  path: string;
  children?: DocsTreeNode[];
}

interface DocPage {
  title: string;
  path: string;
  url: string;
  contentHtml: string;
}

@Component({
  standalone: true,
  selector: 'docs-page',
  imports: [CommonModule, RouterLink],
  templateUrl: './docs.component.html',
  styleUrls: ['./docs.component.css'],
})
export class DocsComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly sanitizer = inject(DomSanitizer);

  protected readonly structure = signal<DocsTreeNode[] | null>(null);
  protected readonly page = signal<DocPage | null>(null);
  protected readonly pageContent = signal<SafeHtml | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly loading = signal(false);

  constructor() {
    this.loadStructure();
    this.route.queryParamMap.subscribe((params) => {
      const path = params.get('path');
      if (path) {
        this.loadPage(path);
      } else {
        this.page.set(null);
        this.pageContent.set(null);
      }
    });
  }

  private async loadStructure() {
    try {
      const response = await fetch('/api/docs/structure');
      const structure = await response.json();
      this.structure.set(structure.children || []);
    } catch (error) {
      this.error.set('Failed to load docs structure.');
    }
  }

  private async loadPage(path: string) {
    this.loading.set(true);
    this.error.set(null);
    this.pageContent.set(null);

    try {
      const response = await fetch(`/api/docs/page?path=${encodeURIComponent(path)}`);
      if (!response.ok) {
        const body = await response.text();
        throw new Error(body || `Failed to load page ${path}`);
      }
      const page = (await response.json()) as DocPage;
      this.page.set(page);
      this.pageContent.set(this.sanitizer.bypassSecurityTrustHtml(page.contentHtml || ''));
    } catch (error) {
      this.page.set(null);
      this.error.set(error instanceof Error ? error.message : 'Failed to load page.');
    } finally {
      this.loading.set(false);
    }
  }
}
