# Data refresh — 2026-07-27 · verified 2026-07-29

**All 8 price flags were false alarms.** Every one of our list prices was already correct when
checked against the vendor's own official pricing page. What the alarm was actually seeing was
OpenRouter quoting a *different tier* — fast mode, priority routing, a regional endpoint, or a
provider pass-through — none of which is a list price.

That is a fault in the alarm, not in the data. See "What this run says about the alarm" below.

## Prices — checked against the vendor's own page. No changes made.

| model | our data | OpenRouter said | vendor's own page | what OpenRouter was showing |
|---|---|---|---|---|
| Claude Opus 5 | $25 out | ~$50.00 | **$5 / $25** ✓ | Fast mode ($10/$50), a labelled premium tier |
| Claude Opus 4.8 | $25 out | ~$50.00 | **$5 / $25** ✓ | Fast mode ($10/$50) |
| GPT-5.5 | $30 out | ~$180.00 | **$5 / $30** ✓ | not any tier OpenAI publishes |
| o4-mini | $4.4 out | ~$8.00 | **$1.10 / $4.40** ✓ | OpenAI's Priority tier ($2.00/$8.00) |
| Gemini 3.5 Flash | $9 out | ~$2.50 | **$1.50 / $9.00** ✓ | not Google's published rate |
| Kimi K2.6 | $4 out | ~$2.72 | **$0.95 / $4.00** ✓ | provider pass-through |
| Qwen3-Max | $6 out | ~$3.90 | **$1.2 / $6** (0–32K, Singapore) ✓ | not a tier Alibaba publishes |
| Qwen3-Coder-Plus | $5 out | ~$3.25 | **$1 / $5** (0–32K, Singapore) ✓ | not a tier Alibaba publishes |

Sources: `platform.claude.com/docs/en/about-claude/pricing` · `developers.openai.com/api/docs/pricing`
· `ai.google.dev/gemini-api/docs/pricing` · `platform.kimi.ai/docs/pricing/chat-k26`
· `alibabacloud.com/help/en/model-studio/billing-for-model-studio`

## New models — 2 added, 3 held

- [x] **`google/gemini-3.6-flash`** → added as `gemini-3-6-flash`. $1.50 in / $7.50 out, from
      Google's own pricing page. Every benchmark null, `confidence: "low"`. Context window is not
      stated on that page, so it is left blank rather than guessed.
- [x] **`z-ai/glm-5.2`** → added as `glm-5-2`. $1.40 in / $4.40 out, from `docs.z.ai`. Every
      benchmark null, `confidence: "low"`.
- [ ] **HELD — `google/gemini-3.1-flash-image`** ($0.50 in / $60.00 out, images only)
- [ ] **HELD — `google/gemini-3.1-flash-lite-image`** ($0.25 in / $30.00 out, images only)
- [ ] **HELD — `google/gemini-3-pro-image`** ($2.00 in / $120.00 out, images only)

  All three prices are vendor-confirmed. They are held on an **editorial** question, not a sourcing
  one: these are **image-generation** models, and every benchmark this site compares on
  (`swe_bench`, `gpqa`, `aime`, `mmlu_pro`, `lmarena_elo`) is a text/reasoning benchmark. Adding
  them would put three permanently blank rows into a text-model comparison, priced per *image*
  output token, where they can never rank. That is a decision about what Modelproof is for, so it
  waits for a human.

## Still open

- [ ] **LADDER — Sonnet 5 (2 rungs), Epoch AI.** Untouched. Ladder points are on the never-automate
      list in `scripts/data-sources.md`, and that rule held here.

## What this run says about the alarm

The drift check compares our list price against **OpenRouter**, which aggregates *provider* prices.
Providers quote fast tiers, priority routing, regional endpoints and pass-through rates. So a
disagreement with OpenRouter is not evidence that our number is wrong — and this week it was wrong
about it **8 times out of 8**, which is why this PR sat unreviewed for two days.

The rule in `scripts/data-sources.md` already says the machine may write **"list prices scraped
from the vendor's own official pricing page (deterministic, one known page per vendor)"**. The
alarm just isn't doing that. Pointing it at the vendor pages instead would make the price half of
this report both trustworthy and safely auto-mergeable — which is the stated goal.

---
_Machine `auto_checked`: 2026-07-27. Human `as_of`: **2026-07-29** — bumped on verification against
vendor-primary sources._
_The machine may propose a model's existence, release entries and official list prices. It may never
write a benchmark, a ladder point, a coding score or a confidence upgrade — see `scripts/data-sources.md`._
