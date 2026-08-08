import { Component, ElementRef, computed, effect, inject, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ChatStore } from './chat.store';

/**
 * The docked chat rail.
 *
 * Holds no state of its own - everything lives in ChatStore so the conversation
 * outlives this component and any route change. Placed in app.html as a sibling
 * of <main>, i.e. outside <router-outlet>, so Angular never destroys it.
 */
@Component({
  selector: 'chat-panel',
  standalone: true,
  imports: [FormsModule, RouterLink],
  templateUrl: './chat-panel.component.html',
  styleUrls: ['./chat-panel.component.css'],
})
export class ChatPanelComponent {
  protected readonly store = inject(ChatStore);

  private readonly scroller = viewChild<ElementRef<HTMLElement>>('scroller');

  constructor() {
    // Keep the newest message in view. Reading both signals registers this
    // effect as a dependency of each, so it re-runs on new messages and when a
    // request starts or finishes.
    effect(() => {
      this.store.messages();
      this.store.isLoading();

      const element = this.scroller()?.nativeElement;
      if (element) {
        queueMicrotask(() => {
          element.scrollTop = element.scrollHeight;
        });
      }
    });
  }

  /** Enter sends; Shift+Enter inserts a newline. */
  protected onKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void this.store.send();
    }
  }

  protected askExample(question: string) {
    this.store.draft.set(question);
    void this.store.send(question);
  }

  /** Angular templates cannot iterate a plain object, so flatten it here. */
  protected rankEntries(ranks: Record<string, number>) {
    return Object.entries(ranks).map(([key, value]) => ({ key, value }));
  }

  /** Empty string means "use the server default" rather than a named provider. */
  protected onProviderChange(event: Event) {
    const value = (event.target as HTMLSelectElement).value;
    this.store.selectProvider(value || null);
  }

  protected onStyleChange(event: Event) {
    this.store.selectStyle((event.target as HTMLSelectElement).value);
  }

  /**
   * Describes the selected voice on hover, and says what it does NOT change.
   * Worth stating: a switcher that alters tone invites the assumption that it
   * alters substance too.
   */
  protected readonly styleHint = computed(() => {
    const selected = this.store.styles().find((s) => s.name === this.store.selectedStyle());
    const base = selected ? `${selected.label}: ${selected.description}` : 'How answers are written';
    return `${base}

Changes the wording only - the sources, citations and refusals are identical for every voice.`;
  });

  /** Tooltip text for the unavailable-provider indicator. */
  protected readonly unavailableSummary = computed(() =>
    this.store
      .unavailableProviders()
      .map((p) => `${p.label}: ${p.hint ?? p.kind}`)
      .join('\n'),
  );

  protected readonly examples = [
    'What is a signal?',
    'How do I create a component?',
    'What is dependency injection?',
  ];
}
