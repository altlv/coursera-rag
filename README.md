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

4. Start the backend server (Fastify)

```bash
npm run start-backend
# runs the backend on http://localhost:5173
```

5. Start the Angular dev server (with a proxy to backend)

```bash
npm start
# runs the frontend on http://localhost:4200 and proxies /api to the backend
```

6. Open the app at `http://localhost:4200` and go to the Chat page.

Environment configuration:
- Copy `.env.sample` to `.env` and set `OPENAI_API_KEY` there.
- `.env` is ignored by git, so your secret key is not committed.
- If you prefer, you can also set `OPENAI_API_KEY` directly in your shell before running the backend or embeddings build.

Verifying the vector store:
- Run `npm run build-embeddings` to build `docs/angular/embeddings.json` from the downloaded docs.
- Run `npm run test:unit` to verify the vector store file exists and contains valid numeric embeddings.

Notes about the dev proxy and API:
- The Angular dev server is configured with `proxy.conf.json` so frontend calls to `/api/*` are forwarded to `http://localhost:5173` during development.
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

Committing progress (recommended):
- This repository was prepared as a working prototype. If you want to record progress in git:

```bash
# (only once)
git init
git add .
git commit -m "v0.1-prototype: Angular docs RAG prototype\n\nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
git tag v0.1-prototype
```

- After the initial commit, continue small, focused commits that describe progress (e.g., `docs: add downloaded Angular pages`, `feat: fastify backend and lexical search`).

Developer notes / troubleshooting:
- `/api/chat` should not return 404 when the backend is running and the frontend dev server is using the proxy. If you see `Cannot POST /api/chat`, verify:
  - The backend is started with `npm run start-backend` and listening on `http://localhost:5173`
  - The Angular app is started with `npm start` or `npx ng serve`, and the proxy config is loaded from `angular.json` / `proxy.conf.json`
  - The frontend request is sent to `/api/chat`, not directly to the Angular app build output.
- To debug backend locally, run `npm run start-backend` and test `POST http://localhost:5173/api/chat` directly.
- The proxy is now configured in `angular.json`, so `ng serve` will automatically use `proxy.conf.json` when run from the project root.

Contact / authorship:
- Prototype created with assistance from Copilot CLI runtime in VS Code.

License: MIT (choose a license if you plan to publish)
