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
          'Whitespace normalisation stripped the newlines that chunking splits on, so every page became one chunk of up to 53,547 characters and the size limit was never enforced. Passages are now capped at 1,200 characters with 150 of overlap, which cut a question from ~10,400 prompt tokens to ~1,300.',
        status: 'done',
        where: 'server/rag.js chunkText()',
      },
      {
        title: 'Binary vector storage',
        detail:
          'Metadata as JSON, vectors as raw Float32 at 512 dimensions and unit-normalised at build time. 1,136 passages occupy 2.3 MB; the same data as JSON numbers would be roughly 45 MB and need parsing on every server start.',
        status: 'done',
        where: 'docs/angular/chunks.json + vectors.bin',
      },
      {
        title: 'Incremental docs updates',
        detail:
          'npm run docs:check reports the captured version against angular.dev and npm, lists Angular releases since, and shows exactly which pages differ - free, no API calls. npm run docs:update applies it and re-embeds only the changed pages, keeping existing vectors for the rest. Fetching is free and embedding is not, so hashes decide the work while version and changelog supply the narrative.',
        status: 'done',
        where: 'scripts/update-docs.js, scripts/docs-source.js',
      },
      {
        title: 'Expand the docs corpus',
        detail:
          'Was 23 pages with none of the core guides. The scraper read the sidebar from a single page, but angular.dev renders collapsed nav sections with no children, so Signals, Components, Templates, Forms, Routing, HTTP and DI were all missed. Now reads sitemap.xml against an allowlist: 134 pages, and "what is a signal?" retrieves /guide/signals first instead of AI-tooling pages.',
        status: 'done',
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
          'A score floor means an off-topic question returns an honest "not in these docs" without calling the model at all - so the refusal is free and cannot be a guess.',
        status: 'done',
        where: 'server/rag.js selectChunks()',
      },
      {
        title: 'Partial answers',
        detail:
          'A third outcome between answering and refusing. When passages clear the floor but none answer the question, the model signals it and we offer the closest pages instead of an answer. Retrieval cannot detect this on score alone - "What does CSS stand for?" scores 0.457 because the styling pages really are about CSS; what is missing is the acronym.',
        status: 'done',
        where: 'server/rag.js generateAnswer()',
      },
      {
        title: 'Answer confidence',
        detail:
          'high/medium/low from a composite of the model verdict, citation coverage, score gap and page corroboration - never from similarity alone, which would rate an unanswerable question as highly as a real one. Known limitation: it leans on the model verdict, so it is comparable within a provider but not across providers.',
        status: 'done',
        where: 'server/rag.js assessConfidence()',
      },
      {
        title: 'Switch which model answers',
        detail:
          'CHAT_PROVIDER selects openai, gemini, openrouter, xai, groq or a local Ollama. All speak the OpenAI protocol, so one SDK serves them all. Generation is switchable; embeddings are not, because the store fixes the embedding space.',
        status: 'done',
        where: 'server/llm-providers.js',
      },
      {
        title: 'Handle providers that cannot answer',
        detail:
          'A key can be present and unusable: xAI returned 403 "no credits or licenses yet", Gemini 429 on a fresh key. Failures are classified permanent or transient - only permanent ones remove a provider from the switcher, and unknown failures fail open.',
        status: 'done',
        where: 'server/provider-health.js',
      },
      {
        title: 'Golden-set retrieval tests',
        detail:
          'Fifteen questions covering match, no-match and adjacent-but-unanswered outcomes, measured as hit@3 and MRR. Question vectors are cached to a fixture, so the suite is free, offline and CI-safe. Currently hit@3 13/13 with MRR 1.000. It also disproved its own premise: the "adjacent" case was meant to score low enough to be distinguishable, but "What does CSS stand for?" scores 0.457 - above several real questions - so no threshold can separate them.',
        status: 'done',
        where: 'test/retrieval.test.mjs, test/golden-set.mjs',
      },
      {
        title: 'Hybrid retrieval and diversity cap',
        detail:
          'BM25 keyword ranking fused with vector similarity by Reciprocal Rank Fusion, plus a limit of 2 passages per page. Fixed the one golden-set miss - "how do I pass data into a component?" ranked /guide/components/inputs 5th because the question says "pass data" and the page says "input" - and took hit@3 from 92% to 100%.',
        status: 'done',
        where: 'server/rag.js selectChunksHybrid()',
      },
      {
        title: 'Drop redirect shells from the corpus',
        detail:
          '21 of 135 allowlisted URLs now serve only a client-side redirect, 24-83 characters long. They filled the sidebar with entries titled "Redirecting" and the vector store with near-empty passages. Skipped, with chain resolution and a warning when a target falls outside the allowlist.',
        status: 'done',
        where: 'scripts/docs-source.js isRedirectStub()',
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
        title: 'Show how each answer was built',
        detail:
          'Every answer carries the model that wrote it, a confidence badge, and a collapsible panel listing each passage with its similarity score, the rank each retrieval method gave it, and the prompt token count. All of it was already in the API response and was being discarded.',
        status: 'done',
        where: 'src/app/chat-panel.component.html',
      },
      {
        title: 'Working memory: chain follow-up questions',
        detail:
          'Today every question is embedded alone, so "what about effects?" has almost nothing retrievable in it and matches near-randomly. The fix is query rewriting - one cheap model call turns the follow-up into a standalone question using the history - plus passing the history into the answer prompt so pronouns resolve. Concatenating the history instead would dilute the embedding across several topics.',
        status: 'todo',
        where: 'server/rag.js, chat.store.ts',
      },
      {
        title: 'Documentation index',
        detail:
          'A browsable list of every indexed page with its real angular.dev URL, so it is clear what the assistant can and cannot answer from.',
        status: 'todo',
        where: 'GET /api/docs/list',
      },
      {
        title: 'Feedback loop',
        detail:
          'Thumbs up/down per answer, logged with the retrieved passages, so failures become golden-set cases. The golden set is currently 15 questions someone guessed; real logs would show what people actually ask, including the phrasings that fail.',
        status: 'todo',
      },
      {
        title: 'Fix dead links in the docs sidebar',
        detail:
          'The nav tree had 28 entries with no path, which rendered as links to /docs?path=undefined. The rebuilt scraper groups pages under section headings where every leaf carries a real path, so there are now zero dead links.',
        status: 'done',
        where: 'scripts/fetch-angular-docs.js buildStructure()',
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
