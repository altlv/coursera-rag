import { Component, ElementRef, effect, inject, viewChild } from '@angular/core';
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

  protected readonly examples = [
    'What is a signal?',
    'How do I create a component?',
    'What is dependency injection?',
  ];
}
