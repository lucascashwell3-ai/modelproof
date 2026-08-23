#!/usr/bin/env node
/* Applies Judge decisions to data/models.json. This is the ONLY writer the cloud Judge routine
   (scripts/refresh-judge.md) is allowed to use — it enforces the schema so the Judge can't write
   anything the honesty gate would reject, and it re-runs the gate itself as a second check.

   Input file: an array of judgments, each:
     { id, kind: "conflict"|"benchmark"|"ladder"|"new-model"|"release", field?, value, sources: [{url, date}], reason }
   A judgment may instead be a hold: { id, hold: true, reason } — recorded, nothing applied.

   Rules enforced here (reject the whole run on any violation — never apply half a judgments file):
     - field (when present) must be a field that actually exists on a model (top-level scalar or a
       known benchmark key) — no writing arbitrary keys into models.json.
     - numeric fields must carry a number, never a string or null.
     - sources[] must be non-empty and every url must be http(s).
     - reason must be >= 12 characters — "trust me" is not a citation.
   On success: writes data/models.json, appends data/changelog.json (with sources), removes the
   applied ids from data/refresh/worklist.json, runs the honesty gate. On gate failure: restores
   the pre-write file content and exits 1 — nothing half-published.

   Usage:
     node scripts/apply-judgment.mjs <judgments.json> [--dry-run]
*/
import { isNotablePriceChange, priceEntry, retiredEntry, addEntry } from './timeline.mjs';
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

/** Validate one judgment. Returns an array of error strings (empty = valid). */
export function validateJudgment(j) {
  const errs = [];
  if (!j || typeof j !== 'object') return ['judgment is not an object'];
  if (!j.id) errs.push('missing id');
  if (j.hold) {
    if (!j.reason || j.reason.length < 12) errs.push(`${j.id}: hold reason must be >= 12 chars`);
    return errs;
  }
  if (!j.kind || !['conflict', 'benchmark', 'ladder', 'new-model', 'release', 'guidance', 'deprecation'].includes(j.kind)) {
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
  } else if (j.kind === 'new-model') {
    if (!j.value || typeof j.value !== 'object') { errs.push(`${j.id}: new-model judgment needs value{}`); return errs; }
    for (const f of ['id', 'name', 'vendor']) if (!j.value[f]) errs.push(`${j.id}: new-model value missing "${f}"`);
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
    if (data.models.some((m) => m.id === j.value.id)) throw new Error(`${j.id}: model id "${j.value.id}" already exists`);
    const nm = {
      benchmarks: { swe_bench: null, gpqa: null, aime: null, mmlu_pro: null },
      best_for: [], strengths: [], weaknesses: [], verdict: null, confidence: 'low',
      coding_score: null, coding_basis: null, coding_confidence: 'low', use_well: [], task_copy: {},
      ...j.value,
      sources: Array.from(new Set([...(j.value.sources || []), ...j.sources.map((s) => s.url)])),
    };
    data.models.push(nm);
    // every admitted model gets a timeline entry (2026-08-22: Judge-admitted models used to skip
    // the timeline — Grok 4.6 and Gemini 3.7 Flash were in the catalog with no "what changed" line).
    // The Judge may supply value.release {summary, why}; otherwise a plain factual stub, never prose we invented.
    data.releases = data.releases || [];
    const title = `${nm.vendor} releases ${nm.name}`;
    if (!data.releases.some((r) => r.title === title)) {
      const rel = j.value.release || {};
      data.releases.push({
        kind: 'model',
        date: nm.released ? String(nm.released).slice(0, 10) : today,
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
  const judgments = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(judgments)) throw new Error('judgments file must be a JSON array');

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
  const today = new Date().toISOString().slice(0, 10);

  const applied = [];
  const held = judgments.filter((j) => j.hold);
  for (const j of judgments) {
    if (j.hold) continue;
    const entry = applyOne(data, j, today);
    if (entry) applied.push(entry);
  }
  if (applied.length) data.as_of = today;
  changelog.push(...applied.map(({ reason, ...c }) => c));

  console.log(`\n=== apply-judgment report (${dryRun ? 'DRY RUN' : 'LIVE'}) ===`);
  console.log(`applied: ${applied.length}  held: ${held.length}`);
  applied.forEach((a) => console.log(`  ${a.model} / ${a.field}: ${a.old} -> ${a.new} [${a.sources.join('+')}]`));
  held.forEach((h) => console.log(`  HELD ${h.id}: ${h.reason}`));

  if (dryRun) return;
  if (!applied.length) { console.log('nothing to apply — worklist/data unchanged.'); return; }

  writeFileSync(dataUrl, JSON.stringify(data, null, 2) + '\n');
  writeFileSync(changelogUrl, JSON.stringify(changelog, null, 2) + '\n');

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
