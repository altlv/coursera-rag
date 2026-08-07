import { Injectable, computed, inject, signal } from '@angular/core';
import {
  ChatService,
  type ChatConfidence,
  type ChatError,
  type ChatHistoryTurn,
  type ChatRetrieved,
  type ChatRewrite,
  type ChatStatus,
  type ProviderOption,
} from './chat.service';

/**
 * Six turns, i.e. three exchanges.
 *
 * A deliberate choice rather than a placeholder: it covers the follow-ups this
 * assistant actually receives - "explain that more simply", "show me an example",
 * "are you sure?" - all of which refer to the immediately preceding answer.
 *
 * Older context is not lost, because query rewriting folds it into the standalone
 * question. Passing the whole conversation instead would make every question
 * steadily more expensive and eventually overflow the context window, to serve
 * follow-up types a documentation assistant rarely sees. Keep in sync with
 * HISTORY_EXCHANGES in server/rag.js.
 */
const HISTORY_TURNS = 6;

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
  /** Set when the question was rewritten before searching, so the UI can show it. */
  rewrite?: ChatRewrite | null;
  /**
   * Which model wrote this. Recorded PER MESSAGE, not just globally, because the
   * provider can be switched mid-conversation - so a single thread can contain
   * answers from several models, and it matters which said what.
   */
  provider?: string;
  providerLabel?: string;
  model?: string;
  isError?: boolean;
  /** Set when logging is on, so this answer can be rated. */
  questionId?: string;
  /** The user's verdict, once given. Kept so the UI can show it was recorded. */
  rating?: 'up' | 'down';
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

  /**
   * Record a verdict on one answer.
   *
   * The rating is stored on the message immediately rather than after the request
   * resolves, so the button responds at once. There is nothing useful to do if the
   * write fails, and rating is not worth blocking the UI on.
   */
  rate(index: number, rating: 'up' | 'down') {
    const message = this.messages()[index];
    if (!message || message.role !== 'assistant') return;

    this.messages.update((list) =>
      list.map((m, i) => (i === index ? { ...m, rating } : m)),
    );
    void this.chatService.rate(rating, message.questionId, this.questionFor(index));
  }

  /** The user question an assistant message was answering. */
  private questionFor(assistantIndex: number): string | undefined {
    const list = this.messages();
    for (let i = assistantIndex - 1; i >= 0; i -= 1) {
      if (list[i].role === 'user') return list[i].text;
    }
    return undefined;
  }

  /**
   * The conversation as the server needs it.
   *
   * Trimmed to the last HISTORY_TURNS and stripped of UI-only fields. Each
   * assistant turn carries the provider that wrote it - so a model reading a
   * different model's answer is told as much rather than inheriting it - and the
   * doc paths it cited, which is what the query rewriter uses.
   *
   * The seeded welcome message is excluded: it is UI furniture, not conversation,
   * and would otherwise be the "earlier question" a first follow-up resolves
   * against.
   */
  private historyForRequest(): ChatHistoryTurn[] {
    return this.messages()
      .filter((message) => !(message.role === 'assistant' && !message.status))
      .slice(-HISTORY_TURNS)
      .map((message) => ({
        role: message.role,
        text: message.text,
        ...(message.provider ? { provider: message.provider } : {}),
        ...(message.sources?.length ? { paths: message.sources.map((s) => s.path) } : {}),
      }));
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
      const response = await this.chatService.ask(
        text,
        this.selectedProvider() ?? undefined,
        this.historyForRequest(),
      );
      this.messages.update((list) => [
        ...list,
        {
          role: 'assistant',
          text: response.answer,
          status: response.status ?? 'answered',
          confidence: response.confidence,
          rewrite: response.rewrite,
          questionId: response.questionId,
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
