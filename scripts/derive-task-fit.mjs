#!/usr/bin/env node
/* Per-model, per-task fit derivation — task fit v1.
   Answers "how well does this model suit task X?" for the ten tasks in data/tasks.json, as a
   0-100 score computed ONLY from fields data/models.json already carries (coding_score,
   benchmarks.{gpqa,mmlu_pro}, context_window, price_output, best_for tags, and whether the
   model appears in any published effort_ladders series). Imported by scripts/auto-refresh.mjs
   the same way it imports scripts/derive-availability.mjs — no separate workflow step; every
   Collect run that changes anything recomputes task_fit for the WHOLE catalog (see the "task_fit
   ... recomputed for the WHOLE catalog" block in auto-refresh.mjs), because its price/context
   normalizers are relative to every model in the catalog, so one price move or one new model can
   shift everyone else's score too. Also imported directly by scripts/test-decide.mjs,
   scripts/test-derive-task-fit.mjs and scripts/validate-data.mjs (the honesty gate).

   Same honesty rule as the rest of this repo: every score traces to a named field (recorded in
   that task's `basis[]`), and a task with no real basis for a model gets `score: null` plus a
   plain-English `reason` — never a fabricated number. A `task_fit_judged` field is written
   alongside task_fit on every model, always null in v1 — reserved for a future Judge pass that
   can override a rule-based score with a researched one; that Judge does not exist yet.

   THE TEN TASKS AND THEIR BASIS (also documented per-task in data/tasks.json)
   -----------------------------------------------------------------------------------------
   coding          coding_score, as-is. No coding_score -> null.
   agents          coding_score (0.7) blended with a min-max normalized context_window (0.3)
                   when context is known; +5 (capped 100) if the model appears in any
                   data/models.json effort_ladders series (a published agentic-benchmark result
                   is itself a fact worth a small bump). No coding_score -> null: agentic fit
                   without a coding baseline isn't a real basis, just a guess wearing a number.
   bulk            "general" score (see below) weighted 0.35, catalog-relative cheapness
                   (from price_output, log-scaled) weighted 0.65 — bulk work is priced first,
                   correct second. Needs both a general score and a price -> either missing
                   is null.
   writing         "general" score, as-is. No general score -> null.
   research        benchmarks.gpqa specifically (not the general fallback — research quality is
                   what GPQA actually measures; mmlu_pro is not treated as a substitute here)
                   blended with normalized context_window (0.3) when context is known. No GPQA
                   -> null.
   extraction      "general" (0.5) + catalog-relative cheapness (0.5). Either missing -> null.
   chat            "general" (0.6) + catalog-relative cheapness (0.4) — weighted toward quality
                   a little more than extraction, since a chat answer is read directly rather
                   than post-processed. Either missing -> null.
   vision          binary: 100 if "vision" is in the model's best_for tags, else null. There is
                   no graded multimodal score anywhere in the data, so this is presence-or-null,
                   never a guessed strength.
   frontend        coding_score, +5 (capped 100) if "speed" is in best_for (fast iteration loops
                   matter more for UI work than for a one-shot backend change). No coding_score
                   -> null.
   exec-summaries  "general" score, as-is. No general score -> null.

   "general" score = benchmarks.gpqa if present, else benchmarks.mmlu_pro, else null — the only
   two catalog fields that measure broad (non-coding) capability. mmlu_pro is sourced for
   exactly one model as of 2026-09-06, so in practice "general" is almost always GPQA-or-null;
   see the module's generalScoreOf() and the refresh report for how many models this excludes
   per task. This is a deliberate, documented proxy, not an invented figure: it never returns a
   value the catalog doesn't already carry, and the exact field used is always recorded in
   basis[] so a reader can trace it (never a bare word "general").

   basis[] tokens are a fixed, small vocabulary (BASIS_TOKENS below) shared with
   assets/decide.mjs, which builds its `why` text from exactly these tokens and nothing else —
   one registry, so the two can't drift apart.

   Usage: node scripts/derive-task-fit.mjs [--dry-run]   (standalone run/preview)
*/
import { readFileSync, writeFileSync } from 'node:fs';

export const TASK_IDS = [
  'coding', 'agents', 'bulk', 'writing', 'research', 'extraction', 'chat', 'vision', 'frontend',
  'exec-summaries',
];

// The only basis tokens any task may cite — assets/decide.mjs's WHY_FIELDS keys this same set.
export const BASIS_TOKENS = [
  'coding_score', 'context_window', 'benchmarks.gpqa', 'benchmarks.mmlu_pro', 'price_output',
  'best_for:vision', 'best_for:speed', 'effort_ladders',
];

const num = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round0 = (v) => Math.round(v);

/** "general" capability proxy: whichever of GPQA / MMLU-Pro is sourced for this model, in that
 * order. Returns { score: 0-100|null, field: 'benchmarks.gpqa'|'benchmarks.mmlu_pro'|null }. */
export function generalScoreOf(model) {
  const b = model.benchmarks || {};
  if (num(b.gpqa)) return { score: b.gpqa, field: 'benchmarks.gpqa' };
  if (num(b.mmlu_pro)) return { score: b.mmlu_pro, field: 'benchmarks.mmlu_pro' };
  return { score: null, field: null };
}

/** Min-max normalizer over one field across the whole catalog, scaled to 0-100. `log` scales
 * the input first (used for price, which spans orders of magnitude). Falls back to a flat 50
 * for every value when the catalog has fewer than 2 distinct values to spread across — matches
 * the tie-handling in assets/app.js / mcp/server.js's own normalizer(). */
function buildNormalizer(models, selector, { log = false } = {}) {
  const raw = models.map(selector).filter(num);
  const vals = raw.map((v) => (log ? Math.log(Math.max(v, 1e-9)) : v));
  if (vals.length < 2) return (v) => (num(v) ? 50 : null);
  const min = Math.min(...vals), max = Math.max(...vals);
  if (max === min) return (v) => (num(v) ? 50 : null);
  return (v) => {
    if (!num(v)) return null;
    const x = log ? Math.log(Math.max(v, 1e-9)) : v;
    return clamp(((x - min) / (max - min)) * 100, 0, 100);
  };
}

/** Model ids that appear in at least one data/models.json effort_ladders series — a published
 * agentic-benchmark result, used only as a small "agents" bonus, never a standalone score. */
export function ladderModelIds(effortLadders) {
  const s = new Set();
  for (const L of effortLadders || []) for (const series of L.series || []) if (series.model_id) s.add(series.model_id);
  return s;
}

/** Build the {contextNorm, cheapNorm, ladderIds} shared across every model in one run — this is
 * why task fit is computed catalog-wide in one pass rather than per model in isolation.
 * cheapNorm is CHEAPNESS (100 = cheapest in the catalog, 0 = priciest) — the inverse of the raw
 * price_output normalization, since every price-weighted task wants "cheaper is better". */
export function buildContext(data) {
  const priceNorm = buildNormalizer(data.models, (m) => m.price_output, { log: true });
  return {
    contextNorm: buildNormalizer(data.models, (m) => m.context_window),
    cheapNorm: (v) => { const p = priceNorm(v); return p == null ? null : 100 - p; },
    ladderIds: ladderModelIds(data.effort_ladders),
  };
}

const nullFit = (reason) => ({ score: null, basis: [], reason });

function fitCoding(m) {
  if (!num(m.coding_score)) return nullFit('no coding_score sourced for this model');
  return { score: round0(m.coding_score), basis: ['coding_score'] };
}

function fitAgents(m, ctx) {
  if (!num(m.coding_score)) return nullFit('no coding_score sourced for this model (agentic fit needs a coding baseline)');
  const basis = ['coding_score'];
  let combined = m.coding_score;
  const ctxN = ctx.contextNorm(m.context_window);
  if (ctxN != null) { combined = m.coding_score * 0.7 + ctxN * 0.3; basis.push('context_window'); }
  let bonus = 0;
  if (ctx.ladderIds.has(m.id)) { bonus = 5; basis.push('effort_ladders'); }
  return { score: round0(clamp(combined + bonus, 0, 100)), basis };
}

function fitBulk(m, ctx) {
  const g = generalScoreOf(m);
  const cheap = ctx.cheapNorm(m.price_output);
  if (g.score == null) return nullFit('no general-capability benchmark (gpqa/mmlu_pro) sourced for this model');
  if (cheap == null) return nullFit('no price_output sourced for this model');
  return { score: round0(clamp(g.score * 0.35 + cheap * 0.65, 0, 100)), basis: [g.field, 'price_output'] };
}

function fitWriting(m) {
  const g = generalScoreOf(m);
  if (g.score == null) return nullFit('no general-capability benchmark (gpqa/mmlu_pro) sourced for this model');
  return { score: round0(g.score), basis: [g.field] };
}

function fitResearch(m, ctx) {
  const gpqa = m.benchmarks?.gpqa;
  if (!num(gpqa)) return nullFit('no GPQA score sourced for this model');
  const basis = ['benchmarks.gpqa'];
  let combined = gpqa;
  const ctxN = ctx.contextNorm(m.context_window);
  if (ctxN != null) { combined = gpqa * 0.7 + ctxN * 0.3; basis.push('context_window'); }
  return { score: round0(clamp(combined, 0, 100)), basis };
}

function fitExtraction(m, ctx) {
  const g = generalScoreOf(m);
  const cheap = ctx.cheapNorm(m.price_output);
  if (g.score == null) return nullFit('no general-capability benchmark (gpqa/mmlu_pro) sourced for this model');
  if (cheap == null) return nullFit('no price_output sourced for this model');
  return { score: round0(clamp(g.score * 0.5 + cheap * 0.5, 0, 100)), basis: [g.field, 'price_output'] };
}

function fitChat(m, ctx) {
  const g = generalScoreOf(m);
  const cheap = ctx.cheapNorm(m.price_output);
  if (g.score == null) return nullFit('no general-capability benchmark (gpqa/mmlu_pro) sourced for this model');
  if (cheap == null) return nullFit('no price_output sourced for this model');
  return { score: round0(clamp(g.score * 0.6 + cheap * 0.4, 0, 100)), basis: [g.field, 'price_output'] };
}

function fitVision(m) {
  if ((m.best_for || []).includes('vision')) return { score: 100, basis: ['best_for:vision'] };
  return nullFit('no "vision" tag on this model — no multimodal signal in the data');
}

function fitFrontend(m) {
  if (!num(m.coding_score)) return nullFit('no coding_score sourced for this model');
  const basis = ['coding_score'];
  let bonus = 0;
  if ((m.best_for || []).includes('speed')) { bonus = 5; basis.push('best_for:speed'); }
  return { score: round0(clamp(m.coding_score + bonus, 0, 100)), basis };
}

function fitExecSummaries(m) {
  const g = generalScoreOf(m);
  if (g.score == null) return nullFit('no general-capability benchmark (gpqa/mmlu_pro) sourced for this model');
  return { score: round0(g.score), basis: [g.field] };
}

const FITTERS = {
  coding: fitCoding,
  agents: fitAgents,
  bulk: fitBulk,
  writing: fitWriting,
  research: fitResearch,
  extraction: fitExtraction,
  chat: fitChat,
  vision: fitVision,
  frontend: fitFrontend,
  'exec-summaries': fitExecSummaries,
};

/** Full task_fit{} object for one model, given the catalog-wide context from buildContext(). */
export function deriveTaskFitForModel(model, ctx) {
  const out = {};
  for (const id of TASK_IDS) out[id] = FITTERS[id](model, ctx);
  return out;
}

/** Run task-fit derivation across the whole catalog, returning { taskFitById, nullCounts } —
 * nullCounts is {taskId: count} for the refresh report (how many models got excluded and why
 * shows up in each model's task_fit[taskId].reason). Does not mutate `data`. */
export function deriveTaskFit(data) {
  const ctx = buildContext(data);
  const taskFitById = new Map();
  const nullCounts = Object.fromEntries(TASK_IDS.map((t) => [t, 0]));
  for (const m of data.models) {
    const fit = deriveTaskFitForModel(m, ctx);
    taskFitById.set(m.id, fit);
    for (const t of TASK_IDS) if (fit[t].score == null) nullCounts[t]++;
  }
  return { taskFitById, nullCounts };
}

// ---------------------------------------------------------------------------------------------
// standalone runner — lets this be previewed/tested outside a full Collect run
// ---------------------------------------------------------------------------------------------

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const ROOT = new URL('../', import.meta.url);
  const dataUrl = new URL('data/models.json', ROOT);
  const data = JSON.parse(readFileSync(dataUrl));

  const { taskFitById, nullCounts } = deriveTaskFit(data);
  for (const m of data.models) {
    m.task_fit = taskFitById.get(m.id);
    if (!('task_fit_judged' in m)) m.task_fit_judged = null;
  }

  console.log(`task-fit: ${data.models.length} models scored across ${TASK_IDS.length} tasks.`);
  console.log('task-fit: models with score:null per task —');
  for (const t of TASK_IDS) console.log(`  ${t}: ${nullCounts[t]} / ${data.models.length}`);

  if (!dryRun) {
    writeFileSync(dataUrl, JSON.stringify(data, null, 2) + '\n');
    console.log('task-fit: data/models.json written.');
  } else {
    console.log('task-fit: --dry-run, nothing written.');
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
