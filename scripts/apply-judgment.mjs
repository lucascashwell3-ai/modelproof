#!/usr/bin/env node
/* Applies Judge decisions to data/models.json. This is the ONLY writer the cloud Judge routine
   (scripts/refresh-judge.md) is allowed to use — it enforces the schema so the Judge can't write
   anything the honesty gate would reject, and it re-runs the gate itself as a second check.

   Input file: an array of judgments, each:
     { id, kind: "conflict"|"benchmark"|"ladder"|"new-model"|"release"|"guidance"|"deprecation"
              |"judged-fit"|"usage", field?, value, sources: [{url, date}], reason }
   A judgment may instead be a hold: { id, hold: true, reason } — recorded, nothing applied.

   Rules enforced here (reject the whole run on any violation — never apply half a judgments file):
     - field (when present) must be a field that actually exists on a model (top-level scalar or a
       known benchmark key) — no writing arbitrary keys into models.json.
     - numeric fields must carry a number, never a string or null.
     - sources[] must be non-empty and every url must be http(s).
     - reason must be >= 12 characters — "trust me" is not a citation.
     - judged-fit (v3, 2026-09): value {taskId, claims:[{sentence, source_url, tier, date, quote,
       polarity?}], reconciliation}. NO band, NO confidence — a v2 judgment carrying either field
       is rejected outright, naming the field, so a stale routine can't write the old shape back
       in. Same shape scripts/validate-data.mjs gates once written — see that file's
       BANNED_RELATIVE_PATTERNS/bannedPhraseIn/wordCount, imported here so the two never drift
       apart. Growth-only: an incoming record never overwrites one already on file with a newer
       as_of (applyOne no-ops in that case, doesn't error).
     - usage: value {category, share, rank}. Same growth-only rule.
   Before validation, normalizeJudgment() repairs what can be repaired without guessing, so one
   sloppy item does not cost the whole batch at the gate (2026-10-03 data contract): a new model's
   `released` "unknown" (or any form outside YYYY-MM-DD | YYYY-MM | YYYY-Qn | YYYY) -> null; a
   release entry's partial date -> first day of the period + `date_precision`, its missing
   `source` -> the judgment's first source url; a ladder's missing as_of/source -> the judgment's
   first source date/url; a release (or a new model's timeline entry) dated after today + 1 day
   (UTC) -> a hold with its reason, since the gate rejects a future date and one such item must not
   roll back the batch. What still fails validation rejects the run, as before.
   On success: writes data/models.json, appends data/changelog.json (with sources), removes the
   applied ids from data/refresh/worklist.json, runs the honesty gate, THEN (only when this run
   wrote at least one judged-fit claim) runs scripts/check-sources.mjs on the judged-fit records
   THIS run wrote (--only <modelId>/<taskId>,...) — the anti-fabrication gate that confirms every
   new quote is actually on its cited page. A quote elsewhere in the catalog that rotted since is
   not this run's doing and must not roll back an unrelated write; the scheduled full
   check-sources run reports those. On either gate's failure: restores the pre-write file content
   and exits 1 — nothing half-published, and a fabricated/misquoted citation can never reach main
   through this path.

   Usage:
     node scripts/apply-judgment.mjs <judgments.json> [--dry-run]
*/
import { isNotablePriceChange, priceEntry, retiredEntry, addEntry, normalizeReleased, releaseDateFor, normalizeEntryDate } from './timeline.mjs';
import { canonicalVendor, bareModelName, modelId as idFromName } from './naming.mjs';
import { TASK_IDS } from './derive-task-fit.mjs';
import { bannedPhraseIn, wordCount, CLAIM_TIERS, CLAIM_POLARITY_VALUES, citesLiveFeed, utcToday } from './validate-data.mjs';
import { deriveStatus, deriveAdoption, deriveStatusAdoptionForCatalog } from './derive-status-adoption.mjs';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../', import.meta.url);
const dataUrl = new URL('data/models.json', ROOT);
const changelogUrl = new URL('data/changelog.json', ROOT);
const worklistUrl = new URL('data/refresh/worklist.json', ROOT);
const receiptUrl = new URL('data/refresh/receipt-judge.json', ROOT);

const NUMERIC_MODEL_FIELDS = ['price_input', 'price_output', 'context_window', 'speed_tps'];
const BENCHMARK_FIELDS = ['swe_bench', 'gpqa', 'aime', 'mmlu_pro'];   // lmarena_elo dropped 2026-08-22
const RELEASE_FIELDS = ['date', 'vendor', 'title', 'summary', 'source', 'why'];
// same vocab as validate-data.mjs — a tag outside it fails the gate anyway; failing here is earlier and clearer
const BEST_FOR_VOCAB = ['reasoning', 'agentic', 'coding', 'research', 'long-context', 'writing', 'cheap-bulk', 'speed', 'vision'];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const DATE_PRECISION_VALUES = ['month', 'quarter', 'year'];

const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Repair what can be repaired without guessing, before validation. Returns {judgment, notes}:
 * a deep copy (the input is never mutated) and one plain line per repair, for the run log.
 * A release (or a new model's timeline entry) dated after `today` + 1 day (UTC) is turned into a
 * hold with its reason: the honesty gate rejects a future date, and one such item must not roll
 * back the rest of the batch. It comes back on a later run, once the date has come. */
export function normalizeJudgment(j, { today = utcToday() } = {}) {
  const notes = [];
  if (!j || typeof j !== 'object' || j.hold) return { judgment: j, notes };
  const out = JSON.parse(JSON.stringify(j));
  const first = Array.isArray(out.sources) && out.sources[0] && /^https?:\/\//i.test(out.sources[0].url || '') ? out.sources[0] : null;
  const v = out.value;
  if (out.kind === 'new-model' && v && typeof v === 'object' && 'released' in v) {
    const r = normalizeReleased(v.released);
    if (r !== v.released) { notes.push(`${out.id}: released "${v.released}" -> ${JSON.stringify(r)}`); v.released = r; }
  }
  if (out.kind === 'release' && v && typeof v === 'object') {
    if (!v.source && first) { v.source = first.url; notes.push(`${out.id}: release source filled from sources[0]`); }
    if (v.date != null && !DATE_RE.test(String(v.date))) {
      const d = normalizeEntryDate(v.date);
      if (d) {
        notes.push(`${out.id}: release date "${v.date}" -> "${d.date}"${d.date_precision ? ` (${d.date_precision} precision)` : ''}`);
        v.date = d.date;
        if (d.date_precision) v.date_precision = d.date_precision;
      }
    }
  }
  const latest = addDays(today, 1);
  const future = out.kind === 'release' && v && typeof v === 'object' && DATE_RE.test(String(v.date)) ? String(v.date)
    : out.kind === 'new-model' && v && typeof v === 'object' && v.released ? releaseDateFor(v.released, today).date : null;
  if (future && future > latest) {
    const reason = `${out.kind === 'release' ? 'release' : 'new model\'s release'} dated ${future}, after ${latest} (today ${today} UTC + 1 day); held until that date comes`;
    notes.push(`${out.id}: ${reason}`);
    return { judgment: { id: out.id, hold: true, reason }, notes };
  }
  if (out.kind === 'ladder' && v && typeof v === 'object' && first) {
    if (!v.as_of && first.date && DATE_RE.test(first.date)) { v.as_of = first.date; notes.push(`${out.id}: ladder as_of filled from sources[0].date`); }
    if (!v.source) { v.source = first.url; notes.push(`${out.id}: ladder source filled from sources[0].url`); }
  }
  return { judgment: out, notes };
}

/** Validate one judgment. Returns an array of error strings (empty = valid). */
export function validateJudgment(j) {
  const errs = [];
  if (!j || typeof j !== 'object') return ['judgment is not an object'];
  if (!j.id) errs.push('missing id');
  if (j.hold) {
    if (!j.reason || j.reason.length < 12) errs.push(`${j.id}: hold reason must be >= 12 chars`);
    return errs;
  }
  if (!j.kind || !['conflict', 'benchmark', 'ladder', 'new-model', 'release', 'guidance', 'deprecation', 'judged-fit', 'usage'].includes(j.kind)) {
    errs.push(`${j.id}: bad or missing kind "${j.kind}"`);
  }
  if (!j.reason || j.reason.length < 12) errs.push(`${j.id}: reason must be >= 12 chars ("${j.reason || ''}")`);
  if (!Array.isArray(j.sources) || !j.sources.length) {
    errs.push(`${j.id}: sources[] must be non-empty`);
  } else {
    for (const s of j.sources) {
      if (!s || !/^https?:\/\//i.test(s.url || '')) errs.push(`${j.id}: source url "${s?.url}" is not http(s)`);
      if (!s?.date) errs.push(`${j.id}: source missing date`);
    }
  }
  if (j.kind === 'conflict' || j.kind === 'benchmark') {
    if (!j.field) { errs.push(`${j.id}: ${j.kind} judgment needs field`); return errs; }
    const isBenchmark = BENCHMARK_FIELDS.includes(j.field);
    const isModelField = NUMERIC_MODEL_FIELDS.includes(j.field);
    if (!isBenchmark && !isModelField) errs.push(`${j.id}: field "${j.field}" does not exist on a model — refusing to write an unknown key`);
    if (typeof j.value !== 'number' || Number.isNaN(j.value)) errs.push(`${j.id}: field "${j.field}" is numeric but value is "${j.value}" (${typeof j.value})`);
  } else if (j.kind === 'release') {
    if (!j.value || typeof j.value !== 'object') { errs.push(`${j.id}: release judgment needs value{}`); return errs; }
    for (const f of RELEASE_FIELDS) if (!j.value[f]) errs.push(`${j.id}: release value missing "${f}"`);
    if (j.value.kind != null && !['model', 'price', 'retired'].includes(j.value.kind)) errs.push(`${j.id}: release kind must be model | price | retired`);
    if (j.value.date && !DATE_RE.test(String(j.value.date))) errs.push(`${j.id}: release date "${j.value.date}" must be YYYY-MM-DD (a partial date YYYY-MM / YYYY-Qn / YYYY is normalized first)`);
    if (j.value.date_precision != null && !DATE_PRECISION_VALUES.includes(j.value.date_precision)) errs.push(`${j.id}: release date_precision must be one of ${DATE_PRECISION_VALUES.join(', ')}`);
    if (j.value.source && !/^https?:\/\//i.test(j.value.source)) errs.push(`${j.id}: release source must be http(s)`);
  } else if (j.kind === 'new-model') {
    if (!j.value || typeof j.value !== 'object') { errs.push(`${j.id}: new-model judgment needs value{}`); return errs; }
    // id is derived from name (scripts/naming.mjs) — a supplied one is ignored, so only name + vendor are required
    for (const f of ['name', 'vendor']) if (!j.value[f]) errs.push(`${j.id}: new-model value missing "${f}"`);
    if (j.value.released != null && normalizeReleased(j.value.released) !== j.value.released) errs.push(`${j.id}: new-model released "${j.value.released}" must be YYYY-MM-DD, YYYY-MM, YYYY-Qn, YYYY or null`);
    if (j.value.release != null) {
      const r = j.value.release;
      if (typeof r !== 'object') errs.push(`${j.id}: release must be an object {summary, why, source?}`);
      else for (const f of ['summary', 'why', 'source']) if (r[f] != null && typeof r[f] !== 'string') errs.push(`${j.id}: release.${f} must be a string`);
      if (r && r.source && !/^https?:\/\//i.test(r.source)) errs.push(`${j.id}: release.source must be http(s)`);
    }
    for (const f of NUMERIC_MODEL_FIELDS) {
      if (j.value[f] != null && (typeof j.value[f] !== 'number' || Number.isNaN(j.value[f]))) {
        errs.push(`${j.id}: new-model field "${f}" is numeric but value is "${j.value[f]}"`);
      }
    }
  } else if (j.kind === 'deprecation') {
    // value must be literally true — "is it retired?" answered yes, with the vendor page in sources
    if (j.value !== true) errs.push(`${j.id}: deprecation value must be true (to decline, hold instead)`);
  } else if (j.kind === 'guidance') {
    // value: { best_for: [vocab…], use_well: [2–4 plain sentences], strengths?: [...] }
    const v = j.value;
    if (!v || typeof v !== 'object') { errs.push(`${j.id}: guidance value must be an object`); return errs; }
    if (!Array.isArray(v.best_for) || !v.best_for.length) errs.push(`${j.id}: guidance needs best_for[]`);
    else for (const t of v.best_for) if (!BEST_FOR_VOCAB.includes(t)) errs.push(`${j.id}: best_for tag "${t}" not in vocab`);
    if (!Array.isArray(v.use_well) || v.use_well.length < 2 || v.use_well.length > 4) errs.push(`${j.id}: use_well needs 2–4 tips`);
    else for (const t of v.use_well) if (typeof t !== 'string' || t.length < 20 || t.length > 240) errs.push(`${j.id}: use_well tip must be 20–240 chars`);
    if (v.strengths != null && (!Array.isArray(v.strengths) || v.strengths.some((t) => typeof t !== 'string'))) errs.push(`${j.id}: strengths must be string[]`);
    for (const k of Object.keys(v)) if (!['best_for', 'use_well', 'strengths'].includes(k)) errs.push(`${j.id}: guidance can't set "${k}"`);
  } else if (j.kind === 'judged-fit') {
    // value (v3): { taskId, claims:[{sentence, source_url, tier, date, quote, polarity?}], reconciliation? }
    // NO band, NO confidence — v3 (2026-09) removed both from the schema (scripts/migrate-judged-v3.mjs);
    // a v2 judgment carrying either is rejected below, naming the field, so the old AI-judged
    // grade can't reach data/models.json again. Same shape scripts/validate-data.mjs gates once
    // written (CLAIM_TIERS/CLAIM_POLARITY_VALUES/bannedPhraseIn/wordCount all imported from
    // there) — failing here is earlier and clearer, exactly like BEST_FOR_VOCAB above mirrors
    // validate-data.mjs's own vocab.
    const v = j.value;
    if (!v || typeof v !== 'object') { errs.push(`${j.id}: judged-fit value must be an object`); return errs; }
    if (!TASK_IDS.includes(v.taskId)) errs.push(`${j.id}: judged-fit taskId "${v.taskId}" must be one of ${TASK_IDS.join(', ')}`);
    if (Object.prototype.hasOwnProperty.call(v, 'band')) errs.push(`${j.id}: judged-fit value has "band" — v3 removed band from the schema; submit claims[] instead`);
    if (Object.prototype.hasOwnProperty.call(v, 'confidence')) errs.push(`${j.id}: judged-fit value has "confidence" — v3 removed confidence from the schema; submit claims[] instead`);
    if (v.reconciliation != null) {
      if (typeof v.reconciliation !== 'string') errs.push(`${j.id}: judged-fit reconciliation must be a string or null`);
      else {
        const hit = bannedPhraseIn(v.reconciliation);
        if (hit) errs.push(`${j.id}: judged-fit reconciliation uses a banned relative phrase (/${hit}/) — statements must be absolute and dated`);
      }
    }
    if (!Array.isArray(v.claims) || !v.claims.length) errs.push(`${j.id}: judged-fit needs a non-empty claims[]`);
    else v.claims.forEach((c, i) => {
      const cl = `${j.id}: judged-fit claims[${i}]`;
      if (!c || typeof c !== 'object') { errs.push(`${cl} must be an object`); return; }
      if (!c.sentence || typeof c.sentence !== 'string') errs.push(`${cl}.sentence is required`);
      else {
        const hit = bannedPhraseIn(c.sentence);
        if (hit) errs.push(`${cl}.sentence uses a banned relative phrase (/${hit}/) — write an absolute, dated fact instead`);
      }
      if (!c.source_url || !/^https?:\/\//i.test(c.source_url)) errs.push(`${cl}.source_url must be http(s)`);
      // 2026-09 migrations (scripts/migrate-claims-2026-09.mjs) removed every claim citing
      // OpenRouter's rankings API, arena.ai, or artificialanalysis.ai — the first two are live
      // feeds this codebase already re-derives daily into model.standings, so a claim quoting
      // them can never stay verified by scripts/check-sources.mjs; artificialanalysis.ai's own
      // terms ban displaying its content outside a paid tier (data/testers.json's own
      // "Display-BANNED" ruling). Reject a new one here, at submission time, so the Judge routine
      // can't reintroduce what those migrations removed.
      else if (citesLiveFeed(c.source_url)) errs.push(`${cl}.source_url cites a live feed or a display-banned source (OpenRouter rankings/arena.ai/artificialanalysis.ai) that can never stay verified — cite the standings record instead (model.standings[taskId] already carries the OpenRouter/arena.ai evidence, dated and linked), or a stable, display-permitted page`);
      if (!CLAIM_TIERS.includes(c.tier)) errs.push(`${cl}.tier must be one of ${CLAIM_TIERS.join(', ')}`);
      if (!c.date) errs.push(`${cl}.date is required`);
      if (!c.quote || typeof c.quote !== 'string') errs.push(`${cl}.quote is required (verbatim from source_url)`);
      else if (wordCount(c.quote) > 25) errs.push(`${cl}.quote is ${wordCount(c.quote)} word(s) — must be ≤25`);
      if (c.polarity != null && !CLAIM_POLARITY_VALUES.includes(c.polarity)) errs.push(`${cl}.polarity must be one of ${CLAIM_POLARITY_VALUES.join(', ')}`);
    });
  } else if (j.kind === 'usage') {
    // value: { category, share (0-100), rank (>=1) } — usage.openrouter on the matching model.
    const v = j.value;
    if (!v || typeof v !== 'object') { errs.push(`${j.id}: usage value must be an object`); return errs; }
    if (!v.category || typeof v.category !== 'string') errs.push(`${j.id}: usage.category is required`);
    if (typeof v.share !== 'number' || Number.isNaN(v.share) || v.share < 0 || v.share > 100) errs.push(`${j.id}: usage.share must be 0-100`);
    if (!Number.isInteger(v.rank) || v.rank < 1) errs.push(`${j.id}: usage.rank must be a positive integer`);
  } else if (j.kind === 'ladder') {
    const v = j.value;
    if (!v || typeof v !== 'object' || !Array.isArray(v.series) || !v.series.length) {
      errs.push(`${j.id}: ladder judgment needs value{series:[...]}`);
    } else {
      // the same provenance the honesty gate demands, checked here so a thin ladder fails before anything is written
      for (const f of ['id', 'suite', 'task', 'as_of', 'publisher', 'source_kind', 'source', 'confidence', 'method', 'caveat', 'levels']) {
        if (!v[f]) errs.push(`${j.id}: ladder value missing "${f}"`);
      }
      if (v.method && !/read off|digitis|digitiz|exact|stated/i.test(v.method)) errs.push(`${j.id}: ladder method must say how the numbers were obtained (exact/stated vs read off a chart)`);
      for (const s of v.series) {
        if (!s.model_id || !s.label) errs.push(`${j.id}: every series needs model_id + label`);
        if (!Array.isArray(s.points) || s.points.length < 3) errs.push(`${j.id}: series "${s.label || s.model_id}" needs ≥3 points — a ladder is several effort settings, not a pair`);
        for (const p of s.points || []) {
          if (typeof p.cost !== 'number' || typeof p.score !== 'number' || !(p.cost > 0)) errs.push(`${j.id}: point "${p.effort}" on ${s.label} needs numeric cost (> 0) and score`);
          if (Array.isArray(v.levels) && !v.levels.includes(p.effort)) errs.push(`${j.id}: point effort "${p.effort}" not in levels[]`);
        }
      }
    }
  }
  return errs;
}

/** Apply one already-validated judgment to `data` (mutates). Returns a changelog entry or null (hold). */
export function applyOne(data, j, today) {
  if (j.hold) return null;
  const modelId = String(j.id).split(':')[0].replace(/^new:/, '');
  if (j.kind === 'conflict' || j.kind === 'benchmark') {
    const m = data.models.find((x) => x.id === modelId);
    if (!m) throw new Error(`${j.id}: no model with id "${modelId}"`);
    const old = BENCHMARK_FIELDS.includes(j.field) ? m.benchmarks?.[j.field] : m[j.field];
    if (BENCHMARK_FIELDS.includes(j.field)) { m.benchmarks = m.benchmarks || {}; m.benchmarks[j.field] = j.value; }
    else m[j.field] = j.value;
    m.sources = Array.from(new Set([...(m.sources || []), ...j.sources.map((s) => s.url)]));
    if ((j.field === 'price_input' || j.field === 'price_output') && isNotablePriceChange(old, j.value)) {
      addEntry(data, priceEntry(m, j.field === 'price_input' ? 'input' : 'output', old, j.value, j.sources[0].url, today));
    }
    return { date: today, model: m.name, field: j.field, old, new: j.value, sources: j.sources.map((s) => s.url), reason: j.reason };
  }
  if (j.kind === 'deprecation') {
    const m = data.models.find((x) => x.id === modelId);
    if (!m) throw new Error(`${j.id}: no model with id "${modelId}"`);
    const old = !!m.deprecated;
    m.deprecated = true;
    m.status = deriveStatus(m).status;
    m.sources = Array.from(new Set([...(m.sources || []), ...j.sources.map((s) => s.url)]));
    addEntry(data, retiredEntry(m, j.sources[0].url, today, j.reason));
    return { date: today, model: m.name, field: 'deprecated', old, new: true, sources: j.sources.map((s) => s.url), reason: j.reason };
  }
  if (j.kind === 'release') {
    data.releases = data.releases || [];
    data.releases.push({ kind: 'model', ...j.value });   // a Judge-written entry defaults to the new-model view unless it says otherwise
    return { date: today, model: j.value.vendor, field: 'release', old: null, new: j.value.title, sources: j.sources.map((s) => s.url), reason: j.reason };
  }
  if (j.kind === 'new-model') {
    // The naming rule (scripts/naming.mjs): canonical vendor spelling, the model's own name with no
    // "Vendor: " label, id derived from that name. A vendor not in VENDORS passes through as written
    // and the honesty gate rejects the run, naming the file to add it to — nothing is guessed here.
    const vendor = canonicalVendor(j.value.vendor) || j.value.vendor;
    const name = bareModelName(j.value.name, vendor);
    const id = idFromName(name);
    if (data.models.some((m) => m.id === id)) throw new Error(`${j.id}: model id "${id}" already exists`);
    const nm = {
      benchmarks: { swe_bench: null, gpqa: null, aime: null, mmlu_pro: null },
      best_for: [], strengths: [], weaknesses: [], verdict: null, confidence: 'low',
      coding_score: null, coding_basis: null, coding_confidence: 'low', use_well: [], task_copy: {},
      task_fit_judged: null, usage: { openrouter: null },
      ...j.value,
      id, name, vendor,
      sources: Array.from(new Set([...(j.value.sources || []), ...j.sources.map((s) => s.url)])),
    };
    if ('released' in nm) nm.released = normalizeReleased(nm.released);
    nm.status = deriveStatus(nm).status;
    nm.adoption = deriveAdoption(nm, data.as_of).adoption;
    data.models.push(nm);
    // every admitted model gets a timeline entry (2026-08-22: Judge-admitted models used to skip
    // the timeline — Grok 4.6 and Gemini 3.7 Flash were in the catalog with no "what changed" line).
    // The Judge may supply value.release {summary, why}; otherwise a plain factual stub, never prose we invented.
    data.releases = data.releases || [];
    const title = `${nm.vendor} releases ${nm.name}`;
    if (!data.releases.some((r) => r.title === title)) {
      const rel = j.value.release || {};
      const when = releaseDateFor(nm.released, today);
      data.releases.push({
        kind: 'model',
        date: when.date,
        ...(when.date_precision ? { date_precision: when.date_precision } : {}),
        vendor: nm.vendor,
        title,
        summary: rel.summary || `Added after Judge verification — ${j.reason}`,
        source: rel.source || j.sources[0].url,
        why: rel.why || 'New listing — pricing sourced; check back once benchmarks and usage guidance land.',
      });
    }
    delete nm.release;
    return { date: today, model: nm.name, field: 'added', old: null, new: 'new model (judged)', sources: nm.sources, reason: j.reason };
  }
  if (j.kind === 'guidance') {
    // growth-only: fills empty fields, never overwrites guidance a human or earlier Judge wrote
    const m = data.models.find((x) => x.id === modelId);
    if (!m) throw new Error(`${j.id}: no model with id "${modelId}"`);
    const filled = [];
    for (const f of ['best_for', 'use_well', 'strengths']) {
      if (j.value[f] && !(m[f] || []).length) { m[f] = j.value[f]; filled.push(f); }
    }
    if (!filled.length) return null;   // nothing was empty — a no-op, not an overwrite
    m.sources = Array.from(new Set([...(m.sources || []), ...j.sources.map((s) => s.url)]));
    return { date: today, model: m.name, field: filled.join('+'), old: null, new: 'usage guidance', sources: j.sources.map((s) => s.url), reason: j.reason };
  }
  if (j.kind === 'judged-fit') {
    // growth-only: an incoming record never overwrites one already on file with a NEWER as_of —
    // a re-judge (same-vendor successor rule, scripts/refresh-judge.md) always carries today's
    // date, so this only ever blocks a genuinely out-of-order/backdated write, never normal use.
    const m = data.models.find((x) => x.id === modelId);
    if (!m) throw new Error(`${j.id}: no model with id "${modelId}"`);
    const { taskId, claims, reconciliation } = j.value;
    const existing = m.task_fit_judged && m.task_fit_judged[taskId];
    if (existing && existing.as_of && existing.as_of > today) return null; // a newer record already on file — no-op
    m.task_fit_judged = m.task_fit_judged || {};
    m.task_fit_judged[taskId] = { claims, reconciliation: reconciliation ?? null, as_of: today };
    m.sources = Array.from(new Set([...(m.sources || []), ...j.sources.map((s) => s.url)]));
    return { date: today, model: m.name, field: `task_fit_judged.${taskId}`, old: existing ? `${existing.claims.length} claim(s) as of ${existing.as_of}` : null, new: `${claims.length} claim(s)`, sources: j.sources.map((s) => s.url), reason: j.reason };
  }
  if (j.kind === 'usage') {
    // growth-only, same as judged-fit above.
    const m = data.models.find((x) => x.id === modelId);
    if (!m) throw new Error(`${j.id}: no model with id "${modelId}"`);
    const existing = m.usage && m.usage.openrouter;
    if (existing && existing.as_of && existing.as_of > today) return null;
    m.usage = m.usage || { openrouter: null };
    m.usage.openrouter = { category: j.value.category, share: j.value.share, rank: j.value.rank, as_of: today, source_url: j.sources[0].url };
    m.adoption = deriveAdoption(m, data.as_of).adoption;
    m.sources = Array.from(new Set([...(m.sources || []), ...j.sources.map((s) => s.url)]));
    return { date: today, model: m.name, field: 'usage.openrouter', old: existing ? existing.rank : null, new: j.value.rank, sources: j.sources.map((s) => s.url), reason: j.reason };
  }
  if (j.kind === 'ladder') {
    data.effort_ladders = data.effort_ladders || [];
    for (const s of j.value.series) if (!data.models.some((m) => m.id === s.model_id)) throw new Error(`${j.id}: series "${s.label}" points at unknown model_id "${s.model_id}"`);
    const existing = data.effort_ladders.find((L) => L.id === j.value.id);
    // a ladder fed from a machine-readable export (series carry source_key) is Collect's — a chart-read
    // judgment must never overwrite exact values with estimates
    if (existing && existing.series.some((s) => s.source_key)) throw new Error(`${j.id}: ladder "${existing.id}" is feed-maintained (source_key) — not writable by a judgment`);
    if (existing) Object.assign(existing, j.value);
    else data.effort_ladders.push(j.value);
    return { date: today, model: j.value.id, field: 'ladder', old: null, new: 'ladder updated', sources: j.sources.map((s) => s.url), reason: j.reason };
  }
  throw new Error(`${j.id}: unknown kind "${j.kind}"`);
}

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== '--dry-run');
  const dryRun = process.argv.includes('--dry-run');
  const file = args[0];
  if (!file) {
    console.error('usage: node scripts/apply-judgment.mjs <judgments.json> [--dry-run]');
    process.exitCode = 1;
    return;
  }
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(raw)) throw new Error('judgments file must be a JSON array');
  // MODELPROOF_TODAY: test-only override so a date-boundary case (e.g. a model aging out of the
  // 60-day "new" adoption window) can be pinned instead of depending on the real clock. Unset in
  // every real run — falls straight through to the real date.
  const today = process.env.MODELPROOF_TODAY || utcToday();
  const judgments = raw.map((j) => {
    const { judgment, notes } = normalizeJudgment(j, { today });
    notes.forEach((n) => console.log(`normalized ${n}`));
    return judgment;
  });

  const allErrors = [];
  for (const j of judgments) allErrors.push(...validateJudgment(j));
  if (allErrors.length) {
    console.error(`✗ ${allErrors.length} schema error(s) — nothing applied:`);
    allErrors.forEach((e) => console.error('  - ' + e));
    process.exitCode = 1;
    return;
  }

  const originalText = readFileSync(dataUrl, 'utf8');
  const data = JSON.parse(originalText);
  const changelog = existsSync(changelogUrl) ? JSON.parse(readFileSync(changelogUrl)) : [];
  const applied = [];
  const judgedKeys = [];   // "<modelId>/<taskId>" of every judged-fit record this run wrote
  const held = judgments.filter((j) => j.hold);
  for (const j of judgments) {
    if (j.hold) continue;
    const entry = applyOne(data, j, today);
    if (entry) applied.push(entry);
    if (entry && j.kind === 'judged-fit') judgedKeys.push(`${String(j.id).split(':')[0]}/${j.value.taskId}`);
  }
  if (applied.length) data.as_of = today;

  // Date-dependent fields (status/adoption, scripts/derive-status-adoption.mjs) must match what
  // the honesty gate below recomputes for the NEW as_of — a judgment that touches one model (say,
  // a price conflict) still bumps the catalog-wide as_of, and any OTHER model that happens to age
  // out of the 60-day "new" adoption window on that exact date would otherwise fail the gate for
  // a value this script never re-derived. Re-run over the whole catalog before the gate, same as
  // scripts/auto-refresh.mjs already does on every full pass.
  if (applied.length) {
    const statusAdoption = deriveStatusAdoptionForCatalog(data.models, data.as_of);
    for (const m of data.models) {
      const next = statusAdoption.get(m.id);
      if (!next) continue;
      if (m.status !== next.status) console.log(`status re-derived: ${m.id} ${m.status} -> ${next.status}`);
      if (m.adoption !== next.adoption) console.log(`adoption re-derived: ${m.id} ${m.adoption} -> ${next.adoption}`);
      m.status = next.status;
      m.adoption = next.adoption;
    }
  }

  changelog.push(...applied.map(({ reason, ...c }) => c));

  console.log(`\n=== apply-judgment report (${dryRun ? 'DRY RUN' : 'LIVE'}) ===`);
  console.log(`applied: ${applied.length}  held: ${held.length}`);
  applied.forEach((a) => console.log(`  ${a.model} / ${a.field}: ${a.old} -> ${a.new} [${a.sources.join('+')}]`));
  held.forEach((h) => console.log(`  HELD ${h.id}: ${h.reason}`));

  if (dryRun) return;
  if (!applied.length) { console.log('nothing to apply — worklist/data unchanged.'); return; }

  // changelog.json is deliberately NOT written yet — only data/models.json, which both gates
  // below check and restore on failure. Writing the changelog here too (as a prior version of
  // this script did) left a stale, permanent entry behind every time a gate failed: the entry
  // describes a change that never actually published. It's written once, after both gates pass,
  // alongside the rest of the "everything succeeded" bookkeeping.
  writeFileSync(dataUrl, JSON.stringify(data, null, 2) + '\n');

  const { execFileSync } = await import('node:child_process');
  let gateOk = true;
  try {
    execFileSync('node', [fileURLToPath(new URL('scripts/validate-data.mjs', ROOT))], { stdio: 'inherit' });
  } catch {
    gateOk = false;
  }
  if (!gateOk) {
    writeFileSync(dataUrl, originalText); // restore — nothing half-published
    console.error('honesty gate failed — restored data/models.json, nothing published.');
    writeFileSync(receiptUrl, JSON.stringify({
      job: 'judge', ran_at: new Date().toISOString(), applied: 0, held: held.length, ok: false, error: 'honesty gate failed',
    }, null, 2) + '\n');
    process.exitCode = 1;
    return;
  }

  // Anti-fabrication gate (scripts/check-sources.mjs): only when this run actually wrote a
  // judged-fit claim — a live network fetch per source_url on every ordinary price-conflict
  // apply would be needless network I/O for nothing this run touched. Scoped to the records this
  // run wrote (--only): a quote elsewhere in the catalog whose page changed since is not this
  // run's doing, and blocking on it would roll back every Judge write until a person re-quoted
  // an unrelated claim. The scheduled full check-sources run reports catalog-wide rot.
  if (judgedKeys.length) {
    console.log(`\nrunning the anti-fabrication gate (scripts/check-sources.mjs) on the ${judgedKeys.length} judged-fit record(s) this run wrote...`);
    let sourcesOk = true;
    try {
      execFileSync('node', [fileURLToPath(new URL('scripts/check-sources.mjs', ROOT)), '--only', judgedKeys.join(',')], { stdio: 'inherit' });
    } catch {
      sourcesOk = false;
    }
    if (!sourcesOk) {
      writeFileSync(dataUrl, originalText); // restore — a fabricated/misquoted citation must never publish
      console.error('check-sources.mjs failed — restored data/models.json, nothing published.');
      writeFileSync(receiptUrl, JSON.stringify({
        job: 'judge', ran_at: new Date().toISOString(), applied: 0, held: held.length, ok: false, error: 'check-sources gate failed',
      }, null, 2) + '\n');
      process.exitCode = 1;
      return;
    }
  }

  // Both gates passed — now it's real. Write the changelog (see the comment above data's own
  // write for why this happens here and not earlier).
  writeFileSync(changelogUrl, JSON.stringify(changelog, null, 2) + '\n');

  // remove applied ids from worklist.json
  if (existsSync(worklistUrl)) {
    const worklist = JSON.parse(readFileSync(worklistUrl));
    const appliedIds = new Set(judgments.filter((j) => !j.hold).map((j) => j.id));
    worklist.items = (worklist.items || []).filter((i) => !appliedIds.has(i.id));
    writeFileSync(worklistUrl, JSON.stringify(worklist, null, 2) + '\n');
  }

  writeFileSync(receiptUrl, JSON.stringify({
    job: 'judge', ran_at: new Date().toISOString(), applied: applied.length, held: held.length, ok: true,
  }, null, 2) + '\n');
}

import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(resolve(process.argv[1]));
if (isMain) {
  main().catch((e) => { console.error(e); process.exitCode = 1; });
}
