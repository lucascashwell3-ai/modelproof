#!/usr/bin/env node
/* Per-model, per-task REAL-WORLD signals — the calibration input assets/decide.mjs's rule 3
   uses to stop a single vendor benchmark claim from earning the same "strong" judged band as a
   model with actual independent evidence behind it (see that file's header for the exact rule).
   Without this, task_fit_judged's `band` field can't tell "Anthropic's own launch post plus
   OpenRouter's #1 usage plus Cursor's featured roster" apart from "one arXiv paper by the same
   team that trained the model" — both can read `strong`/`high confidence` even though only one
   has any evidence outside the vendor's own claim. This script writes a THIRD, separate signal
   next to task_fit (quantitative) and task_fit_judged (qualitative claims): a plain count of how
   many independent, real-world signal families back a model for a task.

   Per model, writes `model.signals[taskId]`:
     { usage_rank: n|null, usage_share: x|null, arena_rank: n|null, expert_default: true|null,
       families: k }
   `families` = how many of {usage-top-10, arena-top-10, expert_default} support this model for
   this task (0-3) — never invented, never averaged; a family with no data for this task/model is
   simply absent, not a zero-that-looks-like-evidence.

   THREE SOURCES, three very different refresh stories:

   (a) USAGE — OpenRouter's real per-task spend-share, LIVE-FETCHED every run, same pattern as
       scripts/derive-usage.mjs's overall-usage fetch:
       `GET https://openrouter.ai/api/frontend/v1/rankings/task-spend` — an undocumented endpoint
       (found by inspecting the rankings page's own CSS class names, not in openrouter.ai/docs;
       see eval/signals.md for the discovery story), returning the top-10 models by 30-day spend
       share for ~29 task tags. data/tasks.json's `openrouter_signal` field maps each of this
       product's 10 tasks to one of those tags (or null, for `vision` — none of the 29 tags is
       vision-specific, a documented gap, not an oversight). `bulk` is a deliberate exception:
       spend-share is dollar-weighted (dominated by whoever spends the most, not who processes the
       highest volume of cheap tokens), the wrong lens for a cost-defined task — bulk instead ranks
       on raw completion-token volume from the same endpoint scripts/derive-usage.mjs already
       fetches (`GET .../rankings/models`), reusing that file's own `aggregateUsageRows`.
       Best-effort: a failed fetch degrades to "no usage signal this run" (every usage_rank/share
       stays whatever it was, or null on a first run), never a hard failure of the whole script —
       matching derive-usage.mjs's own fetchOpenRouterRankings pattern.

   (b) ARENA — arena.ai's (formerly LMArena/Chatbot Arena) human-vote leaderboards. NOT
       live-fetched: the leaderboard tables render client-side via JS (verified empirically —
       curl gets nav/footer only; confirmed again while building this file), so there is no
       machine-readable, script-fetchable source for this family. Read from the checked-in, dated
       snapshot `data/signals/arena-2026-09.json` instead — built from a one-time headless-browser
       capture. See scripts/refresh.md's "signals refresh" section for how to replace it; this
       script never modifies that file, only reads it.

   (c) EXPERT DEFAULT — which models a real tool (Cursor, Claude Code, Anthropic's own
       model-selection guide) ships or recommends by default for a task. NOT live-fetched either:
       these are curated shortlists on documentation pages, not a rankable API — read from the
       checked-in, sourced `data/signals/expert-defaults.json`. OpenAI's/Google's/Copilot's
       equivalent pages are client-rendered SPAs with no curlable content (documented in that
       file's `unusable_sources`), a disclosed bias this family carries — see that file's own
       header for why the calibration rule downstream never lets this family alone promote a
       model to "strong".

   Usage: node scripts/derive-signals.mjs [--dry-run]   (standalone run/preview, mirrors
   scripts/derive-usage.mjs's own runner) */
import { readFileSync, writeFileSync } from 'node:fs';
import { matchAlias } from './auto-refresh.mjs';
import { RANKINGS_URL as USAGE_RANKINGS_URL } from './derive-usage.mjs';
import { TASK_IDS } from './derive-task-fit.mjs';

export const TASK_SPEND_URL = 'https://openrouter.ai/api/frontend/v1/rankings/task-spend';
export const TOP_N = 10;

const num = (v) => typeof v === 'number' && Number.isFinite(v);
const round2 = (v) => Math.round(v * 100) / 100;

/** Every task, mapped to its OpenRouter task-spend tag (or the token_volume special case, or
 * null for a documented gap) — pure, reads only the object already loaded from data/tasks.json.
 * Returns Map<taskId, {type, tag?}>. */
export function taskSignalMap(tasksFile) {
  const out = new Map();
  for (const t of tasksFile?.tasks || []) out.set(t.id, t.openrouter_signal || { type: null });
  return out;
}

/** Rank + share (0-100, 2dp) for the top TOP_N models of one task-spend tag's `models[]` array
 * (already sorted by share, richest-first, by the endpoint itself) — matched to catalog ids via
 * the same matchAlias every other Collect script uses. A name that doesn't match any catalog
 * model (an older/deprecated generation, a vendor/model we don't track) is simply skipped, same
 * as scripts/derive-usage.mjs's own unmatched-permaslug handling. Returns Map<modelId,
 * {rank, share}>. */
export function rankTaskSpendTag(tagModels, models, aliases) {
  const out = new Map();
  let rank = 0;
  for (const row of tagModels || []) {
    if (rank >= TOP_N) break;
    const id = matchAlias(row.model, models, aliases);
    if (!id || out.has(id)) continue; // first (highest-share) match wins; ranks only count matched rows
    rank += 1;
    out.set(id, { rank, share: num(row.share) ? round2(row.share * 100) : null });
  }
  return out;
}

/** `bulk`'s special case: rank by raw completion-token volume (not spend share — see file header
 * for why) from the same rows scripts/derive-usage.mjs's own aggregateUsageRows already knows how
 * to sum per model. Returns Map<modelId, {rank, share}> where share is this model's completion
 * tokens as a % of the summed completion tokens across every row the feed returned that day
 * (whether or not it matched our catalog) — the same "share of the whole tracked ecosystem"
 * definition derive-usage.mjs uses for overall usage. */
export function rankBulkTokenVolume(rankingsRows, models, aliases) {
  // Completion-only totals, computed directly from the raw rows — scripts/derive-usage.mjs's own
  // aggregateUsageRows sums prompt+completion into one `.tokens` figure, which isn't what "raw
  // completion-token volume" means here, so this recomputes per-model completion sums itself
  // rather than reusing a helper shaped for a different definition.
  const byKey = new Map();
  let total = 0;
  for (const r of rankingsRows || []) {
    if (!r || !r.model_permaslug) continue;
    const completion = Number(r.total_completion_tokens) || 0;
    total += completion;
    byKey.set(r.model_permaslug, (byKey.get(r.model_permaslug) || 0) + completion);
  }
  const ranked = [...byKey.entries()].sort((a, b) => b[1] - a[1]);
  const out = new Map();
  let rank = 0;
  for (const [permaslug, tokens] of ranked) {
    if (rank >= TOP_N) break;
    if (tokens <= 0) continue;
    const id = matchAlias(permaslug, models, aliases);
    if (!id || out.has(id)) continue;
    rank += 1;
    out.set(id, { rank, share: total > 0 ? round2((tokens / total) * 100) : null });
  }
  return out;
}

/** Arena signal for one task from the static snapshot file's own shape
 * (data/signals/arena-2026-09.json's `tasks[taskId].ranks[]`) — pure, no I/O.
 * Returns Map<modelId, rank>. */
export function arenaRanksForTask(arenaFile, taskId) {
  const out = new Map();
  const entry = arenaFile?.tasks?.[taskId];
  for (const r of entry?.ranks || []) if (r?.model_id) out.set(r.model_id, r.rank);
  return out;
}

/** Expert-default signal for one task from the static snapshot file's own shape
 * (data/signals/expert-defaults.json's `sources[].entries[]`) — a model counts as an expert
 * default for a task if ANY source names it for that task (OR across sources — see that file's
 * header: membership counts the same regardless of which/how-many sources list it, mirroring
 * eval/METHOD.md's family-(c) treatment). Returns Set<modelId>. */
export function expertDefaultsForTask(expertFile, taskId) {
  const out = new Set();
  for (const source of expertFile?.sources || []) {
    for (const entry of source?.entries || []) {
      if (entry?.model_id && Array.isArray(entry.tasks) && entry.tasks.includes(taskId)) out.add(entry.model_id);
    }
  }
  return out;
}

/** Assemble the full { usage_rank, usage_share, arena_rank, expert_default, families } signals
 * object for the whole catalog x every task — pure, given the raw ingredients already fetched/
 * loaded by the caller. `taskSpendByTag` is Map<tag, tagModels[]> (the task-spend endpoint's own
 * per-tag `models[]` arrays); `bulkRankingsRows` is the raw rows from /rankings/models (or [] if
 * that fetch failed/was skipped). Returns Map<modelId, Record<taskId, signalRecord>>. */
export function deriveSignalsForCatalog(models, aliases, tasksFile, taskSpendByTag, bulkRankingsRows, arenaFile, expertFile) {
  const sigMap = taskSignalMap(tasksFile);
  const out = new Map(models.map((m) => [m.id, {}]));

  for (const taskId of TASK_IDS) {
    const spec = sigMap.get(taskId) || { type: null };
    let usageByModel = new Map();
    if (spec.type === 'task_spend_tag' && spec.tag) {
      usageByModel = rankTaskSpendTag(taskSpendByTag.get(spec.tag) || [], models, aliases);
    } else if (spec.type === 'token_volume') {
      usageByModel = rankBulkTokenVolume(bulkRankingsRows, models, aliases);
    }
    const arenaByModel = arenaRanksForTask(arenaFile, taskId);
    const expertSet = expertDefaultsForTask(expertFile, taskId);

    for (const m of models) {
      const usage = usageByModel.get(m.id) || null;
      const arenaRank = arenaByModel.has(m.id) ? arenaByModel.get(m.id) : null;
      const expertDefault = expertSet.has(m.id) ? true : null;
      const families = (usage ? 1 : 0) + (num(arenaRank) ? 1 : 0) + (expertDefault === true ? 1 : 0);
      out.get(m.id)[taskId] = {
        usage_rank: usage ? usage.rank : null,
        usage_share: usage && num(usage.share) ? usage.share : null,
        arena_rank: num(arenaRank) ? arenaRank : null,
        expert_default: expertDefault,
        families,
      };
    }
  }
  return out;
}

/** Best-effort live fetch of the task-spend endpoint — Map<tag, tagModels[]> on success, empty
 * Map on any failure (network, non-200, bad JSON), matching derive-usage.mjs's own
 * fetchOpenRouterRankings degrade-gracefully pattern: a down/renamed endpoint means "nothing new
 * to report", never a hard failure of the whole Collect pass. */
export async function fetchTaskSpend() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(TASK_SPEND_URL, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const tasks = json?.data?.spend?.tasks;
    const out = new Map();
    for (const t of Array.isArray(tasks) ? tasks : []) if (t?.tag) out.set(t.tag, t.models || []);
    return out;
  } catch (e) {
    console.log(`signals: OpenRouter task-spend fetch failed (${e.message}) — usage signal left as is.`);
    return new Map();
  } finally {
    clearTimeout(t);
  }
}

/** Best-effort live fetch of the raw rankings/models feed (bulk's token-volume source) — []
 * on any failure. Separate from scripts/derive-usage.mjs's own fetchOpenRouterRankings (same
 * URL, but this script shouldn't import a function named for a different file's export just to
 * save one line — keeping the fetch local also means this file's failure handling is legible on
 * its own). */
export async function fetchRankingsModels() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(USAGE_RANKINGS_URL, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return Array.isArray(json?.data) ? json.data : [];
  } catch (e) {
    console.log(`signals: OpenRouter rankings/models fetch failed (${e.message}) — bulk usage signal left as is.`);
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
  const tasksUrl = new URL('data/tasks.json', ROOT);
  const arenaUrl = new URL('data/signals/arena-2026-09.json', ROOT);
  const expertUrl = new URL('data/signals/expert-defaults.json', ROOT);

  const data = JSON.parse(readFileSync(dataUrl));
  const aliases = JSON.parse(readFileSync(aliasUrl));
  const tasksFile = JSON.parse(readFileSync(tasksUrl));
  const arenaFile = JSON.parse(readFileSync(arenaUrl));
  const expertFile = JSON.parse(readFileSync(expertUrl));

  const [taskSpendByTag, bulkRankingsRows] = await Promise.all([fetchTaskSpend(), fetchRankingsModels()]);
  const derived = deriveSignalsForCatalog(data.models, aliases, tasksFile, taskSpendByTag, bulkRankingsRows, arenaFile, expertFile);

  let changed = 0;
  const familyCounts = { 0: 0, 1: 0, 2: 0, 3: 0 };
  for (const m of data.models) {
    const next = derived.get(m.id) || {};
    if (JSON.stringify(m.signals) !== JSON.stringify(next)) changed++;
    m.signals = next;
    for (const taskId of TASK_IDS) familyCounts[next[taskId]?.families ?? 0]++;
  }

  console.log(`signals: ${data.models.length} model(s) x ${TASK_IDS.length} task(s), ${changed} model(s) changed.`);
  console.log(`signals: task-spend tags fetched: ${taskSpendByTag.size}, rankings/models rows: ${bulkRankingsRows.length}.`);
  console.log('signals: families distribution (model x task cells) —', familyCounts);

  if (!dryRun) {
    writeFileSync(dataUrl, JSON.stringify(data, null, 2) + '\n');
    console.log('signals: data/models.json written.');
  } else {
    console.log('signals: --dry-run, nothing written.');
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
