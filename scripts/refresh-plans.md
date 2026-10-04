# Refreshing data/plans.json (manual — no automation yet)

1. For each vendor's pricing page in `data/plans.json`, `curl -s -A "<a real browser UA>" -L <source_url>`
   and read the price straight out of the fetched HTML — don't trust memory or an old screenshot.
2. If a plan's price isn't literally present in that HTML (common on JS-rendered pricing widgets —
   OpenAI's ChatGPT page and Cursor's Pro+/Ultra/Premium tiers are like this today), leave
   `price_usd_month: null` and say why in `billing`. Never fill in a number from general knowledge.
3. Update `as_of` (top-level and per-plan) to the fetch date. For every row that prints a price,
   copy a short verbatim `quote` (≤25 words) from the fetched page that shows that price — on
   `source_url`, or on `quote_url` when the words live on another page of the same vendor (a help
   center or docs table). A row whose price is `null` has nothing to quote. Rows a harness or
   marketplace sells (Cursor, GitHub Copilot, Devin, …) carry `reaches` and `covers_tokens`; a flat
   per-team fee goes in `base_usd_month`; a renamed row keeps its old board label in
   `renamed_from`. Then run `node scripts/validate-data.mjs` and `node scripts/check-sources.mjs
   --only plan/<vendor>` — the first checks every plan has a `source_url`, a valid `as_of`, a
   non-negative price or `null`, and a `quote` on every priced row checked on or after 2026-10-03;
   the second confirms each quote is really on its page.
4. Commit `data/plans.json` with the vendor(s) touched in the message. No PR ceremony required for a
   pure data refresh, same as the rest of this repo's manual data fixes.
