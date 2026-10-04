# Defaults watch — job notes

Keeps the install package's defaults (`data/guidance.json`) and the quoted plan prices
(`data/plans.json`) in step with what the coding tools, the model labs and the plan pages say
today. Deterministic: regex rules on page text, no model calls, no new secrets (`GITHUB_TOKEN`
only).

| | |
|---|---|
| Runs | Sunday 01:23 UTC (`.github/workflows/defaults-watch.yml`, cron `23 1 * * 0`) — clear of Collect (06:00 + 18:00 daily) and Judge/Verify (Tue/Fri). Also `workflow_dispatch` (dry run off main), and a dry run on every pull request that touches the job's own files. |
| Code | `scripts/defaults-watch.mjs` (tests: `scripts/test-defaults-watch.mjs`, frozen fixtures in `scripts/fixtures/watch/`) |
| Rules | `data/defaults-watch.json` — 104 rules over 45 pages; schema in `scripts/validate-data.mjs` `validateWatchList` |
| Reads | the rule pages (fetched fresh, never from a cache), `data/guidance.json`, `data/plans.json`, `data/models.json`, `scripts/model-aliases.json` |
| Writes | ONE bot pull request on the fixed branch `auto/defaults-watch` (guidance.json / plans.json only), its commit status `defaults-watch/gates`, the receipt `data/refresh/receipt-defaults-watch.json` (straight to main, every live run), `guidance.json` `as_of` (straight to main, only on a clean run, that one line) |
| Fails loud | exit 1 + one issue, "Defaults watch: rules need attention" (label `defaults-watch`), updated in place, closed by the next run with nothing to list. The claim-rot issue ("Sourced claims no longer verifiable") comes from the source sweep at the end of the run. |
| Burn-in | 3 green scheduled runs in a row (only `event=schedule` counts; dispatch and pull-request runs don't). |

## How a run goes

1. Fetch each rule page once, fresh. Run every rule: the anchor must be on the page, the pattern's
   group 1 is the value, compared with the data — no rule stores the value it expects.
2. Outcomes: `ok` · `change` (a field rule; for a model, the name resolves to a GA catalog id) ·
   `waiting:catalog` / `waiting:not-ga` (the catalog can't take that model yet; no write) ·
   `needs-review` (a flag rule changed, or a change can't be written honestly; no write; issue) ·
   `declined` (the value sits in a bot PR closed without merging; skipped until the page says
   something else) · `gate-failed` (red) · `blocked` (page unreadable; warning, red after 3 runs in
   a row) · `broken:missing` / `broken:ambiguous` (red; fix the rule, never guess).
3. A change writes the value at `maps_to` (+ `also`), a new claim per `claim_ids` (quote copied
   from the page and confirmed on it, sentence from the rule's template, dated today), marks the old
   claim `superseded_by` and swaps it in every `basis`. A plan price rewrites its row in place
   (price, quote, quote_url, as_of).
4. Each change is gated alone (validate-data + check-live-data `--group plans` on main + that
   change; problems main already has don't count), then all together. Passing changes go into the
   one PR (created, updated, or left alone when it already carries them). No change left: the job
   closes its own PR and deletes the branch.
5. The full source sweep (`check-sources --blocked-ok --fresh`, skipping quotes a pending change
   replaces) + `report-claim-rot`, and `check-live-data --group plans` on main.
6. Receipt to main; re-stamp `guidance.json` `as_of` only when every rule is ok, no change PR is
   open, and the sweep and the plans gate pass.

## Guards

- Remote writes only when not `DRY_RUN`, on `refs/heads/main`, not a `pull_request` event, with a
  token (`scripts/lib/gh-issue.mjs` `writeBlockReason`, checked again by the git pushes).
- PR, label, issue, status and branch delete go through `ghWrite`'s allowlist. The bot branch push
  takes `data/guidance.json` and `data/plans.json` only; the main push takes the receipt and an
  `as_of`-only change to `guidance.json`. A commit on the bot branch by anyone else stops the
  force-push and turns the run red.
- The pull-request dry run has a read-only token. Nothing in the job creates or edits a workflow,
  a schedule or a dispatch (a static test checks the job files).
- GitHub turns off schedules in a public repo after 60 days without activity; the weekly receipt
  commit keeps this one on.

## Run it by hand

- `node scripts/defaults-watch.mjs --dry-run` — real pages and data, prints every rule's outcome and
  what it would write (add `--sweep` for the source sweep; set `TMPDIR` to an empty folder for a
  fully fresh run).
- `node scripts/defaults-watch.mjs --drill` — pass 2 (frozen pages, one value swapped) must print
  exactly one PR; pass 3 (same input again) must print nothing new.
- `node --test scripts/test-defaults-watch.mjs`.

## Changing the rules

Edit `data/defaults-watch.json` in a pull request (the dry run on that PR shows the new outcomes).
A rule keyed to a model in its anchor or pattern names it with a placeholder —
`{short:claude-code.lead}`, `{slug:codex.lead}` — filled from the data at run time, so a new lead
model needs no rule edit. The frozen copies in `scripts/fixtures/watch/` change only by hand.
