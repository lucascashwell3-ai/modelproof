# Modelproof

**Always-current AI model facts, and a setup that installs into the tools you already use.**

Everyone has access to more models than they can keep track of. Modelproof keeps the facts
straight and puts them where you work:

- **The facts** — live prices, OpenRouter usage, sourced scores, effort-cost curves, a release
  timeline, and what each lab says about its own models, every one with its link and date.
  Nothing is ranked, and no model is named for you.
- **The instruction package** — a short setup for Claude Code, Codex, Cursor, or any tool that
  reads `AGENTS.md`. It sets which model each helper agent runs on — your choice first, then the
  tool's or lab's own published default for that job, otherwise the same model as your main one —
  plus a few lines on using them well. It adds files next to yours instead of overwriting them,
  shows you the full plan before it writes anything, and undoes byte for byte.

Live at **[lucascashwell3-ai.github.io/modelproof](https://lucascashwell3-ai.github.io/modelproof/)**.

## Get it

- **Paste a prompt** — one short prompt into Claude Code, Cursor, or any agentic AI. It asks a few
  quick questions about your setup, shows the plan, and installs on your yes.
- **The skill** — [`skills/modelproof-advisor/`](skills/modelproof-advisor/) runs the same flow.
  Copy the folder into your skills folder to keep it.
- **MCP server** — [`mcp/`](mcp/) serves the same facts (prices, releases, sourced quotes) over the
  Model Context Protocol.

## What the site shows

- **Compare** — any two or three models side by side: price, context, sourced scores, and what
  the lab says about each.
- **The model map** — every model plotted, price (→) vs. coding score (↑).
- **Effort ladders** — what turning up a model's reasoning-effort dial actually buys, as
  published cost-accuracy curves; only ladders with a named publisher, harness, and method are
  plotted.
- **Usage lenses** — different measures of who uses what, shown separately because they disagree.
- **Timeline** — dated releases, price changes, and retirements, each with a one-line "should
  you care?"
- **Full table** — every tracked model with its sources and sourced quotes, filterable by lab.
- **Board** ([`board.html`](board.html)) — lay out the teams and routines in a company, or your
  own set of models, and see the monthly bill and the cost per person and per year.
- **How we source facts** ([`how-we-pick.html`](how-we-pick.html)) — where every number and quote
  comes from.

## The data

[`data/models.json`](data/models.json) is the single source: models across the major labs and
open-weight vendors, refreshed twice a week by an automated Collect → Judge → Verify pipeline
(GitHub Actions + a research pass with citations; see
[`automation/jobs/auto-refresh/`](automation/jobs/auto-refresh/)). Anything the pipeline can't
source cleanly is held in a review issue instead of published. Each model also carries an
`availability` object — where it can actually be reached (direct API, OpenRouter, AWS Bedrock,
open weights) — derived automatically every Collect run by
[`scripts/derive-availability.mjs`](scripts/derive-availability.mjs); a field is `true` only when
sourced, `null` otherwise, never a guessed negative. [`data/plans.json`](data/plans.json) holds
seat/subscription pricing for the major chat apps and coding tools (Claude, ChatGPT, Gemini,
Grok, Cursor, GitHub Copilot), refreshed manually (see
[`scripts/refresh-plans.md`](scripts/refresh-plans.md)) straight from each vendor's own pricing
page — a `null` price means the page didn't show that number in static HTML, never an invented one.

**Honesty rules:**

- **Pricing** traces to official vendor pages (standard tier, USD per 1M tokens).
  Verify anything cost-critical against the vendor's own pricing page before relying on it.
- **Benchmarks** are directional and cited — never treated as truth.
- **No ranking.** The site never ranks models or names one for a job. Lab and tool quotes
  (each with a source link, a verbatim quote and the date checked) are shown as what they are:
  that lab's own words about its own models. Every quote is checked against its live source
  before publish ([`scripts/check-sources.mjs`](scripts/check-sources.mjs)) — a claim that can't
  be found on the page it cites is rejected, not softened.
- **A blank (—) means "not reliably sourced," never a guess.** The validator
  ([`scripts/validate-data.mjs`](scripts/validate-data.mjs)) blocks any publish that breaks
  schema or sourcing rules.
- **Independent** — not affiliated with, sponsored by, or advertising for any model vendor.

Retired pieces (the old ranking code and its answer key) are kept for history in
[`archive/`](archive/).

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

- [x] Per-model usage volumes (OpenRouter rankings) as a data layer — `usage.openrouter` on every
      model, collected from OpenRouter's own rankings feed (`scripts/derive-usage.mjs`).
- [ ] More effort ladders as labs publish them (one pending a permissions reply).
- [ ] "Build my stack" — a multi-tool breakdown for teams paying for several AI tools at once.

---

Independent project · not affiliated with any model vendor · built by Lucas Cashwell.
Sibling project: **DATproof**.
