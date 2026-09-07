# Refreshing data/plans.json (manual — no automation yet)

1. For each vendor's pricing page in `data/plans.json`, `curl -s -A "<a real browser UA>" -L <source_url>`
   and read the price straight out of the fetched HTML — don't trust memory or an old screenshot.
2. If a plan's price isn't literally present in that HTML (common on JS-rendered pricing widgets —
   OpenAI's ChatGPT page and Cursor's Pro+/Ultra/Premium tiers are like this today), leave
   `price_usd_month: null` and say why in `billing`. Never fill in a number from general knowledge.
3. Update `as_of` (top-level and per-plan) to the fetch date, and re-run `node scripts/validate-data.mjs`
   — it checks every plan has a `source_url`, a valid `as_of`, and that `price_usd_month` is a
   non-negative number or `null`.
4. Commit `data/plans.json` with the vendor(s) touched in the message. No PR ceremony required for a
   pure data refresh, same as the rest of this repo's manual data fixes.
