import { Routes } from '@angular/router';
import { DocsComponent } from './docs.component';
import { HomeComponent } from './home.component';

export const routes: Routes = [
  { path: '', component: HomeComponent },
  { path: 'docs', component: DocsComponent },

  // The chat used to be its own page. It now lives in a rail that is always
  // present, so this route only exists to keep old links and bookmarks working.
  { path: 'chat', redirectTo: '', pathMatch: 'full' },

  { path: '**', redirectTo: '' },
];
