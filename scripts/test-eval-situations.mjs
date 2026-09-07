/* The real eval: 40 situations + 15 "must never" rules, both from an independently-drafted cold
   answer key (data/eval/situations.json's `expected`, data/eval/must-never.json) — built with real,
   cited signals (OpenRouter usage/spend, Arena leaderboard votes, vendor guidance, enterprise case
   studies) and NO visibility into assets/decide.mjs's internals, specifically so this suite can't
   grade its own homework. This file prints a pass rate for each set and for the combined total;
   see scripts/refresh-judge.md-adjacent PR notes for the rule: never edit the key to force a pass —
   a failure here means either the engine needs a fix, or a real, honestly-reported disagreement
   between the engine's rules and the key's judgment call.

   Usage: node --test scripts/test-eval-situations.mjs   (also picked up by `node --test scripts/test-*.mjs`) */
import test from 'node:test';
import assert from 'node:assert/strict';
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
const mustNever = readJson('data/eval/must-never.json');
const data = { models, plans, presets, vendors };

// ---------------------------------------------------------------------------------------------
// 40 situations
// ---------------------------------------------------------------------------------------------
function runSituation(s) {
  const taskId = s.input.tasks[0];
  const out = decide(s.input, data);
  const shortlist = out.tasks[taskId]?.shortlist || [];
  const startHere = shortlist.find((x) => x.start_here);
  const { start_here_any_of, acceptable, must_not_start, must_not_include } = s.expected;
  const problems = [];

  // start_here_any_of is the key's narrowest "this is the ideal pick" set; acceptable is its own
  // explicitly broader "wouldn't be a wrong answer" superset. A different, independently-sourced
  // engine landing anywhere in EITHER is a legitimate pass — must_not_start/must_not_include are
  // the actual hard failures the key draws a line at.
  const okSet = new Set([...(start_here_any_of || []), ...(acceptable || [])]);
  if (okSet.size) {
    if (!startHere) problems.push('no start_here item in shortlist');
    else if (!okSet.has(startHere.id)) {
      problems.push(`start_here "${startHere.id}" not in start_here_any_of/acceptable [${[...okSet].join(', ')}]`);
    }
  }
  for (const id of must_not_start || []) {
    if (startHere?.id === id) problems.push(`"${id}" must not be start_here but is`);
  }
  for (const id of must_not_include || []) {
    if (shortlist.some((x) => x.id === id)) problems.push(`"${id}" must not appear in the shortlist but does`);
  }
  return { id: s.id, description: s.description, ok: problems.length === 0, problems, startHere: startHere?.id ?? null };
}

const situationResults = situations.map(runSituation);

test('eval situations only reference real task ids', () => {
  for (const s of situations) {
    for (const t of s.input.tasks) assert.ok(TASK_IDS.includes(t), `situation "${s.id}" uses unknown task "${t}"`);
  }
});

test('must-never rules only reference real task ids (or "any")', () => {
  for (const r of mustNever) assert.ok(r.task === 'any' || TASK_IDS.includes(r.task), `must-never rule for "${r.model_id}" uses unknown task "${r.task}"`);
});

test('eval: 40 cold-answer-key situations — pass rate', () => {
  const failed = situationResults.filter((r) => !r.ok);
  const passRate = ((situationResults.length - failed.length) / situationResults.length * 100).toFixed(1);
  console.log(`\n=== situations: ${situationResults.length - failed.length}/${situationResults.length} passed (${passRate}%) ===`);
  for (const r of failed) console.log(`  FAIL ${r.id} (${r.description}) — start_here=${r.startHere} — ${r.problems.join('; ')}`);
  assert.equal(failed.length, 0, `\n${failed.map((r) => `${r.id}: ${r.problems.join('; ')}`).join('\n')}`);
});

// ---------------------------------------------------------------------------------------------
// must-never.json — 15 absolute rules: a (task, stance) pair that must never pick a named model
// as start_here, plus a handful of context-scoped rules (enterprise, noChinaHosted).
// ---------------------------------------------------------------------------------------------
function runMustNever(rule) {
  let input;
  if (rule.context === 'enterprise') {
    input = { tasks: [rule.task === 'any' ? 'coding' : rule.task], have: ['any'], stance: 'best', volume: 'typical', dataRule: {}, enterprise: true };
  } else if (rule.context === 'noChinaHosted') {
    input = { tasks: [rule.task === 'any' ? 'coding' : rule.task], have: ['any'], stance: 'best', volume: 'typical', dataRule: { noChinaHosted: true } };
  } else {
    input = { tasks: [rule.task], have: ['any'], stance: rule.stance, volume: 'typical', dataRule: {} };
  }
  const taskId = input.tasks[0];
  const out = decide(input, data);
  const shortlist = out.tasks[taskId]?.shortlist || [];
  const startHere = shortlist.find((x) => x.start_here);
  const violated = startHere?.id === rule.model_id;
  return { rule, ok: !violated, startHere: startHere?.id ?? null };
}

const mustNeverResults = mustNever.map(runMustNever);

test('eval: 15 "must never" rules — pass rate', () => {
  const failed = mustNeverResults.filter((r) => !r.ok);
  const passRate = ((mustNeverResults.length - failed.length) / mustNeverResults.length * 100).toFixed(1);
  console.log(`\n=== must-never: ${mustNeverResults.length - failed.length}/${mustNeverResults.length} passed (${passRate}%) ===`);
  for (const r of failed) {
    console.log(`  FAIL ${r.rule.task}/${r.rule.stance || r.rule.context} — "${r.rule.model_id}" must never be start_here, but is — ${r.rule.why}`);
  }
  assert.equal(failed.length, 0, `\n${failed.map((r) => `${r.rule.task}/${r.rule.stance || r.rule.context}: "${r.rule.model_id}" was start_here`).join('\n')}`);
});

test('eval: combined pass rate (situations + must-never)', () => {
  const totalPass = situationResults.filter((r) => r.ok).length + mustNeverResults.filter((r) => r.ok).length;
  const total = situationResults.length + mustNeverResults.length;
  console.log(`\n=== combined: ${totalPass}/${total} passed (${(totalPass / total * 100).toFixed(1)}%) ===`);
  // Informational only — the two tests above already assert on their own sets; this just prints
  // the headline number scripts/refresh-judge.md-adjacent PR notes ask for.
  assert.ok(true);
});
