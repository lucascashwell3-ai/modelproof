#!/usr/bin/env node
/* Live-data gate — run after a Collect, against the real data/ (never scripts/fixtures/).
   Checks invariants only, never expected values, so a data refresh that legitimately changes
   prices or availability can't turn this red.

   Two groups (--group feed|plans|all, default all):

   feed — the shape of what Collect publishes (safe to block a publish on):
     (d) model count is within +/-15% of the version committed at HEAD (skipped if git
         is unavailable or HEAD has no data/models.json).
     (e) as_of is a valid YYYY-MM-DD string and not in the future.
     (f) feed health: for each key field (price_input, price_output, availability.openrouter,
         availability.direct_api, the BENCHES benchmarks, and effort-ladder points), the count of
         non-null values hasn't dropped more than 15% from the version committed at HEAD — catches
         a feed silently starting to return empty instead of erroring loud (skipped if git is
         unavailable or HEAD has no data/models.json).
     (g) every timeline entry (models.json releases[]) has an http(s) source.
     (h) every effort-ladder point resolves a publisher and a method (point -> series -> ladder,
         the same inheritance the data contract uses for its source).

   plans — what the board and the install package recommend (Collect never writes these; the
   Judge writes deprecations, so this group runs in tests.yml and the weekly defaults watch,
   never as a Collect publish gate):
     (i) every recommendation line — guidance.json tool_plans slots that name a model_id,
         role_defaults, and board-samples.json personal_default.models — resolves to a catalog
         model whose status is "ga".
     (j) no line anywhere — the above plus guidance.json model_refs and the example boards in
         board-samples.json (org people, modelMode have/roles) — points at a deprecated model.

   Exit: 0 nothing found; 1 one plain line per problem on stderr; 2 bad arguments.
   Usage: node scripts/check-live-data.mjs [--group feed|plans|all] [--data <dir>]
     --data  read models.json / guidance.json / board-samples.json from <dir> (default: data/);
             the HEAD comparisons (d)/(f) only run against this repo's own data/.
   As a module: exports the individual checks (unit-tested in test-check-live-data.mjs). */
import { readFileSync, realpathSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

// (d)
export function checkModelCountRatio(before, after, tolerance = 0.15) {
  if (!Number.isFinite(before) || before <= 0) return [];
  const lo = before * (1 - tolerance);
  const hi = before * (1 + tolerance);
  if (after < lo || after > hi) {
    return [`model count ${after} is outside +/-${Math.round(tolerance * 100)}% of the committed ${before} (allowed ${Math.floor(lo)}-${Math.ceil(hi)})`];
  }
  return [];
}

// (f): a feed that starts silently returning empty (an API dropping a field, a parser regression)
// looks nothing like a normal refresh — a normal refresh changes VALUES, it doesn't erase them.
// Compares non-null counts per field against the committed version; a drop past `tolerance` in
// any one field fails, naming that field and both counts. Field list follows scripts/validate-data.mjs's
// schema: price_input/price_output (rule 1), availability.openrouter/direct_api (rule 9), and the
// BENCHES benchmarks (rule 2) are per-model; effort-ladder points are counted across data.effort_ladders.
const FEED_HEALTH_MODEL_FIELDS = [
  ['price_input', (m) => m.price_input],
  ['price_output', (m) => m.price_output],
  ['availability.openrouter', (m) => m.availability?.openrouter],
  ['availability.direct_api', (m) => m.availability?.direct_api],
  ['benchmarks.swe_bench', (m) => m.benchmarks?.swe_bench],
  ['benchmarks.gpqa', (m) => m.benchmarks?.gpqa],
  ['benchmarks.aime', (m) => m.benchmarks?.aime],
  ['benchmarks.mmlu_pro', (m) => m.benchmarks?.mmlu_pro],
];
const nonNull = (v) => v !== null && v !== undefined;
const countNonNull = (models, getter) => models.reduce((n, m) => n + (nonNull(getter(m)) ? 1 : 0), 0);
const ladderPointCount = (data) => (data.effort_ladders || [])
  .reduce((n, L) => n + (L.series || []).reduce((k, s) => k + (s.points || []).length, 0), 0);

export function checkFeedHealth(before, after, tolerance = 0.15) {
  const problems = [];
  const check = (label, beforeCount, afterCount) => {
    if (!Number.isFinite(beforeCount) || beforeCount <= 0) return; // nothing committed to compare against
    const drop = (beforeCount - afterCount) / beforeCount;
    if (drop > tolerance) {
      problems.push(`feed health: "${label}" non-null count dropped from ${beforeCount} to ${afterCount} (>${Math.round(tolerance * 100)}% drop) — a feed may have silently gone empty`);
    }
  };
  for (const [label, getter] of FEED_HEALTH_MODEL_FIELDS) {
    check(label, countNonNull(before.models || [], getter), countNonNull(after.models || [], getter));
  }
  check('effort_ladders points', ladderPointCount(before), ladderPointCount(after));
  return problems;
}

// (e)
export function checkAsOf(asOf, today = new Date()) {
  if (typeof asOf !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) return [`as_of "${asOf}" is not a YYYY-MM-DD string`];
  const d = new Date(asOf + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return [`as_of "${asOf}" is not a valid calendar date`];
  const todayUTC = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  if (d.getTime() > todayUTC.getTime()) return [`as_of "${asOf}" is in the future`];
  return [];
}

// (g)
export function checkTimelineSources(releases) {
  return (releases || [])
    .filter((r) => !(r && typeof r.source === 'string' && /^https?:\/\//i.test(r.source)))
    .map((r) => `timeline: release "${(r && r.title) || '(untitled)'}" (${(r && r.date) || 'no date'}) has no http(s) source`);
}

// (h): one problem per series (not per point) keeps the output short.
const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';
export function checkLadderProvenance(ladders) {
  const problems = [];
  for (const L of ladders || []) {
    for (const s of L.series || []) {
      for (const field of ['publisher', 'method']) {
        const bad = (s.points || []).filter((p) => !nonEmpty(p[field] ?? s[field] ?? L[field]));
        if (bad.length) problems.push(`ladder ${L.id} series ${s.model_id || s.label}: ${bad.length} point(s) resolve no ${field} (point -> series -> ladder)`);
      }
    }
  }
  return problems;
}

/** Every line on the board / in the install package that names a model:
 * [{where, kind, model_id}], kind one of plan | role_default | personal_default (recommendation
 * lines) or model_ref | sample (illustrative lines). A plan slot with a `choice` and no model_id
 * names no model and is skipped. `basis` arrays are never walked. */
export function planLines(guidance, samples) {
  const out = [];
  for (const tp of (guidance && guidance.tool_plans) || []) {
    const walk = (node, path) => {
      if (Array.isArray(node)) { node.forEach((x, i) => walk(x, `${path}[${i}]`)); return; }
      if (!node || typeof node !== 'object') return;
      if (typeof node.model_id === 'string') out.push({ where: `guidance tool_plans ${tp.tool}${path}`, kind: 'plan', model_id: node.model_id });
      for (const [k, v] of Object.entries(node)) if (v && typeof v === 'object' && k !== 'basis') walk(v, `${path}.${k}`);
    };
    walk({ lead: tp.lead, helpers: tp.helpers, bulk: tp.bulk }, '');
  }
  for (const r of (guidance && guidance.role_defaults) || []) {
    if (typeof r.model_id === 'string') out.push({ where: `guidance role_defaults ${r.tool}/${r.role}`, kind: 'role_default', model_id: r.model_id });
  }
  for (const r of (guidance && guidance.model_refs) || []) {
    if (typeof r.model_id === 'string') out.push({ where: `guidance model_refs ${r.tool}/${r.ref}`, kind: 'model_ref', model_id: r.model_id });
  }
  const pd = (samples && samples.personal_default) || {};
  for (const id of pd.models || []) out.push({ where: 'board-samples personal_default.models', kind: 'personal_default', model_id: id });
  for (const d of (samples && samples.org && samples.org.divisions) || []) {
    for (const p of d.people || []) if (p.model) out.push({ where: `board-samples org ${d.name}/${p.who}`, kind: 'sample', model_id: p.model });
  }
  const mm = (samples && samples.modelMode) || {};
  for (const id of mm.have || []) out.push({ where: 'board-samples modelMode.have', kind: 'sample', model_id: id });
  for (const r of mm.roles || []) if (r.model) out.push({ where: `board-samples modelMode.roles ${r.role}`, kind: 'sample', model_id: r.model });
  return out;
}

export const RECOMMENDATION_KINDS = ['plan', 'role_default', 'personal_default'];
const isDeprecated = (m) => m.deprecated === true || m.status === 'deprecated';

// (i)
export function checkPlanLinesGA(lines, models, { kinds = RECOMMENDATION_KINDS } = {}) {
  const byId = new Map((models || []).map((m) => [m.id, m]));
  const problems = [];
  for (const l of lines) {
    if (!kinds.includes(l.kind)) continue;
    const m = byId.get(l.model_id);
    if (!m) problems.push(`plans: ${l.where} -> ${l.model_id} is not in models.json`);
    else if (m.status !== 'ga' || isDeprecated(m)) problems.push(`plans: ${l.where} -> ${l.model_id} is not GA (status ${isDeprecated(m) ? 'deprecated' : m.status})`);
  }
  return problems;
}

// (j)
export function checkNoRetiredPlans(lines, models) {
  const byId = new Map((models || []).map((m) => [m.id, m]));
  return lines
    .filter((l) => { const m = byId.get(l.model_id); return m && isDeprecated(m); })
    .map((l) => `plans: ${l.where} -> ${l.model_id} points at a deprecated model`);
}

export const GROUPS = ['feed', 'plans', 'all'];

/** Every problem for `group`, from already-read files. `committed` = HEAD's models.json (or
 * null to skip (d)/(f)); `today` pins the clock for (e). Pure. */
export function runChecks({ models, guidance = null, samples = null }, { group = 'all', committed = null, today = new Date() } = {}) {
  if (!GROUPS.includes(group)) throw new Error(`unknown group "${group}" (one of ${GROUPS.join(', ')})`);
  const problems = [];
  if (group === 'feed' || group === 'all') {
    if (committed != null) {
      problems.push(...checkModelCountRatio((committed.models || []).length, (models.models || []).length));
      problems.push(...checkFeedHealth(committed, models));
    }
    problems.push(...checkAsOf(models.as_of, today));
    problems.push(...checkTimelineSources(models.releases));
    problems.push(...checkLadderProvenance(models.effort_ladders));
  }
  if (group === 'plans' || group === 'all') {
    const lines = planLines(guidance, samples);
    problems.push(...checkPlanLinesGA(lines, models.models));
    problems.push(...checkNoRetiredPlans(lines, models.models));
  }
  return problems;
}

export function parseArgs(argv) {
  const out = { group: 'all', dataDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--group') out.group = argv[++i];
    else if (a.startsWith('--group=')) out.group = a.slice(8);
    else if (a === '--data') out.dataDir = argv[++i];
    else if (a.startsWith('--data=')) out.dataDir = a.slice(7);
    else throw new Error(`unknown argument "${a}" (usage: check-live-data.mjs [--group feed|plans|all] [--data <dir>])`);
  }
  if (!GROUPS.includes(out.group)) throw new Error(`unknown group "${out.group}" (one of ${GROUPS.join(', ')})`);
  return out;
}

function committedModelsData(root) {
  try {
    const raw = execFileSync('git', ['show', 'HEAD:data/models.json'], { cwd: fileURLToPath(root), stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 }).toString();
    return JSON.parse(raw);
  } catch {
    return null; // git unavailable, or HEAD has no data/models.json — skip (d)/(f) rather than block.
  }
}

function main() {
  const ROOT = new URL('../', import.meta.url);
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  const dir = args.dataDir ? pathToFileURL(resolve(args.dataDir) + '/') : new URL('data/', ROOT);
  const read = (name, required) => {
    const u = new URL(name, dir);
    if (!required && !existsSync(u)) return null;
    return JSON.parse(readFileSync(u, 'utf8'));
  };
  let files;
  try {
    files = { models: read('models.json', true), guidance: read('guidance.json', false), samples: read('board-samples.json', false) };
  } catch (e) {
    console.error(`could not read live data: ${e.message}`);
    process.exit(1);
  }
  const committed = args.dataDir ? null : committedModelsData(ROOT);
  const problems = runChecks(files, { group: args.group, committed });
  if (problems.length) {
    problems.forEach((p) => console.error(p));
    process.exit(1);
  }
  process.exit(0);
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try { return fileURLToPath(import.meta.url) === realpathSync(resolve(process.argv[1])); }
  catch { return fileURLToPath(import.meta.url) === process.argv[1]; }
})();
if (isMain) main();
