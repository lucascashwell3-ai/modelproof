#!/usr/bin/env node
/* Honesty gate for data/models.json. Run in CI on every push to the auto-refresh PR branch:
   a guessed/unsourced value must NOT be able to merge. Exits non-zero on any error.
   Usage: node scripts/validate-data.mjs */
import { readFileSync } from 'node:fs';

const CONF = ['low', 'medium', 'high'];
const VOCAB = ['reasoning', 'agentic', 'coding', 'research', 'long-context', 'writing', 'cheap-bulk', 'speed', 'vision'];
const BENCHES = ['swe_bench', 'gpqa', 'aime', 'mmlu_pro', 'lmarena_elo'];
const num = (v) => v === null || v === undefined || Number.isNaN(v);

const data = JSON.parse(readFileSync(new URL('../data/models.json', import.meta.url)));
const errors = [], warnings = [];
const E = (m) => errors.push(m);
const W = (m) => warnings.push(m);

for (const m of data.models) {
  const id = m.name || m.id || '(unnamed)';
  const hasSrc = Array.isArray(m.sources) && m.sources.length > 0;
  // 1. any non-null price MUST trace to a source
  if ((!num(m.price_input) || !num(m.price_output)) && !hasSrc) E(`${id}: has a price but no sources[]`);
  // 2. any non-null benchmark MUST trace to a source
  for (const b of BENCHES) if (!num(m.benchmarks?.[b]) && !hasSrc) E(`${id}: benchmark ${b} present but no sources[]`);
  // 3. confidence enums
  if (m.confidence && !CONF.includes(m.confidence)) E(`${id}: bad confidence "${m.confidence}"`);
  if (m.coding_confidence && !CONF.includes(m.coding_confidence)) E(`${id}: bad coding_confidence "${m.coding_confidence}"`);
  // 4. controlled tag vocabulary
  for (const t of m.best_for || []) if (!VOCAB.includes(t)) E(`${id}: best_for tag "${t}" not in vocab`);
  // 5. coding_score range
  if (!num(m.coding_score) && (m.coding_score < 0 || m.coding_score > 100)) E(`${id}: coding_score ${m.coding_score} out of 0–100`);
  // 6. cross-field (target/warning): a real SWE-bench number should read as high-confidence + cited
  if (!num(m.benchmarks?.swe_bench)) {
    if (m.coding_confidence !== 'high') W(`${id}: has SWE-bench but coding_confidence is "${m.coding_confidence}" (expected high)`);
    if (!/swe.?bench/i.test(m.coding_basis || '')) W(`${id}: has SWE-bench but coding_basis doesn't cite it`);
  }
}
for (const r of data.releases || []) if (!r.source) W(`release "${r.title}": no source URL`);

// 7. effort ladders: a published cost/performance curve must carry its provenance, and
//    every plotted point must be a real number against a model we actually list.
const modelIds = new Set(data.models.map((m) => m.id));
for (const L of data.effort_ladders || []) {
  const id = L.id || L.suite || '(unnamed ladder)';
  for (const field of ['suite', 'source', 'publisher', 'method', 'confidence']) {
    if (!L[field]) E(`ladder ${id}: missing ${field} — a ladder without provenance can't ship`);
  }
  if (L.confidence && !CONF.includes(L.confidence)) E(`ladder ${id}: bad confidence "${L.confidence}"`);
  if (!Array.isArray(L.series) || !L.series.length) E(`ladder ${id}: no series[]`);
  for (const s of L.series || []) {
    if (!modelIds.has(s.model_id)) E(`ladder ${id}: series "${s.label || s.model_id}" points at unknown model_id "${s.model_id}"`);
    if (!Array.isArray(s.points) || s.points.length < 2) { E(`ladder ${id}/${s.model_id}: needs at least 2 points to be a curve`); continue; }
    for (const p of s.points) {
      if (num(p.cost) || num(p.score)) E(`ladder ${id}/${s.model_id}: point "${p.effort}" has a blank cost or score — drop the point, don't guess it`);
      if (p.cost <= 0) E(`ladder ${id}/${s.model_id}: point "${p.effort}" cost ${p.cost} must be > 0 (log axis)`);
      if (Array.isArray(L.levels) && !L.levels.includes(p.effort)) W(`ladder ${id}/${s.model_id}: effort "${p.effort}" not in declared levels[]`);
    }
    const costs = s.points.map((p) => p.cost);
    if (costs.some((c, i) => i && c < costs[i - 1])) W(`ladder ${id}/${s.model_id}: cost isn't rising with effort — check the reading`);
  }
}

if (warnings.length) { console.log('⚠ warnings (non-blocking):'); warnings.forEach((w) => console.log('  - ' + w)); }
if (errors.length) {
  console.error(`\n✗ ${errors.length} honesty-gate error(s) — blocking:`);
  errors.forEach((e) => console.error('  - ' + e));
  process.exit(1);
}
const ladderPts = (data.effort_ladders || []).reduce((n, L) => n + (L.series || []).reduce((k, s) => k + (s.points || []).length, 0), 0);
console.log(`\n✓ honesty gate passed: ${data.models.length} models, ${(data.releases || []).length} releases, ${(data.effort_ladders || []).length} effort ladder(s) / ${ladderPts} points, 0 errors.`);
