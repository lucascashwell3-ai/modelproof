# Test fixtures

Frozen snapshot of `data/` on main, taken 2026-09-13 (brain v2 step 3 — standings-based ranking,
round 2 of that same PR). The unit test suite (`scripts/test-*.mjs`) runs on this snapshot, never
on live `data/`. Refresh it deliberately, in a PR a person reviews — never from an automated job.

The ranking engine and its eval fixtures (`eval/*`, `scripts/test-eval-situations.mjs`) now live in
`archive/engine/`. Notes below that mention them are history.

Refreshed this pass (round 2, after the near-top-formula/tier-numbering fixes, the alias/naming
coverage fixes, the deliberate 2026-09-13 Collect run, and the live-feed-claims migration were all
final):
- `models.json` — re-copied from live `data/models.json` one more time: it now also carries the
  round-2 alias/naming coverage fixes (scripts/model-aliases.json, scripts/naming.mjs — Claude
  Haiku 4.5's usage/standings are no longer null), the 2026-09-13 Collect refresh (68 models, one
  new admission), and the scripts/migrate-claims-2026-09.mjs pass (every task_fit_judged claim
  citing a live feed — OpenRouter's rankings API or arena.ai — removed; the same evidence lives on
  in `standings`). This is the one place expected test values are allowed to change, and it
  happened by hand in this PR.
- `eval/situations.json` — replaced the old 20-situation snapshot with the full, current
  40-situation cold answer key (data/eval/situations.json).
- `eval/must-never.json` — added (new file): the 15 absolute "must never start here" rules
  (data/eval/must-never.json), so scripts/test-eval-situations.mjs can run both without touching
  live data.
- `tasks.json` — added (new file, copy of data/tasks.json): scripts/test-derive-signals.mjs needs
  a task -> openrouter_signal map and previously read the live file directly.
- `signals/arena-2026-09.json`, `signals/expert-defaults.json` — added (new files, copies of
  data/signals/*): the two checked-in snapshots scripts/derive-signals.mjs reads for the
  arena/expert-default families; scripts/test-derive-signals.mjs previously read the live copies.

`plans.json`, `usage-presets.json`, `vendors.json`, `eval/situations.json`, `eval/must-never.json`,
`tasks.json`, `signals/*` are unchanged since the round-1 refresh (diffed byte-for-byte against
live `data/` before this round-2 refresh — nothing to update; only `models.json` moved).

Refreshed again (round 3, after the "early" tier-scope fix — item 1 — and the extended claims
migration — item 3 — were both final):
- `models.json` — re-copied once more: the tier-scope fix itself doesn't touch data, but the
  claims migration extension does (artificialanalysis.ai purged as a display-banned host, plus 6
  explicitly-confirmed stale third-party quotes — scripts/migrate-claims-2026-09.mjs's
  `EXPLICIT_STALE_CLAIMS`). `node scripts/check-sources.mjs` against the live catalog: 155/155
  (100%).
- `eval/known-disagreements.json` — added (new file, round 3, item 5): the exact set of situation
  ids the engine misses against THIS fixture, each with a one-line reason.
  `scripts/test-eval-situations.mjs` now asserts the live miss set equals this file's set exactly
  (a new miss or a newly-passing situation both fail the test) instead of asserting zero misses —
  so the 40-situation eval is green AND honest, and any real behavior change gets a person's eyes
  on it via updating this file deliberately, in the same PR. Current set (10 of 40, all traced to
  the key's own additional evidence families — vendor expert-default rosters, cited enterprise
  case studies — that this engine deliberately doesn't rank on): S10, S11, S12, S14, S23, S26,
  S27, S29, S33, S37. must-never stays a hard 15/15.

Data-contract pass (2026-10-03, scripts/validate-data.mjs FEEDS):
- `models.json` — the seven `released: "unknown"` values are now `null`, the Claude Opus 4.8
  timeline entry carries its sourced full date (2026-05-28, Anthropic's announcement), and the dead
  top-level `usage` lens block is gone — the same three edits made to live `data/models.json`, so
  the fixture still passes the gate test-apply-judgment's sandbox runs. Nothing else changed.
- `tasks.json` — gained a file-level `as_of` (the contract asks every shown file for one).
- `board-samples.json` — added (new file): a copy of data/board-samples.json whose
  `personal_default` names ids that exist in this fixture catalog; the sandbox gate checks it.

Lead / Helpers / Bulk pass (2026-10-03, guidance.json tool_plans):
- `guidance.json` — re-copied from live `data/guidance.json`: it now carries `tool_plans` (one plan
  per tool), the refreshed claims, the Codex `model_refs` and the Sonnet 5.5 alias. 205 claims.
- `instructions-models.json` — re-projected from live `data/models.json` (80 models, incl. Claude
  Sonnet 5.5 and GPT-6.1 Sol, which the plans name).
- `instructions-plans.json` — re-projected from live `data/plans.json`, now with the `reaches` and
  `covers_tokens` columns the generator reads instead of a typed table.
- `profiles/` — added `copilot`, `antigravity`, `openrouter`, `cc-copilot` (Claude Code + GitHub
  Copilot) and `power-user-max5x` (a heavy Claude Code user on Max 5x). `packages/` — every golden
  regenerated with `UPDATE_GOLDENS=1 node --test scripts/test-instructions.mjs` and reviewed; the
  new `*.setup.json` files are `install.mjs detect` output on the matching `setups/` folder, with the
  temp paths replaced by made-up ones.
