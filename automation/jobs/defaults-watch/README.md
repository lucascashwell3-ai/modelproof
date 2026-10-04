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
| Writes | ONE bot pull request on the fixed branch `auto/defaults-watch` (guidance.json / plans.json only), its commit status `defaults-watch/gates`, the receipt `data/refresh/receipt-defaults-watch.json` (straight to main, every live run), the date lines of `guidance.json` — each tool's `tool_plans[].as_of` and the top-level `as_of` (straight to main, nothing else in that file) |
| Fails loud | exit 1 + one issue, "Defaults watch: rules need attention" (label `defaults-watch`), updated in place, closed by the next run with nothing to list. The issue has no run date, so a week with the same findings edits nothing and sends no notice. The claim-rot issue ("Sourced claims no longer verifiable") comes from the source sweep at the end of the run. |
| Burn-in | 3 green scheduled runs in a row (only `event=schedule` counts; dispatch and pull-request runs don't). |

## How a run goes

1. Fetch each rule page once, fresh. Run every rule: the anchor must be on the page, the pattern's
   group 1 is the value, compared with the data — no rule stores the value it expects.
2. Outcomes: `ok` · `change` (a field rule; for a model, the name resolves to a GA catalog id) ·
   `waiting:catalog` / `waiting:not-ga` (the catalog can't take that model yet; no write) ·
   `needs-review` (a flag rule changed, or a change can't be written honestly; no write; issue) ·
   `declined` (the value sits in a bot PR closed without merging; not proposed again until the
   page says something else; listed in the issue, and its old quote stays in the source sweep) · `gate-failed` (red) · `blocked` (page unreadable; warning, red after 3 runs in
   a row) · `broken:missing` / `broken:ambiguous` (red; fix the rule, never guess).
3. A change writes the value at `maps_to` (+ `also`), a new claim per `claim_ids` (quote copied
   from the page and confirmed on it, sentence from the rule's template, dated today), marks the old
   claim `superseded_by` and swaps it in every `basis`. A plan price rewrites its row in place
   (price, quote, quote_url, as_of).
4. Each change is gated alone (validate-data + check-live-data `--group plans` on main + that
   change; problems main already has don't count), then all together. Passing changes go into the
   one PR (created, updated, or left alone when it already carries them). No change left: the job
   closes its own PR and deletes the branch. The branch is always built on main as it is at push
   time: the changes are applied again to main's files (and gated again if main moved), never
   copied from the run's own checkout, so nothing that landed on main during the run is undone.
   The PR's fingerprint covers main's copy of each file it changes (the date lines this job
   stamps left out), so when main changes one of them the PR is rebuilt. Its commit status is
   checked every run and posted again when it is missing.
5. The full source sweep (`check-sources --blocked-ok --fresh`, skipping quotes a pending change
   replaces) + `report-claim-rot`, and `check-live-data --group plans` on main.
6. Receipt to main (on a fresh main each try, up to 5 tries with a 1, 2, 4, 8 s wait, so a run of
   Collect pushing at the same time never makes it fail). Each tool is dated on its own: its
   `tool_plans[].as_of` gets today when every rule that feeds it is ok (or declined), none of its
   values waits in the bot PR, and the sweep read and found every guidance quote it rests on. A
   fact no single tool rests on (a lab page, an AGENTS.md fact) feeds every tool; a plan price
   feeds none. The top-level `as_of` is the oldest tool date. So one blocked page or one waiting
   model holds back only the tools it feeds.
7. Red, and in the issue, when `guidance.json` or `plans.json` (kept by hand,
   `scripts/refresh-plans.md`) has an `as_of` within 7 days of the pages' stale notice; when a
   sweep page could not be read 3 runs in a row; and on any run problem (sweep error, a foreign
   commit on the open PR, main moving so far during the run that a change no longer applies). The
   other files kept by hand (every feed with cadence "by hand" in `assets/freshness.mjs`, which
   holds the limits) are listed in the issue within 7 days of their limit, and turn the run red
   once past it. A run that throws writes the error to the issue before it fails. An open PR is
   listed in the issue, and the receipt names it on every run, red or not.

## Worth knowing

- All changes share one pull request. Closing it without merging declines every value in it, not
  just the one you disagree with; to keep some, merge and then fix the rest by hand.
- The pull-request dry run reads the live vendor pages, so a page that changed for reasons that
  have nothing to do with your pull request can turn that check red. Read which rule failed before
  blaming your change.
- The bot's pull requests get no `tests.yml` run (GitHub does not start workflows for pushes made
  with the job's own token). The job gates every change itself with validate-data and
  check-live-data before it pushes, and posts that result as the `defaults-watch/gates` status.

## Guards

- Remote writes only when not `DRY_RUN`, on `refs/heads/main`, not a `pull_request` event, with a
  token (`scripts/lib/gh-issue.mjs` `writeBlockReason`, checked again by the git pushes).
- PR, label, issue, status and branch delete go through `ghWrite`'s allowlist. The bot branch push
  takes `data/guidance.json` and `data/plans.json` only; the main push takes the receipt and a
  change to `guidance.json`'s date lines only (checked line by line and on the parsed data). A commit on the bot branch by anyone else stops the
  force-push and turns the run red while it is not in main and its PR is open (a merged or closed
  PR's branch is reused; GitHub keeps a PR's commits).
- The pull-request dry run has a read-only token, and no dry run keeps the token on disk after
  checkout (`persist-credentials: false`); only the live run, which pushes, keeps it. Every run on
  main, scheduled or dispatched, shares one concurrency group, so two never run at once. Nothing in
  the job creates or edits a workflow, a schedule or a dispatch (a static test checks the job
  files).
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
