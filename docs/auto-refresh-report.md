# Data refresh — 2026-08-17
The automation flagged 30 item(s) for **human verification**. Nothing below was written to the data — verify each against a primary source, edit `data/models.json` by hand, bump `as_of`, then merge.

- [ ] NEW MODEL — `qwen/qwen3.8-27b` (first seen 2026-08-14) is on OpenRouter and not in our data. Verify on the vendor's own page, then paste a stub with **every benchmark null** and `confidence: "low"` so the site shows it as *present, figures pending* rather than absent or guessed.
- [ ] NEW MODEL — `qwen/qwen3.8-2.4t-a95b` (first seen 2026-08-12) is on OpenRouter and not in our data. Verify on the vendor's own page, then paste a stub with **every benchmark null** and `confidence: "low"` so the site shows it as *present, figures pending* rather than absent or guessed.
- [ ] NEW MODEL — `qwen/qwen3.8-max` (first seen 2026-08-03) is on OpenRouter and not in our data. Verify on the vendor's own page, then paste a stub with **every benchmark null** and `confidence: "low"` so the site shows it as *present, figures pending* rather than absent or guessed.
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
- [ ] PRICE — **Google: Gemini 3.7 Flash** has no `price_checked` record. Confirm $0.38/$1.88 against the vendor's own pricing page, then add `price_checked` {url, date, input, output}.
- [ ] PRICE — **SpaceXAI: Grok 4.6** has no `price_checked` record. Confirm $2/$6 against the vendor's own pricing page, then add `price_checked` {url, date, input, output}.
- [ ] PRICE — **Meta: Muse Spark 1.2** has no `price_checked` record. Confirm $1.25/$4.25 against the vendor's own pricing page, then add `price_checked` {url, date, input, output}.
- [ ] PRICE — **Meta: Muse Spark 1.1** has no `price_checked` record. Confirm $1.25/$4.25 against the vendor's own pricing page, then add `price_checked` {url, date, input, output}.
- [ ] PRICE — **Ling-3.0-flash** has no `price_checked` record. Confirm $0.06/$0.18 against the vendor's own pricing page, then add `price_checked` {url, date, input, output}.
- [ ] PRICE — **Qwen: Qwen3.7 Flash** has no `price_checked` record. Confirm $0.03/$0.13 against the vendor's own pricing page, then add `price_checked` {url, date, input, output}.
- [ ] BACKFILL — **Gemini 3.6 Flash** `gpqa` is blank in our data; Epoch AI (CC-BY, independently run) now publishes **85.9%** ±2.5. Source: https://epoch.ai/benchmarks/gpqa-diamond. Verify, then fill the cell **with the source URL in `sources[]`**.
- [ ] BACKFILL — **GLM-5.2** `gpqa` is blank in our data; Epoch AI (CC-BY, independently run) now publishes **71.2%** ±3.2. Source: https://epoch.ai/benchmarks/gpqa-diamond. Verify, then fill the cell **with the source URL in `sources[]`**.
- [ ] BACKFILL — **Google: Gemini 3.7 Flash** `gpqa` is blank in our data; Epoch AI (CC-BY, independently run) now publishes **94.8%** ±1.3. Source: https://epoch.ai/benchmarks/gpqa-diamond. Verify, then fill the cell **with the source URL in `sources[]`**.
- [ ] BACKFILL — **SpaceXAI: Grok 4.6** `gpqa` is blank in our data; Epoch AI (CC-BY, independently run) now publishes **93.2%** ±1.5. Source: https://epoch.ai/benchmarks/gpqa-diamond. Verify, then fill the cell **with the source URL in `sources[]`**.
- [ ] BACKFILL — **Qwen: Qwen3.7 Flash** `gpqa` is blank in our data; Epoch AI (CC-BY, independently run) now publishes **82.3%** ±2.7. Source: https://epoch.ai/benchmarks/gpqa-diamond. Verify, then fill the cell **with the source URL in `sources[]`**.
- [ ] BACKFILL — **GLM-5.2** `swe_bench` is blank in our data; Epoch AI (CC-BY, independently run) now publishes **78.7%** ±1.9. Source: https://epoch.ai/benchmarks/swe-bench-verified. Verify, then fill the cell **with the source URL in `sources[]`**.
- [ ] LADDER — NEW series available: GLM-5.2 (2 rungs) (source: Epoch AI, 'AI Benchmarking Hub'. Published online at epoch.ai. Retrieved from https://epoch.ai/benchmarks/use-this-data)
- [ ] LADDER — NEW series available: Sonnet 5 (2 rungs) (source: Epoch AI, 'AI Benchmarking Hub'. Published online at epoch.ai. Retrieved from https://epoch.ai/benchmarks/use-this-data)
---
_Machine `auto_checked`: 2026-08-17. Human `as_of`: 2026-08-16 — only a person bumps that, at merge._
_The machine may propose a model's existence, release entries and official list prices. It may never write a benchmark, a ladder point, a coding score or a confidence upgrade — see `scripts/data-sources.md`._
