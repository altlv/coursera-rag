import { Injectable, computed, inject, signal } from '@angular/core';
import {
  ChatService,
  type ChatConfidence,
  type ChatError,
  type ChatRetrieved,
  type ChatStatus,
  type ProviderOption,
} from './chat.service';

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
  confidence?: ChatConfidence;
  /** Retrieval trace, shown in the collapsible "how this was built" panel. */
  retrieved?: ChatRetrieved[];
  promptTokens?: number;
  /**
   * Which model wrote this. Recorded PER MESSAGE, not just globally, because the
   * provider can be switched mid-conversation - so a single thread can contain
   * answers from several models, and it matters which said what.
   */
  provider?: string;
  providerLabel?: string;
  model?: string;
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

  /*
   * Which providers are configured, and which one the user picked.
   *
   * `selectedProvider` is null until the user actively chooses, so the server's
   * CHAT_PROVIDER stays authoritative by default rather than the UI silently
   * pinning whatever happened to load first.
   */
  readonly providers = signal<ProviderOption[]>([]);
  readonly unavailableProviders = signal<ProviderOption[]>([]);
  readonly selectedProvider = signal<string | null>(null);
  readonly activeProvider = signal<string | null>(null);

  constructor() {
    void this.loadProviders();
  }

  /** Only worth showing a switcher when there is more than one real choice. */
  readonly canSwitchProvider = computed(() => this.providers().length > 1);

  async loadProviders() {
    try {
      const info = await this.chatService.providers();
      this.providers.set(info.available);
      this.unavailableProviders.set(info.unavailable ?? []);
      this.activeProvider.set(info.active);

      // If the selected provider has since been demoted, fall back to the
      // server default rather than repeatedly sending questions to a dead one.
      const selected = this.selectedProvider();
      if (selected && !info.available.some((p) => p.name === selected)) {
        this.selectedProvider.set(null);
      }
    } catch {
      // Non-fatal: the switcher simply doesn't render, and the server's own
      // default still answers every question.
      this.providers.set([]);
    }
  }

  selectProvider(name: string | null) {
    this.selectedProvider.set(name);
  }

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
      const response = await this.chatService.ask(text, this.selectedProvider() ?? undefined);
      this.messages.update((list) => [
        ...list,
        {
          role: 'assistant',
          text: response.answer,
          status: response.status ?? 'answered',
          confidence: response.confidence,
          retrieved: response.retrieved,
          promptTokens: response.usage?.prompt_tokens,
          provider: response.provider ?? undefined,
          providerLabel: response.providerLabel ?? undefined,
          model: response.model ?? undefined,
          sources: response.sources.map((source) => ({
            title: source.title,
            path: source.path,
            originalUrl: source.originalUrl,
          })),
        },
      ]);
    } catch (error) {
      /*
       * Turn a provider failure into something actionable.
       *
       * A transient failure (rate limit) is worth retrying or routing elsewhere;
       * a permanent one (no credits, revoked key) needs configuration. Saying
       * which, and what to do, beats echoing a status line.
       */
      const chatError = error as ChatError;
      let text =
        chatError?.message || 'Failed to reach the backend. Is it running on port 3000?';

      if (chatError?.errorKind === 'rate-limit') {
        text += this.canSwitchProvider()
          ? ' You can pick another provider above, or wait a moment and retry.'
          : ' Wait a moment and try again.';
      } else if (chatError?.permanent && this.canSwitchProvider()) {
        text += ' Pick another provider above.';
      }

      this.messages.update((list) => [
        ...list,
        { role: 'assistant', text, isError: true },
      ]);

      /*
       * Re-check health after a failure. If the provider failed permanently -
       * out of credits, revoked key - the server has now demoted it, so this
       * removes it from the switcher instead of letting the user pick it again.
       */
      void this.loadProviders();
    } finally {
      this.isLoading.set(false);
    }
  }
}
