# Angular Docs Wiki Chatbot (RAG prototype)

An Angular documentation assistant built with Retrieval-Augmented Generation. Ask it a question about Angular and it answers from a local copy of the official docs, citing the pages it used — or tells you plainly when the docs don't cover it.

- **Frontend** — Angular 22 app: docs browser plus a chat rail that survives navigation
- **Backend** — Fastify server: serves the local corpus and exposes `/api/chat` and `/api/chat/stream`
- **Corpus** — 114 Angular docs pages under `docs/angular/`, ~1,122 indexed passages

> **📘 [LEARN-RAG.md](LEARN-RAG.md) — design choices and reasoning while learning how to build a RAG chatbot.**
>
> Why chunks are 1,200 characters, why cosine similarity collapses to a dot product, why confidence can't be a similarity score, why comparing vectors from two models fails silently, and the evaluation mistake that made a 100% score meaningless. Every claim there is backed by a measurement from this corpus.

> **🧪 [TESTING-A-RAG.md](TESTING-A-RAG.md) — how to know you built the right thing.**
>
> The deterministic/stochastic split that makes RAG testable at all, golden vs held-out sets, hit@k and MRR and what each hides, adversarial testing against the weakest model you support, and how to tell when your *measurement* is the broken thing. Written to apply to any RAG system, not just this one.

Numbers in both are labelled ⚙️ (general) or 📐 (measured on this corpus — re-measure for yours), so nothing is carried over as a rule that was only ever a local result.

A companion construction guide, *Building a RAG chatbot in Python*, is kept outside this repo — it is language- and corpus-agnostic, so it does not belong to the Angular prototype.

---

## Quick start

```bash
npm install
```

Configure a key — `OPENAI_API_KEY` is required, since it powers embeddings:

```bash
copy .env.sample .env      # then edit it
```

Build the corpus and index (the only steps that cost money — about a cent):

```bash
npm run download-docs      # ~114 pages from angular.dev
npm run build-embeddings   # ~1,122 passages -> chunks.json + vectors.bin
```

Run it, in two terminals:

```bash
npm run start-backend      # http://localhost:3000
npm start                  # http://localhost:4200
```

Open `http://localhost:4200`. The assistant is docked on the right and stays open as you browse.

## First look

Three questions that exercise the three outcomes, as a smoke test — **not** as the
testing story. That lives in [Testing](#testing) and is a great deal larger.

| Ask this | Outcome | What you should see |
| --- | --- | --- |
| `what is Angular?` | **answered** | A grounded answer citing `/overview` |
| `got milk?` | **refused** | Zero passages clear the similarity floor, so the model is **never called** — the refusal is free and cannot be a guess |
| `what is CSS?` | **partial** | Passages *do* clear the floor (the styling pages discuss CSS), but none define the acronym — so it says so and cites nothing |

The third is the interesting one: no similarity threshold can separate it from a
real question, so the generation layer has to. [Why →](LEARN-RAG.md#three-outcomes-not-two)

Answers **stream** as they are written, with a **Stop** control to abandon one mid-flight, and the conversation survives a page refresh. **New topic** clears it and starts fresh.

A **Voice** switcher changes how answers are written — Tutor, LOLcatz or Yoda. Presentation only: the grounding rules are byte-identical across every voice, which a test enforces. The silly ones are not just a joke — they make it visible that the facts, citations and refusals are the same whether the assistant sounds like a reference manual or a cat. [The null result that produced them →](LEARN-RAG.md#personality-and-the-null-result-that-was-my-fault)

Each answer shows the model that wrote it, a confidence badge, a thumbs up/down, and a collapsible **"How this answer was built"** with every passage, its score, the rank each retrieval method gave it, and the token count.

Two checks run after the model writes:

- **Citation attribution**, not just range — if a sentence credits a page that does not contain the API name it mentions, confidence is capped at `low`. That caught a real case: an `*ngIf` claim cited to a content-projection passage, none of whose passages mention `ngIf`. A wrong *passage* of the right *page* is reported more gently, because sources are surfaced per page so the reader still lands where the claim is.
- **Code samples** — a miscased API name, or one sample mixing a legacy API with the function that supersedes it. Canonical casing is derived from the corpus rather than curated.

Both report and never rewrite: correcting `@component` silently would hide that the model produced code it could not be trusted to get right. [How they work, and the companion check measurement rejected →](LEARN-RAG.md#attribution-checking-the-citation-points-at-the-right-passage)

Questions are logged to `data/` (gitignored) so `npm run questions` can show what's actually being asked and which answers were rated unhelpful — the eval sets are 30 questions someone invented, and real usage is the only way to improve on that. Disable with `QUESTION_LOG=off`. [Why ratings outrank confidence →](LEARN-RAG.md#ratings-outrank-every-automatic-signal)

## Commands

| Command | What it does | Cost |
| --- | --- | --- |
| `npm start` | Frontend dev server | — |
| `npm run start-backend` | Fastify backend on :3000 | — |
| `npm test` | Angular component tests | — |
| `npm run test:unit` | Every pipeline suite in `test/unit/` — see [Testing](#testing) | free, offline |
| `npm run test:retrieval` | Golden-set retrieval quality, from cached vectors | free, offline |
| `npm run eval` | Score both eval sets; `--compare=DIR` A/Bs two stores | free, offline |
| `npm run download-docs` | Re-scrape the corpus | free |
| `npm run build-embeddings` | Rebuild the index | ~$0.01 |
| `npm run docs:check` | What changed upstream, without writing anything | free |
| `npm run docs:update` | Apply changes, re-embedding only what moved | pennies |
| `npm run list-models` | Ask each provider what models it offers | free |
| `npm run compare-providers` | Same passages, different writers | ~$0.01 |
| `npm run check-attribution` | Do cited passages contain the APIs credited to them? | ~$0.02 |
| `npm run eval:answers` | Score the answers: status, must-mention, citations; `--runs=N` averages | ~$0.02 |
| `npm run eval:rerank` | A/B reranking against plain retrieval on both eval sets | ~$0.01 |
| `npm run questions` | What was asked, and which answers were rated unhelpful | free |

## Cost controls

Two independent limits, because they bound different things — a rate limit caps how *fast* the balance can be spent, not the total.

| Setting | Default | What it does |
| --- | --- | --- |
| `RATE_LIMIT_PER_MINUTE` | `20` | Token bucket per caller on `/api/chat`. `0` disables |
| `RATE_LIMIT_BURST` | `5` | How many can arrive at once before throttling |
| `DAILY_SPEND_USD` | unset | Daily ceiling, enforced before each call. Unset or `0` disables |

## Retrieval and voice

| Setting | Default | What it does |
| --- | --- | --- |
| `RERANK` | on | A second pass that reorders retrieved passages. `off` reverts to plain vector ordering |
| `RERANK_CANDIDATES` | `10` | How many passages to rerank. Measured: recall is already 100% at 10 on this corpus, and widening only adds noise |
| `RERANK_PROVIDER` | `openai` | Pinned separately from `CHAT_PROVIDER`, because reranking changes **retrieval** |
| `ANSWER_STYLE` | `tutor` | How answers are written — `tutor`, `lolcat`, `yoda`, or `concise` (the measurement baseline, not offered in the UI) |

Reranking took held-out hit@1 from 73% to 87%. The candidate count came from a
free offline measurement rather than the conventional advice, which would have
been strictly worse here. [How →](LEARN-RAG.md#reranking-measure-the-ceiling-before-you-build-the-thing)

Exceeding them returns `429` (slow down, retry) or `402` (budget gone, do not retry) — deliberately different, because they call for different client behaviour. Both are reported on `/api/providers` before they fire, and the spend ledger persists to `data/spend.json` so a restart cannot reset it.

Cost is estimated from a static price table that will go stale; the token counts beneath it come from the provider and are exact. An unrecognised model is priced at the most expensive known rate, so adding a provider cannot silently switch the ceiling off. [Why that matters →](LEARN-RAG.md#bounding-cost-two-controls-because-they-bound-different-things)

## Switching the model

Set `CHAT_PROVIDER` in `.env` — `openai` (default), `gemini`, `openrouter`, `groq`, `xai`, or a local `ollama`. All speak the OpenAI protocol, so one SDK serves them all.

There's also a dropdown in the chat rail, and a per-request override:

```bash
curl -X POST localhost:3000/api/chat -H 'Content-Type: application/json' \
  -d '{"question":"what are signals?","provider":"openrouter"}'
```

**`OPENAI_API_KEY` stays required regardless**, because it embeds the query. Generation is switchable; embeddings are not — the store fixes the embedding space, so changing it is a rebuild rather than a setting. [Why →](LEARN-RAG.md#the-failure-that-returns-plausible-numbers)

If a provider's key is missing the server falls back to one that works and says so. Providers that fail permanently — no credits, revoked key — disappear from the switcher; rate-limited ones stay, marked. [Details →](LEARN-RAG.md#silent-failures)

## Keeping the docs current

```bash
npm run docs:check     # report only: no writes, no API calls, no cost
npm run docs:update    # apply, re-embedding only what changed
```

`docs:check` prints the version you captured, what angular.dev serves now, which Angular releases have landed since, and exactly which pages differ.

The design principle: **fetching pages is free, embedding them is not.** So every page is fetched and hashed each run, while the API budget goes only to pages whose text actually moved. Unchanged pages keep their existing vectors. A run finding three changed pages embeds ~25 passages rather than all 1,122.

The server watches `manifest.json` and clears its caches when the corpus changes, so a re-scrape is picked up without a restart.

## How well does it work?

| Set | hit@1 | hit@3 | MRR |
| --- | --- | --- | --- |
| Golden (tuned against) | 100% | 100% | 1.000 |
| Held-out, vector retrieval only | 73% | 93% | 0.822 |
| **Held-out, with reranking** | **87%** | **100%** | **0.922** |

**The held-out rows are the honest ones.** The golden set was used while tuning retrieval, so its perfect score describes the tuning rather than the system — and being saturated, it reported *no change at all* for reranking. [The full story →](LEARN-RAG.md#evaluating-a-rag-system)

Reranking was built only after a free offline measurement showed it could work: the correct page was in the top 10 for **every** held-out question but first for only 73%, so the whole loss was ordering. The same measurement set the candidate count at 10 rather than the conventional 30–50, which on this corpus adds no recall and only noise. [How →](LEARN-RAG.md#reranking-measure-the-ceiling-before-you-build-the-thing)

Known gaps are listed in [LEARN-RAG.md](LEARN-RAG.md#what-is-still-wrong), and live status is on the Overview page in the running app, from `src/app/roadmap.data.ts`.

## Testing

**[TESTING-A-RAG.md](TESTING-A-RAG.md) is the real document here** — the reasoning,
the techniques, and the failures that produced them. This section says only where
the tests live and what ground each part covers.

Deliberately no test count: the last one in this file said 162 and was wrong
within days. Counts rot; structure does not.

### Where they are

| Location | Ground covered | Runs |
| --- | --- | --- |
| `test/unit/` | Pure logic, one suite per concern — chunking, vectors, hybrid fusion, prompts, retries, memory, injection, sanitising, attribution, code samples, answer quality and styles, rerank, question log, rate limit, spend ceiling, sources, streaming | free, offline |
| `test/retrieval.test.mjs` | Golden set: hit@k and MRR against cached question vectors | free, offline |
| `test/holdout.test.mjs` | Held-out set, plus the regression floors and an assertion that it stays *harder* than the golden set | free, offline |
| `test/golden-set.mjs`, `holdout-set.mjs`, `answer-rubrics.mjs` | The data — questions, acceptable pages, and what a correct answer must say | — |
| `src/app/*.spec.ts` | Frontend: conversation persistence and store wiring | free, offline |

Everything above is free and offline. Question vectors are cached and committed,
so retrieval quality is measured with dot products rather than API calls.

### What costs money, and is therefore a script

Measurement that needs a real model cannot gate a commit, so it lives in
`scripts/` and is run deliberately:

| Script | Question it answers |
| --- | --- |
| `npm run eval` | Did retrieval get better or worse? `--compare=DIR` A/Bs two stores |
| `npm run eval:answers` | Was the *answer* right — status, must-mention, citations |
| `npm run eval:rerank` | Is reranking earning its place? |
| `npm run check-attribution` | Do cited passages contain what they are credited with? |
| `npm run compare-providers` | Same passages, different writers |

### Two things worth knowing before trusting a green build

**The vector store is gitignored**, because building it needs a key. On CI the
retrieval suites therefore **skip their assertions** — a green build does not mean
hit@3 was verified, and the workflow prints a warning saying so.

**Whole categories of defect have never been caught by a test here.** Every
response-hygiene and UI bug in this project was found by a human looking at a
screen — duplicate source links, a composer below the fold, a header overlapping
itself, answers vanishing on reload. That is not an argument for more UI tests so
much as for knowing which categories a suite structurally cannot reach.
[The category map, and where this project is still weak →](TESTING-A-RAG.md#the-category-map-where-the-failures-actually-live)

## Project layout

```
server/
  rag.js                  chunking, vector maths, prompts, generation - pure functions
  index.js                Fastify routes
  llm-providers.js        provider registry, timeout, retry, streaming
  provider-health.js      permanent vs transient failure classification
  build-vector-store.js   chunks.json + vectors.bin
  injection-guard.js      neutralise, delimit, detect
  answer-checks.js        citation attribution, code-sample validation
  answer-quality.js       scoring an answer against a rubric
  api-pairs.js            superseded APIs the corpus does not flag itself
  question-log.js         append-only log of what was asked, and ratings
  rate-limit.js           token bucket per caller
  spend-limit.js          daily ceiling, persisted
scripts/
  docs-source.js          shared scraping, allowlist, sanitising, hashing
  fetch-angular-docs.js   full rebuild
  update-docs.js          incremental update
  eval-retrieval.js       score and A/B the eval sets
  eval-answers.js         score the answers, not the retrieval
  check-attribution.js    do cited passages contain what they are credited with
  compare-providers.js    same passages, different writers
test/
  golden-set.mjs          15 questions used for tuning
  holdout-set.mjs         15 questions NEVER used for tuning
  answer-rubrics.mjs      what a correct answer must say, per question
  unit/                   pure-logic suites
src/app/
  chat.store.ts           conversation state (signals, root-scoped)
  chat.service.ts         HTTP, including the SSE stream client
  conversation-storage.ts persistence: serialise, deserialise, trim
  chat-panel.component    the docked rail
  roadmap.data.ts         single source of truth for project status
```

## Environment

See `.env.sample`. `OPENAI_API_KEY` is required; `GEMINI_API_KEY`, `OPENROUTER_API_KEY` and `XAI_API_KEY` are optional and affect only which model writes answers.

Never commit `.env` — it is gitignored, and a key pasted anywhere should be treated as public and rotated.

## License

MIT
