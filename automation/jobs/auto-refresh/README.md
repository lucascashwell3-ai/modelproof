# Modelproof auto-refresh — owner file

v1 job 4 (`automation/PIPELINE_V1.md`). Finds new models, pricing changes, and other listed
facts, and publishes the ones the evidence supports — a human is never a stage.

**Schedule:** Mondays 06:17 UTC, `workflow_dispatch` for on-demand runs. Cap: 1 run/week.

**Sources:** OpenRouter models API + LiteLLM price table (both public, Tier-A) + vendor pages
in `scripts/sources.json`. Optional judgment layer (Claude Sonnet 5, reads a vendor page) runs
only when `ANTHROPIC_API_KEY` is set, capped at 40 calls/run (~$0.30).

**Publish rules:**
- A price/context fact applies when ≥2 independent sources agree within 2%, or vendor page +
  judgment layer agree. Single-source facts are held for review, never published.
- Any change >5x or <0.2x current holds regardless of agreement (sanity bound).
- A new model publishes when found on ≥2 sources with pricing and a known vendor; benchmarks
  stay `null` and it's marked `auto_added`. Never fabricated.
- Missing from every source for 2 consecutive runs sets `deprecated: true` (never deletes).

**Failure behavior:** honesty gate (`scripts/validate-data.mjs`) blocks publish on any error —
nothing writes. Push/verify follow the feeder pattern: publish → wait for Pages → verify live
`as_of` matches → auto-revert + fail loud on mismatch. Held items collect into one GitHub issue
("Needs Lucas — modelproof data refresh"), closed automatically when empty.

**Local run:** `node scripts/auto-refresh.mjs --dry-run` (prints, writes nothing).
Tests: `node --test scripts/test-auto-refresh.mjs`.

**Last known good:** not yet run in Actions.
