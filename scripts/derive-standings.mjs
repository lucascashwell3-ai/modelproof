#!/usr/bin/env node
/* The STANDINGS feed. Writes `standings{}` onto every model in
   data/models.json: three kinds of evidence per model x per task, kept separate, NEVER averaged
   into one another and never used to rank anything here —

     measured   rank out of n on a named, independent benchmark (data/testers.json's registry)
     chosen     real spend share on OpenRouter for that task (task-spend tags merged per task)
     preferred  blind human-vote rank on arena.ai's leaderboard for that task

   `assets/decide.mjs` (the ranking) is UNTOUCHED by this file — step 3 wires standings into a
   ranking; this step only collects and publishes the evidence.

   SOURCES (see data/testers.json for the full audit of why each one is trusted at the level it
   is; this file only re-derives what that audit already ruled, it doesn't re-litigate it):
     - Epoch AI's benchmark_data.zip (tester id "epoch-ai", verdict "use", CC-BY/display-ok) —
       every per_benchmark CSV testers.json maps to one of this catalog's 10 tasks, EXCEPT
       arc_agi_2_external.csv (superseded below — arc-prize is the primary source for that data,
       per epoch-ai's own tasks.research note "ARC-AGI-2 (mirrored — see arc-prize entry for the
       primary source)").
     - ARC Prize Foundation's evaluations.json (tester id "arc-prize", verdict "use",
       display-ok) — the "v2_Semi_Private" cut specifically (data/testers.json: "research:
       ARC-AGI-2 semi-private evaluation").
     - LiveBench's live table_<date>.csv (tester id "livebench", verdict "use") — the date isn't
       documented anywhere; discovered by reading the site's own compiled JS bundle for its
       release-date array, the same way the tester audit found it (see
       discoverLiveBenchTableUrl()).
     - Scale AI SEAL and arena.ai's benchmark boards are the two testers.json flags as
       signal-only-or-worse for MEASURED purposes: SEAL has no stable, non-fragile fetch (Next.js
       RSC payload, no documented API) and was left OUT of measured entirely within this pass's
       budget — never scraped past what a page's own network requests expose. Arena isn't a
       "measured" source at all here; it is PREFERRED (blind human votes), a different kind of
       evidence, read from the checked-in data/signals/arena-2026-09.json snapshot (this script
       never fetches arena.ai itself — see scripts/refresh.md's "Arena preferred boards" section
       for how that snapshot is captured/replaced). Same rule applies one level down: Epoch's
       webdev_arena_external.csv mirrors that SAME blind-vote board (WebDev Arena), just through a
       second party, so it is ALSO preferred, never measured — data/testers.json marks it
       `kind: "preferred"` and epochPreferredFromRanked()/mergePreferredFallback() route it into
       standings.frontend.preferred (mirror first, the arena.ai snapshot as fallback for a model
       the mirror lacks), with `licence: 'signal-only'` and `score: null` always — cite the rank,
       never republish a vote-derived number as if it were display-ok.
     - "chosen" reuses the same OpenRouter task-spend endpoint scripts/derive-signals.mjs already
       fetches (https://openrouter.ai/api/frontend/v1/rankings/task-spend), merging every tag
       data/tasks.json's `openrouter_signal.tags` lists for a task, weighted by each tag's own
       `spendShareOfTotal` (how much of ALL tracked spend that tag represents) — see
       mergeChosenForTags()'s own comment for the exact arithmetic. `bulk` keeps its existing
       token-volume special case (spend-share is dollar-weighted, the wrong lens for a
       cost-defined task).

   NAME MATCHING: every tester's raw model-name string is matched to a catalog id via
   matchTesterModel() below — stripProviderPrefix() (scripts/auto-refresh.mjs, fixed this same
   step to strip hyphen-joined vendor prefixes like "anthropic-claude-fable-5-1-high"), then every
   stage of effortDateSuffixCandidates() (scripts/naming.mjs, promoted out of
   scripts/_audit/map-names.mjs this same step), tried from least- to most-stripped so a name that
   IS a real catalog id ("qwen3-8-max") is never over-stripped into one that isn't ("qwen3-8"). A
   name that never matches is logged to docs/standings-unmapped.md and left out — never guessed.

   BEST-RUNG RULE: several benchmarks (Epoch's CursorBench, Terminal-Bench mirror, GPQA Diamond;
   LiveBench and Arena too) publish more than one row per model — different reasoning-effort
   rungs, different agent harnesses. rankBenchmarkRows() collapses these to one row per model (the
   best-scoring one) before ranking, so a multi-rung model gets one honest rank, not several
   competing ones; the winning rung/harness is recorded (`rung`) when the source names it in a
   dedicated column, else the count of rows collapsed (`rungCount`) is kept so the measured row's
   label can say "best of N".

   Usage:
     node scripts/derive-standings.mjs [--dry-run]
   As a module: every function below is pure given already-fetched raw rows (unit-tested with
   fixtures in scripts/test-derive-standings.mjs, no network) — only fetchEpochZip/
   fetchArcPrizeEvaluations/discoverLiveBenchTableUrl/fetchLiveBenchTable/fetchTaskSpendFull/
   fetchRankingsModelsFull touch the network, and each degrades to "nothing new this run" on
   failure, matching every other Collect script's own pattern. */
import { readFileSync, writeFileSync, mkdtempSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { matchAlias, stripProviderPrefix } from './auto-refresh.mjs';
import { slug, effortDateSuffixCandidates } from './naming.mjs';
import { TASK_IDS } from './derive-task-fit.mjs';
import { TASK_SPEND_URL } from './derive-signals.mjs';
import { RANKINGS_URL as USAGE_RANKINGS_URL } from './derive-usage.mjs';

const ROOT = new URL('../', import.meta.url);
const num = (v) => typeof v === 'number' && Number.isFinite(v);
const round4 = (v) => (num(v) ? Math.round(v * 10000) / 10000 : null);
const round2 = (v) => (num(v) ? Math.round(v * 100) / 100 : null);
const today = () => new Date().toISOString().slice(0, 10);

// -------------------------------------------------------------------------------------------
// name matching — shared with docs/standings-unmapped.md's own bookkeeping
// -------------------------------------------------------------------------------------------

/** Match one tester's raw model-name string to a catalog id, trying every effort/date-suffix
 * peel stage from least- to most-stripped (first match wins) — same rule
 * scripts/_audit/map-names.mjs's tryMatch uses for the tester audit, now built on the shared
 * scripts/naming.mjs helper. Returns a catalog id or null; never guesses past a real match. */
export function matchTesterModel(raw, models, aliases) {
  const s0 = slug(stripProviderPrefix(String(raw || '')));
  if (!s0) return null;
  for (const cand of effortDateSuffixCandidates(s0)) {
    const hit = matchAlias(cand, models, aliases) || matchAlias(cand.replace(/-/g, ' '), models, aliases);
    if (hit) return hit;
  }
  return null;
}

// -------------------------------------------------------------------------------------------
// generic benchmark-row ranking (Epoch, ARC Prize, LiveBench all reuse this)
// -------------------------------------------------------------------------------------------

/**
 * Rank every row of one benchmark's rows by `scoreCol` (higher-is-better by default), collapsing
 * repeated rows for the same model — different reasoning-effort rungs, different agent
 * harnesses — down to that model's single best-scoring row, so a multi-rung model gets one rank,
 * not several. `n_models` is the count of DISTINCT models in the WHOLE feed (catalog-matched or
 * not) — an honest "rank out of n", not "rank among the few of our 67 that happen to be in this
 * feed". Pure; no I/O. Returns Map<catalogId, {rank, n_models, score, rung, rungCount}>.
 */
export function rankBenchmarkRows(rows, { modelCol = 'Model version', scoreCol, rungCol, higherIsBetter = true } = {}, models, aliases) {
  const buckets = new Map(); // bucketKey -> { bestScore, bestRow, matchedId, rungCount }
  for (const row of rows || []) {
    const raw = row?.[modelCol];
    if (!raw) continue;
    const score = parseFloat(row[scoreCol]);
    if (!Number.isFinite(score)) continue;
    const matchedId = matchTesterModel(raw, models, aliases);
    const key = matchedId || `~unmatched:${slug(stripProviderPrefix(String(raw)))}`;
    const cur = buckets.get(key);
    const better = cur == null || (higherIsBetter ? score > cur.bestScore : score < cur.bestScore);
    if (!cur) buckets.set(key, { bestScore: score, bestRow: row, matchedId, rungCount: 1 });
    else { cur.rungCount++; if (better) { cur.bestScore = score; cur.bestRow = row; } }
  }
  const ranked = [...buckets.values()].sort((a, b) => (higherIsBetter ? b.bestScore - a.bestScore : a.bestScore - b.bestScore));
  const nModels = ranked.length;
  const out = new Map();
  ranked.forEach((v, i) => {
    if (!v.matchedId || out.has(v.matchedId)) return;
    out.set(v.matchedId, {
      rank: i + 1,
      n_models: nModels,
      score: v.bestScore,
      rung: rungCol ? (v.bestRow?.[rungCol] || null) : null,
      rungCount: v.rungCount,
    });
  });
  return out;
}

/** Every raw name this pass could NOT match, per source — for docs/standings-unmapped.md. Pure:
 * re-derives the same buckets rankBenchmarkRows did, just to report what got left out. */
export function unmatchedNames(rows, { modelCol = 'Model version' } = {}, models, aliases) {
  const seen = new Set();
  const out = [];
  for (const row of rows || []) {
    const raw = row?.[modelCol];
    if (!raw || seen.has(raw)) continue;
    seen.add(raw);
    if (!matchTesterModel(raw, models, aliases)) out.push(raw);
  }
  return out;
}

// -------------------------------------------------------------------------------------------
// robust CSV parsing (Epoch's export embeds newlines/commas inside quoted notes fields — a
// line-split parser silently corrupts those rows, same reason collect-epoch.mjs has its own)
// -------------------------------------------------------------------------------------------
export function parseCsvRobust(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const head = rows.shift();
  if (!head) return [];
  return rows.filter((r) => r.length > 1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

// -------------------------------------------------------------------------------------------
// Epoch AI — zip fetch + per-file config (task comes from data/testers.json's own per_benchmark
// map at runtime, never re-typed here; scoreCol/label/rungCol are per-file specifics that map
// doesn't carry, so they're the one thing this file does hardcode, each one checked against a
// real header from the zip, 2026-09-07)
// -------------------------------------------------------------------------------------------
export const EPOCH_ZIP_URL = 'https://epoch.ai/data/benchmark_data.zip';

// Superseded by ARC Prize's own primary-source fetch (data/testers.json's epoch-ai entry: "the
// primary source" for ARC-AGI-2 is arc-prize, not this mirror) — never double-counted.
// aider_polyglot_external.csv: dropped 2026-09-07 (brain v2 step 2 fix round) — matches the
// standalone `aider-polyglot` tester's own "exclude" verdict (data/testers.json: frozen since
// 2025-10-04, 1 catalog model). The same stale leaderboard reached two ways gets the same verdict.
export const EPOCH_SKIP_FILES = new Set(['arc_agi_2_external.csv', 'aider_polyglot_external.csv']);

export const EPOCH_FILE_CONFIG = {
  'gpqa_diamond.csv': { scoreCol: 'mean_score', label: 'GPQA Diamond' },
  'simpleqa_verified.csv': { scoreCol: 'mean_score', label: 'SimpleQA Verified' },
  'hle_external.csv': { scoreCol: 'Accuracy', label: "Humanity's Last Exam (Epoch mirror)" },
  'deepresearchbench_external.csv': { scoreCol: 'Average score', label: 'DeepResearch Bench (Epoch mirror)' },
  // webdev_arena_external's own per_benchmark entry carries kind: "preferred" (data/testers.json)
  // — WebDev Arena is a blind human-vote board, not a test, so this config is only used to RANK
  // the mirror's rows; assembleStandings() routes its result into standings.frontend.preferred,
  // never .measured (see epochKindOf below).
  'webdev_arena_external.csv': { scoreCol: 'Arena Score', label: 'WebDev Arena (Epoch mirror)' },
  'cursorbench_external.csv': { scoreCol: 'Score', label: 'CursorBench', rungCol: 'Reasoning level' },
  'swe_bench_verified.csv': { scoreCol: 'mean_score', label: 'SWE-bench Verified (Epoch mirror)' },
  // Added 2026-09-07 (brain v2 step 2) — each fit confirmed against the benchmark's own page
  // before wiring it in (data/testers.json's epoch-ai notes carries the one-line confirmation):
  'scicode_external.csv': { scoreCol: 'Score', label: 'SciCode (Epoch mirror)' },
  'ale_bench_external.csv': { scoreCol: 'Performance', label: 'ALE-Bench (Epoch mirror)' },
  'weirdml_external.csv': { scoreCol: 'Accuracy', label: 'WeirdML (Epoch mirror)' },
  // DeepSWE's own `Harness` column is constant ("mini-swe-agent") across every row — the model
  // varies, the scaffold doesn't, so this is a genuine per-model SWE-bench-style run, not a
  // fixed-agent product being scored (checked before wiring in, per the fix-round instructions).
  'deepswe_external.csv': { scoreCol: 'Pass@1', label: 'DeepSWE (Epoch mirror, mini-swe-agent harness)', rungCol: 'Reasoning effort' },
  'terminalbench_external.csv': { scoreCol: 'Accuracy mean', label: 'Terminal-Bench 2.0 (Epoch mirror)', rungCol: 'Agent' },
  'vending_bench_2_external.csv': { scoreCol: 'Score', label: 'Vending-Bench 2 (Epoch mirror)' },
  'metr_time_horizons_external.csv': { scoreCol: 'Time horizon', label: 'METR time horizons (Epoch mirror)' },
  'apex_agents_external.csv': { scoreCol: 'Pass@1 score', label: 'APEX-Agents (Epoch mirror)' },
  'osworld_2_external.csv': { scoreCol: 'Binary accuracy', label: 'OSWorld 2.0 (Epoch mirror)', rungCol: 'Reasoning' },
  'lech_mazur_writing_external.csv': { scoreCol: 'Mean score', label: 'Lech Mazur Writing (Epoch mirror)' },
  // FrontierMath's versioned self-run sets (no `_external` suffix — Epoch's own run, like gpqa/
  // simpleqa above) supersede the un-versioned frontiermath.csv, which never mapped to a task id.
  'frontiermath_tiers_1_3_v2.csv': { scoreCol: 'mean_score', label: 'FrontierMath Tiers 1-3 v2' },
  'frontiermath_tier_4_v2.csv': { scoreCol: 'mean_score', label: 'FrontierMath Tier 4 v2' },
  'proofbench_external.csv': { scoreCol: 'Accuracy', label: 'ProofBench (Epoch mirror)', rungCol: 'Reasoning effort' },
  'otis_mock_aime_2024_2025.csv': { scoreCol: 'mean_score', label: 'OTIS Mock AIME 2024-2025' },
  'critpt_external.csv': { scoreCol: 'Accuracy', label: 'CritPt (Epoch mirror)' },
  'gdp_pdf_external.csv': { scoreCol: 'GDP.pdf score', label: 'GDP.pdf (Epoch mirror)' },
  'gdpval_external.csv': { scoreCol: 'Win Rate (%)', label: 'GDPval (Epoch mirror)' },
};

export const epochBenchmarkUrl = (file) => `https://epoch.ai/benchmarks/${file.replace(/\.csv$/, '').replace(/_/g, '-')}`;

/** Best-effort live fetch + unzip of Epoch's export. Returns the extracted directory path, or
 * null on any failure (network, non-200, bad zip) — a down feed means "measured stays as it was
 * on the last successful run", never a hard failure of the whole pass. */
export async function fetchEpochZip() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 60000);
  try {
    const res = await fetch(EPOCH_ZIP_URL, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const dir = mkdtempSync(join(tmpdir(), 'epoch-standings-'));
    const zip = join(dir, 'benchmark_data.zip');
    writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
    execFileSync('unzip', ['-qo', zip, '-d', dir]);
    return dir;
  } catch (e) {
    console.log(`standings: Epoch AI fetch failed (${e.message}) — measured rows from epoch-ai left as-is.`);
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Read + parse every EPOCH_FILE_CONFIG file present in `dir` (a fetchEpochZip() result).
 * Returns Map<filename, row[]>; a file that's missing from this zip run is simply absent, never
 * padded with stale rows. */
export function readEpochFiles(dir) {
  const out = new Map();
  if (!dir) return out;
  let names;
  try { names = readdirSync(dir); } catch { return out; }
  for (const file of Object.keys(EPOCH_FILE_CONFIG)) {
    if (!names.includes(file)) continue;
    try { out.set(file, parseCsvRobust(readFileSync(join(dir, file), 'utf8'))); } catch { /* skip unreadable file */ }
  }
  return out;
}

// -------------------------------------------------------------------------------------------
// ARC Prize — direct evaluations.json (primary source for ARC-AGI-2)
// -------------------------------------------------------------------------------------------
export const ARC_PRIZE_URL = 'https://arcprize.org/media/data/evaluations.json';
// "research: ARC-AGI-2 semi-private evaluation" (data/testers.json's arc-prize entry) — the one
// cut that entry names, not the public/private eval or the retired ARC-AGI-1 rows the same file
// also carries.
export const ARC_PRIZE_DATASET_ID = 'v2_Semi_Private';

export async function fetchArcPrizeEvaluations() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(ARC_PRIZE_URL, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return Array.isArray(json) ? json : [];
  } catch (e) {
    console.log(`standings: ARC Prize fetch failed (${e.message}) — measured rows from arc-prize left as-is.`);
    return [];
  } finally {
    clearTimeout(t);
  }
}

/** Filter to ARC_PRIZE_DATASET_ID and reshape into rankBenchmarkRows' expected row shape. Pure. */
export function rankArcPrizeRows(rows, models, aliases, datasetId = ARC_PRIZE_DATASET_ID) {
  const filtered = (rows || []).filter((r) => r && r.datasetId === datasetId && num(r.score));
  const asRows = filtered.map((r) => ({ 'Model version': r.modelId, Score: r.score }));
  return rankBenchmarkRows(asRows, { modelCol: 'Model version', scoreCol: 'Score' }, models, aliases);
}

// -------------------------------------------------------------------------------------------
// LiveBench — live table_<date>.csv; the date is discovered by reading the site's own compiled
// JS (undocumented, same as the tester audit), not hardcoded and not guessed.
// -------------------------------------------------------------------------------------------
export const LIVEBENCH_SITE_URL = 'https://livebench.ai/';

/** Every task this catalog can map onto one of LiveBench's raw per-question columns (see
 * data/testers.json's livebench entry for which category each group corresponds to). A task's
 * "measured" score is the plain mean of its mapped columns present on that row — LiveBench
 * itself doesn't publish a machine-readable category rollup in this export, only the raw
 * per-question columns, so this is the disclosed, honest way to approximate the category score
 * it displays on its own site. */
export const LIVEBENCH_TASK_COLUMNS = {
  coding: ['code_generation', 'code_completion', 'python', 'javascript', 'typescript'],
  research: ['connections', 'logic_with_navigation', 'zebra_puzzle', 'spatial', 'theory_of_mind', 'AMPS_Hard', 'math_comp', 'olympiad', 'integrals_with_game'],
  extraction: ['tablejoin', 'tablereformat', 'consecutive_events'],
  writing: ['typos', 'paraphrase', 'plot_unscrambling', 'story_generation'],
  'exec-summaries': ['summarize'],
};
export const LIVEBENCH_TASK_LABEL = {
  coding: 'LiveBench Coding category',
  research: 'LiveBench Reasoning + Math categories',
  extraction: 'LiveBench Data Analysis category',
  writing: 'LiveBench Language category (creative-writing columns)',
  'exec-summaries': 'LiveBench summarize (Language category)',
};

/** Pure: find the largest JS array-literal of ten-plus "YYYY-MM-DD" strings in the site's own
 * compiled bundle — the release-date selector's own data, read the same way the tester audit
 * found it (data/testers.json's livebench entry). Not tied to a minified variable name (that
 * changes across builds), just the shape "an array of ISO date strings". */
export function extractLiveBenchDates(jsSource) {
  const re = /\[\s*"(\d{4}-\d{2}-\d{2})"(?:\s*,\s*"\d{4}-\d{2}-\d{2}")*\s*\]/g;
  let best = [];
  let m;
  while ((m = re.exec(String(jsSource || '')))) {
    const arr = m[0].match(/\d{4}-\d{2}-\d{2}/g) || [];
    if (arr.length > best.length) best = arr;
  }
  return best;
}

/** Best-effort: fetch the site's index page, find its compiled JS bundle path, fetch that, pull
 * out the newest date, and build that date's table_<date>.csv URL. Returns null on any failure —
 * a redesigned site or a renamed bundle means "measured stays as it was", never a guess at a URL. */
export async function discoverLiveBenchTableUrl() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(LIVEBENCH_SITE_URL, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const jsMatch = html.match(/src="([^"]*\/static\/js\/main\.[a-z0-9]+\.js)"/i);
    if (!jsMatch) throw new Error("could not find the site's compiled JS bundle path in its own index.html");
    const jsUrl = new URL(jsMatch[1], LIVEBENCH_SITE_URL).toString();
    const jsRes = await fetch(jsUrl, { signal: ctrl.signal });
    if (!jsRes.ok) throw new Error(`HTTP ${jsRes.status} fetching ${jsUrl}`);
    const dates = extractLiveBenchDates(await jsRes.text());
    if (!dates.length) throw new Error("no date array found in the site's compiled JS");
    const latest = [...dates].sort().at(-1);
    return `${LIVEBENCH_SITE_URL}table_${latest.replaceAll('-', '_')}.csv`;
  } catch (e) {
    console.log(`standings: LiveBench date discovery failed (${e.message}) — measured rows from livebench left as-is.`);
    return null;
  } finally {
    clearTimeout(t);
  }
}

export async function fetchLiveBenchTable(url) {
  if (!url) return [];
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseCsvRobust(await res.text());
  } catch (e) {
    console.log(`standings: LiveBench table fetch failed (${e.message}) — measured rows from livebench left as-is.`);
    return [];
  } finally {
    clearTimeout(t);
  }
}

/** This row's composite score for one task = the plain mean of its mapped columns that parse as
 * a real number on this row — null (never a fabricated partial average) if none do. Pure. */
export function livebenchCompositeScore(row, cols) {
  const vals = (cols || []).map((c) => parseFloat(row?.[c])).filter((v) => Number.isFinite(v));
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

export function rankLivebenchTask(rows, taskId, models, aliases) {
  const cols = LIVEBENCH_TASK_COLUMNS[taskId];
  if (!cols) return new Map();
  const asRows = (rows || [])
    .map((r) => ({ model: r?.model, __score: livebenchCompositeScore(r, cols) }))
    .filter((r) => r.model && r.__score != null);
  return rankBenchmarkRows(asRows, { modelCol: 'model', scoreCol: '__score' }, models, aliases);
}

// -------------------------------------------------------------------------------------------
// OpenRouter "chosen" — task-spend tag merge (per data/tasks.json's openrouter_signal.tags) +
// bulk's existing token-volume special case, both reused from scripts/derive-signals.mjs /
// scripts/derive-usage.mjs's own fetch endpoints (not their capped top-10 helpers — chosen wants
// a full ranking + an honest n_models, the same way rankBenchmarkRows does for measured).
// -------------------------------------------------------------------------------------------
export const OPENROUTER_RANKINGS_URL = 'https://openrouter.ai/rankings';

/** Best-effort live fetch of the task-spend endpoint, keeping the per-tag `spendShareOfTotal`
 * scripts/derive-signals.mjs's own fetchTaskSpend() discards (that file only needs per-model
 * top-10 shares; merging multiple tags into one task needs each tag's own weight too). Returns
 * Map<tag, {spendShareOfTotal, models}>, empty Map on any failure. */
export async function fetchTaskSpendFull() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(TASK_SPEND_URL, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const tasks = json?.data?.spend?.tasks;
    const out = new Map();
    for (const tg of Array.isArray(tasks) ? tasks : []) {
      if (tg?.tag) out.set(tg.tag, { spendShareOfTotal: Number(tg.spendShareOfTotal) || 0, models: tg.models || [] });
    }
    return out;
  } catch (e) {
    console.log(`standings: OpenRouter task-spend fetch failed (${e.message}) — chosen left as-is.`);
    return new Map();
  } finally {
    clearTimeout(t);
  }
}

/**
 * Merge one or more OpenRouter task-spend tags into a single task's "chosen" ranking.
 * Each tag's models are only its own top 10 by spend share (the endpoint's own limit — there is
 * no fuller list to fetch), so a merged task's union can exceed 10 when its tags don't fully
 * overlap. Share for a merged task = spend-weighted by each tag's own `spendShareOfTotal` (how
 * much of ALL tracked spend that tag represents): tag weight = its spendShareOfTotal / the sum of
 * spendShareOfTotal across just the tags in THIS task (so the weights inside one task sum to 1,
 * regardless of how big that task is next to the other nine); a model's combined share = the
 * weighted sum of its per-tag share across every tag it appears in (0 for a tag it's absent
 * from — never guessed). Ranked descending by that combined share; `n_models` = the union of
 * distinct catalog models appearing in ANY of the merged tags' top 10. Pure. Returns
 * Map<catalogId, {rank, share, n_models}>.
 */
export function mergeChosenForTags(tags, taskSpendMap, models, aliases) {
  const list = (tags || []).map((tag) => [tag, taskSpendMap.get(tag)]).filter(([, v]) => v);
  const totalWeight = list.reduce((s, [, v]) => s + (v.spendShareOfTotal || 0), 0);
  if (!list.length || totalWeight <= 0) return new Map();
  const combined = new Map();
  const union = new Set();
  for (const [, v] of list) {
    const w = (v.spendShareOfTotal || 0) / totalWeight;
    for (const row of v.models || []) {
      const id = matchAlias(row.model, models, aliases);
      if (!id) continue;
      union.add(id);
      combined.set(id, (combined.get(id) || 0) + w * (Number(row.share) || 0));
    }
  }
  const ranked = [...combined.entries()].sort((a, b) => b[1] - a[1]);
  const nModels = union.size;
  const out = new Map();
  ranked.forEach(([id, share], i) => out.set(id, { rank: i + 1, share: round2(share * 100), n_models: nModels }));
  return out;
}

/** Best-effort live fetch of the raw rankings/models feed (bulk's token-volume source, and the
 * one place a real snapshot `date` is published) — [] on any failure. */
export async function fetchRankingsModelsFull() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(USAGE_RANKINGS_URL, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return Array.isArray(json?.data) ? json.data : [];
  } catch (e) {
    console.log(`standings: OpenRouter rankings/models fetch failed (${e.message}) — bulk chosen left as-is.`);
    return [];
  } finally {
    clearTimeout(t);
  }
}

/** bulk's chosen: full (not top-10-capped) ranking by raw completion-token volume — same metric
 * scripts/derive-signals.mjs's rankBulkTokenVolume uses, just not capped, so n_models is an
 * honest count of the whole tracked ecosystem that day. Pure. */
export function chosenForBulk(rankingsRows, models, aliases) {
  const byKey = new Map();
  let total = 0, asOf = null;
  for (const r of rankingsRows || []) {
    if (!r || !r.model_permaslug) continue;
    const completion = Number(r.total_completion_tokens) || 0;
    total += completion;
    byKey.set(r.model_permaslug, (byKey.get(r.model_permaslug) || 0) + completion);
    if (r.date) asOf = String(r.date).slice(0, 10);
  }
  const ranked = [...byKey.entries()].sort((a, b) => b[1] - a[1]);
  const nModels = ranked.length;
  const out = new Map();
  ranked.forEach(([permaslug, tokens], i) => {
    if (tokens <= 0) return;
    const id = matchAlias(permaslug, models, aliases);
    if (!id || out.has(id)) return;
    out.set(id, { rank: i + 1, share: total > 0 ? round2((tokens / total) * 100) : null, n_models: nModels, as_of: asOf });
  });
  return out;
}

// -------------------------------------------------------------------------------------------
// Arena "preferred" — read-only from the checked-in snapshot (data/signals/arena-2026-09.json).
// This script never fetches arena.ai itself; scripts/refresh.md documents the capture procedure.
// -------------------------------------------------------------------------------------------

/** One task's preferred ranking from the snapshot file's own shape:
 * tasks[taskId] = { category, board_url, n_models, ranks: [{model_id, rank, votes?}] }.
 * `n_models` is a literal, disclosed fact copied from the board's own page text (its "N models"
 * label) — never recomputed here. `rank` is the row's position on the FULL board as captured
 * (ranks[] is already in ascending-rank order; the first row for a given model_id is kept if a
 * name somehow appears twice). Pure. Returns Map<catalogId, {board, rank, n_models, url}>. */
export function preferredForTask(arenaFile, taskId) {
  const entry = arenaFile?.tasks?.[taskId];
  const out = new Map();
  if (!entry || !Array.isArray(entry.ranks)) return out;
  const nModels = num(entry.n_models) ? entry.n_models : entry.ranks.length;
  const url = entry.board_url || entry.source_url || null;
  const board = entry.category || taskId;
  for (const r of entry.ranks) {
    if (!r?.model_id || out.has(r.model_id)) continue;
    out.set(r.model_id, { board, rank: r.rank, n_models: nModels, url });
  }
  return out;
}

/** Reshape one already-ranked Epoch file (an epochRanked.get(file) result) into a "preferred"
 * evidence map — used for a per_benchmark set whose own `kind` is "preferred" (webdev_arena_
 * external, brain v2 step 2), never for a plain measured set. `licence: 'signal-only'` and
 * `score: null` always, regardless of what the mirror's own licence class says elsewhere in
 * data/testers.json — this is Arena's blind-vote number reused through a THIRD party's mirror, not
 * something this codebase has any standing to redistribute as a display-ok figure; cite the rank,
 * never republish the score. Pure. Returns Map<catalogId, {board, rank, n_models, url, licence,
 * score}>. */
export function epochPreferredFromRanked(ranked, file, label) {
  const out = new Map();
  for (const [id, rec] of ranked || new Map()) {
    out.set(id, { board: label, rank: rec.rank, n_models: rec.n_models, url: epochBenchmarkUrl(file), licence: 'signal-only', score: null });
  }
  return out;
}

/** Merge two per-task preferred maps for the SAME task, primary first: a model present in
 * `primary` (e.g. the Epoch mirror) keeps its primary record; a model only in `fallback` (e.g. the
 * arena.ai top-10 card) is kept as-is so it isn't silently dropped just because a fuller primary
 * source doesn't happen to carry it. Pure. Never used to average or reconcile — one record per
 * model, whichever source actually has it. */
export function mergePreferredFallback(primary, fallback) {
  const out = new Map(primary);
  for (const [id, rec] of fallback || new Map()) if (!out.has(id)) out.set(id, rec);
  return out;
}

// -------------------------------------------------------------------------------------------
// assembly — pure given every already-ranked ingredient (unit-tested with fixtures)
// -------------------------------------------------------------------------------------------

/**
 * Build the full `standings{}` object for every model x every task from already-computed ranking
 * maps. Pure — no I/O, no network. A task a model has no evidence for anywhere gets
 * `measured: [], chosen: null, preferred: null` — never a missing key, never a guess.
 *
 * `epochRanked`     Map<epochFile, Map<catalogId, {rank,n_models,score,rung,rungCount}>>
 * `epochTaskOf`     Map<epochFile, taskId>              (from data/testers.json's per_benchmark)
 * `epochKindOf`     Map<epochFile, "measured"|"preferred">  (per_benchmark's own `kind`, default
 *                   "measured" — a "preferred" file, e.g. webdev_arena_external, is ranked exactly
 *                   like any other Epoch file but its result is routed into `preferred`, never
 *                   `measured`; it never appears in this loop's `measured` array at all)
 * `arcRanked`       Map<catalogId, {rank,n_models,score}>              (research only)
 * `livebenchByTask` Map<taskId, Map<catalogId, {rank,n_models,score}>>
 * `chosenByTask`    Map<taskId, Map<catalogId, {rank,share,n_models,as_of?}>>
 * `chosenTagsOf`    Map<taskId, string[]>                 (data/tasks.json's own tags[], or [])
 * `preferredByTask` Map<taskId, Map<catalogId, {board,rank,n_models,url,licence?,score?}>> — the
 *                   `licence`/`score` keys are only ever present on a preferred record that was
 *                   itself built from a licensed/scored feed (e.g. an Epoch mirror routed here via
 *                   `epochKindOf`); a genuine arena.ai-native capture carries neither key, and this
 *                   function never adds one that wasn't already on the input record.
 */
export function assembleStandings(models, {
  epochRanked = new Map(), epochTaskOf = new Map(), epochKindOf = new Map(), arcRanked = new Map(),
  livebenchByTask = new Map(), chosenByTask = new Map(), chosenTagsOf = new Map(),
  preferredByTask = new Map(), asOf = today(),
} = {}) {
  const out = new Map();
  for (const m of models) {
    const standings = { as_of: asOf };
    for (const taskId of TASK_IDS) {
      const measured = [];
      for (const [file, cfg] of Object.entries(EPOCH_FILE_CONFIG)) {
        if (epochTaskOf.get(file) !== taskId) continue;
        if ((epochKindOf.get(file) || 'measured') !== 'measured') continue;
        const rec = epochRanked.get(file)?.get(m.id);
        if (!rec) continue;
        const rungNote = cfg.rungCol && rec.rung ? ` (best rung: ${rec.rung})`
          : rec.rungCount > 1 ? ` (best of ${rec.rungCount} rows)` : '';
        measured.push({
          tester: 'epoch-ai', benchmark: `${cfg.label}${rungNote}`,
          rank: rec.rank, n_models: rec.n_models, score: round4(rec.score),
          as_of: asOf, url: epochBenchmarkUrl(file), licence: 'display-ok',
        });
      }
      if (taskId === 'research') {
        const rec = arcRanked.get(m.id);
        if (rec) {
          measured.push({
            tester: 'arc-prize', benchmark: 'ARC-AGI-2 (semi-private evaluation)',
            rank: rec.rank, n_models: rec.n_models, score: round4(rec.score),
            as_of: asOf, url: 'https://arcprize.org/leaderboard', licence: 'display-ok',
          });
        }
      }
      const lb = livebenchByTask.get(taskId)?.get(m.id);
      if (lb) {
        measured.push({
          tester: 'livebench', benchmark: LIVEBENCH_TASK_LABEL[taskId] || 'LiveBench',
          rank: lb.rank, n_models: lb.n_models, score: round4(lb.score),
          as_of: asOf, url: LIVEBENCH_SITE_URL, licence: 'display-ok',
        });
      }

      const chosenRec = chosenByTask.get(taskId)?.get(m.id) || null;
      const chosen = chosenRec ? {
        rank: chosenRec.rank, share: chosenRec.share, tags: chosenTagsOf.get(taskId) || [],
        n_models: chosenRec.n_models, as_of: chosenRec.as_of || asOf, url: OPENROUTER_RANKINGS_URL,
      } : null;

      const prefRec = preferredByTask.get(taskId)?.get(m.id) || null;
      const preferred = prefRec ? {
        board: prefRec.board, rank: prefRec.rank, n_models: prefRec.n_models,
        as_of: asOf, url: prefRec.url,
        // only ever set when the input record itself carried one (see the JSDoc above) — never
        // invented here, so a plain arena.ai capture's preferred object keeps its original 5 keys.
        ...(prefRec.licence !== undefined ? { licence: prefRec.licence } : {}),
        ...(prefRec.score !== undefined ? { score: prefRec.score } : {}),
      } : null;

      standings[taskId] = { measured, chosen, preferred };
    }
    out.set(m.id, standings);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// standalone runner
// ---------------------------------------------------------------------------------------------
async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const dataUrl = new URL('data/models.json', ROOT);
  const aliasUrl = new URL('scripts/model-aliases.json', ROOT);
  const testersUrl = new URL('data/testers.json', ROOT);
  const tasksUrl = new URL('data/tasks.json', ROOT);
  const arenaUrl = new URL('data/signals/arena-2026-09.json', ROOT);
  const unmappedUrl = new URL('docs/standings-unmapped.md', ROOT);

  const data = JSON.parse(readFileSync(dataUrl));
  const aliases = JSON.parse(readFileSync(aliasUrl));
  const testersFile = JSON.parse(readFileSync(testersUrl));
  const tasksFile = JSON.parse(readFileSync(tasksUrl));
  const arenaFile = JSON.parse(readFileSync(arenaUrl));
  const models = data.models;
  const asOf = today();

  // --- Epoch ---
  const epochTester = testersFile.testers.find((t) => t.id === 'epoch-ai');
  const epochTaskOf = new Map();
  const epochKindOf = new Map(); // file -> per_benchmark's own "kind" ("measured" default | "preferred")
  for (const [file, meta] of Object.entries(epochTester?.mapping?.per_benchmark || {})) {
    if (EPOCH_SKIP_FILES.has(file) || !EPOCH_FILE_CONFIG[file]) continue;
    epochTaskOf.set(file, meta.task);
    epochKindOf.set(file, meta.kind || 'measured');
  }
  const epochDir = await fetchEpochZip();
  const epochRawByFile = readEpochFiles(epochDir);
  const epochRanked = new Map();
  const unmappedBySource = new Map(); // source label -> Set<raw name>
  const addUnmapped = (label, names) => {
    if (!names.length) return;
    if (!unmappedBySource.has(label)) unmappedBySource.set(label, new Set());
    for (const n of names) unmappedBySource.get(label).add(n);
  };
  for (const [file, cfg] of Object.entries(EPOCH_FILE_CONFIG)) {
    const rows = epochRawByFile.get(file) || [];
    epochRanked.set(file, rankBenchmarkRows(rows, { modelCol: 'Model version', scoreCol: cfg.scoreCol, rungCol: cfg.rungCol }, models, aliases));
    addUnmapped(`epoch-ai / ${file}`, unmatchedNames(rows, { modelCol: 'Model version' }, models, aliases));
  }

  // --- ARC Prize ---
  const arcRows = await fetchArcPrizeEvaluations();
  const arcFiltered = arcRows.filter((r) => r && r.datasetId === ARC_PRIZE_DATASET_ID);
  const arcRanked = rankArcPrizeRows(arcRows, models, aliases);
  addUnmapped('arc-prize (v2_Semi_Private)', unmatchedNames(arcFiltered.map((r) => ({ 'Model version': r.modelId })), { modelCol: 'Model version' }, models, aliases));

  // --- LiveBench ---
  const livebenchUrl = await discoverLiveBenchTableUrl();
  const livebenchRows = await fetchLiveBenchTable(livebenchUrl);
  const livebenchByTask = new Map();
  for (const taskId of Object.keys(LIVEBENCH_TASK_COLUMNS)) {
    livebenchByTask.set(taskId, rankLivebenchTask(livebenchRows, taskId, models, aliases));
  }
  addUnmapped('livebench', unmatchedNames(livebenchRows, { modelCol: 'model' }, models, aliases));

  // --- OpenRouter chosen ---
  const [taskSpendMap, bulkRankingsRows] = await Promise.all([fetchTaskSpendFull(), fetchRankingsModelsFull()]);
  const chosenByTask = new Map();
  const chosenTagsOf = new Map();
  for (const t of tasksFile.tasks) {
    const spec = t.openrouter_signal || {};
    chosenTagsOf.set(t.id, spec.tags || (spec.tag ? [spec.tag] : []));
    if (spec.type === 'token_volume') {
      chosenByTask.set(t.id, chosenForBulk(bulkRankingsRows, models, aliases));
    } else if (spec.type === 'task_spend_tag' && Array.isArray(spec.tags) && spec.tags.length) {
      chosenByTask.set(t.id, mergeChosenForTags(spec.tags, taskSpendMap, models, aliases));
    } else {
      chosenByTask.set(t.id, new Map());
    }
  }

  // --- Arena preferred (read-only snapshot) ---
  const preferredByTask = new Map();
  for (const taskId of TASK_IDS) preferredByTask.set(taskId, preferredForTask(arenaFile, taskId));

  // --- Epoch-mirror preferred (kind: "preferred" sets, e.g. webdev_arena_external) — the mirror
  // is the PRIMARY source for its task's preferred evidence; the arena.ai snapshot captured just
  // above is kept only as a fallback for a model the mirror itself doesn't carry, per the fix
  // round's own rule ("keep the card as fallback only if the mirror lacks the model").
  for (const [file, kind] of epochKindOf) {
    if (kind !== 'preferred') continue;
    const taskId = epochTaskOf.get(file);
    const mirrorPreferred = epochPreferredFromRanked(epochRanked.get(file), file, `${EPOCH_FILE_CONFIG[file].label} (mirrors arena.ai's blind human votes)`);
    preferredByTask.set(taskId, mergePreferredFallback(mirrorPreferred, preferredByTask.get(taskId)));
  }

  // --- assemble + write ---
  const standingsMap = assembleStandings(models, { epochRanked, epochTaskOf, epochKindOf, arcRanked, livebenchByTask, chosenByTask, chosenTagsOf, preferredByTask, asOf });
  for (const m of models) m.standings = standingsMap.get(m.id);

  // --- coverage table ---
  const coverage = Object.fromEntries(TASK_IDS.map((t) => [t, { measured: 0, chosen: 0, preferred: 0 }]));
  for (const m of models) {
    for (const taskId of TASK_IDS) {
      const s = m.standings[taskId];
      if (s.measured.length) coverage[taskId].measured++;
      if (s.chosen) coverage[taskId].chosen++;
      if (s.preferred) coverage[taskId].preferred++;
    }
  }
  console.log(`standings: ${models.length} model(s) x ${TASK_IDS.length} task(s).`);
  console.log('task           | measured | chosen | preferred (of ' + models.length + ')');
  for (const taskId of TASK_IDS) {
    const c = coverage[taskId];
    console.log(`${taskId.padEnd(14)} | ${String(c.measured).padStart(8)} | ${String(c.chosen).padStart(6)} | ${String(c.preferred).padStart(9)}`);
  }

  // --- docs/standings-unmapped.md ---
  const lines = [
    '# Standings — unmapped tester names',
    '',
    `Generated by \`scripts/derive-standings.mjs\`, as of ${asOf}. Every name below was fetched from a`,
    'live tester feed and could not be matched to a catalog model id — never guessed, so it never',
    'appears in any model\'s `standings`. A future run re-checks all of these; add an alias to',
    '`scripts/model-aliases.json` only after confirming the feed name really is that model.',
    '',
  ];
  for (const [label, set] of unmappedBySource) {
    if (!set.size) continue;
    lines.push(`## ${label} (${set.size})`, '', ...[...set].sort().map((n) => `- \`${n}\``), '');
  }
  if (unmappedBySource.size === 0 || [...unmappedBySource.values()].every((s) => !s.size)) lines.push('Nothing unmapped this run.');

  if (!dryRun) {
    writeFileSync(dataUrl, JSON.stringify(data, null, 2) + '\n');
    if (!existsSync(new URL('docs/', ROOT))) mkdirSync(new URL('docs/', ROOT), { recursive: true });
    writeFileSync(unmappedUrl, lines.join('\n') + '\n');
    console.log('standings: data/models.json + docs/standings-unmapped.md written.');
  } else {
    console.log('standings: --dry-run, nothing written.');
  }
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try { return fileURLToPath(import.meta.url) === realpathSync(resolve(process.argv[1])); }
  catch { return fileURLToPath(import.meta.url) === process.argv[1]; }
})();
if (isMain) {
  main().catch((e) => { console.error(e); process.exitCode = 1; });
}
