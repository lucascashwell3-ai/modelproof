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
