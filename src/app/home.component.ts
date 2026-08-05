import { CommonModule } from '@angular/common';
import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';

interface ProgressTask {
  title: string;
  detail: string;
  status: 'not started' | 'in progress' | 'done';
}

@Component({
  standalone: true,
  selector: 'home-page',
  imports: [CommonModule, RouterLink],
  templateUrl: './home.component.html',
  styleUrls: ['./home.component.css'],
})
export class HomeComponent {
  protected readonly tasks: ProgressTask[] = [
    {
      title: 'Create introduction page',
      detail: 'Explain the Angular wiki chatbot project and RAG workflow.',
      status: 'done',
    },
    {
      title: 'Build the chat interactions page',
      detail: 'Add a separate page for asking questions and showing answers.',
      status: 'done',
    },
    {
      title: 'Implement chat UI and local conversation state',
      detail: 'Wire the chat page to accept questions, render message history, and show sources.',
      status: 'done',
    },
    {
      title: 'Design and implement backend (Fastify)',
      detail: 'Create a Fastify API that serves docs structure and exposes a /api/chat endpoint.',
      status: 'done',
    },
    {
      title: 'Download and store Angular docs locally',
      detail: 'Scrape the docs sidebar and save per-page JSON under docs/angular/ (structure.json + page files).',
      status: 'done',
    },
    {
      title: 'Implement basic retrieval search (lexical)',
      detail: 'Simple lexical search over normalized text to return relevant pages and snippets.',
      status: 'done',
    },
    {
      title: 'Add frontend service to call backend',
      detail: 'ChatService to POST questions to /api/chat and display responses in the UI.',
      status: 'done',
    },
    {
      title: 'Create dev scripts',
      detail: 'npm scripts to download docs, start backend, and run the frontend.',
      status: 'done',
    },
    {
      title: 'Build embeddings & vector store (RAG)',
      detail: 'Add the embedding builder and local vector store support for retrieval-augmented answers.',
      status: 'in progress',
    },
    {
      title: 'Add backend vector retrieval support',
      detail: 'Load embeddings and use vector similarity search with a fallback to lexical search when needed.',
      status: 'done',
    },
    {
      title: 'Integrate LLM prompt + RAG flow',
      detail: 'Assemble prompt with retrieved chunks and call an LLM for final answer (with citations).',
      status: 'not started',
    },
    {
      title: 'Prompt engineering and citation formatting',
      detail: 'Improve prompts to prefer citing exact doc snippets and return source references.',
      status: 'not started',
    },
    {
      title: 'Add unit/integration tests and CI',
      detail: 'Tests for backend endpoints, chat service, and critical UI flows. Add CI (GitHub Actions).',
      status: 'not started',
    },
    {
      title: 'Prepare deployment',
      detail: 'Decide hosting for backend and frontend, containerize, and provide deployment steps.',
      status: 'not started',
    },
    {
      title: 'Write comprehensive README and developer guide',
      detail: 'Document architecture, how to run the project, and next steps for RAG integration.',
      status: 'done',
    },
    {
      title: 'Commit progress and tag milestone',
      detail: 'Create a git repo (if not present), commit the current working state, and tag v0.1-prototype.',
      status: 'done',
    },
  ];

  protected readonly statusStages: ProgressTask['status'][] = ['not started', 'in progress', 'done'];

  protected cycleStatus(task: ProgressTask) {
    const nextIndex = (this.statusStages.indexOf(task.status) + 1) % this.statusStages.length;
    task.status = this.statusStages[nextIndex];
  }
}
