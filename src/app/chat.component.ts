import { CommonModule } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ChatService } from './chat.service';

interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  sources?: string[];
}

@Component({
  standalone: true,
  selector: 'chat-page',
  imports: [CommonModule, FormsModule],
  templateUrl: './chat.component.html',
  styleUrls: ['./chat.component.css'],
})
export class ChatComponent {
  private readonly chatService = inject(ChatService);
  protected readonly messages = signal<ChatMessage[]>([
    {
      role: 'assistant',
      text: 'Welcome! What do you want to learn about Angular?',
    },
  ]);

  protected question = '';
  protected isLoading = signal(false);

  protected async sendQuestion() {
    const trimmed = this.question.trim();
    if (!trimmed || this.isLoading()) {
      return;
    }

    const currentMessages = [...this.messages()] as ChatMessage[];
    currentMessages.push({ role: 'user', text: trimmed });
    this.messages.set(currentMessages);
    this.question = '';
    this.isLoading.set(true);

    try {
      const response = await this.chatService.ask(trimmed);
      const assistantMessage: ChatMessage = {
        role: 'assistant',
        text: response.answer,
        sources: response.sources.map((source) => `${source.title} (${source.path})`),
      };
      this.messages.update((list) => [...list, assistantMessage]);
    } catch (error) {
      this.messages.update((list) => [
        ...list,
        {
          role: 'assistant',
          text: error instanceof Error ? error.message : 'Failed to get a response from the backend.',
          sources: ['Backend error'],
        },
      ]);
    } finally {
      this.isLoading.set(false);
    }
  }
}
