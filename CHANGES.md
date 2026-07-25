# Second effort ladder: CursorBench via Epoch AI (CC-BY) — 2026-07-25

Panel 03 shipped with one ladder, digitised from **Anthropic's own launch figure** — a vendor
grading its own models, disclosed but not fixed. This adds a **second, independent ladder** so the
panel stops resting on a single interested party. Pure data change: one new entry in
`effort_ladders`. No chart code was touched; the suite picker appears on its own once there is
more than one ladder.

## Why this source

Researched every candidate that publishes score *and* real cost per attempt (see
`claude-universe/status/_modelproof-neutral-ladder-findings.md`). Two hard requirements: rungs at
each reasoning-effort level, and a licence that permits republication on a public site.

- **Artificial Analysis — rejected.** Best-shaped data anywhere, but its free tier is internal-use
  only and a public site counts as redistribution, needing a Commercial licence at an unpublished
  "contact us" price. Lucas's call, 2026-07-25: *"if we have to pay we're not using it."* AA stays
  usable as an ordinary cited reference; it is not a feed.
- **Epoch AI — adopted.** Data is **CC-BY**: free to use, distribute and reproduce with credit,
  read off their own licensing page. Its `cursorbench_external.csv` export carries one row per
  reasoning level with `Cost per task`, `Tokens per task` and `Steps per task` alongside the score.
- Ruled out for having no cost-per-attempt at effort rungs: vals.ai (one effort setting per run),
  LMArena, the SWE-bench leaderboard, llm-stats, OpenRouter. Using any of them would have meant
  modelling cost from list prices, which this repo forbids outright.

## What the numbers are

Exact published values from Epoch's CC-BY export (updated 2026-07-25) — **not digitised from a
picture**, unlike the Frontier-Bench ladder. Four series, 15 points:

| Model | Rungs | Cost/score range |
|---|---|---|
| Opus 5 | high · xhigh · max | $3.91 / 66.7% → $8.23 / 70.0% |
| Fable 5 | high · xhigh · max | $10.81 / 70.6% → $18.02 / 72.9% |
| Opus 4.8 | low → max (all five) | $2.93 / 54.3% → $7.59 / 63.8% |
| GPT-5.5 | low · medium · high · xhigh | $1.19 / 48.8% → $4.37 / 64.3% |

GPT-5.6 Sol has only its `max` rung published, so it is **not plotted** — one point is not a
ladder. Rungs missing a cost or a score are dropped, never interpolated, which is why the series
have different lengths.

**Upstream data quirk, recorded:** all three Opus 5 rows carry the model-version string
`claude-opus-5_max`, which looks like a copy-paste error at the source. The `Reasoning level`
column is correct and is what the rungs are keyed on. Worth reporting to Epoch.

## The finding this surfaces

**The two ladders disagree, and the panel now shows that.**

- Frontier-Bench (Anthropic's own): Opus 5 **peaks at `xhigh`** — `max` costs more and scores lower.
- CursorBench (Cursor's suite, via Epoch): Opus 5 is **still climbing at `max`** — the last step
  buys +0.7 points for 12% more spend.

Different suites measuring different tasks can legitimately disagree, and the repo rule is that
disagreement gets shown rather than averaged away — never average across harnesses. A reader
flipping between the two learns more than either curve claiming to settle it.

## Honesty fields

Independent of Anthropic is not the same as independent. The `caveat` that renders under the chart
says all three of these plainly:

1. **CursorBench is run and published by Cursor**, which ships its own coding model (Composer) — a
   benchmark by a company with a horse in the coding race.
2. **Epoch mirrors those numbers, it does not re-run them.**
3. **Epoch has its own disclosed conflict**: OpenAI funded the FrontierMath benchmark with dataset
   access, disclosed only after the fact.

## Verification

- `scripts/validate-data.mjs` passes: 23 models, 2 ladders, 35 points, 0 errors.
- Rendered in a real browser at 1440px and 390px: suite picker switches curves, per-ladder
  takeaways recompute from the points, provenance block renders all of the above, **no JS errors**,
  no horizontal overflow on mobile.
- `as_of` deliberately **not** bumped. It signals freshness of model prices and benchmarks, which
  this change does not touch; the ladder carries its own `as_of`. Bumping it would overclaim.

---

# Claude Opus 5 added + effort-ladder chart — 2026-07-24

## 1. Claude Opus 5 (released 2026-07-23) added — 23 models

Sourced and entered at **medium** overall confidence. What's solid vs. what isn't:

| Field | Value | Sourcing |
|---|---|---|
| Price | **$5 / $25** per M | Anthropic platform pricing; corroborated by CNBC / VentureBeat / OfficeChai all reporting "half of Fable 5" ($10/$50) |
| Context / output | 1M (default *and* max) / 128K | Anthropic docs |
| Effort levels | `low` `medium` `high` `xhigh` `max` | Anthropic docs |
| Frontier-Bench v0.1 | **43.3%** (vs Fable 5 33.7, Opus 4.8 18.7) | Anthropic launch figure, quoted numerically in launch coverage |
| CursorBench 3.2 | within 0.5% of Fable 5's peak at max effort, ~half the cost/task | Anthropic launch coverage |
| SWE-bench Verified, GPQA, AIME, MMLU-Pro | **blank (—)** | Not published and not third-party verified 24h after launch. Left blank per the honesty rule. |

**`coding_score` = 95, medium confidence.** Not a SWE-bench number — there isn't one yet. It's
calibrated against Fable 5 (95, SWE-bench 95.5) because the two agentic suites the lab *has*
published put Opus 5 at or above Fable. Basis string on the record says exactly that.
Same treatment Kimi K3 got on 2026-07-16 (frontend-led estimate, medium).

Consequence worth knowing: at 95 it ties Fable 5 on coding, so the recommender's price tiebreak
sends coding picks to Opus 5 at half the cost. That is the honest read of the sourced evidence,
not a thumb on the scale — but it's the line to re-check first when SWE-bench Verified lands.

Also swapped the compare table's Anthropic default from Opus 4.8 → Opus 5.

## 2. New panel 03 — "What more effort actually buys"

The ask (Lucas, 2026-07-24): performance vs. cost, top models, a point at each effort level —
modelled on Anthropic's Opus 5 launch chart.

New `effort_ladders` block in `models.json` + `renderEffort()` in `app.js`. Log cost axis,
one curve per model, one dot per effort rung, hover gives the rung-to-rung delta
("+4.1 pts · +23% cost"), legend chips isolate a curve. The per-model takeaways under the
chart are **computed from the points**, not written by hand.

### The sourcing decision (the contentious bit)

Nobody publishes effort-ladder data as numbers. It exists as *figures* in launch posts.
Two options: fabricate cost-per-task from list prices (impossible — cost/attempt depends on
token usage per run, which pricing pages don't contain), or digitise the published figure.

**Chose: digitise, and disclose everything.** The ladder carries `publisher`, `source_kind`,
`method` (with ±5% cost / ±0.5 pt error bars), `harness` (mini-SWE-agent, GKE backend, mean
reward over 5 attempts, Opus 4.8 as refusal fallback) and `caveat` — and the panel renders all
of it on screen under the chart, not buried in a footer.

The reading is anchored, not eyeballed: the three max-effort endpoints (43.3 / 33.7 / 18.7) are
quoted numerically in launch coverage and land on the digitised points, which is what gives
confidence in the intermediate rungs.

**Caveat shown to users, verbatim in the data:** Anthropic's own benchmark, own harness, own
run, three of four models its own. Read it for the *shape* of each curve — where extra spend
stops buying accuracy — not as a settled cross-lab ranking. No third party has reproduced it.

Only one ladder is plotted because only one has been published. The chart is data-driven: a
suite picker appears automatically the moment a second one exists.

## 3. Honesty gate extended

`scripts/validate-data.mjs` now blocks a ladder missing `suite`/`source`/`publisher`/`method`/
`confidence`, an unknown `model_id`, a blank cost or score, or a non-positive cost. Warns on
cost that doesn't rise with effort (a mis-read chart) and on undeclared effort names.

---
_23 models · 14 releases · 1 effort ladder / 20 points · 0 gate errors._

---

# Data refresh — 2026-07-20 · RESOLVED 2026-07-24

The weekly automation flagged 6 price-drift items for human verification. Each was checked
against the vendor's official/list pricing on 2026-07-24. **Result: all 6 flags rejected —
every price in `data/models.json` matched the vendor list price.** The OpenRouter figures the
bot compared against are third-party provider pass-through rates (host margins, long-context
tiers, batch rates), which is exactly the false-positive mode the bot's own note warned about.

| Flag | Ours | OpenRouter | Verified list price | Decision |
|---|---|---|---|---|
| Claude Opus 4.8 out | $25 | ~$50 | **$5/$25** (Anthropic first-party API rates) | ✗ rejected — $50 is pass-through (Fable-tier/host markup) |
| GPT-5.5 out | $30 | ~$180 | **$5/$30** (OpenAI pricing, multiple July-2026 trackers) | ✗ rejected — $180 is a provider outlier |
| o4-mini out | $4.40 | ~$8 | **$1.10/$4.40** (July 2026 trackers) | ✗ rejected |
| DeepSeek V4-Flash out | $0.28 | ~$0.20 | **$0.28** (official rate as of 2026-07-10; OpenRouter blends DeepInfra $0.20/OR $0.18 hosts) | ✗ rejected |
| Qwen3-Max out | $6 | ~$3.90 | **$1.20/$6.00** entry tier (Alibaba Model Studio; $3.00 is the *batch* rate) | ✗ rejected — batch/host rate ≠ list |
| Qwen3-Coder-Plus out | $5 | ~$3.25 | Alibaba tiered list $1/$5 at base tier | ✗ rejected — same pass-through pattern as the other five |

Snapshot `as_of` bumped to 2026-07-24 to record the re-verification (pricing layer confirmed
current; no values changed).

**Follow-up candidate for the next real refresh:** search results surfaced a newer Alibaba
flagship, **Qwen3.7-Max** (~$2.50/$7.50 list, currently $1.25/$3.75 promo). Not added — needs
a proper sourced pass (benchmarks, specs) per `scripts/refresh.md`, not a price-check merge.

---
_Machine `auto_checked`: 2026-07-20. Human verification + `as_of` bump: 2026-07-24._
