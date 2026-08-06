# Angular Docs Wiki Chatbot (RAG prototype)

This repository contains a prototype Angular documentation assistant built with a Retrieval-Augmented Generation (RAG) approach.

High-level components:
- Frontend: Angular app (chat UI, progress logger)
- Backend: Fastify server that serves a local copy of Angular docs and exposes a /api/chat endpoint
- Docs corpus: Local download of selected Angular docs pages under `docs/angular/` (structure + per-page JSON)

Quick start (development):

1. Install dependencies

```bash
npm install
```

2. Download Angular docs (creates `docs/angular/`)

```bash
npm run download-docs
```

3. Configure your OpenAI API key

```bash
copy .env.sample .env
# then edit .env and set OPENAI_API_KEY
```

4. Build embeddings for the local docs corpus

```bash
npm run build-embeddings
```

5. Start the backend server (Fastify)

```bash
npm run start-backend
# runs the backend on http://localhost:3000
```

6. Start the Angular dev server (with a proxy to backend)

```bash
npm start
# runs the frontend on http://localhost:4200 and proxies /api to the backend
```

7. Open the app at `http://localhost:4200`. The assistant is docked on the right and stays open as you browse.

## Three questions worth trying

These three cover the behaviours a RAG system has to get right. Ask them in the chat rail, in this order.

| Ask this | Behaviour | What you should see |
| --- | --- | --- |
| `what is Angular?` | **Match** | A real, grounded answer. Five passages retrieved, top similarity **0.472**, led by `/overview`, citing `[1][3][4]`. |
| `got milk?` | **No match** | An honest refusal. **Zero** passages clear the similarity floor, so the language model is never called at all - the refusal is free and cannot be a guess. |
| `what is CSS?` | **Partial match** | The interesting one. Five passages *just* clear the floor (**0.298** down to **0.264**, against a floor of 0.25) from `/best-practices/security` and `/guide/components/styling` - they discuss styling, so they are weakly related. But the model correctly replies *"The provided passages do not contain a definition or explanation of CSS"* and cites **nothing**. |

Why the third case matters: there are **two independent defences** against confident nonsense, and it exercises the second one.

1. The **similarity floor** in `selectChunks()` rejects passages that aren't close enough. This is what handles `got milk?`.
2. The **grounding instruction** in the system prompt tells the model to answer only from the supplied passages and to say so when they don't cover the question. This is what handles `what is CSS?`, where retrieval was weakly positive but the content genuinely wasn't there.

A system with only the first defence would answer `what is CSS?` from the model's own training data, sounding authoritative while citing Angular security and styling pages that never defined CSS. Retrieval returning something is not the same as retrieval returning something *useful*, and the prompt has to assume it might not have.

Note that absolute similarity scores are lower than you might expect (a strong match sits near 0.47, not 0.9). That is normal and not a defect: passages are ~1,200 characters, so a broad question like *"what is Angular?"* only ever overlaps part of any single passage. What matters is the **gap** between a real match and noise, which here is roughly 0.47 versus 0.26.

Environment configuration:
- Copy `.env.sample` to `.env` and set `OPENAI_API_KEY` there.
- `.env` is ignored by git, so your secret key is not committed.
- If you prefer, you can also set `OPENAI_API_KEY` directly in your shell before running the backend or embeddings build.

The docs corpus and vector store:
- `npm run download-docs` reads `https://angular.dev/sitemap.xml` and downloads the sections listed in `SECTION_ALLOWLIST` in `scripts/fetch-angular-docs.js`. Currently **134 pages** across Signals, Components, Templates, Directives, DI, Forms, Routing, HTTP, Pipes, Best practices and the essentials. Widening the corpus is a one-line edit to that array.
- `npm run build-embeddings` produces two files, both gitignored because they are regenerable:
  - `docs/angular/chunks.json` - passage metadata and text (~1.4 MB)
  - `docs/angular/vectors.bin` - raw Float32 vectors, unit-normalised (~2.3 MB)
- Roughly **1,136 passages** at 512 dimensions. Storing vectors as raw Float32 rather than JSON numbers keeps this at 2.3 MB; the same data as JSON would be around 45 MB and would need parsing on every server start.
- `npm run test:unit` runs the offline suites: chunking, vector maths, prompt assembly and the citation guard.

## Keeping the docs up to date

The corpus is a snapshot, so it goes stale as Angular releases. Two commands:

```bash
npm run docs:check     # report only. No writes, no API calls, no cost
npm run docs:update    # apply changes and re-embed ONLY what changed
```

`docs:check` prints the version you captured, what angular.dev serves now, which Angular releases have landed since, and exactly which pages differ - then stops. `docs:update` does the same work and applies it.

Three signals are available, and they are good for different things:

| Signal | Answers | Limitation |
| --- | --- | --- |
| Version, from angular.dev and the npm registry | *Might* anything have changed? | Says nothing about which pages |
| `CHANGELOG.md`, grouped by package | What changed in the **framework** | Describes code, not prose. A `fix(compiler)` may touch no page, and a docs typo fix appears in no changelog. Its `docs` section is the one entry that does refer to prose |
| Per-page content hash | Which pages **actually** changed | Requires fetching every page - which is free |

The economics decide the design: **fetching pages costs nothing, embedding them costs money.** So every page is fetched and hashed on each run (cheap and exact), while the API budget is spent only on pages whose text genuinely moved. Version and changelog supply the narrative; hashes decide the work.

The hash covers `contentText`, not `contentHtml`, because `contentText` is precisely what gets embedded. If Angular restructures its markup while the prose stays identical, the resulting vectors would be bit-for-bit the same, so re-embedding would be waste.

Unchanged pages keep their existing vectors, copied straight across into the rebuilt store. A run that finds three changed pages embeds roughly 25 passages rather than all 1,136 - fractions of a cent instead of a full rebuild.

`docs/angular/manifest.json` records the captured version and a hash per page. It is what makes the comparison possible, so it is committed alongside the pages.

For a clean slate - a first run, or after widening `SECTION_ALLOWLIST` substantially - use `npm run download-docs` followed by `npm run build-embeddings` instead.

Notes about the dev proxy and API:
- The Angular dev server is configured with `proxy.conf.json` so frontend calls to `/api/*` are forwarded to `http://localhost:3000` during development.
- The ChatService in the frontend uses relative URLs (e.g. `/api/chat`).

What is implemented (prototype v0.1):
- Introduction/landing page with a progress logger and navigation to the chatbot
- Chat UI and local conversation state in Angular
- Scripts to download Angular docs, scrape the docs sidebar, and save page JSON under `docs/angular/`
- Fastify backend serving local docs, a `/api/chat` endpoint, and both lexical search and vector search fallback support
- Local embeddings builder in `server/build-vector-store.js` with `.env`-based OpenAI configuration
- A unit test that verifies `docs/angular/embeddings.json` exists and contains numeric vector embeddings
- A developer-friendly README with setup, troubleshooting, and progress guidance

Current status:
- Angular docs corpus downloaded and stored locally under `docs/angular/`
- Vector store generated locally in `docs/angular/embeddings.json` with 23 chunks using `text-embedding-3-small`
- Backend supports vector retrieval fallback and lexical search when embeddings are not available
- Embedding store validation test passes with `npm run test:unit`
- OpenAI key configuration is handled via `.env` and `.env.sample`
- The next major phase is prompt assembly and generating final answers from retrieved chunks

Planned next steps (RAG work):
- Add prompt assembly for retrieved chunks and call an OpenAI completion model for final answers
- Improve prompt engineering so answers cite exact Angular docs sources and snippets
- Add broader tests and CI automation for backend, frontend, and vector workflows
- Prepare deployment guidance for the frontend and backend

Committing progress:
- Keep commits small and focused (e.g. `docs: add downloaded Angular pages`, `feat: fastify backend and lexical search`).
- For a multi-line commit message, pass `-m` more than once rather than embedding `\n`. Shells do not expand `\n` inside `-m "..."`, so it lands in the message as the literal two characters — several commits in this repo's history show exactly that:

```bash
git commit -m "feat: short summary" -m "Longer explanation on its own paragraph."
```

Developer notes / troubleshooting:
- `/api/chat` should not return 404 when the backend is running and the frontend dev server is using the proxy. If you see `Cannot POST /api/chat`, verify:
  - The backend is started with `npm run start-backend` and listening on `http://localhost:3000`
  - The Angular app is started with `npm start` or `npx ng serve`, and the proxy config is loaded from `angular.json` / `proxy.conf.json`
  - The frontend request is sent to `/api/chat`, not directly to the Angular app build output.
- To debug backend locally, run `npm run start-backend` and test `POST http://localhost:3000/api/chat` directly.
- The proxy is now configured in `angular.json`, so `ng serve` will automatically use `proxy.conf.json` when run from the project root.

Contact / authorship:
- Prototype created with assistance from Copilot CLI runtime in VS Code.

License: MIT 
