import { Routes } from '@angular/router';
import { ChatComponent } from './chat.component';
import { DocsComponent } from './docs.component';
import { HomeComponent } from './home.component';

export const routes: Routes = [
  { path: '', component: HomeComponent },
  { path: 'chat', component: ChatComponent },
  { path: 'docs', component: DocsComponent },
  { path: '**', redirectTo: '' },
];
