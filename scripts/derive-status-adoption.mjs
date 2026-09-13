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

   adoption: 'broad' | 'moderate' | 'low' | 'unknown' | 'new' — a pure, deterministic bucketing of
   the model's own `usage.openrouter.share` (already a sourced fact — scripts/derive-usage.mjs):
     share >= 2       -> 'broad'
     0.5 <= share < 2  -> 'moderate'
     share < 0.5       -> 'low'
     no usage.openrouter.share sourced -> 'unknown' (never a guessed bucket)
   ...EXCEPT: a share that would otherwise land on 'low' or 'unknown' is overridden to 'new' when
   the model was released within RECENCY_WINDOW_DAYS (60) days of the data snapshot's own `as_of`.
   Fixed 2026-09-07: claude-fable-5-1 (released 2026-09-01, 6 days before as_of 2026-09-07) was
   landing on 'low' from its 0.26% share and getting demoted below older, better-established
   models by assets/decide.mjs's low-adoption start_here gate — a thin, launch-week share number
   is noise, not evidence the model hasn't caught on; there simply hasn't been time for a real
   number to form. 'new' is a distinct bucket from 'low' specifically so a caller can tell "too
   early to measure" apart from "measured and it's genuinely low" — see assets/decide.mjs's
   ADOPTION_RANK and isDisqualifiedFromStartHere, which only ever demote 'low', never 'new'.
   The override is deliberately one-directional: it never touches a 'broad' or 'moderate' result.
   A model that already shows real, substantial share in its first days (e.g. a vendor's flagship
   launch) has adoption that IS measured and IS strong — calling that "not yet measurable" would
   be as dishonest in the other direction as calling a genuinely-thin number "new" isn't. Recency
   only ever rescues a THIN reading from being misread as a verdict; it never overrides a good one.
   Needs a real, full YYYY-MM-DD `released` date to fire at all — see daysSinceRelease: a model
   with only a year (or month, quarter, or "unknown") on file can't be checked against a day-level
   window, so it falls through to the plain share-based bucket above instead of guessing 'new'.

   Both are pure functions of fields the catalog already carries, so — like derive-task-fit.mjs —
   this is deterministic and safe to re-run on every refresh (scripts/auto-refresh.mjs calls
   deriveStatus/deriveAdoption for the whole catalog right after usage.openrouter is updated, the
   same place task_fit gets recomputed), not a one-time hand edit.

   Usage: node scripts/derive-status-adoption.mjs [--dry-run]   (standalone run/preview) */
import { readFileSync, writeFileSync } from 'node:fs';

export const STATUS_VALUES = ['ga', 'preview', 'deprecated'];
export const ADOPTION_VALUES = ['broad', 'moderate', 'low', 'unknown', 'new'];
export const RECENCY_WINDOW_DAYS = 60;

const num = (v) => typeof v === 'number' && Number.isFinite(v);
const FULL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Days between a model's own `released` date and the data snapshot's own `as_of` date (both
 * required to be a full YYYY-MM-DD date), or null when either isn't one — a partial date
 * (year-only "2026", month-only "2026-07", quarter "2026-Q1") or the literal string "unknown"
 * can't be checked against a day-level window without guessing, so null reads the same as "no
 * date on file": unknown recency, never 'new'. A negative result (released logged after as_of,
 * which shouldn't happen in real data but isn't this function's job to police) still counts as
 * "within the window" — see deriveAdoption. */
export function daysSinceRelease(released, asOf) {
  if (typeof released !== 'string' || !FULL_DATE_RE.test(released)) return null;
  if (typeof asOf !== 'string' || !FULL_DATE_RE.test(asOf)) return null;
  const releasedMs = Date.parse(`${released}T00:00:00Z`);
  const asOfMs = Date.parse(`${asOf}T00:00:00Z`);
  if (Number.isNaN(releasedMs) || Number.isNaN(asOfMs)) return null;
  return Math.round((asOfMs - releasedMs) / 86_400_000);
}

/** { status, reason } — reason is plain-English provenance, not stored on the model (the model's
 * own name/deprecated field IS the source), just for the refresh log. */
export function deriveStatus(model) {
  if (model.deprecated === true) return { status: 'deprecated', reason: 'model.deprecated is true (cited Judge deprecation)' };
  if (/\bpreview\b/i.test(model.name || '')) return { status: 'preview', reason: `model name "${model.name}" says so` };
  return { status: 'ga', reason: 'no preview/deprecated signal in the model\'s own name or deprecated flag' };
}

/** { adoption, share } — share is the raw number (or null) so a caller can cite it in a `why`.
 * `asOf` is the data snapshot's own as_of date (data/models.json's top-level `as_of`); omit it
 * (or pass anything that isn't a full YYYY-MM-DD date) to fall back to pure share-based bucketing
 * with no recency override at all — see daysSinceRelease. The recency override only ever rescues
 * an otherwise-'low'/'unknown' result into 'new'; a 'broad'/'moderate' share stands as-is (see the
 * file header for why). */
export function deriveAdoption(model, asOf) {
  const share = model.usage?.openrouter?.share;
  const known = num(share);
  const base = !known ? 'unknown' : share >= 2 ? 'broad' : share >= 0.5 ? 'moderate' : 'low';
  if (base === 'low' || base === 'unknown') {
    const days = daysSinceRelease(model?.released, asOf);
    if (days != null && days <= RECENCY_WINDOW_DAYS) return { adoption: 'new', share: known ? share : null };
  }
  return { adoption: base, share: known ? share : null };
}

/** Derive both for the whole catalog. Pure — does not mutate `models`. `asOf` is the data
 * snapshot's own as_of date, forwarded to deriveAdoption for the 60-day recency rule. Returns
 * Map<modelId, {status, adoption, share}>. */
export function deriveStatusAdoptionForCatalog(models, asOf) {
  const out = new Map();
  for (const m of models || []) {
    const { status } = deriveStatus(m);
    const { adoption, share } = deriveAdoption(m, asOf);
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

  const derived = deriveStatusAdoptionForCatalog(data.models, data.as_of);
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
