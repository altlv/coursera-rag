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

3. Build embeddings for the local docs corpus

```bash
# Unix/macOS
export OPENAI_API_KEY=your_api_key_here
npm run build-embeddings

# Windows PowerShell
$env:OPENAI_API_KEY='your_api_key_here'
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

```bash
npm start
# runs the frontend on http://localhost:4200 and proxies /api to the backend
```

5. Open the app at `http://localhost:4200` and go to the Chat page.

Notes about the dev proxy and API:
- The Angular dev server is configured with `proxy.conf.json` so frontend calls to `/api/*` are forwarded to `http://localhost:5173` during development.
- The ChatService in the frontend uses relative URLs (e.g. `/api/chat`).

What is implemented (prototype v0.1):
- Introduction/landing page with progress logger
- Chat UI and local conversation state
- Scripts to download Angular docs (sidebar crawler)
- Fastify backend serving local docs and a simple lexical search endpoint `/api/chat`
- Frontend service to call the backend and render answers + source links
- Vector search scaffolding with a local embeddings builder and vector similarity fallback path

Planned next steps (RAG work):
- Run `npm run build-embeddings` with `OPENAI_API_KEY` to generate `docs/angular/embeddings.json`
- Use retrieved chunks to build a prompt and call a completion model for final answers
- Improve prompts to prefer exact doc citations and source references
- Add tests, CI, and deployment configuration

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
  - The Angular app is started with `npm start` so `/api` requests are forwarded by `proxy.conf.json`
- To debug backend locally, run `npm run start-backend` and test `POST http://localhost:5173/api/chat` directly.

Contact / authorship:
- Prototype created with assistance from Copilot CLI runtime in VS Code.

License: MIT (choose a license if you plan to publish)
