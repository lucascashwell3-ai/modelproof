# Refreshing MODELproof's data

All model data lives in one file: [`../data/models.json`](../data/models.json). Refreshing =
regenerating that file with current, sourced figures. There is **no build step** — replace the
JSON and reload the page.

The v1 snapshot was gathered by a fan-out research pass (one agent per vendor + a benchmarks
agent + a releases agent → consolidate → adversarial fact-check). To refresh, re-run that
procedure. Fastest path: paste the prompt below into a Claude Code session with web search.

## Refresh prompt

> Research current AI-model data as of TODAY and output a single JSON object matching the
> schema in `modelproof/data/models.json`. Cover the frontier + mid + cheap/open tiers across
> Anthropic, OpenAI, Google, xAI, DeepSeek, Qwen, Moonshot/Kimi, Meta, Mistral (~15–22 models).
>
> **Strict sourcing rules (this ships to people making real spend decisions):**
> - Report only numbers you can source; put the backing URL in `sources`. If you can't find a
>   figure, set it to `null`. Never invent or estimate a benchmark/price and present it as fact.
> - `price_input` / `price_output` = official API list price, USD per **1,000,000** tokens,
>   standard tier (not batch/cached). Prefer the vendor's own pricing page.
> - Benchmarks: prefer primary vendor cards; otherwise reputable aggregators (Artificial
>   Analysis, LMArena, SWE-bench leaderboard, llm-stats, vals.ai). If a vendor published only
>   an agentic eval (SWE-bench Pro, Terminal-Bench) with no SWE-bench Verified, leave
>   `swe_bench` null — do NOT cross-file a different benchmark into it.
> - `verdict` = one plain-English sentence: when to reach for this model.
> - `confidence`: high (official pricing + ≥1 sourced benchmark), medium (some sourced), low.
> - Also produce `releases`: 8–15 most notable recent releases, dated, newest first, sourced.
> - Set `as_of` to today's date and write an honest `notes` caveat about freshness/uncertainty.
> - Finally: run a skeptical fact-check pass. Flag any figure that's duplicated across vendors,
>   near-benchmark-saturation, or unsourced-but-presented-as-fact, and null it out.

## Schema (per model)

```jsonc
{
  "id": "kebab-case-unique",
  "name": "Display Name",
  "vendor": "Vendor",
  "released": "YYYY-MM | YYYY-MM-DD | unknown",
  "context_window": 1000000,        // max input tokens, or null
  "price_input": 2,                  // USD / 1M input tokens, or null
  "price_output": 10,                // USD / 1M output tokens, or null
  "speed_tps": null,                 // output tokens/sec, or null
  "benchmarks": { "swe_bench": 85.2, "gpqa": null, "aime": null,
                  "mmlu_pro": null, "lmarena_elo": null },  // % or Elo; null if unsourced
  "coding_score": 85,               // unified 0-100 coding ability (see below) — REQUIRED
  "coding_basis": "SWE-bench Verified 85.2%",   // what the score rests on
  "coding_confidence": "high",      // high (SWE-bench) | medium (alt signal) | low (consensus)
  "best_for": ["coding","agentic","cheap-bulk"],  // controlled vocab (see below)
  "strengths": ["…"], "weaknesses": ["…"],
  "verdict": "One plain-English sentence.",
  "sources": ["https://…"],
  "confidence": "high | medium | low"
}
```

### coding_score (the coding-ability signal)

The coding goal ranks on `coding_score` (0–100), NOT raw SWE-bench — because strong new models
often ship before a formal SWE-bench Verified number exists. Build it per model:

1. Has official **SWE-bench Verified %** → `coding_score` = that % (rounded); `coding_confidence`
   = high (drop to medium if the number is uncorroborated or disagrees with other signals).
2. No SWE-bench Verified → estimate from sourced alternatives — **Artificial Analysis Coding
   Index**, **LMArena Code Elo** rank (arena.ai/leaderboard/code), **SWE-bench Pro**,
   **LiveCodeBench** — calibrated against the benchmarked models; `coding_confidence` = medium.
3. No coding benchmark at all → expert/community consensus; `coding_confidence` = low.

Always set `coding_basis` to the human-readable signal(s) used. Also set the top-level
`coding_score_note` (shown in the UI). These signals genuinely disagree — never stamp an estimate
"high" confidence.

`best_for` vocabulary (must match the UI filters/goals):
`coding`, `agentic`, `writing`, `reasoning`, `cheap-bulk`, `vision`, `long-context`, `speed`, `research`.

Top level also needs: `as_of` (string), `releases` (array), `benchmarks_legend` (object of
one-line descriptions per benchmark key), `notes` (honest global caveat shown in the footer),
and `usage` (the "who's using what" lenses):

```jsonc
"usage": {
  "as_of": "2026-06 → 07",
  "basis": "one honest sentence: no single 'most used'; each lens is a different population",
  "lenses": [
    { "label": "Developers", "sub": "OpenRouter API token volume",
      "note": "one-line caveat", "source": "https://…",
      "top": [ { "name": "DeepSeek V4-Flash", "detail": "#1 model · ~6.4T tokens/mo" }, … ] },
    { "label": "Preference", "sub": "LMArena blind human votes", … },
    { "label": "Consumers", "sub": "AI-assistant web traffic", … }
  ]
}
```

Usage is a **proxy**, not market share — each lens measures a different population and they
disagree. Newest models often have no usage yet (data lags a couple of weeks); that's expected.
Re-run the usage/currency research pass to refresh it.

## After refreshing

1. Overwrite `data/models.json`.
2. Reload the page — the recommender, chart, table, and feed all read from it.
3. Sanity-check: for a **quality goal** (coding/agentic/reasoning), the top pick must be a
   model with a sourced score for that goal — never a "—".

## Runbook: keeping it current (added 2026-07-12)

Two cadences. Both end with bumping `as_of` and re-verifying the page loads.

### A. Weekly currency pass (~10 min, no full regen)
1. In a Claude Code session with web search, ask:
   > "What changed in AI models since <as_of date in data/models.json>? New model releases,
   > price changes, major benchmark updates — sourced links only."
2. For each finding:
   - New release → add to `releases[]` (date, title, summary, sourced URL, and a neutral
     `why` line: "Should you care?"). If it's a rankable model, add a full model entry
     per the schema rules above (nulls where unsourced).
   - Price change → update `price_input`/`price_output` + the source URL. Never estimate.
   - Benchmark update → same: only sourced, confidence-flagged.
3. Bump `as_of`. Reload the page locally; confirm the nav stamp shows the new date.
4. Commit + push on explicit go (public repo).

### B. Full refresh (quarterly, or when the landscape shifts)
Run the fan-out refresh prompt above (regenerates the whole file, then adversarial fact-check).

### Known dated triggers
- **2026-09-01**: Claude Sonnet 5 intro pricing ($2/$10) rises to $3/$15 — update on that day.

### Non-negotiables (same as ever)
- Blank beats guessed. Pricing traces to an official vendor page.
- Neutral voice: a release entry must read as information, never promotion of a lab.

### Wanted next (Lucas, 2026-07-12): per-model usage volumes
In the weekly pass, also pull **per-model monthly token/request volumes from OpenRouter's
public rankings** for as many of our 22 models as are listed. Add to each lens entry (or a
new `usage.models[]` map) with the source URL. Where a model isn't listed, leave it blank —
usage bars/figures only render for sourced numbers, never interpolated.

## Automated weekly check (scaffolding — see .github/workflows/data-refresh.yml)
A weekly GitHub Action runs **flag-first, propose-only** automation. It never writes prices or
benchmarks and never pushes to `main`:
- `scripts/refresh-auto.mjs` — fetches OpenRouter's public models API as a **price-drift alarm**
  (OpenRouter is provider pass-through, not list price → it flags "verify against the official
  page", never overwrites), checks dated triggers (Sonnet 5 → $3/$15 on 2026-09-01) and `as_of`
  staleness, and writes a `CHANGES.md` verification checklist + a machine `auto_checked` date
  (kept separate from the human-owned `as_of` so the site never overclaims freshness).
- `scripts/validate-data.mjs` — the **honesty gate**: fails if any non-null price/benchmark lost
  its `sources`, an enum is illegal, or a tag is off-vocab. Run it locally before committing data.
- The Action opens a PR (`auto/data-refresh`); **a human verifies, edits by hand, bumps `as_of`,
  and merges** — the only path to production.

**One-time enablement (Lucas):** repo Settings → Actions → General → "Allow GitHub Actions to
create and approve pull requests"; branch protection on `main` requiring 1 review. Per-model usage
volumes (OpenRouter *rankings*) need an API-key secret — deferred with the usage view.
