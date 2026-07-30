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
  `sources[]`, never as a ladder feed, unless Lucas buys a Commercial licence.
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
