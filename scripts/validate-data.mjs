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

if (warnings.length) { console.log('⚠ warnings (non-blocking):'); warnings.forEach((w) => console.log('  - ' + w)); }
if (errors.length) {
  console.error(`\n✗ ${errors.length} honesty-gate error(s) — blocking:`);
  errors.forEach((e) => console.error('  - ' + e));
  process.exit(1);
}
console.log(`\n✓ honesty gate passed: ${data.models.length} models, ${(data.releases || []).length} releases, 0 errors.`);
