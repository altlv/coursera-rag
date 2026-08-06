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
  /** Which retrieval path produced this answer. The server always sends it. */
  mode?: 'vector' | 'lexical';
  /** Token counts for the generation call, when one was made. */
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

@Injectable({ providedIn: 'root' })
export class ChatService {
  async ask(question: string): Promise<ChatResponse> {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ question }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Chat request failed: ${response.status} ${response.statusText} - ${errorBody}`);
    }

    return await response.json();
  }
}
