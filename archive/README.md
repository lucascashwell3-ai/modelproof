# archive/

Superseded work, kept for history, never deleted. Nothing in here is loaded by the site, the
tests or the data pipeline.

- `hero-ascii-reference.html` — the original ASCII-sunset hero mockup that seeded the live
  site-wide scene (shipped in PR #1, 2026-07-19). The production implementation lives in
  `assets/app.js` (`initScene`); this file is the parked reference it grew from.

## engine/ — the retired ranking (2026-09)

Modelproof used to rank models and name one per task. It now shows sourced facts and installs a
setup that follows your own choice, then the tool's or lab's own published default, otherwise
the same model as your main one. These pieces ranked, or existed only to test the ranking, so
they moved here.

- `lab.html` — a test page that ran the ranking on every task and showed the top of each
  shortlist. Linked from nowhere; retired with the ranking.
- `data/eval/situations.json`, `data/eval/must-never.json` — the 40-situation answer key and the
  15 "must never come first" rules the ranking was graded against. Nothing ranks now, so there is
  nothing to grade.
- `scripts/eval-report.mjs` — printed the ranking's pass rate against that answer key after each
  data refresh. Its step in the refresh workflow was removed in the same change.
- `scripts/test-decide.mjs` (62 tests), `scripts/test-eval-situations.mjs` (6 tests) and
  `scripts/fixtures/eval/` — unit tests and frozen fixtures for the ranking. They import
  `assets/decide.mjs` and the fixtures by their old paths, so they no longer run from here.
- `app-ranking.js` — the ranking half of `assets/app.js`: the task/budget/lab console, the scorer,
  the "your pick" card and its basis panel, the per-lab kit, the upgrade check, the goal maps, and
  the old compare seeding that filled the board with the top three by score. The compare board
  now starts from each of three labs' newest release, and the table filters by lab.
- `mcp-scorer.js` — the MCP server's copy of that scorer plus its two ranking tools
  (`recommend_model`, `my_kit`). The server (v0.3.0) now serves facts only.

`scripts/check-live-data.mjs` kept its model-count, date and feed-health checks; the three checks
that ran the ranking on live data went with it.
