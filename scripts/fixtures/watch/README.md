# Defaults watch — frozen fixtures

Frozen on 2026-10-04 for `scripts/test-defaults-watch.mjs` and the drill
(`node scripts/defaults-watch.mjs --drill`). Nothing here is read from `data/` or the network at test
time, so a merged data change or a rule edit never turns these tests red on its own. Refresh by hand,
in a reviewed pull request, never from a job.

- `watch.json` — copy of `data/defaults-watch.json`.
- `guidance.json`, `plans.json` — copies of the data files.
- `models.json` — the catalog slice the job needs: id, name, vendor, status of every model.
- `aliases.json` — copy of `scripts/model-aliases.json`.
- `pages.json` — `{url: page text}`: normalized excerpts (≤2 KB each) of every rule page, cut around
  each anchor, each match and each quote a rule rewrites; ` … ` marks a cut.
- `drill.json` — the drill's one swapped value.
