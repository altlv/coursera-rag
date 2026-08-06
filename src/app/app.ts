import { Component, inject, signal } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { ChatPanelComponent } from './chat-panel.component';
import { ChatStore } from './chat.store';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, ChatPanelComponent],
  templateUrl: './app.html',
  styleUrls: ['./app.css'],
})
export class App {
  protected readonly title = signal('Angular Docs Wiki Chatbot');

  /** Read by the template so the grid can react to the rail collapsing. */
  protected readonly chat = inject(ChatStore);
}
