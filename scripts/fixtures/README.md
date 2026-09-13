# Test fixtures

Frozen snapshot of `data/` on main, taken 2026-09-13 (brain v2 step 3 — standings-based ranking).
The unit test suite (`scripts/test-*.mjs`) runs on this snapshot, never on live `data/`. Refresh it
deliberately, in a PR a person reviews — never from an automated job.

Refreshed this pass:
- `models.json` — now carries `standings` (scripts/derive-standings.mjs), `signals`
  (scripts/derive-signals.mjs), and `status`/`adoption` (scripts/derive-status-adoption.mjs) on
  every model; the previous frozen copy predated all three and had none of them. This is the one
  place expected test values are allowed to change, and it happened by hand in this PR, after the
  new ranking (assets/decide.mjs) was final.
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

`plans.json`, `usage-presets.json`, `vendors.json` are unchanged this pass (diffed byte-for-byte
against live `data/` before this refresh — nothing to update).
