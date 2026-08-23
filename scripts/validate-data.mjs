#!/usr/bin/env node
/* Honesty gate for data/models.json. Run in CI on every push to the auto-refresh PR branch:
   a guessed/unsourced value must NOT be able to merge. Exits non-zero on any error.
   Usage: node scripts/validate-data.mjs */
import { readFileSync } from 'node:fs';

const CONF = ['low', 'medium', 'high'];
const VOCAB = ['reasoning', 'agentic', 'coding', 'research', 'long-context', 'writing', 'cheap-bulk', 'speed', 'vision'];
const BENCHES = ['swe_bench', 'gpqa', 'aime', 'mmlu_pro'];   // lmarena_elo dropped 2026-08-22
const num = (v) => v === null || v === undefined || Number.isNaN(v);

const data = JSON.parse(readFileSync(new URL('../data/models.json', import.meta.url)));
const registry = JSON.parse(readFileSync(new URL('./sources.json', import.meta.url)));
const errors = [], warnings = [];
const E = (m) => errors.push(m);
const W = (m) => warnings.push(m);

// Host → registry entry, so a URL anywhere in the data can be traced back to a licence and a tier.
const byHost = new Map();
for (const s of registry.sources) for (const h of s.hosts || []) byHost.set(h, s);
// Subdomains resolve to their parent entry, so www.anthropic.com and docs.anthropic.com both land
// on the vendor-primary tier without every host needing its own line.
const sourceFor = (url) => {
  let host;
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
  for (let h = host; h.includes('.'); h = h.slice(h.indexOf('.') + 1)) if (byHost.has(h)) return byHost.get(h);
  return null;
};

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
    // Each rung may appear once. A repeated effort means the rungs were keyed on the wrong
    // column upstream and collapsed together — Epoch's CursorBench export ships exactly this
    // bug (all three Opus 5 rows carry the model version "claude-opus-5_max"), so a future
    // refresh that trusts that field would silently plot three "max" dots and hand the
    // takeaway generator a curve that peaks and still climbs at the same time.
    const seen = new Set();
    for (const p of s.points) {
      if (seen.has(p.effort)) E(`ladder ${id}/${s.model_id}: effort "${p.effort}" appears more than once — the rungs were keyed on the wrong field; one point per effort level`);
      seen.add(p.effort);
    }

    // Points must run low → max in the order levels[] declares. The chart and the takeaways
    // both read the last point as "the top rung", so out-of-order points misreport what the
    // most expensive setting actually buys.
    if (Array.isArray(L.levels)) {
      const rank = (e) => L.levels.indexOf(e);
      const ranks = s.points.map((p) => rank(p.effort));
      if (ranks.every((r) => r >= 0) && ranks.some((r, i) => i && r < ranks[i - 1])) {
        E(`ladder ${id}/${s.model_id}: points are out of effort order — sort them to match levels[], the last point is read as the top rung`);
      }
    }

    const costs = s.points.map((p) => p.cost);
    if (costs.some((c, i) => i && c < costs[i - 1])) W(`ladder ${id}/${s.model_id}: cost isn't rising with effort — check the reading`);
  }
}

// 8. source-registry gates (scripts/sources.json). The tier system only means something if the
//    build enforces it: Tier B is licensed to be CITED, not ingested, so it must never be what a
//    ladder rests on. Getting this wrong is a licensing problem, not a style problem.
for (const L of data.effort_ladders || []) {
  const id = L.id || L.suite || '(unnamed ladder)';
  const reg = sourceFor(L.source);
  if (!reg) {
    W(`ladder ${id}: source host isn't in scripts/sources.json — add it to the registry with its tier and licence, or the page can't say what we're allowed to republish`);
  } else if (reg.tier === 'B' || !reg.redistributable) {
    // Tier B is licensed to be quoted, not reproduced. This is the licensing gate.
    E(`ladder ${id}: backed by "${reg.name}" (tier ${reg.tier}, redistributable=${reg.redistributable}) — tier B may be cited in sources[], never used as a ladder feed. See scripts/data-sources.md.`);
  } else if (reg.tier === 'C' && L.source_kind !== 'vendor-reported') {
    // Tier C (a lab publishing about its own models) is allowed — it is often the only thing that
    // exists at launch — but it has to be labelled as such, because the panel renders source_kind
    // and a vendor curve reading as third-party is the exact failure this site exists to avoid.
    E(`ladder ${id}: backed by vendor-primary source "${reg.name}" but source_kind is "${L.source_kind}" — a lab publishing about its own models must be labelled "vendor-reported"`);
  }
}

// A stub is how a model appears on day 0 without anyone guessing: present, with visible blanks.
// A stub carrying a score is a contradiction — it means a figure got in without verification.
for (const m of data.models) {
  if (m.confidence !== 'low') continue;
  const scored = BENCHES.filter((b) => m.benchmarks?.[b] != null);
  if (scored.length && !(Array.isArray(m.sources) && m.sources.length))
    E(`${m.name}: confidence "low" with unsourced benchmark(s) [${scored.join(', ')}] — a day-0 stub must keep every benchmark null until a source publishes one`);
}

if (warnings.length) { console.log('⚠ warnings (non-blocking):'); warnings.forEach((w) => console.log('  - ' + w)); }
if (errors.length) {
  console.error(`\n✗ ${errors.length} honesty-gate error(s) — blocking:`);
  errors.forEach((e) => console.error('  - ' + e));
  process.exit(1);
}
const ladderPts = (data.effort_ladders || []).reduce((n, L) => n + (L.series || []).reduce((k, s) => k + (s.points || []).length, 0), 0);
console.log(`\n✓ honesty gate passed: ${data.models.length} models, ${(data.releases || []).length} releases, ${(data.effort_ladders || []).length} effort ladder(s) / ${ladderPts} points, 0 errors.`);
