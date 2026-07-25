#!/usr/bin/env node
/* Epoch AI collector — Tier A, CC-BY.

   PROPOSES, never writes. It downloads Epoch's published benchmark export, maps rows onto the
   models we already list, and prints what it found alongside what we currently hold. Nothing here
   edits data/models.json. That is the whole design: the machine removes the searching, a human
   does the vouching (scripts/data-sources.md).

   Two jobs:
     1. Effort ladders  — CursorBench rows carry one entry per reasoning level WITH a real measured
                          cost per task, which is the only honest way to build a cost/score curve.
     2. Benchmark backfill — for every benchmark cell we hold as null, report whether Epoch has now
                          published an independently-run number for it.

   Usage:  node scripts/collect-epoch.mjs [--json]
   Behind a proxy:  NODE_USE_ENV_PROXY=1 node scripts/collect-epoch.mjs
*/
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REGISTRY = JSON.parse(readFileSync(new URL('./sources.json', import.meta.url)));
const SRC = REGISTRY.sources.find((s) => s.id === 'epoch-ai');
const data = JSON.parse(readFileSync(new URL('../data/models.json', import.meta.url)));
const asJson = process.argv.includes('--json');

// Guard the tier rule at the point of ingestion, not just in review: a collector must never be
// pointed at a source we are only allowed to cite.
if (SRC.tier !== 'A' || !SRC.redistributable) {
  console.error(`refusing to ingest ${SRC.id}: tier ${SRC.tier}, redistributable=${SRC.redistributable}`);
  process.exit(1);
}

// --- fetch + unzip -----------------------------------------------------------------------------
async function fetchExport() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 60000);
  const res = await fetch(SRC.endpoint, { signal: ctrl.signal });
  clearTimeout(t);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${SRC.endpoint}`);
  const dir = mkdtempSync(join(tmpdir(), 'epoch-'));
  const zip = join(dir, 'benchmark_data.zip');
  writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  execFileSync('unzip', ['-qo', zip, '-d', dir]);
  return dir;
}

// Minimal RFC-4180 CSV reader. Epoch's export embeds newlines and commas inside quoted notes
// fields, so splitting on commas silently corrupts rows — hence a real parser rather than a regex.
function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const head = rows.shift();
  return rows.filter((r) => r.length > 1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

// --- mapping Epoch's model identifiers onto ours -----------------------------------------------
// Epoch keys on strings like "claude-opus-5_max" / "gpt-5.6-sol_xhigh". We match on the part before
// the underscore so a model matches regardless of which effort rung the row describes.
const LEVELS = { low: 'low', medium: 'medium', high: 'high', 'extra high': 'xhigh', xhigh: 'xhigh', max: 'max' };
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

function baseVersion(v) { return slug(String(v || '').split('_')[0]); }

function matchModel(epochVersion, displayName) {
  const base = baseVersion(epochVersion);
  const disp = slug(displayName).replace(/-(low|medium|high|extra-high|xhigh|max)$/, '');
  for (const m of data.models) {
    const id = slug(m.id), name = slug(m.name).replace(/^claude-/, '');
    if (base === id || base === slug(m.name)) return m;
    if (disp && (disp === id || disp === name)) return m;
    // "claude-opus-4-8" vs Epoch's "claude-opus-4-8"; also bare "opus-5" against our "claude-opus-5"
    if (base && (id.endsWith(base) || base.endsWith(id))) return m;
  }
  return null;
}

// --- job 1: effort ladders ----------------------------------------------------------------------
function collectLadder(rows) {
  const order = ['low', 'medium', 'high', 'xhigh', 'max'];
  const byModel = new Map();
  const skipped = [];
  for (const r of rows) {
    // The rung comes from the reasoning-level column, NOT the model-version string: Epoch's export
    // currently repeats "claude-opus-5_max" on all three Opus 5 rows, so trusting the version field
    // would collapse three rungs into one and invent a curve that does not exist.
    const lvl = LEVELS[String(r['Reasoning level'] || '').trim().toLowerCase()];
    const cost = parseFloat(r['Cost per task']);
    const score = parseFloat(r['Score']);
    const label = r['Name'] || r['Model version'];
    if (!lvl) { skipped.push(`${label}: no reasoning level (single-setting entry — cannot be a rung)`); continue; }
    if (!isFinite(cost) || !isFinite(score)) { skipped.push(`${label} @ ${lvl}: missing cost or score — dropped, never interpolated`); continue; }
    const m = matchModel(r['Model version'], r['Name']);
    if (!m) { skipped.push(`${label}: no model in models.json matches "${r['Model version']}"`); continue; }
    if (!byModel.has(m.id)) byModel.set(m.id, { model_id: m.id, label: m.name.replace(/^Claude /, ''), points: [] });
    byModel.get(m.id).points.push({ effort: lvl, cost: Math.round(cost * 100) / 100, score: Math.round(score * 1000) / 10 });
  }
  const series = [];
  for (const s of byModel.values()) {
    s.points.sort((a, b) => order.indexOf(a.effort) - order.indexOf(b.effort));
    const dupes = s.points.map((p) => p.effort).filter((e, i, a) => a.indexOf(e) !== i);
    if (dupes.length) { skipped.push(`${s.label}: repeated rung(s) ${[...new Set(dupes)].join(', ')} — upstream keying bug, not plotted`); continue; }
    // One point is a dot, not a curve. Two is the minimum that shows a trade-off.
    if (s.points.length < 2) { skipped.push(`${s.label}: only ${s.points.length} rung published — not a ladder yet`); continue; }
    series.push(s);
  }
  return { series, skipped };
}

// --- job 2: benchmark backfill ------------------------------------------------------------------
// Only benchmarks Epoch RUNS ITSELF are proposed here. Mirrored leaderboards carry someone else's
// licence and someone else's harness, so they are reported separately rather than as a fill.
const SELF_RUN = {
  'gpqa_diamond.csv': 'gpqa',
  'swe_bench_verified.csv': 'swe_bench',
  'math_level_5.csv': null,
  'frontiermath.csv': null,
  'simpleqa_verified.csv': null,
};

function collectBackfill(dir) {
  const out = [];
  for (const [file, field] of Object.entries(SELF_RUN)) {
    if (!field) continue;
    let rows;
    try { rows = parseCsv(readFileSync(join(dir, file), 'utf8')); } catch { continue; }
    for (const m of data.models) {
      if (m.benchmarks?.[field] != null) continue;             // already have it — never overwrite
      const hit = rows.find((r) => matchModel(r['Model version'], r['Name'])?.id === m.id);
      if (!hit) continue;
      const mean = parseFloat(hit.mean_score);
      if (!isFinite(mean)) continue;
      const se = parseFloat(hit.stderr);
      out.push({
        model_id: m.id, model: m.name, field,
        value: Math.round(mean * 1000) / 10,
        stderr: isFinite(se) ? Math.round(se * 1000) / 10 : null,
        epoch_version: hit['Model version'],
        source: 'https://epoch.ai/benchmarks/' + file.replace(/\.csv$/, '').replace(/_/g, '-'),
      });
    }
  }
  return out;
}

// --- run ----------------------------------------------------------------------------------------
let dir;
try {
  dir = await fetchExport();
} catch (e) {
  console.error(`collect-epoch: could not reach ${SRC.id} (${e.message}). Nothing proposed — stale but honest.`);
  process.exit(2);
}

const ladderRows = parseCsv(readFileSync(join(dir, 'cursorbench_external.csv'), 'utf8'));
const { series, skipped } = collectLadder(ladderRows);
const backfill = collectBackfill(dir);

const current = (data.effort_ladders || []).find((l) => l.id === 'cursorbench-agentic-coding');
const drift = [];
if (current) {
  for (const s of series) {
    const have = current.series.find((x) => x.model_id === s.model_id);
    if (!have) { drift.push(`NEW series available: ${s.label} (${s.points.length} rungs)`); continue; }
    for (const p of s.points) {
      const h = have.points.find((x) => x.effort === p.effort);
      if (!h) { drift.push(`NEW rung: ${s.label} @ ${p.effort} — $${p.cost} / ${p.score}%`); continue; }
      if (h.cost !== p.cost || h.score !== p.score)
        drift.push(`CHANGED: ${s.label} @ ${p.effort} — we hold $${h.cost}/${h.score}%, upstream now $${p.cost}/${p.score}%`);
    }
  }
}

if (asJson) {
  console.log(JSON.stringify({ as_of: new Date().toISOString().slice(0, 10), source: SRC.id, licence: SRC.licence, attribution: SRC.attribution, series, backfill, drift, skipped }, null, 2));
} else {
  console.log(`collect-epoch — ${SRC.name} (${SRC.licence})`);
  console.log(`attribution required: ${SRC.attribution}\n`);
  console.log(`LADDER: ${series.length} plottable series, ${series.reduce((n, s) => n + s.points.length, 0)} points`);
  for (const s of series) console.log(`  ${s.label.padEnd(12)} ${s.points.map((p) => `${p.effort} $${p.cost}/${p.score}%`).join('  ')}`);
  console.log(`\nDRIFT vs what we ship: ${drift.length ? '' : 'none — data/models.json matches upstream'}`);
  drift.forEach((d) => console.log('  • ' + d));
  console.log(`\nBACKFILL candidates (blank cells Epoch has now published): ${backfill.length ? '' : 'none'}`);
  backfill.forEach((b) => console.log(`  • ${b.model} ${b.field} = ${b.value}%${b.stderr != null ? ` ±${b.stderr}` : ''}  [${b.epoch_version}]  ${b.source}`));
  console.log(`\nSKIPPED (why each row did not become a point): ${skipped.length}`);
  skipped.forEach((s) => console.log('  - ' + s));
  console.log(`\nNothing was written. A human verifies, edits data/models.json, and merges.`);
}
