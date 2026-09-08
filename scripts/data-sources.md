# Modelproof — autonomous data sourcing: the source registry & ensemble design

_Added 2026-07-24. Companion to `refresh.md` (which covers the schema and the manual refresh).
This file covers **where numbers come from, which ones a machine may collect on its own, and how
sources get combined.** Design only — the collectors are not built yet; see "Build plan"._

## The goal

Keep Modelproof carrying **accurate performance-vs-price data for the models people actually use,
at or shortly after the moment that data becomes public** — pulled automatically, from whatever
mix of credible sources covers the ground, rather than from one vendor's launch chart.

## The rule that makes it worth reading

**The machine collects. A human publishes.** This is not caution for its own sake — it is the
entire product. Modelproof's value is that a number on the page is a number somebody checked, and
a blank is an honest blank. A bot writing benchmark scores straight to the live site would make it
one more scraped aggregator, which is the thing it exists not to be.

So "autonomous" here means: the pipeline finds new models and new figures on its own, opens a PR
with sources attached and nothing yet asserted, and a human clicks through. Automation removes the
*searching*, never the *vouching*.

What the machine **may** write autonomously (still via PR):
- That a new model **exists** — name, vendor, release date, API id.
- `releases[]` entries, with the source URL.
- **List prices** scraped from the vendor's own official pricing page (deterministic, one known
  page per vendor). Prices are published facts with a single authoritative source.

  **On aggregators — learned the hard way, 2026-07-29.** OpenRouter is Tier A for *model existence*
  and useless for *list price*: it aggregates provider prices, which include fast tiers, priority
  routing, regional endpoints and pass-throughs. The weekly drift check used to flag any gap > 20%
  against it. On 2026-07-29 it fired 8 times and was **wrong 8 times out of 8** — every one of our
  figures was already correct against the vendor's own page. That noise is why the PR went unread
  for two days, which is worse than having no alarm at all. The check now keys off our own
  `price_checked` record (vendor URL + date + the figures confirmed there) and stays silent for
  anything verified inside 90 days, whatever OpenRouter says.
- The `auto_checked` date, flags, and reviewer checklists.

What it **may not**, ever:
- Any figure **derived by inference** — averaging suites, interpolating a rung, modelling cost from
  list prices, reconciling two sources that disagree. Blank beats guessed stays absolute.
- Any `coding_score`, `confidence` upgrade, or `verdict`. Those are judgements, not facts.
- **Overwriting a figure that is already published.** See the fill-vs-change rule below.

### The rule redrawn: provenance, not field type (2026-07-29)

This file used to ban benchmark scores and ladder points *by field name*. That line was in the wrong
place. Copying a rung verbatim out of Epoch's CC-BY export is the same kind of act as scraping a
vendor's list price — one authoritative source, a stable identifier, no interpretation — and list
prices were already allowed. Meanwhile the ban did nothing about the actual risk, which is
**derivation**, and it forced a human to hand-transcribe numbers, which is the step most likely to
introduce an error.

So the test is no longer *which field* but **where the number came from and what was done to it**:

> A machine may write a figure it copied **verbatim** from a **Tier-A source** with a **stable
> identifier**, provided it attaches the source URL and the retrieval date. It may never compute,
> average, interpolate, reconcile, or round one.

**Fill vs. change — the guard that makes this safe.** These are not the same risk:
- **Filling a blank** may land automatically. Nothing on the page changes meaning; a cell goes from
  absent to sourced.
- **Changing a number that already published** always stops for a human. An upstream methodology
  revision, a re-run, or a renamed model id must never silently rewrite a figure a reader may
  already have acted on. The PR states the old value, the new one, and why.

`validate-data.mjs` was always doing the real work here — provenance per ladder, a licence tier per
host, no blank points, no duplicate rungs, correct effort order. The field-name ban was
belt-and-braces that cost more than it caught.

## Source registry

### Tier A — republishable + machine-readable (the spine)

These carry a published licence that permits redistribution with credit. No negotiation, no spend.

| Source | Licence | What it gives | Access |
|---|---|---|---|
| **Epoch AI Benchmarking Hub** | **CC-BY** — "free to use, distribute, and reproduce provided the source and authors are credited" | Benchmark results **joined to pricing → cost per task**. Mix of evals Epoch runs itself (GPQA Diamond, OTIS Mock AIME, SWE-bench Verified, FrontierMath) and external leaderboards it mirrors. **CursorBench** entries are per-reasoning-effort rungs with avg cost + tokens + steps per task. | CSV download; `pip install epochai` client over the Airtable API (preserves relationships the CSV flattens) |
| **Terminal-Bench 2.0 / 2.1** | **Apache 2.0** | Independent, audited, cross-lab agentic scores with **avg cost per task in USD**, broken down by input / cache-hit / cache-write / reasoning / answer tokens. Public trajectories. | `tbench.ai` leaderboard; HF dataset `harborframework/terminal-bench-2.0`; GitHub `harbor-framework/*` |
| **Aider Polyglot** | **Apache 2.0** (via Epoch's mirror) | Coding scores, cost per run | Epoch hub |
| **OpenRouter** | Public API | Live provider prices + model IDs + usage volume. **No scores.** | `https://openrouter.ai/api/v1/models` — already wired as the price-drift alarm |

**Attribution is a build requirement, not a footnote.** CC-BY and Apache 2.0 both require credit.
The panel already renders `publisher` / `source` / `method` per ladder, so compliance falls out of
the existing design — but each Tier-A source also needs a line in the site's credits.

### Tier B — cite, don't ingest

Usable as a **linked citation for a handful of figures** (ordinary editorial practice; individual
facts aren't copyrightable). Not usable as a systematic feed.

- **Artificial Analysis** — the best-shaped data of anyone: Intelligence Index vs cost per task,
  with **separate per-effort entries** (Opus 5 xhigh = 60, max = 61; $2,909.91 / $3,835.51 to run
  the index, as of 2026-07-24). But: free tier is **internal use only, no redistribution**; Pro is
  single-seat; redistribution needs the **Commercial** tier, whose **price is not published**
  ("contact us", no free trial). Also runs paid pre-release evals *with* the labs. → cite in
  `sources[]`, never as a ladder feed without a Commercial licence.
- **llm-stats.com** — 334 models, aggregates benchmarks + provider pricing + live throughput, has
  a REST API and MCP. But redistribution terms are unpublished, and it's an aggregator (thinner
  provenance than whoever ran the eval). Useful for *discovery* — "who's published a number we
  don't have" — not as a cited authority.
- **LMArena** — human-preference Elo. No cost axis, no effort rungs. Already used as its own
  separate signal in `usage.lenses`; keep it there.
- **vals.ai** — genuinely independent evals in regulated domains, but sells private eval
  infrastructure to the labs (same conflict class as AA). Licence unpublished. Watch, don't ingest.

### Tier C — vendor primary sources

Lab launch posts, model cards, pricing pages. **Fastest at launch and the most conflicted** — this
is how Opus 5 and the Frontier-Bench ladder got in. Always usable, always labelled
`source_kind: "vendor-reported"`, and never the only source once a Tier-A number exists.

## Ensemble rules

The instinct to merge everything into one number is the thing to resist.

1. **Never average across suites.** Different harness, different scaffold, different task set —
   a mean of two is a number that describes nothing. Each suite stays whole and separate; the
   panel's suite picker lets the reader flip between them.
2. **Agreement is the product.** When two independently-published ladders agree on **shape** —
   e.g. Opus 5 peaking at `xhigh` and paying more for less at `max` — surface that agreement. It
   carries credibility neither source has alone. That's the real answer to the vendor-benchmark
   problem: not finding one pristine source, but showing corroboration.
3. **Disagreement gets shown, not resolved.** If Epoch and Anthropic rank differently, that IS
   the finding. Silently picking a winner is how aggregators lose their credibility.
4. **Precedence, for single scalar fields only** (price, `swe_bench`, context window):
   official vendor page → independent re-run → vendor-reported benchmark → aggregator.
5. **Provenance travels with the number**, per-field, not per-model. A model can hold a
   vendor-reported coding score and a Tier-A price at the same time; the page must say which is which.

## Cadence — how "breaking news" actually works

The launch-day problem: a model drops and *nobody* — vendor included — has published cost-per-task
at each effort rung. Independent numbers lag days to weeks. So the pipeline is two-speed:

**1. Launch detector (daily).** Poll the cheap, fast signals for model IDs we don't have:
OpenRouter's models API (new IDs appear at or near launch), vendor pricing pages, Epoch's hub
index. On a hit → open a PR the same day with a **stub entry**: name, vendor, date, API id, list
price if the official page gives it — and **every benchmark null, `confidence: low`**. The site
shows the model as *present, figures pending* rather than absent or guessed.

**2. Backfill watcher (weekly).** For every null on every model, re-check the Tier-A sources. Each
time one publishes, propose that single field with its source URL attached. `coding_confidence`
gets proposed for promotion only when a real SWE-bench Verified number lands — the existing rule.

That is the honest version of breaking-news: **day-0 presence with visible blanks, day-N accuracy
as real numbers land** — and the blanks themselves are informative, because "nobody independent has
benchmarked this yet" is exactly what a buyer needs to know in week one.

## Honesty gates to extend (`validate-data.mjs`)

- Every source used must resolve to an entry in this registry, with its `licence` and `tier`.
- Tier-B sources may appear in `sources[]` but must **fail the build** if used as a ladder feed.
- Stub models must have all-null benchmarks — a stub with a score is a bug, not a shortcut.
- Ladders keep the existing five mandatory provenance fields, plus `licence` and `attribution`.

## Build plan

| Phase | What | Status |
|---|---|---|
| 0 | Source registry + ensemble rules (this file) | ✅ done |
| 1 | `sources.json` — machine-readable registry (id, tier, licence, attribution, hosts, endpoint) | ✅ done 2026-07-25 |
| 2 | `collect-epoch.mjs` — pull CC-BY export, map to our model ids, emit **proposed** ladder + backfill | ✅ done 2026-07-25 |
| 3 | `refresh-auto.mjs` extended: launch detector + price drift + backfill watcher | ✅ done 2026-07-25 |
| 4 | `validate-data.mjs` registry/tier/stub gates | ✅ done 2026-07-25 |
| 5 | Site credits line for CC-BY / Apache-2.0 attribution | ✅ done 2026-07-25 |

Every endpoint in `sources.json` was fetched and confirmed live on 2026-07-25 before being written
down, which is why phases 1–3 waited for network access rather than being guessed at.

## How to run it

```
node scripts/collect-epoch.mjs          # what Epoch publishes vs what we ship — proposes, never writes
node scripts/collect-epoch.mjs --json   # same, machine-readable
node scripts/refresh-auto.mjs           # the full weekly pass; writes docs/auto-refresh-report.md
node scripts/validate-data.mjs          # the honesty gate; exits non-zero on any error
```

Behind a proxy, prefix with `NODE_USE_ENV_PROXY=1` — Node does not read proxy env vars for `fetch`
on its own. CI needs no such flag.

## Two decisions worth knowing about

**The launch detector proposes a stub, it does not write one.** The design allows the machine to
record that a model *exists*. In practice OpenRouter's name and date fields are provider
pass-through and are routinely wrong or placeholder in the first days after a launch — exactly when
the detector fires. Auto-inserting them would put unverified strings on the page, so the report
carries a paste-ready stub instead and a human confirms the name against the vendor's own page.
Merging still requires a human either way, so this costs no time and removes the failure mode.
Reversible if it proves too conservative.

**The bot no longer writes `CHANGES.md`.** It used to overwrite that file wholesale on every run,
which would have destroyed the human decision log one week at a time. Its report now goes to
`docs/auto-refresh-report.md`, and the workflow reads the PR body from there.

## Availability + plans (added 2026-09-06, engine round 2)

Two new facts, same rule: sourced or blank.

**`availability{}` on every model** (`scripts/derive-availability.mjs`, run as part of Collect —
`scripts/auto-refresh.mjs` calls it every full pass, so it stays at most a day stale):

- `openrouter` — exact membership check against the OpenRouter feed Collect already fetches (the
  same id/name/alias match used for price facts). This is the one field allowed to be a definite
  `false`: the feed is a complete live snapshot, so absence is a real, checked fact.
- `direct_api` — `true` + a source URL only when the model already has one of its own vendor's
  domains on file (`price_checked.url` or `sources[]`) for one of the vendors this v1 covers
  (Anthropic, OpenAI, Google, xAI, Mistral, DeepSeek, Moonshot, Alibaba/Qwen, Z.ai — see
  `VENDOR_DOMAINS` in the script). `null`, never `false`, when no such URL is on file — plenty of
  vendors on that list simply haven't had their pricing page cited yet on a given model.
- `open_weights` — `true` when OpenRouter's own entry for the model carries a `hugging_face_id`,
  or the catalog's existing prose already says "open weight(s)". `null`, never `false` — most
  vendors are closed by default and a text-search miss proves nothing.
- `aws_bedrock` — `true` + source only on an exact id/name match against **AWS's Price List API**
  (`https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrock/current/us-east-1/index.json`),
  which is public, unauthenticated JSON with a `products[].attributes.model` field per SKU — unlike
  the Bedrock `ListFoundationModels` API (needs signed AWS credentials) or the models-supported
  docs page (HTML table, no stable structure). Checked live 2026-09-06: of the 68 catalog models,
  only 1 (`x-ai-grok-4-6`, listed as `xai.grok-4.6`) matched — Bedrock's model rollout lags most
  frontier launches, which is itself the honest finding, not a bug in the matcher.
- `google_vertex`, `azure` — **null for every model in v1.** Tried within budget and found no
  public, unauthenticated, machine-readable list: Vertex's Model Garden listing needs an
  authenticated `aiplatform.googleapis.com` call (`GET .../publishers/google/models` 404s with no
  token); Azure AI Foundry's catalog lives across thousands of per-model `spec.yaml` files in the
  `Azure/azureml-assets` GitHub repo with no manifest, and its API needs an authenticated
  `ai.azure.com` session. Candidate URLs for whoever revisits this:
  `https://docs.aws.amazon.com/bedrock/latest/userguide/models-supported.html` (AWS's own docs
  page, HTML only — the Price List API above is the workaround), the Vertex `aiplatform.googleapis.com`
  publisher-models endpoint (needs an API key/OAuth token), and the `Azure/azureml-assets` repo on
  GitHub (needs a real crawl, not a single fetch).
- `eu_hosting` — null unless sourced; no automated method yet.
- A field already `true` from a prior run is never regressed to `null`/`false` by a run that
  simply couldn't re-derive it (a failed fetch, a renamed vendor field) — same fill-vs-change
  spirit as the rest of this file.

**`data/plans.json`** — seat/subscription pricing for Anthropic, OpenAI, Google, xAI, Cursor, and
GitHub Copilot. Refreshed manually (`scripts/refresh-plans.md`): fetch each vendor's own pricing
page with `curl`, read the price straight out of the returned HTML, and set `price_usd_month:
null` when the number isn't actually in that HTML — several vendors render prices client-side
(OpenAI's ChatGPT pricing page has zero digits in its static HTML; Cursor's Pro+/Ultra and Teams
Premium tiers share a JS-toggled price display with their base tier). Google, Anthropic, xAI, and
GitHub Copilot's own pages, by contrast, render every number server-side. Every entry carries the
`source_url` it was read from and an `as_of` date; `scripts/validate-data.mjs` rejects any entry
with a price and no source, or a non-URL `source_url`.

## Judged task fit + usage (added 2026-09-06/07, engine round 3)

Two more fields, same rule: sourced or blank.

**`task_fit_judged{}`** on every model — a per-task, sourced qualitative fit (band + confidence +
`claims[]`) that fills the gap when `task_fit`'s quantitative score is null (`scripts/refresh-judge.md`
carries the full writing rules; `scripts/validate-data.mjs` gates the shape and bans relative
phrasing in the Judge's own prose; `scripts/check-sources.mjs` is the separate live-fetch gate that
confirms every `quote` is actually on its cited page — the one no wording rule alone can enforce,
since a well-formed claim can still misquote or fabricate a source). `assets/decide.mjs`'s rule 3
uses this only when the quantitative score is missing; see that file for the exact precedence and
scoring.

**`usage.openrouter`** — per-model token-volume share + rank, the machine-readable usage source
this schema asked for. What was tried, in order:

1. **`openrouter.ai/api/v1/models`** (the existing Tier-A price/model-id feed, `scripts/sources.json`) —
   confirmed to carry pricing and model metadata only, no usage/volume field. Ruled out immediately.
2. **`openrouter.ai/rankings`** (the public rankings page) — HTML only in its initial response, no
   embedded JSON blob (`__NEXT_DATA__` or similar) to read instead of scraping the rendered page.
   Scraping brittle HTML is explicitly against this file's own rule — ruled out.
3. **`openrouter.ai/api/frontend/v1/rankings/models`** — found by reading the network requests the
   rankings page itself makes (the same JSON the page renders from). Confirmed live 2026-09-06:
   unauthenticated `GET`, returns `{"data": [{"date", "model_permaslug", "variant",
   "total_prompt_tokens", "total_completion_tokens", "count", ...}]}` — one row per
   (model, variant) for the day, across OpenRouter's **entire** tracked catalog. **Used.** It is
   the JSON the task explicitly named as a candidate ("a JSON behind openrouter.ai/rankings"), and
   every field it returns is copied, not scraped from rendered markup.

   **Caveat, stated plainly:** unlike `/api/v1/models`, this endpoint is not documented at
   `openrouter.ai/docs` — it's the frontend's own internal API, discovered rather than published,
   so it carries no stability guarantee and could change shape or disappear without notice.
   `scripts/derive-usage.mjs` treats a failed/reshaped fetch as "nothing to report this run," never
   as "usage dropped to zero" (same fill-vs-change spirit as availability above). If this endpoint
   ever breaks for good, the fallback is back to option 2 (a real HTML scrape) or watching for
   OpenRouter to document a real usage API — worth a note in the PR that finds it broken.

   **The arithmetic** (why this is collection, not judgment, under this file's "provenance, not
   field type" rule): `share` is one model's `(total_prompt_tokens + total_completion_tokens)` as a
   percentage of that same sum across every row the endpoint returns that day — one division of
   two directly-fetched numbers, not an average, interpolation, or reconciliation across sources.
   `rank` is that model's position sorted by the same total among the **whole** feed, including
   rows that never match our catalog — a more honest "where does this model sit" than ranking only
   among the ~65 models we happen to track. `category` is always `"overall"`: the endpoint reports
   total volume, not a task-specific breakdown (a `?category=` query param was tried and returned
   identical data regardless of value — not a real filter, so never assume one), and inventing a
   per-task split the source doesn't give would be exactly the kind of guess this file exists to
   forbid.

   Collected every full Collect run (`scripts/auto-refresh.mjs`, right after availability); the
   first live pass (2026-09-06) matched 58 of the catalog's 67 models.

## How to run these two

```
node scripts/derive-usage.mjs          # usage.openrouter only, standalone (also runs inside auto-refresh.mjs)
node scripts/check-sources.mjs         # the anti-fabrication gate — fetches every judged-fit claim's source_url
```

## Tester registry (added 2026-09-07, brain v2 step 1)

**The rule this section exists to serve: the AI never ranks a model.** Everything above this
section is about sourcing individual facts (price, a benchmark score, availability). Ranking is a
different problem — and the plan is that ranking never comes from this codebase's own judgment.
Instead, a future ranking is meant to come from **agreement across the named, independent testers
below, plus human votes, plus real usage** — three things that already exist in the world, none of
them invented here. `data/testers.json` is the machine-readable registry backing that plan: every
entry was actually fetched (curl, or a headless browser where a site is JS-rendered) and dated, the
same discipline the rest of this file already holds sources to.

| Tester | Tasks covered | Licence class | Mapped / feed models | Verdict |
|---|---|---|---|---|
| Epoch AI Benchmarking Hub | research, frontend, coding, agents, writing, vision, exec-summaries | display-ok (CC-BY-4.0 for Epoch's own runs; external mirrors keep upstream terms — see `data/testers.json`) | 37 / 902 | use |
| Aider Polyglot Leaderboard | coding | display-ok (Apache-2.0) | 2 / 68 | exclude — frozen since 2025-10-04 |
| LiveBench | coding, research, extraction, writing, exec-summaries | unknown | 32 / 56 | use |
| Terminal-Bench 2.0 | agents | display-ok (Apache-2.0, via Epoch's mirror) | 3 / 48 | use |
| SWE-bench Verified leaderboard | coding | unknown | 1 / 83 | signal-only |
| Scale AI SEAL Leaderboards | agents, research, vision, chat | banned (all rights reserved) | 13 / 44 | signal-only |
| Vals AI | coding, research, extraction (descriptive only) | banned (proprietary) | — (no feed found) | exclude |
| LMArena / Arena.ai | coding, agents, writing, research, extraction, chat, vision, frontend, exec-summaries | signal-only (live site unlicensed; legacy Apache-2.0 mirror dead since 2025-08-04) | 15 / — | signal-only |
| OpenRouter task/category spend & usage | coding, agents, bulk, writing, research, extraction, chat, frontend, exec-summaries | signal-only (undocumented internal API) | 58 / 554 | use |
| Artificial Analysis | coding, research, agents (descriptive only) | signal-only (redistribution gated, internal use not) | — (API paid-gated) | signal-only |
| ARC Prize Foundation — ARC-AGI-2 Evaluations | research | display-ok (terms restrict commercial republishing only; this site is non-commercial; courtesy request sent 2026-08-22) | 12 / 247 | use |

Notes on how to read this table:

- **"Mapped / feed models"** is how many of this catalog's models (`data/models.json`) a tester's
  own feed names contain, out of that feed's total distinct model names — computed by a throwaway
  matcher (`scripts/_audit/map-names.mjs`) that strips only *known* reasoning-effort/date suffixes
  before comparing. It never guesses a fuzzy match; a real alias goes into `model-aliases.json`
  only after a human confirms it. A low ratio here usually means the tester tracks a long history
  of superseded models this catalog no longer lists, not that the tester is thin.
- **Licence class** follows the same display-ok / signal-only / banned / unknown scale as the rest
  of this file (`unknown` is a real, allowed answer — never a guessed licence).
- **OpenRouter's usage row is not a "tester" in the same sense as the other ten** — it is the
  **real-usage** leg of the three-legged plan (agreement + votes + usage), included because the
  brief that built this registry named it as a candidate to check.
- Full detail — feed URLs, exact licence quotes, independence citations, refresh cadence, and the
  unmapped-name samples behind each ratio — lives in `data/testers.json`. Nothing in that file was
  invented: a number not fetched is recorded as `null` with a note, per this file's own rule above.
- **Epoch's 37 / 902 is a feed-wide total across ~80 benchmark CSVs**, not one number for one
  table — `data/testers.json`'s `epoch-ai.mapping.per_benchmark` breaks it down file by file
  (catalog models matched, feed models, which of this catalog's 10 tasks it maps to, and its own
  licence: Epoch's own runs are CC-BY, Aider Polyglot and Terminal-Bench are Apache-2.0, everything
  else Epoch mirrors carries unstated upstream terms). Two mirrored sets — Video-MME and Epoch's
  own LiveBench mirror (`live_bench_external.csv`, separate from the standalone LiveBench row
  above) — matched zero catalog models each because both are frozen at snapshots older than this
  catalog, not because the matcher failed.
- **ARC Prize's 12 / 247 undercounts the real match rate.** Its feed names use a hyphen-joined
  vendor prefix (`anthropic-claude-fable-5-1-high`) that the shared matcher's provider-prefix
  stripper doesn't recognize (it only strips a prefix followed by `/` or `.`) — a naming-convention
  gap in `scripts/auto-refresh.mjs`, not fixed here since this pass is research-only. Epoch's own
  mirror of the same ARC-AGI-2 data matches 22 / 203 with the same unmodified matcher, which is a
  partial cross-check that ARC Prize's true rate is well above 12 / 247.

