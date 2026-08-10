# Data refresh — 2026-08-10
The automation flagged 21 item(s) for **human verification**. Nothing below was written to the data — verify each against a primary source, edit `data/models.json` by hand, bump `as_of`, then merge.

- [ ] NEW MODEL — `qwen/qwen3.8-max` (first seen 2026-08-03) is on OpenRouter and not in our data. Verify on the vendor's own page, then paste a stub with **every benchmark null** and `confidence: "low"` so the site shows it as *present, figures pending* rather than absent or guessed.
- [ ] NEW MODEL — `qwen/qwen3.7-flash` (first seen 2026-07-27) is on OpenRouter and not in our data. Verify on the vendor's own page, then paste a stub with **every benchmark null** and `confidence: "low"` so the site shows it as *present, figures pending* rather than absent or guessed.
- [ ] NEW MODEL — `google/gemini-3.1-flash-lite-image` (first seen 2026-06-30) is on OpenRouter and not in our data. Verify on the vendor's own page, then paste a stub with **every benchmark null** and `confidence: "low"` so the site shows it as *present, figures pending* rather than absent or guessed.
- [ ] PRICE — **Kimi K3** has no `price_checked` record. Confirm $3/$15 against the vendor's own pricing page, then add `price_checked` {url, date, input, output}.
- [ ] PRICE — **Claude Fable 5** has no `price_checked` record. Confirm $10/$50 against the vendor's own pricing page, then add `price_checked` {url, date, input, output}.
- [ ] PRICE — **Claude Sonnet 5** has no `price_checked` record. Confirm $2/$10 against the vendor's own pricing page, then add `price_checked` {url, date, input, output}.
- [ ] PRICE — **Gemini 3.1 Pro (Preview)** has no `price_checked` record. Confirm $2/$12 against the vendor's own pricing page, then add `price_checked` {url, date, input, output}.
- [ ] PRICE — **DeepSeek V4-Pro** has no `price_checked` record. Confirm $0.435/$0.87 against the vendor's own pricing page, then add `price_checked` {url, date, input, output}.
- [ ] PRICE — **Llama 4 Maverick** has no `price_checked` record. Confirm $0.22/$0.88 against the vendor's own pricing page, then add `price_checked` {url, date, input, output}.
- [ ] PRICE — **Claude Haiku 4.5** has no `price_checked` record. Confirm $1/$5 against the vendor's own pricing page, then add `price_checked` {url, date, input, output}.
- [ ] PRICE — **GPT-5.6 Sol** has no `price_checked` record. Confirm $5/$30 against the vendor's own pricing page, then add `price_checked` {url, date, input, output}.
- [ ] PRICE — **Gemini 2.5 Flash-Lite** has no `price_checked` record. Confirm $0.1/$0.4 against the vendor's own pricing page, then add `price_checked` {url, date, input, output}.
- [ ] PRICE — **Grok 4.5** has no `price_checked` record. Confirm $2/$6 against the vendor's own pricing page, then add `price_checked` {url, date, input, output}.
- [ ] PRICE — **DeepSeek V4-Flash** has no `price_checked` record. Confirm $0.14/$0.28 against the vendor's own pricing page, then add `price_checked` {url, date, input, output}.
- [ ] PRICE — **Qwen-Turbo** has no `price_checked` record. Confirm $0.05/$0.2 against the vendor's own pricing page, then add `price_checked` {url, date, input, output}.
- [ ] PRICE — **Mistral Medium 3.1** has no `price_checked` record. Confirm $0.4/$2 against the vendor's own pricing page, then add `price_checked` {url, date, input, output}.
- [ ] BACKFILL — **Gemini 3.6 Flash** `gpqa` is blank in our data; Epoch AI (CC-BY, independently run) now publishes **85.9%** ±2.5. Source: https://epoch.ai/benchmarks/gpqa-diamond. Verify, then fill the cell **with the source URL in `sources[]`**.
- [ ] BACKFILL — **GLM-5.2** `gpqa` is blank in our data; Epoch AI (CC-BY, independently run) now publishes **91.9%** ±1.6. Source: https://epoch.ai/benchmarks/gpqa-diamond. Verify, then fill the cell **with the source URL in `sources[]`**.
- [ ] BACKFILL — **GLM-5.2** `swe_bench` is blank in our data; Epoch AI (CC-BY, independently run) now publishes **78.7%** ±1.9. Source: https://epoch.ai/benchmarks/swe-bench-verified. Verify, then fill the cell **with the source URL in `sources[]`**.
- [ ] LADDER — NEW series available: GLM-5.2 (2 rungs) (source: Epoch AI, 'AI Benchmarking Hub'. Published online at epoch.ai. Retrieved from https://epoch.ai/benchmarks/use-this-data)
- [ ] LADDER — NEW series available: Sonnet 5 (2 rungs) (source: Epoch AI, 'AI Benchmarking Hub'. Published online at epoch.ai. Retrieved from https://epoch.ai/benchmarks/use-this-data)
---
_Machine `auto_checked`: 2026-08-10. Human `as_of`: 2026-07-29 — only a person bumps that, at merge._
_The machine may propose a model's existence, release entries and official list prices. It may never write a benchmark, a ladder point, a coding score or a confidence upgrade — see `scripts/data-sources.md`._
