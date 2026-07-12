# Modelproof

**Which AI model should you actually use?** A no-nonsense decision tool: tell it your goal
and how much you care about cost, and it gives you a straight answer — backed by a
cost-vs-capability map, real usage data, a full compare table, and a "what changed lately" feed.

Not another leaderboard. The point is the *decision*, not the horse race. Sibling to
**DATproof** in the Proof portfolio.

Live snapshot as of **2026-07-12**. 21 models across 9 vendors.

## Why this exists

New models drop every week (Fable 5, GPT-5.6 Sol/Terra/Luna, Grok 4.5, Gemini 3.x, a wall
of open-weight coders…). Keeping up is exhausting, and it's easy to overpay — e.g. running
Fable 5 ($10/$50 per M) for routine coding when Sonnet 5 or DeepSeek V4-Pro do most of the
job for a fraction. Modelproof cuts the noise down to: *given what you're doing, here's what
to use.*

## What it does

- **Decision engine** — pick a goal (coding / research & strategy / writing / cheap-bulk)
  and a cost↔quality slider; get a top pick + two runners-up with a plain-English verdict.
  Each goal has a one-line description so there's no jargon to decode.
- **The buy zone** — every model plotted, price (→) vs capability (↑). Top-left = cheap *and*
  capable. Your pick is highlighted; hover any dot for detail, click it to jump to the table.
- **Who's actually using what** — three honest lenses (developer API tokens, human-preference
  votes, consumer web traffic) that rank models *completely differently*. There's no single
  "most used" — it depends who you count.
- **Compare everything** — sortable, filterable table with per-model verdicts, strengths,
  weaknesses, benchmarks, sources, and a confidence flag.
- **What changed lately** — a dated timeline of the releases actually worth knowing about.

## Honesty model (why you can trust the numbers)

This ships to people making real spend decisions, so:

- **Pricing** is the reliable layer — verified against official vendor pricing pages
  (standard tier, USD per 1M tokens).
- **Benchmarks** are *directional* — mostly third-party aggregators (Artificial Analysis,
  Vellum, llm-stats, vals.ai), not primary vendor cards. Every model carries a **confidence
  flag** (high / medium / low).
- **Usage** is a *proxy* — each lens measures a different population; none equals global market
  share. Figures lag a couple of weeks, so the newest models aren't ranked yet.
- **A blank (—) means "not reliably sourced," never a guess.** The recommender only ranks
  models it has a sourced score for on a quality goal; cheap-bulk is price-led.

## Run it locally

Pure static site — no build step, no dependencies.

```bash
python3 -m http.server 8475 --directory .
# → http://localhost:8475
```

## Refresh the data

Model data lives in [`data/models.json`](data/models.json). To bring it current, follow
[`scripts/refresh.md`](scripts/refresh.md) — it documents the research procedure, schema, and
sourcing rules (models, releases, and the usage lenses). A live daily auto-refresh is a
possible phase 2; today's refresh is a run-it-when-you-want procedure.

## Tech

Vanilla HTML + CSS + JS. One `models.json` data file. Fontshare type (Clash Display /
Satoshi / JetBrains Mono). Dark, single satin-gold accent. Restrained, GPU-friendly motion
(no `backdrop-filter` on scrolling chrome, no fixed-attachment backgrounds — it stays smooth).

## Roadmap

- [ ] Deploy (static host — Vercel / GitHub Pages).
- [ ] Add card to the Proof portfolio once its design overhaul lands.
- [ ] Phase 2: live daily refresh pipeline (data + usage) — pending infra decision.
- [ ] Expand coverage (GLM-5.2, Qwen3-Coder-Next, Kimi K2.7, Grok 4.5 Heavy, more tiers).
- [ ] Per-model detail pages + shareable "here's what to use" permalinks.

---

Independent project · not affiliated with any model vendor. Sibling to **DATproof** in Lucas
Cashwell's **Proof** portfolio.
