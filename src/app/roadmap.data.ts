/**
 * Single source of truth for project status.
 *
 * The Overview page renders this. The README deliberately does NOT repeat it:
 * the roadmap used to be transcribed into both places by hand, and they drifted
 * until the README knew the docs viewer had shipped while the task list still
 * called it "not started".
 *
 * To update status, edit this file in a commit. That keeps the claim and the
 * code in the same diff, which is the only thing that reliably stops rot.
 */

export type TaskStatus = 'done' | 'in progress' | 'todo';

export interface RoadmapTask {
  title: string;
  detail: string;
  status: TaskStatus;
  /** Where the work lives, for anyone reading the code alongside the page. */
  where?: string;
}

export interface RoadmapPhase {
  name: string;
  summary: string;
  tasks: RoadmapTask[];
}

export const ROADMAP: RoadmapPhase[] = [
  {
    name: 'Foundations',
    summary: 'App shell, docs corpus and the backend that serves it.',
    tasks: [
      {
        title: 'Angular app shell and routing',
        detail: 'Standalone components, router, Overview and Docs pages.',
        status: 'done',
        where: 'src/app/app.ts, app.routes.ts',
      },
      {
        title: 'Fastify backend',
        detail: 'Serves the local docs corpus and exposes /api/chat.',
        status: 'done',
        where: 'server/index.js',
      },
      {
        title: 'Angular docs scraper',
        detail: 'Downloads angular.dev pages to JSON under docs/angular/.',
        status: 'done',
        where: 'scripts/fetch-angular-docs.js',
      },
      {
        title: 'Docs viewer page',
        detail: 'Sidebar tree plus a reading pane for any downloaded page.',
        status: 'done',
        where: 'src/app/docs.component.ts',
      },
      {
        title: 'Shared design tokens',
        detail:
          'Colours, spacing and radii in one place. Replaced hex literals copy-pasted across stylesheets that had already drifted apart.',
        status: 'done',
        where: 'src/styles.css',
      },
    ],
  },
  {
    name: 'Retrieval',
    summary: 'Turning documentation into something searchable by meaning.',
    tasks: [
      {
        title: 'Lexical keyword search',
        detail: 'Token-overlap scoring, used as a fallback when vectors are unavailable.',
        status: 'done',
        where: 'server/index.js searchDocs()',
      },
      {
        title: 'Embeddings and vector search',
        detail: 'text-embedding-3-small vectors, ranked by similarity against the question.',
        status: 'done',
        where: 'server/build-vector-store.js',
      },
      {
        title: 'Testable pipeline module',
        detail:
          'Chunking, vector maths and prompt assembly extracted into pure functions. Nothing in the server was exported before, so none of it could be tested.',
        status: 'done',
        where: 'server/rag.js',
      },
      {
        title: 'Fix the chunking bug',
        detail:
          'Whitespace normalisation stripped the newlines that chunking splits on, so every page became one chunk of up to 53,547 characters. Questions currently cost ~10,000 prompt tokens each because whole pages are sent as context.',
        status: 'todo',
        where: 'server/rag.js chunkText()',
      },
      {
        title: 'Binary vector storage',
        detail:
          'Store metadata as JSON and vectors as raw Float32 at 512 dimensions. Keeps the store near 3 MB instead of the 45 MB the current format would reach once chunking is fixed.',
        status: 'todo',
        where: 'docs/angular/chunks.json + vectors.bin',
      },
      {
        title: 'Expand the docs corpus',
        detail:
          'Only 23 pages are indexed and none of the core guides are among them. The scraper reads the sidebar from one page, but collapsed nav sections render empty, so Signals, Components, Templates, Forms, Routing and HTTP were all missed. Switching to sitemap.xml brings in roughly 127 pages.',
        status: 'todo',
        where: 'scripts/fetch-angular-docs.js',
      },
    ],
  },
  {
    name: 'Answering',
    summary: 'Writing grounded answers instead of listing search hits.',
    tasks: [
      {
        title: 'Generate real answers',
        detail:
          'The endpoint used to return a hardcoded string: "I found 4 relevant chunks...". It now assembles retrieved passages into a prompt and calls gpt-4o-mini.',
        status: 'done',
        where: 'server/rag.js generateAnswer()',
      },
      {
        title: 'Citations and hallucination guard',
        detail:
          'Answers cite numbered sources, and any citation pointing outside the passages actually retrieved is stripped. An unchecked citation is worse than none, because it looks verified.',
        status: 'done',
        where: 'server/rag.js extractCitations()',
      },
      {
        title: 'Refuse when nothing matches',
        detail:
          'A score floor means an off-topic question returns an honest "not in these docs" without calling the model at all.',
        status: 'done',
        where: 'server/rag.js selectChunks()',
      },
      {
        title: 'Golden-set retrieval tests',
        detail:
          'Assert that real questions land on the right guide pages, measured as hit@3 and MRR. Question vectors get cached to a fixture so the suite runs free and offline. This is also the instrument for tuning k, chunk size and the score floor.',
        status: 'todo',
        where: 'test/retrieval.test.mjs',
      },
    ],
  },
  {
    name: 'Interface',
    summary: 'Making the assistant usable while reading the docs.',
    tasks: [
      {
        title: 'Persistent chat rail',
        detail:
          'Chat is docked beside the content and lives outside the router outlet, so the conversation survives moving between Overview and Docs. It used to be a page whose state was destroyed on every navigation.',
        status: 'done',
        where: 'src/app/chat-panel.component.ts, chat.store.ts',
      },
      {
        title: 'Clickable citations',
        detail:
          'Each source opens in the local docs viewer without disturbing the conversation, and links out to angular.dev.',
        status: 'done',
        where: 'src/app/chat-panel.component.html',
      },
      {
        title: 'Documentation index',
        detail:
          'A browsable list of every indexed page with its real angular.dev URL, so it is clear what the assistant can and cannot answer from.',
        status: 'todo',
        where: 'GET /api/docs/list',
      },
      {
        title: 'Recursive docs tree',
        detail:
          'The sidebar renders only two levels and shows pathless nav entries as dead links.',
        status: 'todo',
        where: 'src/app/docs.component.html',
      },
    ],
  },
  {
    name: 'Documentation',
    summary: 'Explaining how it works, for learning rather than for setup.',
    tasks: [
      {
        title: 'LEARN-RAG.md',
        detail:
          'What embeddings are, why unit-normalising turns cosine similarity into a dot product, how chunk size is chosen, how to evaluate retrieval, and when a real vector database would start to earn its place.',
        status: 'todo',
      },
      {
        title: 'Rewrite the README',
        detail: 'Architecture, quick start and the plan. Status stays here, not there.',
        status: 'todo',
      },
      {
        title: 'CI',
        detail: 'Run the offline suites on push.',
        status: 'todo',
      },
    ],
  },
];

export const STATUS_LABEL: Record<TaskStatus, string> = {
  done: 'Done',
  'in progress': 'In progress',
  todo: 'To do',
};
