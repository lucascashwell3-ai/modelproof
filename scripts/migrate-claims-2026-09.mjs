#!/usr/bin/env node
/* One-off migration (2026-09, brain v2 step 3 rounds 2-3): remove every task_fit_judged claim
   that can never stay verified by scripts/check-sources.mjs. Two categories:

   (1) citesLiveFeed (scripts/validate-data.mjs) — a claim citing OpenRouter's rankings API
       (openrouter.ai/api/frontend/*, openrouter.ai/rankings*), arena.ai's leaderboards
       (arena.ai/*), or artificialanalysis.ai. The first two are live feeds this codebase now
       ingests directly and re-derives every day into model.standings — their numbers change
       daily, and arena.ai no longer even server-renders its table, so a claim citing them would
       fail the anti-fabrication gate FOREVER (the exact red-Collect failure the standings feed —
       scripts/derive-standings.mjs, scripts/derive-signals.mjs — was built to end). Nothing is
       lost: the same evidence, dated and linked, now lives in model.standings[taskId] (chosen/
       preferred) — a claim citing these hosts was only ever restating that. artificialanalysis.ai
       is different: its own terms ban DISPLAYING its content outside a paid tier
       (data/testers.json's "artificial-analysis" entry: verdict "signal-only", "Display-BANNED
       stands") — a claim quoting it is a licence problem independent of whether the quote still
       matches the page (round 3 — 4 of its claims were also failing content-drift, on top of
       this).

   (2) EXPLICIT_STALE_CLAIMS below — individually confirmed content drift (round 3): a handful of
       third-party pages (buildfastwithai.com, o-mega.ai, a HuggingFace README) that check-
       sources.mjs kept failing because the page changed since the claim was written, verified
       BY HAND against the live page on 2026-09-13, one at a time — never removed by a blanket
       host rule (some of these same hosts have OTHER, still-passing claims on OTHER tasks for
       the SAME model, which this list leaves untouched by matching on the exact (model, task,
       source_url) triple, not just the host).

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
// citesLiveFeed (scripts/validate-data.mjs) is the ONE definition of "a live feed, or a display-
// banned source, we can never keep a claim citing" — reused here, by the permanent honesty-gate
// check next to it, and by scripts/apply-judgment.mjs's pre-flight validator, so all three can
// never drift apart.

/** Individually-confirmed content drift (round 3, 2026-09-13) — see the file header's category
 * (2). Matched on the EXACT (modelId, taskId, source_url) triple, never just a host, so a
 * still-passing claim citing the same host on a different task/model is never touched. */
export const EXPLICIT_STALE_CLAIMS = [
  { modelId: 'deepseek-v4-pro', taskId: 'coding', source_url: 'https://www.buildfastwithai.com/blogs/deepseek-v4-pro-review-2026', reason: 'quote no longer on the cited page as of 2026-09-13' },
  { modelId: 'deepseek-v4-pro', taskId: 'agents', source_url: 'https://www.buildfastwithai.com/blogs/deepseek-v4-pro-review-2026', reason: 'quote no longer on the cited page as of 2026-09-13' },
  { modelId: 'deepseek-v4-pro', taskId: 'bulk', source_url: 'https://www.buildfastwithai.com/blogs/deepseek-v4-pro-review-2026', reason: 'quote no longer on the cited page as of 2026-09-13' },
  { modelId: 'gemini-3-5-flash', taskId: 'agents', source_url: 'https://o-mega.ai/articles/gemini-3-5-flash-benchmarks-cost-and-guide', reason: 'quote no longer on the cited page as of 2026-09-13' },
  { modelId: 'gemini-3-5-flash', taskId: 'vision', source_url: 'https://o-mega.ai/articles/gemini-3-5-flash-benchmarks-cost-and-guide', reason: 'quote no longer on the cited page as of 2026-09-13' },
  { modelId: 'hy-mt2-1-8b', taskId: 'bulk', source_url: 'https://huggingface.co/tencent/Hy-MT2-1.8B', reason: 'quote no longer on the cited page as of 2026-09-13' },
];
function isExplicitlyStale(modelId, taskId, url) {
  return EXPLICIT_STALE_CLAIMS.some((e) => e.modelId === modelId && e.taskId === taskId && e.source_url === url);
}

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
      const kept = rec.claims.filter((c) => !citesLiveFeed(c?.source_url) && !isExplicitlyStale(m.id, taskId, c?.source_url));
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
