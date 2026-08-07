/**
 * Single source of truth for project status.
 *
 * The Overview page renders this. The README deliberately does NOT repeat it: the
 * roadmap used to be transcribed into both places by hand, and they drifted until
 * the README knew the docs viewer had shipped while the task list still called it
 * "not started".
 *
 * To update status, edit this file in a commit. That keeps the claim and the code
 * in the same diff, which is the only thing that reliably stops rot.
 *
 * Grouped by CONCERN rather than chronology, so the remaining work in any one area
 * is visible at a glance.
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
  // -------------------------------------------------------------------------
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
      {
        title: 'Testable pipeline module',
        detail:
          'Chunking, vector maths and prompt assembly as pure functions. Nothing in the server was exported before, so none of it could be tested.',
        status: 'done',
        where: 'server/rag.js',
      },
    ],
  },

  // -------------------------------------------------------------------------
  {
    name: 'Corpus',
    summary: 'Getting the right documentation onto disk, and keeping it current.',
    tasks: [
      {
        title: 'Scrape from sitemap.xml',
        detail:
          'Was 23 pages with none of the core guides: the scraper read the sidebar from one page, but angular.dev renders collapsed nav sections with no children, so Signals, Components, Templates, Forms, Routing and DI were all missed. Now 114 pages across 12 sections.',
        status: 'done',
        where: 'scripts/docs-source.js',
      },
      {
        title: 'Drop redirect shells',
        detail:
          '21 of 135 allowlisted URLs serve only a client-side redirect, 24-83 characters long. They filled the sidebar with entries titled "Redirecting" and the store with near-empty passages. Skipped rather than followed, since five pointed at the same page. Chains are resolved, and any target outside the allowlist is reported as a warning.',
        status: 'done',
        where: 'scripts/docs-source.js isRedirectStub()',
      },
      {
        title: 'Incremental updates',
        detail:
          'docs:check reports the captured version against angular.dev and npm, lists releases since, and shows which pages differ - free, no API calls. docs:update re-embeds only what changed. Fetching is free and embedding is not, so hashes decide the work.',
        status: 'done',
        where: 'scripts/update-docs.js',
      },
      {
        title: 'Notice a changed corpus while running',
        detail:
          'The server watches manifest.json mtime and clears its caches. Without it a re-scrape appeared to do nothing - a fixed duplicate-heading bug looked unfixed purely because old HTML was still cached.',
        status: 'done',
        where: 'server/index.js invalidateIfCorpusChanged()',
      },
    ],
  },

  // -------------------------------------------------------------------------
  {
    name: 'Retrieval',
    summary: 'Finding the passages that actually answer a question.',
    tasks: [
      {
        title: 'Embeddings and vector search',
        detail: 'text-embedding-3-small at 512 dimensions, unit-normalised so query time is a dot product.',
        status: 'done',
        where: 'server/build-vector-store.js',
      },
      {
        title: 'Fix the chunking bug',
        detail:
          'Whitespace normalisation stripped the newlines chunking splits on, so every page became one chunk of up to 53,547 characters. Passages are now capped at 1,200 with 150 overlap, cutting a question from ~10,400 prompt tokens to ~1,300.',
        status: 'done',
        where: 'server/rag.js chunkText()',
      },
      {
        title: 'Binary vector storage',
        detail:
          'Metadata as JSON, vectors as raw Float32. 1,122 passages occupy 2.2 MB; the same data as JSON numbers would be ~45 MB and need parsing on every start.',
        status: 'done',
        where: 'docs/angular/chunks.json + vectors.bin',
      },
      {
        title: 'Hybrid search and diversity cap',
        detail:
          'BM25 fused with vector similarity by Reciprocal Rank Fusion, plus at most 2 passages per page. Fixed the one golden-set miss and took hit@3 from 92% to 100%.',
        status: 'done',
        where: 'server/rag.js selectChunksHybrid()',
      },
      {
        title: 'Search both question formulations',
        detail:
          'Rewriting is not reliably better: "what about validation?" retrieved the right page at rank 1 as typed and lost it once rewritten. So both are searched and all rankings fused - which found a page neither formulation found alone.',
        status: 'done',
        where: 'server/rag.js selectChunksMultiQuery()',
      },
      {
        title: 'Contextual chunking: page title in the embedded text',
        detail:
          'A mid-page passage was embedded with no trace of which page it came from, while keyword scoring already saw the title - so the two halves of retrieval disagreed about what a passage was. Measurable only on the held-out set: hit@1 67 to 73%, MRR 0.789 to 0.822. The golden set reported no change whatsoever, which is exactly why the held-out set had to exist first.',
        status: 'done',
        where: 'server/build-vector-store.js',
      },
      {
        title: 'Code-block-aware chunking',
        detail:
          'Chunking splits on blank lines and knows nothing about fenced code, so a long example is torn across two passages - verified with an 80-line sample landing in 2 chunks. Bad for a documentation assistant specifically, where the code IS the answer.',
        status: 'todo',
        where: 'server/rag.js chunkText()',
      },
      {
        title: 'Reranking',
        detail:
          'Retrieve ~20 by vector then rerank to 5 with a cheap model call. Would help where fusion still ranks the best passage below the top 3. Worth doing only once a held-out eval set can prove it helped.',
        status: 'todo',
      },
    ],
  },

  // -------------------------------------------------------------------------
  {
    name: 'Answering',
    summary: 'Turning passages into grounded answers, and knowing when not to.',
    tasks: [
      {
        title: 'Generate real answers',
        detail:
          'The endpoint used to return a hardcoded string: "I found 4 relevant chunks...". It now assembles retrieved passages into a prompt and calls a model.',
        status: 'done',
        where: 'server/rag.js generateAnswer()',
      },
      {
        title: 'Citations and hallucination guard',
        detail:
          'Answers cite numbered sources, and any citation outside the supplied passages is stripped. An unchecked citation is worse than none, because it looks verified.',
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
          'A third outcome between answering and refusing. Retrieval cannot detect this on score alone - "What does CSS stand for?" scores 0.457 because the styling pages really are about CSS; what is missing is the acronym.',
        status: 'done',
        where: 'server/rag.js generateAnswer()',
      },
      {
        title: 'Answer confidence',
        detail:
          'high/medium/low from a composite of the model verdict, citation coverage, score gap and page corroboration - never similarity alone, which would rate an unanswerable question as highly as a real one.',
        status: 'done',
        where: 'server/rag.js assessConfidence()',
      },
      {
        title: 'Working memory for follow-ups',
        detail:
          'One cheap call rewrites "how do I test it?" into a standalone question, built from the user\'s own questions and retrieved doc paths - never model prose, so retrieval stays independent of the active model. Three exchanges reach the answer prompt, and answers from a different model are labelled so it does not inherit them.',
        status: 'done',
        where: 'server/rag.js rewriteQuestion()',
      },
      {
        title: 'Surface contradictions instead of merging them',
        detail:
          'Passages are selected for similarity, never for agreeing with each other, so the prompt can contain version drift or a deprecated API beside its replacement - and a model faithfully reproduces both. The prompt should ask it to flag disagreement and cite both sides, and passage rank should be passed so stronger evidence outweighs weaker. The citation guard catches invented sources and is blind to conflicting ones.',
        status: 'todo',
        where: 'server/rag.js SYSTEM_PROMPT, buildPrompt()',
      },
      {
        title: 'Calibrate confidence per provider',
        detail:
          'Identical passages produced opposite verdicts: llama-3.3-70b answered with high confidence where gpt-4o-mini returned partial/low. Confidence weights the model verdict most heavily, so it is comparable within a provider but not across them. Also skews optimistic on follow-ups, since a passage reports its best score across both formulations.',
        status: 'todo',
      },
    ],
  },

  // -------------------------------------------------------------------------
  {
    name: 'Providers',
    summary: 'Choosing which model answers, and coping when it cannot.',
    tasks: [
      {
        title: 'Switch which model answers',
        detail:
          'CHAT_PROVIDER selects openai, gemini, openrouter, xai, groq or a local Ollama. All speak the OpenAI protocol, so one SDK serves them all. Generation is switchable; embeddings are not, because the store fixes the embedding space.',
        status: 'done',
        where: 'server/llm-providers.js',
      },
      {
        title: 'Classify provider failures',
        detail:
          'A key can be present and unusable: xAI returned 403 "no credits or licenses yet", Gemini 429 on a fresh key. Only permanent failures remove a provider from the switcher; unknown ones fail open, because a misclassified transient recovers whereas a wrongly-permanent one is gone until restart.',
        status: 'done',
        where: 'server/provider-health.js',
      },
      {
        title: 'Compare providers on identical evidence',
        detail:
          'compare-providers retrieves once and hands every provider the same passages, so differences are attributable to the model alone. list-models asks each provider what it actually offers, which immediately revealed that Gemini prefixes ids with "models/".',
        status: 'done',
        where: 'scripts/compare-providers.js, scripts/list-models.js',
      },
      {
        title: 'Resolve the Gemini model naming question',
        detail:
          'Both the bare name and the "models/" prefix returned 429, so quota masked which form the OpenAI-compatibility layer wants. Blocked until the free-tier limit resets.',
        status: 'todo',
      },
    ],
  },

  // -------------------------------------------------------------------------
  {
    name: 'Safeguards',
    summary: 'Failure modes that are cheap to prevent and expensive to debug.',
    tasks: [
      {
        title: 'Embedding-space integrity',
        detail:
          'Vectors from two models are incompatible, and comparing them returns plausible numbers while measuring nothing - so it is guarded in six places: the store records model and dimensions, byte length is validated on load, dotProduct throws on a length mismatch, embedQuery reads the model from the store, the golden fixture asserts a matching space, and createEmbedder refuses to follow CHAT_PROVIDER.',
        status: 'done',
        where: 'server/rag.js, server/index.js, test/retrieval.test.mjs',
      },
      {
        title: 'Timeout and selective retry',
        detail:
          '30-second deadline per model call, and up to 3 attempts with exponential backoff. Retry reuses the permanent/transient classification, so a 429 is retried while no-credits or a revoked key fails on the first attempt rather than making the user wait through backoff to reach the same error. Tested against the real loop via an injectable client.',
        status: 'done',
        where: 'server/llm-providers.js',
      },
      {
        title: 'Bound client-supplied input',
        detail:
          'Questions capped at 2,000 characters and history bounded server-side. /api/chat previously checked only for a non-empty string, so a 50,000-character body went straight into an embedding call and the prompt. History is client-supplied too, so the frontend limit is re-enforced on arrival rather than trusted.',
        status: 'done',
        where: 'server/index.js',
      },
      {
        title: 'Spend ceiling',
        detail:
          'Nothing caps cumulative API cost. Low risk on a local prototype, real the moment it is exposed.',
        status: 'todo',
      },
      {
        title: 'Rate limiting on /api/chat',
        detail: 'Only matters beyond localhost, but trivial to add before it does.',
        status: 'todo',
      },
      {
        title: 'Prompt injection from documents',
        detail:
          'Scraped pages are stripped of <script> and <style>, but not of TEXT. A document containing "ignore previous instructions" would go straight into the prompt as trusted context. Low risk from angular.dev specifically, but the pattern is unguarded, and retrieved content is third-party input by definition.',
        status: 'todo',
      },
      {
        title: 'Verify citation attribution, not just range',
        detail:
          'The guard checks that [n] refers to a passage that was supplied. It does not check that the claim actually came from passage n - a model can cite [1] for something it read in [3], and nothing notices.',
        status: 'todo',
      },
    ],
  },

  // -------------------------------------------------------------------------
  {
    name: 'Interface',
    summary: 'Making the assistant usable while reading the docs.',
    tasks: [
      {
        title: 'Persistent chat rail',
        detail:
          'Docked beside the content and outside the router outlet, so the conversation survives navigation. It used to be a page whose state was destroyed on every route change.',
        status: 'done',
        where: 'src/app/chat-panel.component.ts, chat.store.ts',
      },
      {
        title: 'Clickable citations',
        detail: 'Each source opens in the local docs viewer without disturbing the conversation.',
        status: 'done',
        where: 'src/app/chat-panel.component.html',
      },
      {
        title: 'Show how each answer was built',
        detail:
          'Model that wrote it, confidence badge, the rewritten question when one was used, and a collapsible panel with each passage, its score, per-method ranks and token count. All of it was already in the API response and being discarded.',
        status: 'done',
        where: 'src/app/chat-panel.component.html',
      },
      {
        title: 'Provider switcher with health',
        detail:
          'Unusable providers disappear from the dropdown, with a hover indicator explaining why; rate-limited ones stay but are marked.',
        status: 'done',
        where: 'src/app/chat-panel.component.html',
      },
      {
        title: 'Documentation index',
        detail:
          'A browsable list of every indexed page with its real angular.dev URL, so it is clear what the assistant can and cannot answer from. Needs GET /api/docs/list and a DocsService that caches - the tree is currently refetched on every visit.',
        status: 'todo',
        where: 'server/index.js, src/app/docs.service.ts',
      },
      {
        title: 'Stream answers',
        detail: 'Render tokens as they arrive instead of 2-4 seconds of dead air.',
        status: 'todo',
      },
      {
        title: 'Fix the leaking docs subscription',
        detail:
          'docs.component subscribed to queryParamMap and never unsubscribed, so the handler outlived the component and every visit left another live listener writing to dead signals. Fixed with takeUntilDestroyed.',
        status: 'done',
        where: 'src/app/docs.component.ts',
      },
      {
        title: 'Move async state onto httpResource',
        detail:
          'All state is signal-based, but the async plumbing is hand-rolled: raw fetch, a manual isLoading flag, and try/catch, kept in sync by hand. httpResource collapses those into one unit exposing value, error and isLoading - and cancels superseded requests for free. provideHttpClient would also bring interceptors and make the frontend HTTP layer testable, which it currently is not at all.',
        status: 'todo',
        where: 'src/app/chat.store.ts, docs.component.ts',
      },
      {
        title: 'Persist the conversation and allow cancelling',
        detail:
          'The rail survives navigation but not a reload. And isLoading BLOCKS a second question rather than cancelling the first, which an AbortController would handle properly.',
        status: 'todo',
      },
    ],
  },

  // -------------------------------------------------------------------------
  {
    name: 'Evaluation',
    summary: 'Knowing whether a change helped, rather than assuming.',
    tasks: [
      {
        title: 'Golden-set retrieval suite',
        detail:
          'Fifteen questions covering match, no-match and adjacent-but-unanswered outcomes, measured as hit@3 and MRR, currently 13/13 and 1.000. Question vectors are cached so it runs free and offline. It also disproved its own premise about score bands, and caught a real retrieval weakness rather than letting it hide behind a widened expectation.',
        status: 'done',
        where: 'test/retrieval.test.mjs, test/golden-set.mjs',
      },
      {
        title: 'Held-out evaluation set',
        detail:
          'Fifteen questions never used for tuning, targeting details in the middle of long pages and phrased to avoid echoing page titles. It earned its keep immediately: contextual chunking produced NO rank change on the golden set - which is saturated and cannot distinguish two stores - while showing hit@1 67 to 73% and MRR 0.789 to 0.822 here. Honest figures are hit@1 73%, hit@3 93%, MRR 0.822, against the golden set's flattering 100% and 1.000. Thresholds are regression guards set BELOW current performance, never targets.',
        status: 'done',
        where: 'test/holdout-set.mjs, test/holdout.test.mjs, scripts/eval-retrieval.js',
      },
      {
        title: 'Measure answer quality, not just retrieval',
        detail:
          'Retrieval is measured thoroughly and generation barely. Nothing scores whether an answer is faithful to the passages it cites - only that the citation numbers are in range. Faithfulness and groundedness checks would cover the half currently taken on trust.',
        status: 'todo',
      },
      {
        title: 'Continuous integration',
        detail:
          'Runs the pipeline suites, component tests, a production build and the golden set on every push. One caveat made explicit rather than hidden: the vector store is gitignored because building it needs a key, so on CI the golden set skips its assertions - the workflow emits a warning saying retrieval was NOT measured, since a passing test that asserted nothing is the false confidence this project guards against everywhere else.',
        status: 'done',
        where: '.github/workflows/ci.yml',
      },
      {
        title: 'Log questions for analysis',
        detail:
          'No record of what is actually asked, so the golden set stays fifteen guesses. Should capture the question, the rewritten form, retrieved paths with scores, status, confidence and tokens - enough to reconstruct any decision. It is user data, so it stays gitignored and needs a retention decision before any deployment.',
        status: 'todo',
      },
      {
        title: 'Feedback loop',
        detail:
          'Thumbs up/down per answer. Logs alone say what was asked, not whether the answer was good - pairing them is what turns a failure into a regression test.',
        status: 'todo',
      },
      {
        title: 'Semantic cache',
        detail:
          'Reuse an answer when a new question is very close to a previous one. Saves cost and latency on repeats; risks stale answers after a docs update and near-miss collisions. An optimisation, so it comes after the measurement.',
        status: 'todo',
      },
    ],
  },

  // -------------------------------------------------------------------------
  {
    name: 'Documentation',
    summary: 'Explaining how it works, for learning rather than setup.',
    tasks: [
      {
        title: 'README as the front door',
        detail:
          'Architecture, setup, retrieval design, confidence, provider switching and failure handling, working memory, and the incremental update flow - each with the measurement that motivated it. Status deliberately lives here in roadmap.data.ts instead.',
        status: 'done',
        where: 'README.md',
      },
      {
        title: 'Document the safeguards',
        detail:
          'The guard inventory has no single home: why cross-model vectors are incompatible and fail silently, what each guard prevents, and which gaps remain open.',
        status: 'todo',
        where: 'README.md',
      },
      {
        title: 'LEARN-RAG.md',
        detail:
          'The teaching deliverable. What an embedding is, why unit-normalising turns cosine into a dot product, how chunk size was chosen, why retrieval and generation must be evaluated separately, how rank fusion works, and when a real vector database would start to earn its place. Written last, because it documents settled architecture.',
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
