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
  /** Similarity score, present in vector mode. */
  score?: number;
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
  /** Which retrieval path produced this answer. The server always sends it. */
  mode?: 'vector' | 'lexical';
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
