# Modelproof

**Which AI model should you actually use?** A calm, opinionated decision tool for people who
don't have time to keep up with AI news. Tell it what you're working on — or which lab you already
pay for — and it gives you a straight answer, not a leaderboard.

Not another benchmark race. The point is the *decision*. Sibling to **DATproof** in the Proof
portfolio.

Data snapshot **2026-07-12** · 21 models across 9 vendors.

## Why this exists

New models drop every week (Fable 5, GPT-5.6 Sol/Terra/Luna, Grok 4.5, Gemini 3.x, a wall of
open-weight coders…). Keeping up is exhausting, and it's easy to overpay — running Fable 5
($10/$50 per M) for routine coding when Sonnet 5 or DeepSeek V4-Pro do most of the job for a
fraction. Modelproof lowers the barrier to a good choice: *given what you're doing, here's what to
use.*

## What it does

- **Two ways in.**
  - **By task** — pick what you're doing (Coding / Strategy / Writing / Cheap bulk) and how much
    you weigh cost vs. quality (Cheapest / Value / Balanced / Best). Get a top pick + two
    runners-up with a plain-English verdict.
  - **By lab** — already locked into one provider? Pick your lab (Claude, ChatGPT, Gemini, Grok,
    DeepSeek, Llama, Qwen, Kimi, Mistral) and get *its* best model for each kind of work. For
    people who only use one thing and just want to use it well.
- **Get a prompt for your own AI** — turn your selection into a copy-paste "model advisor" prompt.
  Drop it into Claude or ChatGPT and it becomes your ongoing model-picker: your setup + a dated
  snapshot of the model facts + honest, neutral advice rules.
- **The buy zone** — every model plotted, price (→) vs. capability (↑). Top-left = cheap *and*
  capable. Your pick is highlighted; hover any dot for detail.
- **Who's actually using what** — three honest lenses (developer API tokens, human-preference
  votes, consumer web traffic) that rank models *completely differently*. There's no single "most
  used" — it depends who you count.
- **Compare everything** — a sortable table that defaults to one flagship per major lab (full 21
  one click away), with per-model verdicts, strengths, weaknesses, benchmarks, sources, and a
  confidence flag.
- **What changed lately** — a dated timeline of the releases worth knowing about, each with a
  one-line **"Should you care?"** so you can skim what actually affects you.

## Honesty model (why you can trust the numbers)

This ships to people making real spend decisions, so:

- **Pricing** is the reliable layer — verified against official vendor pricing pages (standard
  tier, USD per 1M tokens).
- **Benchmarks** are *directional* — mostly third-party aggregators (Artificial Analysis, Vellum,
  llm-stats, vals.ai), not primary vendor cards. Every model carries a **confidence flag**
  (high / medium / low).
- **Usage** is a *proxy* — each lens measures a different population; none equals global market
  share. Figures lag a couple of weeks, so the newest models aren't ranked yet.
- **A blank (—) means "not reliably sourced," never a guess.** The recommender only ranks models
  it has a sourced score for on a quality goal; cheap-bulk is price-led.
- **Independent** — not affiliated with, sponsored by, or advertising for any lab. Recommendations
  are made on merit and cost only.

## Run it locally

Pure static site — no build step, no dependencies.

```bash
python3 -m http.server 8475 --directory .
# → http://localhost:8475
```

## Refresh the data

Model data lives in [`data/models.json`](data/models.json). To bring it current, follow
[`scripts/refresh.md`](scripts/refresh.md) — it documents the research procedure, schema, and
sourcing rules (models, releases, usage lenses). A live daily auto-refresh is a possible phase 2;
today's refresh is a run-it-when-you-want procedure.

## Tech

Vanilla HTML + CSS + JS, one `models.json`. A living ASCII-sunset hero on `<canvas>` that dissolves
into the dark tool at a dusk seam. Type: Fraunces (wordmark) + Fontshare's Clash Display / Satoshi /
JetBrains Mono. Dark, single satin-gold accent. Restrained, GPU-friendly motion — the hero animates
only while parked at the top and freezes on scroll; no `backdrop-filter` on scrolling chrome, no
fixed-attachment backgrounds, so it stays smooth on modest hardware.

## Roadmap

- [ ] Deploy (static host — Vercel / GitHub Pages).
- [ ] Add a card to the Proof portfolio.
- [ ] Test the prompt-generator's real-world usefulness; maybe evolve it into an MCP/API that
      selects for you.
- [ ] "Build my stack" — multi-tool breakdown for people who pay for several AI tools at once.
- [ ] Phase 2: live daily refresh pipeline (data + usage) — pending infra decision.
- [ ] Expand coverage (GLM-5.2, Qwen3-Coder-Next, Kimi K2.7, Grok 4.5 Heavy, more tiers).

---

Independent project · not affiliated with any model vendor. Sibling to **DATproof** in Lucas
Cashwell's **Proof** portfolio.
