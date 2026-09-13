#!/usr/bin/env node
/* Informational eval report — runs the 40-situation cold answer key + 15 "must never" rules
   (data/eval/situations.json, data/eval/must-never.json) against LIVE data/, the same way
   scripts/test-eval-situations.mjs does against the frozen fixture, plus a top-3 table per task
   for the 'best' and 'cheapest' stances. Prints markdown to stdout and ALWAYS exits 0 — this is a
   report, never a gate (the live-data gate is scripts/check-live-data.mjs, rule-based only,
   which never asserts an expected winner). A miss here means either an engine bug or a real,
   honestly-reported disagreement between the engine's rules and the key's independently-drafted
   judgment call — this script never edits the key, it only reports.

   Usage: node scripts/eval-report.mjs [--thin-share=<0..1>]
     --thin-share overrides THIN_RULE.minShareOfCatalog (assets/decide.mjs) for this run ONLY —
     a task is thin when its measured-evidence count is below 8 OR below that share of the whole
     catalog. Never changes the shipped default (minShareOfCatalog: 0); lets this report show how
     the tiers/picks would look under a stricter thinness bar without touching production code.
   CI: .github/workflows/auto-refresh.yml runs this after the live-data check and appends its
   output to $GITHUB_STEP_SUMMARY. */
import { readFileSync } from 'node:fs';
import { decide } from '../assets/decide.mjs';
import { TASK_IDS } from './derive-task-fit.mjs';

const ROOT = new URL('../', import.meta.url);
const readJson = (p) => JSON.parse(readFileSync(new URL(p, ROOT)));

const models = readJson('data/models.json').models;
const plans = readJson('data/plans.json').plans;
const presets = readJson('data/usage-presets.json').presets;
const vendors = readJson('data/vendors.json').vendors;
const situations = readJson('data/eval/situations.json').situations;
const mustNeverFile = readJson('data/eval/must-never.json');
// v2 (2026-09-13) wraps the rules in { _readme, _dropped, rules }; v1 was a bare array.
const mustNever = Array.isArray(mustNeverFile) ? mustNeverFile : mustNeverFile.rules;
const data = { models, plans, presets, vendors };

const thinShareArg = process.argv.find((a) => a.startsWith('--thin-share='));
const thinShare = thinShareArg ? Number(thinShareArg.slice('--thin-share='.length)) : null;
const thinRuleOverride = Number.isFinite(thinShare) && thinShare >= 0 && thinShare <= 1
  ? { minTested: 8, minShareOfCatalog: thinShare } : null;
const withThinRule = (input) => (thinRuleOverride ? { ...input, thin_rule: thinRuleOverride } : input);

// ---------------------------------------------------------------------------------------------
// Situations — same logic scripts/test-eval-situations.mjs runs against the frozen fixture.
// ---------------------------------------------------------------------------------------------
function runSituation(s) {
  const taskId = s.input.tasks[0];
  const out = decide(withThinRule(s.input), data);
  const shortlist = out.tasks[taskId]?.shortlist || [];
  const startHere = shortlist.find((x) => x.start_here);
  const { start_here_any_of, acceptable, must_not_start, must_not_include } = s.expected;
  const problems = [];
  const okSet = new Set([...(start_here_any_of || []), ...(acceptable || [])]);
  if (okSet.size) {
    if (!startHere) problems.push('no start_here item in shortlist');
    else if (!okSet.has(startHere.id)) problems.push(`start_here "${startHere.id}" not in start_here_any_of/acceptable [${[...okSet].join(', ')}]`);
  }
  for (const id of must_not_start || []) if (startHere?.id === id) problems.push(`"${id}" must not be start_here but is`);
  for (const id of must_not_include || []) if (shortlist.some((x) => x.id === id)) problems.push(`"${id}" must not appear in the shortlist but does`);
  return { id: s.id, description: s.description, ok: problems.length === 0, problems, startHere: startHere?.id ?? null };
}

function runMustNever(rule) {
  let input;
  if (rule.context === 'enterprise') {
    input = { tasks: [rule.task === 'any' ? 'coding' : rule.task], have: ['any'], stance: 'best', volume: 'typical', dataRule: {}, enterprise: true };
  } else if (rule.context === 'noChinaHosted') {
    input = { tasks: [rule.task === 'any' ? 'coding' : rule.task], have: ['any'], stance: 'best', volume: 'typical', dataRule: { noChinaHosted: true } };
  } else {
    input = { tasks: [rule.task], have: ['any'], stance: rule.stance, volume: 'typical', dataRule: {} };
  }
  input = withThinRule(input);
  const taskId = input.tasks[0];
  const out = decide(input, data);
  const shortlist = out.tasks[taskId]?.shortlist || [];
  const startHere = shortlist.find((x) => x.start_here);
  const violated = startHere?.id === rule.model_id;
  return { rule, ok: !violated, startHere: startHere?.id ?? null };
}

const situationResults = situations.map(runSituation);
const mustNeverResults = mustNever.map(runMustNever);

// ---------------------------------------------------------------------------------------------
// Top-3 table per task, for 'best' and 'cheapest', have=any/typical/no data rule.
// ---------------------------------------------------------------------------------------------
function top3Table(stance) {
  const lines = [
    `| task | 1 (start_here) | tier | 2 | tier | 3 | tier |`,
    `|---|---|---|---|---|---|---|`,
  ];
  for (const taskId of TASK_IDS) {
    const out = decide(withThinRule({ tasks: [taskId], have: ['any'], stance, volume: 'typical', dataRule: {} }), data);
    const shortlist = out.tasks[taskId]?.shortlist || [];
    const cell = (item) => (item ? `${item.name} ($${item.monthly_cost_usd ?? '—'}/mo)` : '—');
    const tierCell = (item) => (item ? `${item.tier} ${item.tier_name}` : '—');
    const [a, b, c] = shortlist;
    lines.push(`| ${taskId} | ${cell(a)} | ${tierCell(a)} | ${cell(b)} | ${tierCell(b)} | ${cell(c)} | ${tierCell(c)} |`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Markdown report
// ---------------------------------------------------------------------------------------------
const lines = [];
const sitFailed = situationResults.filter((r) => !r.ok);
const mnFailed = mustNeverResults.filter((r) => !r.ok);
const totalPass = (situationResults.length - sitFailed.length) + (mustNeverResults.length - mnFailed.length);
const total = situationResults.length + mustNeverResults.length;

lines.push('# Modelproof eval report (live data)');
lines.push('');
lines.push(`Generated by \`scripts/eval-report.mjs\` against live \`data/\` (as_of ${readJson('data/models.json').as_of}). Informational only — never a gate; see \`scripts/check-live-data.mjs\` for the rule-based live-data gate. A miss below is either an engine bug or an honest disagreement between the engine's real-evidence ranking and this independently-drafted cold answer key — the key is never edited to force a pass.`);
lines.push(thinRuleOverride
  ? `Thin rule this run: minTested=8, minShareOfCatalog=${thinRuleOverride.minShareOfCatalog} (overridden via --thin-share — the shipped default is minShareOfCatalog=0).`
  : 'Thin rule this run: the shipped default (minTested=8, minShareOfCatalog=0).');
lines.push('');
lines.push(`**Situations: ${situationResults.length - sitFailed.length}/${situationResults.length} passed (${((situationResults.length - sitFailed.length) / situationResults.length * 100).toFixed(1)}%)**`);
lines.push(`**Must-never: ${mustNeverResults.length - mnFailed.length}/${mustNeverResults.length} passed (${((mustNeverResults.length - mnFailed.length) / mustNeverResults.length * 100).toFixed(1)}%)**`);
lines.push(`**Combined: ${totalPass}/${total} passed (${(totalPass / total * 100).toFixed(1)}%)**`);
lines.push('');

if (sitFailed.length) {
  lines.push('## Situation disagreements');
  lines.push('');
  for (const r of sitFailed) {
    lines.push(`- **${r.id}** (${r.description}) — start_here=\`${r.startHere}\` — ${r.problems.join('; ')}`);
  }
  lines.push('');
}
if (mnFailed.length) {
  lines.push('## Must-never disagreements');
  lines.push('');
  for (const r of mnFailed) {
    lines.push(`- **${r.rule.task}/${r.rule.stance || r.rule.context}** — "${r.rule.model_id}" must never be start_here, but is — ${r.rule.why}`);
  }
  lines.push('');
}
if (!sitFailed.length && !mnFailed.length) {
  lines.push('No disagreements this run.');
  lines.push('');
}

lines.push("## Top 3 per task — stance 'best'");
lines.push('');
lines.push(top3Table('best'));
lines.push('');
lines.push("## Top 3 per task — stance 'cheapest'");
lines.push('');
lines.push(top3Table('cheapest'));
lines.push('');

const report = lines.join('\n') + '\n';
console.log(report);
process.exit(0);
