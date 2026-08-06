import { Component, computed, signal } from '@angular/core';
import { ROADMAP, STATUS_LABEL, type TaskStatus } from './roadmap.data';

type Filter = 'remaining' | 'all';

/**
 * Overview page: current status, with the remaining work first.
 *
 * This used to hold 22 hardcoded tasks whose statuses were stale - several read
 * "not started" for features that had already shipped - plus a status pill you
 * could click to cycle it, which persisted nowhere and was lost on reload.
 * Status now comes from roadmap.data.ts, so the page cannot disagree with the
 * repository.
 */
@Component({
  standalone: true,
  selector: 'home-page',
  templateUrl: './home.component.html',
  styleUrls: ['./home.component.css'],
})
export class HomeComponent {
  protected readonly statusLabel = STATUS_LABEL;

  /** Defaults to what's left, because that is the useful view. */
  protected readonly filter = signal<Filter>('remaining');

  private readonly allTasks = ROADMAP.flatMap((phase) => phase.tasks);

  protected readonly counts = computed(() => {
    const total = this.allTasks.length;
    const done = this.allTasks.filter((t) => t.status === 'done').length;
    return { total, done, remaining: total - done, percent: Math.round((done / total) * 100) };
  });

  /** Phases with their tasks filtered; phases that end up empty are dropped. */
  protected readonly phases = computed(() => {
    const showAll = this.filter() === 'all';
    return ROADMAP.map((phase) => ({
      ...phase,
      tasks: showAll ? phase.tasks : phase.tasks.filter((t) => t.status !== 'done'),
      doneCount: phase.tasks.filter((t) => t.status === 'done').length,
      totalCount: phase.tasks.length,
    })).filter((phase) => phase.tasks.length > 0);
  });

  protected setFilter(next: Filter) {
    this.filter.set(next);
  }

  protected statusClass(status: TaskStatus): string {
    return status.replace(' ', '-');
  }
}
