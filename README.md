# Modelproof

**Which AI model should you actually use?**

Everyone has access to more models than they can keep track of — and no time to work out which
one fits the task and the budget in front of them. Modelproof answers that in two ways:

- **A skill** for people who work inside Claude Code, Cursor, or any agentic AI setup: say what
  you're about to do ("overnight bulk run", "client deck", "new project") and it names one model
  from what you already have access to, with a plan and an undo.
- **A site** for people deciding what their team should run: live prices, sourced scores,
  effort-cost curves, and a release timeline — enough to choose good models without overpaying
  for frontier ones where they aren't needed.

Live at **[lucascashwell3-ai.github.io/modelproof](https://lucascashwell3-ai.github.io/modelproof/)**.
Not a leaderboard; the point is the decision.

## Get the advisor

Three ways in, all on the site's installer:

- **Paste a prompt** — one short prompt into Claude Code, Cursor, or any agentic AI; it installs
  the advisor and asks what you're about to do.
- **Install the skill** — a one-line command that downloads
  [`skills/modelproof-advisor/`](skills/modelproof-advisor/) into your Claude Code skills folder.
- **MCP server** — [`mcp/`](mcp/) exposes the same data and advice over the Model Context
  Protocol.

## What the site shows

- **Compare** — any two models side by side: price, sourced benchmarks, strengths, verdicts.
- **The buy zone** — every model plotted, price (→) vs. capability (↑); top-left is cheap *and*
  capable.
- **Effort ladders** — what turning up a model's reasoning-effort dial actually buys, as
  published cost-accuracy curves; only ladders with a named publisher, harness, and method are
  plotted.
- **Usage lenses** — different measures of who uses what, shown separately because they disagree.
- **Timeline** — dated releases, price changes, and retirements, each with a one-line "should
  you care?"
- **Full table** — every tracked model with per-model verdicts, sources, and a confidence flag.

## The data

[`data/models.json`](data/models.json) is the single source: models across the major labs and
open-weight vendors, refreshed twice a week by an automated Collect → Judge → Verify pipeline
(GitHub Actions + a research pass with citations; see
[`automation/jobs/auto-refresh/`](automation/jobs/auto-refresh/)). Anything the pipeline can't
source cleanly is held in a review issue instead of published.

**Honesty rules:**

- **Pricing** traces to official vendor pages (standard tier, USD per 1M tokens).
- **Benchmarks** are directional, cited, and confidence-flagged — never treated as truth.
- **A blank (—) means "not reliably sourced," never a guess.** The validator
  ([`scripts/validate-data.mjs`](scripts/validate-data.mjs)) blocks any publish that breaks
  schema or sourcing rules.
- **Independent** — not affiliated with, sponsored by, or advertising for any model vendor.

## Run it locally

Pure static site — no build step, no dependencies.

```bash
python3 -m http.server 8475 --directory .
# → http://localhost:8475
```

## Tech

Vanilla HTML + CSS + JS, one `models.json`. Type: Fraunces (wordmark) + Cabinet Grotesk /
Switzer / JetBrains Mono. Restrained, GPU-friendly motion; no build tooling anywhere.

## Roadmap

- [ ] Per-model usage volumes (OpenRouter rankings) as a data layer.
- [ ] More effort ladders as labs publish them (one pending a permissions reply).
- [ ] "Build my stack" — a multi-tool breakdown for teams paying for several AI tools at once.

---

Independent project · not affiliated with any model vendor · built by Lucas Cashwell.
Sibling project: **DATproof**.
