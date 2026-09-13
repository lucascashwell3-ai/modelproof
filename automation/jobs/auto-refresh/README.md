# Modelproof refresh v1.1 — owner file

`automation/PIPELINE_V1.md` "Modelproof refresh — v1.1". Three pieces; Collect checks in twice a
day (see "Release watching" below), Judge + Verify stay Tue/Fri, 45 min end to end.

| UTC | Piece | Runs on | Does |
|---|---|---|---|
| 06:00 (full pass) + 18:00 (id check) | **Collect** | GitHub Actions (`.github/workflows/auto-refresh.yml`) | Cheap id check at 18:00 (see below); at 06:00, pulls OpenRouter + LiteLLM + Epoch's benchmark export, applies 2-source-agreement facts, writes `data/refresh/worklist.json` for anything it can't settle (new models, conflicts, benchmarks, ladders, releases) |
| 06:30 Tue/Fri | **Judge** | claude.ai cloud routine, Sonnet | Reads only `worklist.json`, researches the open web, writes `judgments.json`, applies via `scripts/apply-judgment.mjs`, pushes to main. Instructions: `scripts/refresh-judge.md`. |
| 07:15 Tue/Fri | **Verify** | GitHub Actions (`.github/workflows/refresh-verify.yml`) | Confirms live `as_of` ≥ collect's receipt date and the gate passes on the live file; reverts + fails loud on mismatch |

**Gate (fixed 2026-09-12 — see `scripts/fixtures/README.md`):** the unit suite
(`scripts/test-*.mjs`) runs on a frozen fixture (`scripts/fixtures/`), never on live `data/`, so a
legitimate data change can never turn CI red. After Collect writes real data, `scripts/validate-data.mjs`
+ `scripts/check-live-data.mjs` check the live file — schema/honesty rules plus a small set of
invariants (decide() still runs, ids are real, `must_not_include` still holds, model count and
`as_of` look sane, and no key field's non-null count dropped more than 15% since the committed
version — catches a feed silently starting to return empty instead of erroring loud) — never an
expected winner.

**Dry run / UAT:** every change to `.github/workflows/auto-refresh.yml` is proven on a real GitHub
Actions run before merge — `gh workflow run auto-refresh.yml --ref <branch> -f dry_run=true`. It
runs the real feeds and both gates exactly as a live pass would, but skips the GitHub issue write
(no token), the commit, the push, and the live-site verify — a branch dispatch is always a dry run
regardless of the flag, since a bot must never push code to main from anywhere but main. Ends with
a `$GITHUB_STEP_SUMMARY` showing gate result, changed data files, and `as_of` before/after.

**Release watching (added 2026-09-06, cadence fixed 2026-09-12):** Collect's workflow schedule is
06:00 + 18:00 UTC — one workflow, two cron entries a day, no second job. The 18:00 cycle only
fetches the OpenRouter + LiteLLM id lists and compares them against `data/models.json` +
`data/_auto_refresh_state.json`'s already-flagged candidates (`findNewCandidateIds` /
`decideRefreshRun` in `scripts/auto-refresh.mjs`); with no genuinely new id, it logs `no new
models — skipping full run` and exits without touching the network further or writing anything. A
new candidate id, or the 06:00 UTC hour itself, runs the full Collect pass exactly as before —
this is what catches a launch-day model within about 12h instead of waiting for the next scheduled
pass.

**Sources:** OpenRouter models API + LiteLLM price table (Tier A, public, no key) + Epoch AI's
CC-BY benchmark export (ladders). LMArena dropped 2026-08-22: feed 404s and its terms forbid republishing. Judge also
searches vendor pages, model cards, Epoch, papers for anything Collect can't settle.

**Publish rules:**
- A price/context fact applies when ≥2 independent sources agree within 2%. Single-source or
  conflicting facts go to the worklist for the Judge, never guessed.
- Any change >5x or <0.2x current holds regardless of agreement (sanity bound).
- Every record follows one naming rule (`scripts/naming.mjs`): the id is the slug of the model's
  own name with no vendor glued on (`gemini-3-8-flash`, not `google-gemini-3-8-flash`), the vendor
  is one canonical spelling from that file's list, the name carries no "Vendor: " label. The
  honesty gate rejects anything else. OpenRouter "~vendor/…" community re-hosts are dropped with a
  logged reason and never queued.
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

**Usage guidance (added 2026-08-22):** the advisor skill ranks on `best_for` + `use_well`, and 24
of 49 models had neither. Collect now puts up to 3 blank models per run on the worklist as
`guidance` items — reserved slots inside the 15 (a live dry-run showed ~45 higher-priority
candidates per run, so without reservation guidance would never reach the Judge). Rotation is a
cursor in `data/_auto_refresh_state.json` (`guidanceCursor`): sorted ids, start after the last
attempted, wrap — a held model comes round again after the rest. The Judge fills from the
vendor's docs, cited; `apply-judgment.mjs` enforces vocab tags, 2–4 tips of 20–240 chars, and
growth-only (never overwrites existing guidance). At 3 per run, 2 runs/week, the blank half of the
catalog fills in about a month.

**Effort ladders (added 2026-08-22):** Collect downloads Epoch AI's CC-BY `benchmark_data.zip` and
rebuilds the CursorBench ladder's rungs from `cursorbench_external.csv` (tier A, exact values). Each
series carries a `source_key` (the CSV's model stem); the series list is fixed in data — the feed never
adds or drops a model, only refreshes rungs. A series with < 2 usable rungs in the file keeps
yesterday's points; an unreachable feed leaves the ladder untouched. The other two ladders
(Frontier-Bench, Terminal-Bench) are chart-read from vendor posts — manual, by design.

**Timeline kinds (2026-08-22):** every entry carries `kind: model | price | retired`; the site shows
new models by default and lets readers add the other two. Collect writes a `price` entry for any
applied price move of 20%+ (`scripts/timeline.mjs`); the Judge's price resolutions do the same, and a
Judge `deprecation` (value: true, vendor notice in sources) marks the model retired and writes a
`retired` entry. Smaller price moves stay in the changelog only.

**Timeline — new models:** every model the Judge admits now gets a `releases` entry (date = its release date,
source = the Judge's first source; the Judge may supply `release: {summary, why, source}`).
Collect's auto-admits already did this.

**Caps:** 2 passes/week. Judge: ≤15 worklist items, ≤10 minutes wall-clock, Sonnet only. Anything
past the cap waits for the next pass — nothing piles up silently, it just stays in the worklist.

**Failure behavior:** honesty gate (`scripts/validate-data.mjs`) blocks every publish, Collect or
Judge, on any error. Verify reverts the data commit(s) since Collect on a live-mismatch or
gate failure and fails loud. Held items collect into one GitHub issue ("Held for review — modelproof
data refresh", via `scripts/held-review-issue.mjs`), closed automatically when empty.

Both Collect's post-push check and the standalone Verify piece use `scripts/verify-live.mjs`,
which polls the live site for up to 30 minutes instead of checking once: matched → publish
confirmed; Pages build failed, or built but content still wrong after a short grace period →
revert; still pending at 30 min → fail loud with main untouched (the next run re-verifies).
**Only a failed or wrong deploy ever reverts — a deploy that's merely slow never does.**

**Receipts:** each piece writes `data/refresh/receipt-<piece>.json (collect / judge / verify)` (`{job, ran_at, ..., ok}`) — the
reporter reads these for the board and missed-tick detection.

**Local run:**
- `node scripts/auto-refresh.mjs --dry-run` — collect, prints only.
- `REFRESH_FORCE_FULL=1 node scripts/auto-refresh.mjs --dry-run` — force a full pass regardless of
  the early-exit check (testing only). `REFRESH_FORCE_SKIP=1` forces the skip path the same way.
- `node scripts/apply-judgment.mjs judgments.json --dry-run` — judge apply, prints only.
- `node --test scripts/test-*.mjs` — unit tests (frozen fixture).
- `node scripts/validate-data.mjs && node scripts/check-live-data.mjs` — live-data gate.

**Last known good:** 2026-08-16 — Collect 31966006991 (15 queued) → Judge cse_01UTBzYskvNx5YYeHgimPGzS (Sonnet; +9 models cited, 6 held → issue #13) → Verify 31966363872 green. 38 models live.
