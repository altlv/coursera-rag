import { Injectable, computed, inject, signal } from '@angular/core';
import { ChatService, type ChatStatus } from './chat.service';

export interface ChatMessageSource {
  title: string;
  /** Doc path within the corpus, e.g. `/guide/signals`. Drives the in-app link. */
  path: string;
  /** Canonical angular.dev URL, when the backend supplies one. */
  originalUrl?: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  sources?: ChatMessageSource[];
  /** See ChatStatus: shapes how sources are labelled. */
  status?: ChatStatus;
  isError?: boolean;
}

const WELCOME: ChatMessage = {
  role: 'assistant',
  text: 'Ask me anything about Angular. I answer from a local copy of the Angular docs and cite the pages I used.',
};

/**
 * Conversation state, held at root scope.
 *
 * This is the whole reason the chat survives navigation. Previously `messages`
 * lived in ChatComponent, so Angular destroyed it whenever the route changed and
 * the conversation vanished. A root-provided service is created once for the
 * application's lifetime, and the panel that renders it sits outside
 * <router-outlet> - so neither the state nor the DOM is torn down on navigation.
 */
@Injectable({ providedIn: 'root' })
export class ChatStore {
  private readonly chatService = inject(ChatService);

  readonly messages = signal<ChatMessage[]>([WELCOME]);
  readonly isLoading = signal(false);

  /** Rail expanded or collapsed. Also persists across navigation. */
  readonly isOpen = signal(true);

  /** In-progress textarea content, so a half-typed question isn't lost either. */
  readonly draft = signal('');

  /** Excludes the seeded welcome message, so the UI can tell "fresh" from "used". */
  readonly hasConversation = computed(
    () => this.messages().some((m) => m.role === 'user'),
  );

  readonly messageCount = computed(() => this.messages().filter((m) => m.role === 'user').length);

  toggle() {
    this.isOpen.update((open) => !open);
  }

  open() {
    this.isOpen.set(true);
  }

  reset() {
    this.messages.set([WELCOME]);
    this.draft.set('');
  }

  async send(question?: string) {
    const text = (question ?? this.draft()).trim();
    if (!text || this.isLoading()) {
      return;
    }

    this.messages.update((list) => [...list, { role: 'user', text }]);
    this.draft.set('');
    this.isLoading.set(true);

    try {
      const response = await this.chatService.ask(text);
      this.messages.update((list) => [
        ...list,
        {
          role: 'assistant',
          text: response.answer,
          status: response.status ?? 'answered',
          sources: response.sources.map((source) => ({
            title: source.title,
            path: source.path,
            originalUrl: source.originalUrl,
          })),
        },
      ]);
    } catch (error) {
      this.messages.update((list) => [
        ...list,
        {
          role: 'assistant',
          text:
            error instanceof Error
              ? error.message
              : 'Failed to reach the backend. Is it running on port 3000?',
          isError: true,
        },
      ]);
    } finally {
      this.isLoading.set(false);
    }
  }
}
