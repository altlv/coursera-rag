import { Injectable } from '@angular/core';

export interface ChatSource {
  title: string;
  /** Doc path within the corpus, e.g. `/guide/signals`. */
  path: string;
  /** In-app route to the local docs viewer, e.g. `/docs?path=/guide/signals`. */
  url: string;
  /**
   * Canonical angular.dev URL. The backend has always returned this; the
   * interface previously omitted it, so the UI silently discarded it.
   */
  originalUrl?: string;
}

export interface ChatRetrieved {
  title: string;
  path: string;
  snippet: string;
  /** Cosine similarity, present in vector mode. */
  score?: number;
  /** Where each retrieval method placed this chunk, e.g. { vector: 5, lexical: 4 }. */
  ranks?: Record<string, number>;
}

/**
 * How much to trust the answer.
 *
 * Composite on purpose. Similarity alone would mislead: "What does CSS stand
 * for?" scores 0.457 while a correct answer scores 0.475, so a score-based badge
 * would rate an unanswerable question as highly as a real one.
 */
export interface ChatConfidence {
  level: 'high' | 'medium' | 'low' | 'none';
  reasons: string[];
  signals: {
    status?: string;
    topScore: number;
    scoreGap: number;
    distinctPages: number;
    citationCount: number;
  };
}

/**
 * How well the docs covered the question.
 *
 *  answered - the passages covered it; the answer is grounded and cited.
 *  partial  - passages were found but none answer it. `sources` are offered as
 *             the closest thing rather than as citations.
 *  refused  - nothing cleared the similarity floor; there is nothing to show.
 */
export type ChatStatus = 'answered' | 'partial' | 'refused';

export interface ChatResponse {
  question: string;
  answer: string;
  sources: ChatSource[];
  retrieved: ChatRetrieved[];
  status?: ChatStatus;
  confidence?: ChatConfidence;
  rewrite?: ChatRewrite | null;
  /** Identifies this answer so a rating can be attached to it. */
  questionId?: string;
  /** Which model wrote this answer. */
  model?: string | null;
  provider?: string | null;
  providerLabel?: string | null;
  /** Which retrieval path produced this answer. The server always sends it. */
  mode?: 'vector' | 'lexical';
  /** Token counts for the generation call, when one was made. */
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

/**
 * One turn of conversation, as sent to the server.
 *
 * `paths` carries the doc pages an answer cited. The rewriter uses those plus the
 * user's own questions, and deliberately NOT the answer prose - so retrieval stays
 * independent of which model is active.
 */
export interface ChatHistoryTurn {
  role: 'user' | 'assistant';
  text: string;
  provider?: string;
  paths?: string[];
}

/** Present only when a follow-up was rewritten before searching. */
export interface ChatRewrite {
  original: string;
  rewritten: string;
}

/** Structured error body sent by /api/chat when generation fails. */
export interface ChatErrorPayload {
  error: string;
  provider?: string;
  errorKind?: string;
  permanent?: boolean;
  detail?: string;
}

/** Error thrown by ask(), carrying enough context for the UI to advise a fix. */
export interface ChatError extends Error {
  provider?: string;
  errorKind?: string;
  permanent?: boolean;
}

export interface ProviderOption {
  name: string;
  label: string;
  model: string;
  /** ok | degraded | unknown for offerable providers; unavailable ones are split out. */
  status?: 'ok' | 'degraded' | 'unknown' | 'unavailable';
  /** Why it is unusable or degraded, safe to show a user. */
  hint?: string;
  kind?: string;
}

export interface ProviderInfo {
  /** Providers worth offering. Permanently failed ones are excluded. */
  available: ProviderOption[];
  /** Configured but unusable, e.g. no credits or a revoked key. */
  unavailable: ProviderOption[];
  active: string | null;
  reason: string;
  embeddings: { provider: string; model: string; switchable: boolean; note: string };
}

@Injectable({ providedIn: 'root' })
export class ChatService {
  /** Which providers have keys configured. Names only - never key values. */
  async providers(): Promise<ProviderInfo> {
    const response = await fetch('/api/providers');
    if (!response.ok) throw new Error(`Failed to load providers: ${response.status}`);
    return await response.json();
  }

  /**
   * Rate an answer. Deliberately fire-and-forget: a failed rating must never
   * interrupt the conversation, and there is nothing useful to tell the user if the
   * log is unavailable.
   */
  async rate(rating: 'up' | 'down', questionId?: string, question?: string): Promise<void> {
    try {
      await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating, questionId, question }),
      });
    } catch {
      // Intentionally ignored.
    }
  }

  async ask(
    question: string,
    provider?: string,
    history: ChatHistoryTurn[] = [],
  ): Promise<ChatResponse> {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      // `provider` is optional; omitting it uses the server's CHAT_PROVIDER.
      body: JSON.stringify({
        question,
        ...(provider ? { provider } : {}),
        ...(history.length ? { history } : {}),
      }),
    });

    if (!response.ok) {
      /*
       * The server sends a structured error: a human-readable `error` plus
       * `provider`, `errorKind` and `permanent`. Surface the readable part and
       * attach the rest, instead of dumping the raw JSON body into a chat bubble.
       */
      let payload: Partial<ChatErrorPayload> | null = null;
      try {
        payload = await response.json();
      } catch {
        // Not JSON - e.g. a proxy error page. Fall through to a generic message.
      }

      const error = new Error(
        payload?.error ||
          (response.status === 502
            ? 'The model provider could not be reached.'
            : `Request failed (${response.status} ${response.statusText}).`),
      ) as ChatError;

      error.provider = payload?.provider;
      error.errorKind = payload?.errorKind;
      error.permanent = payload?.permanent;
      throw error;
    }

    return await response.json();
  }
}
