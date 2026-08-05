import { Injectable } from '@angular/core';

export interface ChatSource {
  title: string;
  path: string;
  url: string;
}

export interface ChatRetrieved {
  title: string;
  path: string;
  snippet: string;
}

export interface ChatResponse {
  question: string;
  answer: string;
  sources: ChatSource[];
  retrieved: ChatRetrieved[];
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
