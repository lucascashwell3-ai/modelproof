# Modelproof refresh v1.1 — owner file

`automation/PIPELINE_V1.md` "Modelproof refresh — v1.1". Three pieces, Tue/Fri, 45 min end to end.

| UTC (Tue+Fri) | Piece | Runs on | Does |
|---|---|---|---|
| 06:00 | **Collect** | GitHub Actions (`.github/workflows/auto-refresh.yml`) | Pulls OpenRouter + LiteLLM + LMArena (best effort); applies 2-source-agreement facts; writes `data/refresh/worklist.json` for anything it can't settle (new models, conflicts, benchmarks, ladders, releases) |
| 06:30 | **Judge** | claude.ai cloud routine, Sonnet | Reads only `worklist.json`, researches the open web, writes `judgments.json`, applies via `scripts/apply-judgment.mjs`, pushes to main. Instructions: `scripts/refresh-judge.md`. |
| 07:15 | **Verify** | GitHub Actions (`.github/workflows/refresh-verify.yml`) | Confirms live `as_of` ≥ collect's receipt date and the gate passes on the live file; reverts + fails loud on mismatch |

**Sources:** OpenRouter models API + LiteLLM price table (Tier A, public, no key) + LMArena
leaderboard CSV (best effort — skipped with a note if unreachable, never scraped). Judge also
searches vendor pages, model cards, Epoch, papers for anything Collect can't settle.

**Publish rules:**
- A price/context fact applies when ≥2 independent sources agree within 2%. Single-source or
  conflicting facts go to the worklist for the Judge, never guessed.
- Any change >5x or <0.2x current holds regardless of agreement (sanity bound).
- A new model publishes when found on ≥2 sources with pricing and a known vendor; gets a
  `releases` entry and a deterministic `best_for_line` (facts template, no prose). Otherwise it's
  a `new-model` worklist item for the Judge.
- Missing from every source for 2 consecutive Collect runs is NEVER auto-deprecated — it becomes
  a `deprecation` worklist item ("Is X deprecated/retired? Cite the vendor page.") for the Judge
  to decide and cite. Presence detection uses the exact same name/id alias matching as the price
  check, so a model matched for price can never also count as absent.
- Every Judge write goes through `scripts/apply-judgment.mjs`: schema-enforced (known fields
  only, numeric fields numeric, sourced, reason ≥12 chars), gate-checked, restores the file and
  exits 1 on gate failure.

**Caps:** 2 passes/week. Judge: ≤15 worklist items, ≤10 minutes wall-clock, Sonnet only. Anything
past the cap waits for the next pass — nothing piles up silently, it just stays in the worklist.

**Failure behavior:** honesty gate (`scripts/validate-data.mjs`) blocks every publish, Collect or
Judge, on any error. Verify reverts the data commit(s) since Collect on a live-mismatch or
gate failure and fails loud. Held items collect into one GitHub issue ("Needs Lucas — modelproof
data refresh", via `scripts/needs-lucas-issue.mjs`), closed automatically when empty.

**Receipts:** each piece writes `data/refresh/receipt.json` (`{job, ran_at, ..., ok}`) — the
reporter reads these for the board and missed-tick detection.

**Local run:**
- `node scripts/auto-refresh.mjs --dry-run` — collect, prints only.
- `node scripts/apply-judgment.mjs judgments.json --dry-run` — judge apply, prints only.
- `node --test scripts/test-auto-refresh.mjs scripts/test-apply-judgment.mjs` — unit tests.

**Last known good:** not yet run under v1.1.
