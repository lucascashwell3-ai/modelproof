#!/usr/bin/env node
/* One-off migration (2026-09, judged-fit schema v3): strip `band` and `confidence` off every
   task_fit_judged[taskId] record. Those two fields were the AI-judged grade — brain v2 step 3
   (PR #34) already stripped them of ranking weight; this migration finishes the job by removing
   them from the schema entirely, so a record is now just claims[] + reconciliation + as_of (see
   scripts/validate-data.mjs's judged-fit block and scripts/apply-judgment.mjs).

   A record with no claims after stripping (there shouldn't be any today — band/confidence never
   gated claims — but a hand-edited or malformed record could exist) becomes `null` rather than an
   empty object, matching the file's existing convention for "no judged record for this task": see
   the KEY DELETED / null convention in scripts/migrate-claims-2026-09.mjs.

   Idempotent: a second run finds no record still carrying band/confidence and reports zero changes.

   Usage: node scripts/migrate-judged-v3.mjs [--dry-run] [--file <path>] */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = new URL('../', import.meta.url);
const DEFAULT_TARGETS = ['data/models.json', 'scripts/fixtures/models.json'];
const dryRun = process.argv.includes('--dry-run');
const fileArgIdx = process.argv.indexOf('--file');
const targets = fileArgIdx >= 0 ? [process.argv[fileArgIdx + 1]] : DEFAULT_TARGETS;

/** Pure: run the migration over an already-parsed models.json object, mutating it in place.
 * Returns a report: { recordsStripped, recordsNulled, perModel: [...] }. */
export function migrateJudgedV3(data) {
  let recordsStripped = 0;
  let recordsNulled = 0;
  const perModel = [];

  for (const m of data.models || []) {
    const tfj = m.task_fit_judged;
    if (tfj == null || typeof tfj !== 'object') continue;
    const touched = [];
    for (const taskId of Object.keys(tfj)) {
      const rec = tfj[taskId];
      if (!rec || typeof rec !== 'object') continue;
      const hadBand = Object.prototype.hasOwnProperty.call(rec, 'band');
      const hadConfidence = Object.prototype.hasOwnProperty.call(rec, 'confidence');
      if (!hadBand && !hadConfidence) continue;
      delete rec.band;
      delete rec.confidence;
      recordsStripped++;
      if (!Array.isArray(rec.claims) || !rec.claims.length) {
        tfj[taskId] = null;
        recordsNulled++;
        touched.push({ taskId, nulled: true });
      } else {
        touched.push({ taskId, nulled: false });
      }
    }
    if (touched.length) perModel.push({ id: m.id, name: m.name, touched });
  }
  return { recordsStripped, recordsNulled, perModel };
}

async function runOn(relPath) {
  const url = new URL(relPath, ROOT);
  const data = JSON.parse(readFileSync(url));
  const report = migrateJudgedV3(data);

  console.log(`migrate-judged-v3 (${relPath}): ${report.recordsStripped} record(s) stripped of band/confidence, ${report.recordsNulled} nulled for having no claims.`);
  for (const m of report.perModel.slice(0, 20)) {
    console.log(`  ${m.name} (${m.id}): ${m.touched.map((t) => `${t.taskId}${t.nulled ? ' [nulled]' : ''}`).join(', ')}`);
  }
  if (report.perModel.length > 20) console.log(`  ...and ${report.perModel.length - 20} more`);

  if (!dryRun) {
    writeFileSync(url, JSON.stringify(data, null, 2) + '\n');
    console.log(`migrate-judged-v3: ${relPath} written.`);
  } else {
    console.log('migrate-judged-v3: --dry-run, nothing written.');
  }
  return report;
}

async function main() {
  for (const t of targets) await runOn(t);
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try { return fileURLToPath(import.meta.url) === realpathSync(resolve(process.argv[1])); }
  catch { return fileURLToPath(import.meta.url) === process.argv[1]; }
})();
if (isMain) {
  main().catch((e) => { console.error(e); process.exitCode = 1; });
}
