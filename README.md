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

Note that absolute similarity scores are lower than you might expect (a strong match sits near 0.47, not 0.9). That is normal and not a defect: passages are ~1,200 characters, so a broad question like *"what is Angular?"* only ever overlaps part of any single passage. What matters is the **gap** between a real match and noise.

## How retrieval works

Three mechanisms, each added because something measurable was wrong without it.

**Hybrid search: vectors and keywords, fused by rank.** Embeddings match meaning but can skate over exact terminology. *"How do I pass data into a component?"* ranked `/guide/components/inputs` only **5th** under pure vector search, because the question says "pass data" while the page says "input". Adding BM25 keyword scoring moved it to **1st**.

The two cannot simply be added together: cosine similarity lives in roughly 0.25–0.65 while BM25 is unbounded and corpus-dependent, so one would silently dominate. Instead they are combined by **Reciprocal Rank Fusion**, which uses positions rather than scores:

```
fused(passage) = Σ over methods of  1 / (60 + rank)
```

This rewards agreement: a passage ranked 1st by one method and 10th by the other beats one ranked 5th by both. The `ranks` field in the API response shows exactly where each method placed a passage.

Keyword scoring is applied only to passages that already cleared the similarity floor, making it a **reranker rather than a recall expander**. That is deliberate — it preserves the free refusal. If keyword matches could enter from below the floor, *"Got milk?"* could drag in a passage containing "milk" and turn a free refusal into a partial answer. The measured problem was a *ranking* failure, not a recall failure, so reranking is sufficient. The cost: a passage with strong exact-term overlap but weak semantic similarity still cannot be recalled.

**Diversity cap: at most 2 passages per page.** Without it the top-k collapses onto one well-matched page. *"What does CSS stand for?"* spent 2 of its 5 slots on duplicates, so 40% of the context window went to material the model had already seen — and adjacent passages overlap by 150 characters by design.

**Measured effect of both**, on the golden set:

| | hit@3 | MRR |
| --- | --- | --- |
| Vector only | 12/13 (92%) | 0.836 |
| Hybrid + diversity cap | **13/13 (100%)** | **1.000** |

> **That 100% is not the honest number.** Hybrid retrieval, the diversity cap and the score floor were all tuned *while watching these same 15 questions*, so the score describes the tuning rather than the system — and being saturated, it cannot detect a change in either direction.

### The held-out set, and why it matters

`test/holdout-set.mjs` holds 15 questions **never used for tuning**. They deliberately target details in the *middle* of long pages, phrased to avoid echoing page titles, so a match has to come from the body rather than a lucky headline overlap.

**The honest retrieval numbers:**

| Set | hit@1 | hit@3 | MRR |
| --- | --- | --- | --- |
| Golden (tuned against) | 100% | 100% | 1.000 |
| **Held-out (never tuned against)** | **73%** | **93%** | **0.822** |

The gap between those rows is the cost of evaluating on what you tuned.

It proved itself immediately. **Contextual chunking** — prepending the page title before embedding, so a mid-page passage carries some trace of where it came from — was measured both ways:

| | Golden set | Held-out set |
| --- | --- | --- |
| Effect | **no rank changed at all** | hit@1 **67% → 73%**, MRR **0.789 → 0.822** |

The golden set literally could not tell the two stores apart. Without the held-out set, a real improvement would have shipped as an unverified guess — or a regression could have shipped the same way.

`npm run eval -- --compare=<dir>` scores both sets against two stores and prints the rank changes, which is how any retrieval change should be judged.

The thresholds in `test/holdout.test.mjs` are set *below* current performance on purpose: they are regression guards, not targets. Tuning until they go green would destroy the only unbiased measurement here and turn it into a second golden set.

## Working memory: follow-up questions

Every question used to be embedded on its own, so *"what about effects?"* carried almost nothing searchable and matched near-randomly. Follow-ups now resolve against the conversation.

**Query rewriting, not concatenation.** Appending the history to the question would produce a vector averaged across several topics that matches none of them well. Instead one cheap model call turns the follow-up into a standalone question:

```
user:    "what are reactive forms?"        → retrieved /guide/forms/reactive-forms
user:    "how do I test it?"
rewrite: "How do I test reactive forms in Angular?"
```

**The rewrite is built from the user's own questions plus the doc paths already retrieved — never from model prose.** That is what keeps retrieval independent of which model is active: if answer text fed the rewrite, switching provider would change what gets found, and comparing providers on identical passages would be meaningless. The rewriter is also **pinned to one provider** regardless of `CHAT_PROVIDER`, for the same reason embeddings are.

### Rewriting is not reliably better — so both formulations are searched

This was measured, and the result was mixed:

| Follow-up | As typed | Rewritten only |
| --- | --- | --- |
| *"how do I test it?"* | `/guide/http/testing` — wrong subject | `/guide/forms/…` — better |
| *"what about validation?"* | `/guide/forms/form-validation` at **rank 1** | dropped out of the top 3 — **worse** |

The second case is the trap: "validation" is already distinctive, and adding "reactive forms" context diluted the embedding toward generic forms pages. No heuristic reliably predicts which formulation wins.

So the system does not choose. **Both the original and the rewritten question are searched, and all four rankings — vector and keyword for each — are fused by RRF.** The machinery already existed. A passage both formulations like rises; one only the better formulation finds still gets in. Cost is one extra embedding call, fractions of a cent.

Result: *"how do I test it?"* now retrieves `/guide/forms/signals/testing`, which **neither formulation found alone**. The `ranks` field in the trace shows each formulation's contribution, e.g. `{"vector:asked":15,"vector:rewritten":4}`.

Rewriting is also skipped entirely when a question already stands alone — it saves a call and avoids the regression above. It fires only on anaphora ("it", "that"), continuations ("what about…"), reformulation requests ("explain more simply"), or very short questions. A rewrite that comes back empty, over-long, or unchanged falls back to the question as typed.

### Three exchanges of history — a deliberate limit

Generation receives the last **3 exchanges** (6 turns). This is a considered choice, not a default: it covers the follow-ups a documentation assistant actually gets — *"explain that more simply"*, *"show me an example"*, *"are you sure?"* — all of which refer to the immediately preceding answer. Older context is not lost, because rewriting folds it into the standalone question. Passing the whole conversation would make every question steadily more expensive and eventually overflow the context window, to serve follow-up types that rarely arise here.

### Switching models mid-conversation

History survives a switch, and **retrieval is unaffected** — the rewriter is pinned and never reads model prose.

Answers written by a *different* model are **labelled** in the generation prompt. Without that, model B reads model A's answer as its own previous turn and inherits it: defending a claim, or standing by a refusal, that it never made. The history is also marked as context for resolving references only, not as a citable source, so a model cannot cite its own earlier prose as evidence.

One interaction worth knowing: a passage's reported `score` is its best similarity across formulations, so follow-ups score slightly higher than first questions. Since confidence thresholds were calibrated on single-question scores, confidence skews a little optimistic on follow-ups.

## Answer confidence

Each answer carries a `high` / `medium` / `low` badge. It is **not** the similarity score, and this repo has the measurement showing why that would mislead:

| Question | Top score | Reality |
| --- | --- | --- |
| `What does CSS stand for?` | 0.457 | Docs cannot answer it |
| `how do I loop over a list in a template?` | 0.475 | Correct answer |

An 0.018 gap. **Similarity measures topical closeness, not whether the answer is present.** A score-based badge would rate an unanswerable question as highly as a real one.

So confidence is composite, in descending order of usefulness:

1. **`status`** — by far the strongest signal. The model has read the passages and stated whether they answer the question; nothing derived from scores beats that.
2. **Citation coverage** — an answer citing nothing is unsupported prose, however well retrieval scored.
3. **Score gap** between the top hit and the rest — a distinctive match stands out; uniformly flat scores mean the corpus had no strong opinion.
4. **Distinct pages** — agreement across several pages is corroboration; everything from one page may be a single well-matched paragraph.

Reported as a level with its reasons attached, deliberately not a percentage: the inputs do not support that precision, and "73% confident" invites trust it has not earned.

Expand **"How this answer was built"** under any answer to see the passages, their similarity scores, the rank each method assigned, and the prompt token count.

### A known limitation: confidence is provider-dependent

Asking *"what about CSS?"* with **identical retrieved passages** produced opposite verdicts:

| Provider | Status | Confidence |
| --- | --- | --- |
| OpenRouter (`llama-3.3-70b-instruct`) | `answered`, cited `[2][3][5]` | **high** |
| OpenAI (`gpt-4o-mini`) | `partial` | **low** |

Since `status` is weighted as the strongest confidence signal, and `status` is the *model's own judgement* about whether the passages answer the question, **confidence inherits that model's calibration**. Switching providers silently shifts the numbers.

This is a genuine weakness, not a bug to hide. It is also not obvious which model was right: *"what about CSS?"* is partly answerable from the Angular styling docs, so Llama answering is defensible, while gpt-4o-mini refusing is arguably over-cautious. (For *"What does CSS stand for?"* — an acronym the docs never expand — refusing is clearly correct.)

The honest reading: confidence is comparable **within** a provider, not **across** providers. A stricter design would calibrate per provider, or weight the score-derived signals more heavily to reduce the dependence on one model's judgement.

Environment configuration:
- Copy `.env.sample` to `.env` and set `OPENAI_API_KEY` there.
- `.env` is ignored by git, so your secret key is not committed.
- If you prefer, you can also set `OPENAI_API_KEY` directly in your shell before running the backend or embeddings build.

The docs corpus and vector store:
- `npm run download-docs` reads `https://angular.dev/sitemap.xml` and downloads the sections listed in `SECTION_ALLOWLIST` in `scripts/docs-source.js`. Currently **114 pages** across Signals, Components, Templates, Directives, DI, Forms, Routing, HTTP, Pipes, Best practices and the essentials. Widening the corpus is a one-line edit to that array.
- **Redirect shells are skipped.** angular.dev has restructured repeatedly, so 21 of the 135 allowlisted URLs now serve only a client-side redirect: a `<meta refresh>` and the line *"Redirecting to /guide/…"*, 24–83 characters long. They were filling the sidebar with entries titled "Redirecting" and the vector store with near-empty passages that could still win a similarity comparison against a short question. Their content lives at the target, which the sitemap lists separately — and 5 of them all pointed at the same page, so *following* them would have created duplicates.
  - The filter checks length **and** wording, because length alone would wrongly drop `/guide/routing/redirecting-routes` — a genuine 4,897-character page *about* redirects.
  - Redirects also **chain**: `/guide/components/importing` → `/guide/components/anatomy-of-components` → `/guide/components`. The scraper resolves chains before reporting whether a target is covered; a one-hop check reported false gaps.
  - Any target falling outside the allowlist is reported as a **warning**, since that topic would otherwise be silently unanswerable. That check is what caught `/guide/signals/rxjs-interop` → `/ecosystem/rxjs-interop`, now added to the allowlist.
- `npm run build-embeddings` produces two files, both gitignored because they are regenerable:
  - `docs/angular/chunks.json` - passage metadata and text (~1.4 MB)
  - `docs/angular/vectors.bin` - raw Float32 vectors, unit-normalised (~2.3 MB)
- Roughly **1,122 passages** at 512 dimensions. Storing vectors as raw Float32 rather than JSON numbers keeps this at 2.3 MB; the same data as JSON would be around 45 MB and would need parsing on every server start.
- `npm run test:unit` runs the offline suites: chunking, vector maths, prompt assembly and the citation guard.

## Switching which model writes the answers

Set `CHAT_PROVIDER` in `.env` and restart the backend. Supported: `openai` (default), `gemini`, `openrouter`, `groq`, `xai`, `ollama`.

All of them speak the OpenAI chat protocol, so the single `openai` package serves every one — adding a provider is a table entry in `server/llm-providers.js`, not a dependency.

```bash
GET /api/providers        # which providers have keys, and what is active
```

A per-request override is also accepted, so providers can be compared without restarting:

```bash
curl -X POST localhost:3000/api/chat -H 'Content-Type: application/json' \
  -d '{"question":"what are signals?","provider":"groq"}'
```

If the requested provider has no key, the server **falls back** to one that does and says so, rather than failing to start or erroring the request.

### Generation is switchable. Embeddings are not.

This asymmetry is the important part:

| | Switchable at runtime? | Why |
| --- | --- | --- |
| **Generation** | **Yes** | The writer receives passages retrieval already chose. Changing it changes only the prose — scores, citations and the golden set are unaffected |
| **Embeddings** | **No** | The store holds 1,136 passages in `text-embedding-3-small`'s 512-dimension space. A different provider's embedding of the same text lands in a *different space*, and comparing across the two produces plausible numbers that mean nothing |

So `OPENAI_API_KEY` is required regardless of `CHAT_PROVIDER` — it embeds the query. Changing the embedding provider means `npm run build-embeddings` **and** `npm run build-golden`, and the server refuses to load a store whose model or dimensions disagree with what it expects rather than silently returning nonsense.

### When a provider fails

Having a key is not the same as being able to use it. Both of these came up in practice:

```
xAI     403  "Your newly created team doesn't have any credits or licenses yet"
Gemini  429  rate limited on a brand-new free-tier key
```

Both keys were valid. One cannot work until credits are bought; the other recovers by itself. Treating them the same would be wrong in both directions — so failures are **classified**, and only permanent ones remove a provider:

| Failure | Kind | Permanent? | Effect |
| --- | --- | --- | --- |
| `403` no credits | `credits` | Yes | Removed from the switcher |
| `401` bad key | `auth` | Yes | Removed |
| `404` unknown model | `model` | Yes | Removed; hint points at `npm run list-models` |
| `429` rate limited | `rate-limit` | **No** | Still offered, marked *(rate limited)*, re-checked after 60s |
| `5xx` / network | `server` | No | Still offered |
| Anything else | `unknown` | No | Still offered |

Getting this backwards produces both classic bugs: a working provider hidden forever because it was briefly rate-limited, or a dead one offered again and again. Unknown failures deliberately **fail open** — a misclassified transient error recovers on its own, whereas a wrongly-permanent one is gone until restart.

An unprobed provider counts as offerable too, so a first run doesn't look empty.

In the UI: unusable providers disappear from the dropdown and a small ⚠ appears beside it, listing what's wrong on hover. Errors reach the user as the readable reason plus what to do — *"Google Gemini could not answer: Rate limited or over the current quota window. You can pick another provider above, or wait a moment and retry."* — rather than a raw status line. After any failure the frontend re-checks health, so a provider that dies mid-conversation stops being selectable.

### What each answer shows

| Badge | Meaning |
| --- | --- |
| Model name | Which provider wrote *that* answer. Recorded per message, because the provider can be switched mid-conversation |
| `high` / `medium` / `low` | Composite confidence — hover for the reasons |
| **How this answer was built** | Each passage with its similarity score, the rank each retrieval method gave it, and the prompt token count |
| Sources vs **Closest pages found** | On a `partial` answer these are not citations, and are labelled accordingly |

### Comparing providers

```bash
npm run compare-providers              # representative subset
npm run compare-providers -- --all     # every golden question
npm run compare-providers -- --only=groq
```

Retrieval runs **once per question**, and every provider is handed the identical passages, in the same order, with the same prompt. Any difference in output is therefore attributable to the model alone — not retrieval luck, not different context. Comparing two providers that each did their own retrieval would confound the writer with the evidence and teach you nothing about either.

The behaviour worth watching is the `weak` case (*"What does CSS stand for?"*): does the model **admit** the passages don't answer the question, or does it pad an answer out of adjacent material? Frontier models usually emit the refusal sentinel correctly; smaller open-weight models often don't, and they cite less reliably. The script reports exactly that, per provider, alongside latency and token counts.

Model IDs are **defaults, not guarantees** — provider naming churns. Override per provider (`GROQ_MODEL`, `GEMINI_MODEL`, …) or globally with `CHAT_MODEL`.

## Safeguards

Most RAG failures don't announce themselves. They return plausible output while being wrong, which makes them expensive to find and cheap to prevent. These are the guards, and what each one prevents.

### The silent one: incompatible vectors

An embedding model maps text into ℝⁿ, and **the axes of that space are arbitrary** — dimension 47 doesn't mean "is about routing". The geometry is an artifact of one training run. Two models produce two unrelated coordinate systems, with no transformation between them, because nothing ever aligned them.

So a cosine similarity between a query vector from model A and passage vectors from model B measures the incidental overlap of two arbitrary bases. **It doesn't throw** — you get numbers in [-1, 1] that look entirely normal, and a confidently wrong ranking. The tell-tale symptom is *the same few passages returned regardless of the question*.

This applies to more than "a different model": same family at a different size (`3-small` vs `3-large`) and the same model at a different dimension count are also different spaces. It's not that two encoders can never share a space — it's that they must be *trained to*, as dense-retrieval architectures do with paired query and passage encoders. Two independently trained models never qualify.

Guarded in six places, because one check is not enough:

| Guard | Prevents |
| --- | --- |
| `chunks.json` records model + dimensions | Ambiguity about what built the store |
| `vectors.bin` byte length validated against `chunks × dims` | A half-written or mismatched store loading anyway |
| `dotProduct` **throws** on a length mismatch | Silently scoring the first N dimensions of two unrelated spaces |
| `embedQuery` reads the model from the store, not a constant | The two drifting apart — it was previously declared twice |
| The golden fixture records model + dimensions and asserts they match | A test suite that passes while measuring nothing |
| `createEmbedder` deliberately does not follow `CHAT_PROVIDER` | Switching the chat model silently corrupting retrieval |

That last one is why changing the embedding provider is a **rebuild** (`build-embeddings` + `build-golden`), never a setting.

A related failure worth knowing, which no guard here can catch: an embedding model trained for **classification** rather than retrieval will also return unrelated results, even used correctly on both sides. Its objective taught it to encode *label identity* and discard intra-class detail, and it never saw query-document pairs — so similarity means "same category", not "answers this". The API surface gives no hint. `text-embedding-3-small` is retrieval-trained, which is why inferential queries work here at all.

### Answer integrity

| Guard | Prevents |
| --- | --- |
| Score floor → refusal **without a model call** | Answering off-topic questions from the model's own memory. Also makes refusals free |
| Citations outside the supplied range are stripped | An invented source that looks verified — worse than no citation |
| Explicit `NO_ANSWER_IN_DOCS` sentinel | Inferring failure from missing citations, which breaks whenever a model answers correctly without citing |
| History marked "not a citable source" | A model citing its own earlier prose as evidence |
| Answers from another model are labelled | Model B inheriting model A's claims — defending an answer, or standing by a refusal, it never made |
| Implausible rewrites fall back to the question as typed | A model that answers instead of rewriting poisoning retrieval |

### Resilience

| Guard | Prevents |
| --- | --- |
| 30-second timeout on every model call | A hung provider holding the request open indefinitely — there is no upstream deadline to fall back on |
| Up to 3 attempts with exponential backoff | A single 429 failing a request that one retry would have satisfied |
| **Permanent failures are not retried** | Wasting the user's time on backoff to reach the same error. No credits, revoked key and unknown model fail on the first attempt |
| Question capped at 2,000 characters | A 50,000-character body going straight into an embedding call and the prompt |
| History bounded server-side | The same blowout via a different field — history is client-supplied, so the frontend's 3-exchange limit is enforced again on arrival rather than trusted |

Retry reuses the classification from `provider-health.js`, which is what makes it selective. Retrying everything, or nothing, would both be wrong.

The retry loop is tested against the real code path — `createLlm` accepts an injectable client for exactly that reason. A test that re-implements the logic it checks only proves the copy works.

### Continuous integration

`.github/workflows/ci.yml` runs the pipeline suites, the Angular component tests, a production build, and the retrieval golden set on every push and PR.

One caveat stated deliberately: **the vector store is gitignored**, since producing it needs an API key. So on CI it is absent and the golden set **skips its assertions** — a green build does *not* mean hit@3 was verified. Rather than let that hide behind a checkmark, the workflow emits a warning annotation saying retrieval was not measured. To make CI genuinely enforce it, either commit `docs/angular/{chunks.json,vectors.bin}` (~3.6 MB) or add a key secret and build them in CI, at roughly a cent per run.

### Remaining gaps

| Gap | Risk |
| --- | --- |
| **No spend ceiling or rate limiting** | Low risk locally, real once exposed |
| **Contradiction blind spot** | Passages are selected for similarity, never for agreeing with each other. Version drift, or a deprecated API beside its replacement, can put conflicting claims in one prompt — and a model faithfully reproduces both. The citation guard catches *invented* sources and is blind to *conflicting* ones |
| **No question logging** | No record of what is actually asked, so the golden set stays fifteen guesses |
| **Confidence is provider-dependent** | See the limitation noted above |
| **Prompt injection from documents** | `<script>` and `<style>` are stripped at scrape time, but not *text*. A page containing "ignore previous instructions" would enter the prompt as trusted context. Low risk from angular.dev, but retrieved content is third-party input by definition |
| **Citation attribution unverified** | The guard checks `[n]` refers to a *supplied* passage, not that the claim came from passage *n* |
| **Lost in the middle** | Models attend least to the middle of a long context. Passages are ordered by fused rank, with no attention paid to position |
| **Code samples split across chunks** | Chunking splits on blank lines and ignores fenced code — an 80-line example lands in two passages. Bad for a documentation assistant, where the code often *is* the answer |

Live status for all of these is on the Overview page, from `src/app/roadmap.data.ts`.

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

**The running server notices.** Every scrape rewrites `manifest.json`, and the backend watches its mtime to clear the page, structure and vector caches. Without that, a re-scrape appeared to do nothing — a fixed duplicate-heading bug looked unfixed for a while purely because the old HTML was still cached in memory.

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
- Prototype created with assistance from Claude Code and Copilot CLI runtime in VS Code.

License: MIT 
