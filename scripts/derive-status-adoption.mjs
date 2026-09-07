#!/usr/bin/env node
/* Per-model `status` and `adoption` — two catalog-wide facts the decision layer's new ranking
   rules (assets/decide.mjs) gate on directly, so they live on the MODEL itself, not buried inside
   a single task's task_fit_judged record — the gate has to fire even for a task where no judged
   record exists yet (the exact gap that let a 0.16%-share preview SKU top "research" on a
   benchmark number alone; see the PR this shipped in for the full story).

   status: 'ga' | 'preview' | 'deprecated' — sourced, never guessed:
     - 'deprecated' when the model's own `deprecated` flag is true (set only by a cited Judge
       deprecation judgment — scripts/apply-judgment.mjs's "deprecation" kind).
     - 'preview' when the model's own NAME says so. The name field is already a sourced fact
       (scripts/naming.mjs: "the model's own name, as the vendor writes it") and naming.mjs's own
       id-derivation rule already treats a trailing "(Preview)" qualifier as meaningful (it's
       stripped when deriving the id) — reusing that exact same signal here means "preview" is
       never an invented label, just a read of a fact the catalog already carries. Deliberately
       narrow (a literal "preview" word, case-insensitive) — "Exp"/"beta"/"alpha" are different
       claims this pass doesn't have a source for, so a model carrying one of those stays 'ga'
       rather than being guessed into a status the name doesn't actually say.
     - 'ga' otherwise — the default for a model with no first-party signal that it's anything else.

   adoption: 'broad' | 'moderate' | 'low' | 'unknown' — a pure, deterministic bucketing of the
   model's own `usage.openrouter.share` (already a sourced fact — scripts/derive-usage.mjs), never
   a second opinion on it:
     share >= 2       -> 'broad'
     0.5 <= share < 2  -> 'moderate'
     share < 0.5       -> 'low'
     no usage.openrouter.share sourced -> 'unknown' (never a guessed bucket)

   Both are pure functions of fields the catalog already carries, so — like derive-task-fit.mjs —
   this is deterministic and safe to re-run on every refresh (scripts/auto-refresh.mjs calls
   deriveStatus/deriveAdoption for the whole catalog right after usage.openrouter is updated, the
   same place task_fit gets recomputed), not a one-time hand edit.

   Usage: node scripts/derive-status-adoption.mjs [--dry-run]   (standalone run/preview) */
import { readFileSync, writeFileSync } from 'node:fs';

export const STATUS_VALUES = ['ga', 'preview', 'deprecated'];
export const ADOPTION_VALUES = ['broad', 'moderate', 'low', 'unknown'];

const num = (v) => typeof v === 'number' && Number.isFinite(v);

/** { status, reason } — reason is plain-English provenance, not stored on the model (the model's
 * own name/deprecated field IS the source), just for the refresh log. */
export function deriveStatus(model) {
  if (model.deprecated === true) return { status: 'deprecated', reason: 'model.deprecated is true (cited Judge deprecation)' };
  if (/\bpreview\b/i.test(model.name || '')) return { status: 'preview', reason: `model name "${model.name}" says so` };
  return { status: 'ga', reason: 'no preview/deprecated signal in the model\'s own name or deprecated flag' };
}

/** { adoption, share } — share is the raw number (or null) so a caller can cite it in a `why`. */
export function deriveAdoption(model) {
  const share = model.usage?.openrouter?.share;
  if (!num(share)) return { adoption: 'unknown', share: null };
  if (share >= 2) return { adoption: 'broad', share };
  if (share >= 0.5) return { adoption: 'moderate', share };
  return { adoption: 'low', share };
}

/** Derive both for the whole catalog. Pure — does not mutate `models`. Returns
 * Map<modelId, {status, adoption, share}>. */
export function deriveStatusAdoptionForCatalog(models) {
  const out = new Map();
  for (const m of models || []) {
    const { status } = deriveStatus(m);
    const { adoption, share } = deriveAdoption(m);
    out.set(m.id, { status, adoption, share });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// standalone runner
// ---------------------------------------------------------------------------------------------
async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const ROOT = new URL('../', import.meta.url);
  const dataUrl = new URL('data/models.json', ROOT);
  const data = JSON.parse(readFileSync(dataUrl));

  const derived = deriveStatusAdoptionForCatalog(data.models);
  let changed = 0;
  for (const m of data.models) {
    const next = derived.get(m.id);
    if (m.status !== next.status || m.adoption !== next.adoption) changed++;
    m.status = next.status;
    m.adoption = next.adoption;
  }

  const counts = { status: {}, adoption: {} };
  for (const { status, adoption } of derived.values()) {
    counts.status[status] = (counts.status[status] || 0) + 1;
    counts.adoption[adoption] = (counts.adoption[adoption] || 0) + 1;
  }
  console.log(`status/adoption: ${data.models.length} model(s), ${changed} changed.`);
  console.log('status/adoption: status —', counts.status);
  console.log('status/adoption: adoption —', counts.adoption);

  if (!dryRun) {
    writeFileSync(dataUrl, JSON.stringify(data, null, 2) + '\n');
    console.log('status/adoption: data/models.json written.');
  } else {
    console.log('status/adoption: --dry-run, nothing written.');
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
