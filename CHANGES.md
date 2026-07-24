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
