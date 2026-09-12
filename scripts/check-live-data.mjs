#!/usr/bin/env node
/* Live-data gate — run after a Collect, against the real data/ (never scripts/fixtures/).
   Checks invariants only: it never asserts an expected winner, so a data refresh that
   legitimately changes prices/scores/availability can't turn this red. Golden-value checks on
   decide()'s logic live in scripts/test-decide.mjs, which runs on the frozen fixture instead.

   Checks:
     (a) decide() runs for every task id with a default input and does not throw.
     (b) every id in every shortlist decide() returns exists in data/models.json.
     (c) every situation's must_not_include rule in data/eval/situations.json still holds
         (start_here winners are NOT checked here — those are the golden-fixture test's job).
     (d) model count is within +/-15% of the version committed at HEAD (skipped if git
         is unavailable or HEAD has no data/models.json).
     (e) as_of is a valid YYYY-MM-DD string and not in the future.

   Exits 1 with one plain line per problem found, exits 0 silently otherwise.
   Usage: node scripts/check-live-data.mjs
   As a module: exports the individual checks (unit-tested in test-check-live-data.mjs). */
import { readFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { decide } from '../assets/decide.mjs';
import { TASK_IDS } from './derive-task-fit.mjs';

// (a) + (b): decide() must not throw for any task id, and every shortlisted id must be real.
export function checkDecideRuns(data) {
  let out = null;
  try {
    out = decide({ tasks: TASK_IDS, have: ['any'], stance: 'balanced', volume: 'typical', dataRule: {} }, data);
  } catch (e) {
    return { problems: [`decide() threw on the live catalog: ${e.message}`], out: null };
  }
  const modelIds = new Set(data.models.map((m) => m.id));
  const problems = [];
  for (const taskId of TASK_IDS) {
    const shortlist = out.tasks[taskId]?.shortlist || [];
    for (const item of shortlist) {
      if (!modelIds.has(item.id)) problems.push(`decide() shortlist for "${taskId}" includes unknown model id "${item.id}"`);
    }
  }
  return { problems, out };
}

// (c): rule-based, safe to run on live data — unlike start_here_any_of, must_not_include never
// asserts which model should win, only that certain ids must never appear.
export function checkMustNotInclude(situations, data) {
  const problems = [];
  for (const s of situations || []) {
    const taskId = s.input.tasks[0];
    let out;
    try {
      out = decide(s.input, data);
    } catch (e) {
      problems.push(`decide() threw on situation "${s.id}": ${e.message}`);
      continue;
    }
    const shortlist = out.tasks[taskId]?.shortlist || [];
    for (const id of s.expected?.must_not_include || []) {
      if (shortlist.some((x) => x.id === id)) problems.push(`situation "${s.id}": "${id}" must not appear in the shortlist but does`);
    }
  }
  return problems;
}

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
  const readJson = (p) => JSON.parse(readFileSync(new URL(p, root)));
  return {
    modelsFile: readJson('data/models.json'),
    plansFile: readJson('data/plans.json'),
    presetsFile: readJson('data/usage-presets.json'),
    vendorsFile: readJson('data/vendors.json'),
    situationsFile: readJson('data/eval/situations.json'),
  };
}

function committedModelCount(root) {
  try {
    const raw = execFileSync('git', ['show', 'HEAD:data/models.json'], { cwd: fileURLToPath(root), stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    return JSON.parse(raw).models.length;
  } catch {
    return null; // git unavailable, or HEAD has no data/models.json — skip (d) rather than block.
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
  const data = {
    models: files.modelsFile.models,
    plans: files.plansFile.plans,
    presets: files.presetsFile.presets,
    vendors: files.vendorsFile.vendors,
  };

  const problems = [];
  problems.push(...checkDecideRuns(data).problems);
  problems.push(...checkMustNotInclude(files.situationsFile.situations, data));

  const before = committedModelCount(ROOT);
  if (before != null) problems.push(...checkModelCountRatio(before, data.models.length));

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
