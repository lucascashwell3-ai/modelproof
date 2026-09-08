# Refreshing Modelproof's data

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
  "id": "gemini-3-8-flash",          // derived from name — slug, no vendor glued on (scripts/naming.mjs)
  "name": "Gemini 3.8 Flash",         // the model's own name, no "Vendor: " label
  "vendor": "Google",                 // one canonical spelling per vendor: scripts/naming.mjs VENDORS
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

## Schema: `effort_ladders` (added 2026-07-24)

A ladder is a **published** cost-vs-performance curve: one model run at several effort /
reasoning settings, so a reader can see what extra spend actually buys. It powers panel 03.

```jsonc
{
  "id": "frontier-bench-v0-1-agentic-coding",
  "suite": "Frontier-Bench v0.1",      // benchmark name
  "task": "Agentic coding",            // what it measures, in plain words
  "x_label": "…", "y_label": "…",      // axis captions
  "as_of": "2026-07-23",
  "publisher": "Anthropic",            // WHO ran it
  "source_kind": "vendor-reported",    // or "third-party"
  "source": "https://…",               // the figure/page itself
  "confidence": "low|medium|high",
  "method":  "how the numbers were obtained + error bars",
  "harness": "the run conditions the publisher stated (verbatim-ish)",
  "caveat":  "who benefits from this benchmark looking the way it does",
  "levels":  ["low","medium","high","xhigh","max"],
  "series":  [{ "model_id": "claude-opus-5", "label": "Opus 5", "color": "#e05c3e",
                "points": [{ "effort": "low", "cost": 5.63, "score": 25.8 }, …] }]
}
```

Rules — `scripts/validate-data.mjs` enforces the first four and CI blocks on them:
- `suite`, `source`, `publisher`, `method`, `confidence` are **mandatory**. A curve without
  provenance doesn't ship; the panel renders all of it on screen under the chart.
- Every `model_id` must exist in `models[]`. Every point needs a real `cost` **and** `score` —
  drop an incomplete rung, never interpolate one.
- **Never model a ladder from list prices.** Cost-per-attempt depends on token usage per run,
  which pricing pages don't tell you. If the lab hasn't published the curve, there is no curve.
- Digitising a published *figure* is allowed (that's how the Frontier-Bench one was built) but
  say so in `method`, give the error bars, and anchor it to any numerically-quoted endpoints.
- `caveat` is not optional politeness. A vendor benchmarking its own models against rivals is
  the normal case here — say who ran it and what that means for reading it.

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
- **Claude Opus 5 benchmarks**: added 2026-07-23 with blank SWE-bench/GPQA cells and a
  medium-confidence, agentic-suite-led coding score. Re-check once third parties publish —
  that's the trigger to promote it to `high`.

### Non-negotiables (same as ever)
- Blank beats guessed. Pricing traces to an official vendor page.
- Neutral voice: a release entry must read as information, never promotion of a lab.
- An effort ladder ships with its publisher, harness, method and caveat, or it doesn't ship.

### Wanted next (2026-07-12): per-model usage volumes
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

**One-time enablement (repo owner):** repo Settings → Actions → General → "Allow GitHub Actions to
create and approve pull requests"; branch protection on `main` requiring 1 review. Per-model usage
volumes (OpenRouter *rankings*) need an API-key secret — deferred with the usage view.

## Arena preferred boards (added 2026-09-07)

`data/signals/arena-2026-09.json` backs every model's `standings.<task>.preferred` field
(`scripts/derive-standings.mjs`) — arena.ai's leaderboard tables render client-side with no
documented API (curl gets nav/footer only, confirmed both times this file has been captured), so
this is a **dated, manual snapshot**, not a live Collect fetch. `scripts/derive-standings.mjs`
only *reads* this file; it never touches arena.ai itself.

Three of this catalog's tasks (`coding`, `writing`, `chat`) map to a **full Text-Arena board**
(hundreds of models); the rest map to an Overview-tab **top-10 card**. Both are captured the same
way, with a headless browser (Claude_Browser / any MCP browser tool with `javascript_tool` or
equivalent DOM access) — read-only, no login, no vote submitted:

1. Navigate to `https://arena.ai/leaderboard/text` (for a Text-Arena board) or
   `https://arena.ai/leaderboard/` (for the Overview top-10 cards).
2. For a Text-Arena board: click the category in the left sidebar (`Overall`, `Coding`,
   `Creative Writing`, …). The page header shows the board's own disclosed totals — quote them
   verbatim into `category` and `n_models`, never recompute a total yourself.
3. Run this in the page (a full Text-Arena board renders EVERY row client-side at once — no
   scroll-triggered pagination was needed for any of the three boards captured 2026-09-07, up to
   400 rows in one `document.querySelector('table')`):
   ```js
   function extractBoard() {
     const table = document.querySelector('table');
     const rows = [...table.querySelectorAll('tbody tr')];
     return rows.map((tr, i) => {
       const tds = [...tr.querySelectorAll('td')];
       const rankTxt = tds[0]?.textContent.trim();
       const modelTd = tds[2];
       const nameSpan = modelTd?.querySelector('a span[title]');
       const modelName = nameSpan ? nameSpan.getAttribute('title') : (modelTd?.querySelector('a')?.textContent.trim() || null);
       const vendorLicense = modelTd?.querySelector('span.text-text-secondary')?.textContent.trim() || null;
       const scoreTxt = tds[3]?.textContent.trim() || null;
       const scoreMatch = scoreTxt ? scoreTxt.match(/^-?\d+(\.\d+)?/) : null;
       const votesTxt = tds[4]?.textContent.trim() || null;
       return { rank: rankTxt ? parseInt(rankTxt, 10) : (i + 1), model: modelName, vendorLicense,
                score: scoreMatch ? parseFloat(scoreMatch[0]) : null, votes: votesTxt };
     });
   }
   JSON.stringify(extractBoard());
   ```
   For an Overview top-10 card, use the card's own `[role="figure"][aria-label*="top 10 models"]`
   element instead of `table` — see the git history of this file / `scripts/derive-standings.mjs`
   for the exact selector used per card (rank/model/score sit in `order-1`/`[title]`/`order-4`
   spans inside each card row).
4. The result is large enough that a full-board capture usually gets saved to a file by the tool
   rather than returned inline — read it back with `python3`/`jq`, not by re-running the query.
5. Match each row's raw `model` string to a catalog id with
   `scripts/derive-standings.mjs`'s `matchTesterModel()` (same name-matching rule every other
   tester uses) — keep the row's **true rank as captured** (its position in the full/`top-10`
   ordering), never renumber after dropping unmatched rows. A name that doesn't match is simply
   left out, never guessed.
6. Write the result into that task's `tasks.<id>` entry: `category` (the page's own disclosed
   label, verbatim), `board_url`, `n_models` (the page's own disclosed total for a full board; for
   a top-10 card with no disclosed total, `10` — the count actually captured, not a guess),
   `capture` (a one-line note: full board vs. top-10 card, and why), `ranks: [{model_id, rank,
   votes?}]`.
7. Bump the file's own `as_of` to the capture date and re-run `node scripts/validate-data.mjs`.

**What's been captured so far:** `coding` → Text-Arena "Coding" (full, 395 models); `writing` →
Text-Arena "Creative Writing" (full, 398 models); `chat` → Text-Arena "Overall" (full, 400
models, used as the general-chat-quality proxy); `agents` → Agent Arena (full, 59 models);
`vision` → Vision Arena (full, 148 models); `extraction` → Document Arena (full, 39 models);
`research` → Search Arena (full, 34 models, used as the closest available proxy — Arena has no
dedicated research/analysis category); `frontend` → still the Overview "WebDev" top-10 card (no
dedicated full-board route exists for it — see below).
`exec-summaries` (Text-Arena rank-matrix "Longer Query" column — no dedicated summarization
category) and `bulk` (no Arena coverage at all — preference/quality by vote, not cost) were **not**
recaptured; `exec-summaries` still carries its original top-5 snapshot from the first capture.
Recapturing either is the next thing to do here, not a design decision to leave undone.

### A better capture method, discovered 2026-09-07 (brain v2 step 2)

While checking whether `agents`/`vision`/`extraction`/`research` (all top-10 cards until this
pass) had grown a full-board page, it turned out arena.ai now serves **dedicated per-category
routes** — `/leaderboard/vision`, `/leaderboard/document`, `/leaderboard/agent`,
`/leaderboard/search` — and, unlike `/leaderboard` (Overview) and `/leaderboard/text`
(Text-Arena), **these render the entire leaderboard table server-side, directly into the HTML
response.** A plain `curl` (or any read-only HTTP GET) returns the whole `<table>` with every
`<tr>` populated — no headless browser, no JS execution, no login, no vote, and no risk of a
scroll-triggered pagination cutting the capture short. Checked by diffing a `curl` fetch against
the rendered DOM for the same URL: identical rows.

Parse the returned HTML directly (Python's `html.parser`/BeautifulSoup or an equivalent):

```python
from bs4 import BeautifulSoup
soup = BeautifulSoup(html, 'html.parser')
tbody = soup.find('table').find('tbody')
for tr in tbody.find_all('tr', recursive=False):
    tds = tr.find_all('td', recursive=False)
    rank = int(tds[0].get_text(strip=True))          # vision/document/search layout
    name_span = tds[2].select_one('a span[title]')
    model = name_span.get('title') if name_span else tds[2].get_text(strip=True)
    score, votes = tds[3].get_text(strip=True), tds[4].get_text(strip=True)
```

**One board has a different column layout** — Agent Arena's table has no single Elo+votes pair
(it reports Net Improvement / Confirmed Success / Praise vs Complaint / Steerability / etc. per
model instead), and its rank/model cells sit one column earlier and use a nested `<span>` for the
rank rather than the cell's own direct text:

```python
rank = int(tds[0].find('span').get_text(strip=True))
name_span = tds[1].find('a').select_one('span[title]')
model = name_span.get('title') if name_span else tds[1].get_text(strip=True)
```

Total row count = the table's own row count (no separate "N models" label is disclosed on these
four pages, unlike the older Text-Arena boards) — confirmed complete by checking the last row's
rank equals the row count and that no "load more"/pagination control exists.

**Still no dedicated route for WebDev** — `/leaderboard/webdev` 404s (the site's own "Leaderboard
Not Found" page), checked the same day. `frontend` stays the Overview top-10 card as this
snapshot's fallback; its PRIMARY preferred evidence as of this pass is Epoch's own WebDev Arena
mirror (`scripts/derive-standings.mjs`, `data/testers.json`'s `webdev_arena_external.csv` entry,
`kind: "preferred"`) — see that file and `scripts/data-sources.md` for how the two combine (mirror
first, this card only for a model the mirror itself lacks).

The Overview (`/leaderboard`) and Text-Arena (`/leaderboard/text`) pages remain genuinely
client-rendered (curl still gets nav/footer only there) — the headless-browser method documented
above them in this section is still the right tool for those two and for any future board that
turns out to work the same way. Check both ways on a future recapture; don't assume one method
covers every board just because it worked for four of them this time.
