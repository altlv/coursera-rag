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

export interface ChatResponse {
  question: string;
  answer: string;
  sources: ChatSource[];
  retrieved: ChatRetrieved[];
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
