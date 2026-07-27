# Data refresh — 2026-07-27
The automation flagged 14 item(s) for **human verification**. Nothing below was written to the data — verify each against a primary source, edit `data/models.json` by hand, bump `as_of`, then merge.

- [ ] NEW MODEL — `google/gemini-3.6-flash` (first seen 2026-07-21) is on OpenRouter and not in our data. Verify on the vendor's own page, then paste a stub with **every benchmark null** and `confidence: "low"` so the site shows it as *present, figures pending* rather than absent or guessed.
- [ ] NEW MODEL — `google/gemini-3.1-flash-lite-image` (first seen 2026-06-30) is on OpenRouter and not in our data. Verify on the vendor's own page, then paste a stub with **every benchmark null** and `confidence: "low"` so the site shows it as *present, figures pending* rather than absent or guessed.
- [ ] NEW MODEL — `google/gemini-3.1-flash-image` (first seen 2026-06-18) is on OpenRouter and not in our data. Verify on the vendor's own page, then paste a stub with **every benchmark null** and `confidence: "low"` so the site shows it as *present, figures pending* rather than absent or guessed.
- [ ] NEW MODEL — `google/gemini-3-pro-image` (first seen 2026-06-18) is on OpenRouter and not in our data. Verify on the vendor's own page, then paste a stub with **every benchmark null** and `confidence: "low"` so the site shows it as *present, figures pending* rather than absent or guessed.
- [ ] NEW MODEL — `z-ai/glm-5.2` (first seen 2026-06-16) is on OpenRouter and not in our data. Verify on the vendor's own page, then paste a stub with **every benchmark null** and `confidence: "low"` so the site shows it as *present, figures pending* rather than absent or guessed.
- [ ] PRICE — verify **Claude Opus 5**: we list $25/1M out; OpenRouter shows ~$50.00 (provider pass-through ≠ list price — confirm against the vendor's official pricing page before changing).
- [ ] PRICE — verify **Claude Opus 4.8**: we list $25/1M out; OpenRouter shows ~$50.00 (provider pass-through ≠ list price — confirm against the vendor's official pricing page before changing).
- [ ] PRICE — verify **GPT-5.5**: we list $30/1M out; OpenRouter shows ~$180.00 (provider pass-through ≠ list price — confirm against the vendor's official pricing page before changing).
- [ ] PRICE — verify **Kimi K2.6**: we list $4/1M out; OpenRouter shows ~$2.72 (provider pass-through ≠ list price — confirm against the vendor's official pricing page before changing).
- [ ] PRICE — verify **o4-mini**: we list $4.4/1M out; OpenRouter shows ~$8.00 (provider pass-through ≠ list price — confirm against the vendor's official pricing page before changing).
- [ ] PRICE — verify **Gemini 3.5 Flash**: we list $9/1M out; OpenRouter shows ~$2.50 (provider pass-through ≠ list price — confirm against the vendor's official pricing page before changing).
- [ ] PRICE — verify **Qwen3-Max**: we list $6/1M out; OpenRouter shows ~$3.90 (provider pass-through ≠ list price — confirm against the vendor's official pricing page before changing).
- [ ] PRICE — verify **Qwen3-Coder-Plus**: we list $5/1M out; OpenRouter shows ~$3.25 (provider pass-through ≠ list price — confirm against the vendor's official pricing page before changing).
- [ ] LADDER — NEW series available: Sonnet 5 (2 rungs) (source: Epoch AI, 'AI Benchmarking Hub'. Published online at epoch.ai. Retrieved from https://epoch.ai/benchmarks/use-this-data)
---
_Machine `auto_checked`: 2026-07-27. Human `as_of`: 2026-07-24 — only a person bumps that, at merge._
_The machine may propose a model's existence, release entries and official list prices. It may never write a benchmark, a ladder point, a coding score or a confidence upgrade — see `scripts/data-sources.md`._
