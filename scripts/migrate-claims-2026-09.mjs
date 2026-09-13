#!/usr/bin/env node
/* One-off migration (2026-09, brain v2 step 3 round 2): remove every task_fit_judged claim whose
   source_url cites a live feed this codebase now ingests directly and re-derives every day —
   OpenRouter's rankings API (openrouter.ai/api/frontend/*, openrouter.ai/rankings*) and arena.ai's
   leaderboards (arena.ai/*). Those pages' numbers change daily and arena.ai no longer even
   server-renders its table, so scripts/check-sources.mjs (a publish gate in
   .github/workflows/auto-refresh.yml) would fail on a claim citing them FOREVER — the exact
   red-Collect failure the standings feed (scripts/derive-standings.mjs, scripts/derive-
   signals.mjs) was built to end. Nothing is lost: the same evidence, dated and linked, now lives
   in model.standings[taskId] (chosen/preferred) — a claim citing one of these hosts was only ever
   restating what standings already carries as a live, re-derived fact, never independent
   evidence a claim exists to preserve.

   A task_fit_judged[taskId] record left with zero claims after this has its KEY DELETED (not set
   to null — scripts/validate-data.mjs requires an existing key's value to be an object, so a
   null value there would itself fail the gate; "no record for this task" is properly expressed by
   the key being ABSENT). A model whose task_fit_judged ends up with no task keys left at all has
   its task_fit_judged set to `null` (the file's own existing convention for "no judged records").

   Idempotent: a second run finds nothing left to remove (every remaining claim already survived
   the first pass) and reports zero changes.

   Usage: node scripts/migrate-claims-2026-09.mjs [--dry-run] */
import { readFileSync, writeFileSync } from 'node:fs';
import { citesLiveFeed } from './validate-data.mjs';

const ROOT = new URL('../', import.meta.url);
const dataUrl = new URL('data/models.json', ROOT);
const dryRun = process.argv.includes('--dry-run');
// citesLiveFeed (scripts/validate-data.mjs) is the ONE definition of "a live feed we now ingest
// directly" — reused here, by the permanent honesty-gate check next to it, and by
// scripts/apply-judgment.mjs's pre-flight validator, so all three can never drift apart.

/** Pure: run the migration over an already-parsed data/models.json object, mutating it in place.
 * Returns a report: { claimsRemoved, tasksEmptied, modelsFullyCleared, perModel: [...] }. */
export function migrateClaims(data) {
  let claimsRemoved = 0;
  let tasksEmptied = 0;
  let modelsFullyCleared = 0;
  const perModel = [];

  for (const m of data.models || []) {
    const tfj = m.task_fit_judged;
    if (tfj == null || typeof tfj !== 'object') continue;
    const touched = [];
    for (const taskId of Object.keys(tfj)) {
      const rec = tfj[taskId];
      if (!rec || !Array.isArray(rec.claims)) continue;
      const before = rec.claims.length;
      const kept = rec.claims.filter((c) => !citesLiveFeed(c?.source_url));
      const removed = before - kept.length;
      if (!removed) continue;
      claimsRemoved += removed;
      if (kept.length) {
        rec.claims = kept;
        touched.push({ taskId, removed, emptied: false });
      } else {
        delete tfj[taskId];
        tasksEmptied++;
        touched.push({ taskId, removed, emptied: true });
      }
    }
    if (touched.length) perModel.push({ id: m.id, name: m.name, touched });
    if (Object.keys(tfj).length === 0 && touched.some((t) => t.emptied)) {
      m.task_fit_judged = null;
      modelsFullyCleared++;
    }
  }
  return { claimsRemoved, tasksEmptied, modelsFullyCleared, perModel };
}

async function main() {
  const data = JSON.parse(readFileSync(dataUrl));
  const report = migrateClaims(data);

  console.log(`migrate-claims: ${report.claimsRemoved} claim(s) removed across ${report.perModel.length} model(s).`);
  console.log(`migrate-claims: ${report.tasksEmptied} task_fit_judged[taskId] record(s) deleted entirely (their claims all cited a live feed).`);
  console.log(`migrate-claims: ${report.modelsFullyCleared} model(s)' task_fit_judged is now null (no judged records left at all).`);
  for (const m of report.perModel.slice(0, 20)) {
    console.log(`  ${m.name} (${m.id}): ${m.touched.map((t) => `${t.taskId}${t.emptied ? ' [emptied]' : ` (-${t.removed})`}`).join(', ')}`);
  }
  if (report.perModel.length > 20) console.log(`  ...and ${report.perModel.length - 20} more`);

  if (!dryRun) {
    writeFileSync(dataUrl, JSON.stringify(data, null, 2) + '\n');
    console.log('migrate-claims: data/models.json written.');
  } else {
    console.log('migrate-claims: --dry-run, nothing written.');
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
