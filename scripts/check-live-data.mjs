#!/usr/bin/env node
/* Live-data gate — run after a Collect, against the real data/ (never scripts/fixtures/).
   Checks invariants only, never expected values, so a data refresh that legitimately changes
   prices or availability can't turn this red.

   Checks (lettering kept from earlier versions; (a)-(c) retired with the ranking engine,
   see archive/README.md):
     (d) model count is within +/-15% of the version committed at HEAD (skipped if git
         is unavailable or HEAD has no data/models.json).
     (e) as_of is a valid YYYY-MM-DD string and not in the future.
     (f) feed health: for each key field (price_input, price_output, availability.openrouter,
         availability.direct_api, the BENCHES benchmarks, and effort-ladder points), the count of
         non-null values hasn't dropped more than 15% from the version committed at HEAD — catches
         a feed silently starting to return empty instead of erroring loud (skipped if git is
         unavailable or HEAD has no data/models.json).

   Exits 1 with one plain line per problem found, exits 0 silently otherwise.
   Usage: node scripts/check-live-data.mjs
   As a module: exports the individual checks (unit-tested in test-check-live-data.mjs). */
import { readFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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

function readLiveData(root) {
  return { modelsFile: JSON.parse(readFileSync(new URL('data/models.json', root))) };
}

function committedModelsData(root) {
  try {
    const raw = execFileSync('git', ['show', 'HEAD:data/models.json'], { cwd: fileURLToPath(root), stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    return JSON.parse(raw);
  } catch {
    return null; // git unavailable, or HEAD has no data/models.json — skip (d)/(f) rather than block.
  }
}

function main() {
  const ROOT = new URL('../', import.meta.url);
  let files;
  try {
    files = readLiveData(ROOT);
  } catch (e) {
    console.error(`could not read live data/: ${e.message}`);
    process.exit(1);
  }
  const models = files.modelsFile.models || [];
  const problems = [];

  const committed = committedModelsData(ROOT);
  if (committed != null) {
    problems.push(...checkModelCountRatio(committed.models.length, models.length));
    problems.push(...checkFeedHealth(committed, files.modelsFile));
  }

  problems.push(...checkAsOf(files.modelsFile.as_of));

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
