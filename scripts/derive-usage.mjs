/* Per-model usage.openrouter — the machine-readable usage/rankings source the judged-fit spec
   asked for (scripts/data-sources.md's "Availability + plans" section documents the search; see
   the "Usage (added 2026-09-06)" entry there for the full story of what was tried and ruled out).

   THE SOURCE: https://openrouter.ai/api/frontend/v1/rankings/models — the JSON endpoint that
   backs OpenRouter's own public /rankings page. Confirmed live 2026-09-06: unauthenticated GET,
   returns `{ data: [{ date, model_permaslug, variant, total_prompt_tokens,
   total_completion_tokens, count, ... }] }` — one row per (model, variant) for a given day, across
   OpENrouter's ENTIRE tracked catalog, not just ours. It is NOT documented at openrouter.ai/docs
   the way the Tier-A /api/v1/models feed is (scripts/sources.json's "openrouter" entry), so it
   carries no stability guarantee — treat a fetch failure as "nothing to report", never as
   "everyone's usage is now zero".

   THE ARITHMETIC (why this is collection, not judgment): `share` is this model's
   (total_prompt_tokens + total_completion_tokens) as a percentage of the SAME SUM across every
   row the endpoint returns that same day — a single division of two directly-fetched numbers, not
   an average, interpolation, or reconciliation of multiple sources (the line data-sources.md's
   "provenance, not field type" rule actually draws). `rank` is this model's position when every
   tracked row (including models outside our own catalog) is sorted by that same token total —
   rank among the whole OpenRouter ecosystem, which is more meaningful than rank-among-our-63
   models. `category` is always "overall": the endpoint reports total volume, not a per-task
   breakdown, so a task-specific label would be invented — see data-sources.md for the one
   category-param experiment that was tried and found to do nothing.

   Usage: node scripts/derive-usage.mjs [--dry-run]   (standalone run/preview, mirrors
   scripts/derive-task-fit.mjs's own runner) */
import { readFileSync, writeFileSync } from 'node:fs';
import { matchAlias } from './auto-refresh.mjs';

export const RANKINGS_URL = 'https://openrouter.ai/api/frontend/v1/rankings/models';

/** Sum tokens per model_permaslug across every variant row on the day the feed returns (the feed
 * is a single day's snapshot, not a range) — pure, no I/O. Returns
 * [{ permaslug, tokens, requests, date }]. */
export function aggregateUsageRows(rows) {
  const byKey = new Map();
  for (const r of rows || []) {
    if (!r || !r.model_permaslug) continue;
    const tokens = (Number(r.total_prompt_tokens) || 0) + (Number(r.total_completion_tokens) || 0);
    const cur = byKey.get(r.model_permaslug) || { permaslug: r.model_permaslug, tokens: 0, requests: 0, date: r.date };
    cur.tokens += tokens;
    cur.requests += Number(r.count) || 0;
    if (r.date) cur.date = r.date;
    byKey.set(r.model_permaslug, cur);
  }
  return [...byKey.values()];
}

/**
 * Map the aggregated rows onto our catalog ids via the same alias/canonical matching Collect
 * already uses for price facts (auto-refresh.mjs's matchAlias — permaslugs carry a routing
 * prefix + date suffix exactly like the OpenRouter price feed's own ids, e.g.
 * "google/gemini-3.8-flash-20260902", which canonicalKey already knows how to strip).
 * Returns a Map<modelId, usageOpenrouterObject>. Pure — never touches the network; a model this
 * run couldn't match is simply absent from the map (the caller decides what "absent" means, per
 * the fill-vs-change rule — never regress a model that was matched on a prior run).
 */
export function deriveUsageForCatalog(rows, models, aliases = {}) {
  const agg = aggregateUsageRows(rows);
  const totalTokens = agg.reduce((s, a) => s + a.tokens, 0);
  if (!totalTokens || !agg.length) return new Map();
  const ranked = [...agg].sort((a, b) => b.tokens - a.tokens);
  const rankOf = new Map(ranked.map((a, i) => [a.permaslug, i + 1]));
  const asOf = agg[0]?.date ? String(agg[0].date).slice(0, 10) : null;
  if (!asOf) return new Map();

  const result = new Map();
  for (const a of agg) {
    if (a.tokens <= 0) continue;
    const id = matchAlias(a.permaslug, models, aliases);
    if (!id || result.has(id)) continue; // first (highest-token) match wins if a permaslug somehow double-maps
    result.set(id, {
      category: 'overall',
      share: Math.round((a.tokens / totalTokens) * 10000) / 100, // 2 decimal places
      rank: rankOf.get(a.permaslug),
      as_of: asOf,
      source_url: RANKINGS_URL,
    });
  }
  return result;
}

/** Best-effort live fetch — [] on any failure (matches feedEpochCursorBench's own pattern in
 * auto-refresh.mjs), so a down/renamed endpoint degrades to "usage unchanged this run", never a
 * hard failure of the whole Collect pass. */
export async function fetchOpenRouterRankings() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(RANKINGS_URL, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return Array.isArray(json?.data) ? json.data : [];
  } catch (e) {
    console.log(`usage: OpenRouter rankings fetch failed (${e.message}) — usage.openrouter left as is.`);
    return [];
  } finally {
    clearTimeout(t);
  }
}

// ---------------------------------------------------------------------------------------------
// standalone runner
// ---------------------------------------------------------------------------------------------
async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const ROOT = new URL('../', import.meta.url);
  const dataUrl = new URL('data/models.json', ROOT);
  const aliasUrl = new URL('scripts/model-aliases.json', ROOT);
  const data = JSON.parse(readFileSync(dataUrl));
  const aliases = JSON.parse(readFileSync(aliasUrl));

  const rows = await fetchOpenRouterRankings();
  const usageMap = deriveUsageForCatalog(rows, data.models, aliases);
  let changed = 0;
  for (const m of data.models) {
    if (!m.usage || typeof m.usage !== 'object') m.usage = { openrouter: null };
    const next = usageMap.get(m.id);
    if (next && JSON.stringify(m.usage.openrouter) !== JSON.stringify(next)) { m.usage.openrouter = next; changed++; }
  }
  console.log(`usage: ${rows.length} row(s) fetched, ${usageMap.size} matched to a catalog model, ${changed} updated.`);
  if (!dryRun && changed) {
    writeFileSync(dataUrl, JSON.stringify(data, null, 2) + '\n');
    console.log('usage: data/models.json written.');
  } else {
    console.log('usage: --dry-run or nothing changed, nothing written.');
  }
}

import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
const isMain = (() => {
  if (!process.argv[1]) return false;
  try { return fileURLToPath(import.meta.url) === realpathSync(resolve(process.argv[1])); }
  catch { return fileURLToPath(import.meta.url) === process.argv[1]; }
})();
if (isMain) {
  main().catch((e) => { console.error(e); process.exitCode = 1; });
}
