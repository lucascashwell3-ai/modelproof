import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  checkAsOf, checkModelCountRatio, checkFeedHealth,
  checkTimelineSources, checkLadderProvenance, planLines, checkPlanLinesGA, checkNoRetiredPlans,
  runChecks, parseArgs,
} from './check-live-data.mjs';

test('checkAsOf accepts a valid past date', () => {
  assert.deepEqual(checkAsOf('2026-09-11', new Date('2026-09-12T00:00:00Z')), []);
});

test('checkAsOf rejects a malformed string', () => {
  assert.ok(checkAsOf('09/11/2026').length);
});

test('checkAsOf rejects a future date', () => {
  assert.ok(checkAsOf('2099-01-01', new Date('2026-09-12T00:00:00Z')).length);
});

test('checkModelCountRatio passes within +/-15%, fails outside it', () => {
  assert.deepEqual(checkModelCountRatio(100, 110), []);
  assert.ok(checkModelCountRatio(100, 50).length);
  assert.ok(checkModelCountRatio(100, 200).length);
});

test('checkModelCountRatio skips (no problems) when there is no committed baseline', () => {
  assert.deepEqual(checkModelCountRatio(NaN, 5), []);
});

// checkFeedHealth: synthetic before/after pair, never the frozen fixture — this check compares
// two snapshots of the SAME shape, not a golden fixture's answers.
function feedHealthModel(overrides = {}) {
  return {
    price_input: 1, price_output: 2,
    availability: { openrouter: true, direct_api: true },
    benchmarks: { swe_bench: 50, gpqa: null, aime: null, mmlu_pro: null },
    ...overrides,
  };
}
const feedHealthBefore = {
  models: Array.from({ length: 10 }, () => feedHealthModel()),
  effort_ladders: [{ series: [{ points: Array.from({ length: 10 }, (_, i) => ({ effort: i })) }] }],
};

test('checkFeedHealth passes when values change but nothing goes empty', () => {
  const after = {
    models: feedHealthBefore.models.map((m) => feedHealthModel({ price_input: m.price_input * 1.1 })),
    effort_ladders: feedHealthBefore.effort_ladders,
  };
  assert.deepEqual(checkFeedHealth(feedHealthBefore, after), []);
});

test('checkFeedHealth fails when a field silently goes empty on most models', () => {
  // 10 -> 2 non-null: an 80% drop, well past the 15% tolerance.
  const after = {
    models: feedHealthBefore.models.map((m, i) => (i < 2 ? m : feedHealthModel({ price_input: null }))),
    effort_ladders: feedHealthBefore.effort_ladders,
  };
  const problems = checkFeedHealth(feedHealthBefore, after);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /price_input/);
  assert.match(problems[0], /10 to 2/);
});

test('checkFeedHealth fails when effort-ladder points collapse', () => {
  const after = {
    models: feedHealthBefore.models,
    effort_ladders: [{ series: [{ points: [{ effort: 0 }, { effort: 1 }] }] }],
  };
  const problems = checkFeedHealth(feedHealthBefore, after);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /effort_ladders points/);
  assert.match(problems[0], /10 to 2/);
});

test('checkFeedHealth skips a field with nothing committed to compare against', () => {
  const before = { models: [feedHealthModel({ price_input: null })], effort_ladders: [] };
  const after = { models: [feedHealthModel({ price_input: 5 })], effort_ladders: [] };
  assert.deepEqual(checkFeedHealth(before, after), []);
});

// --- groups: feed (timeline sources, ladder provenance) and plans (GA / not deprecated) -------
// Frozen fixtures only (scripts/fixtures/), never data/. The plan checks use the consistent
// fixture pair: guidance.json + board-samples.json against instructions-models.json.
const fx = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const clone = (v) => JSON.parse(JSON.stringify(v));
const FX = { guidance: fx('guidance.json'), samples: fx('board-samples.json'), planModels: fx('instructions-models.json'), feedModels: fx('models.json') };
const deprecate = (models, id) => {
  const out = clone(models);
  const m = out.models.find((x) => x.id === id);
  m.deprecated = true; m.status = 'deprecated';
  return out;
};

test('planLines: 33 lines on the fixture pair; choice slots name no model; basis is never walked', () => {
  const lines = planLines(FX.guidance, FX.samples);
  const kinds = lines.reduce((a, l) => ((a[l.kind] = (a[l.kind] || 0) + 1), a), {});
  assert.deepEqual(kinds, { plan: 6, role_default: 2, model_ref: 6, personal_default: 2, sample: 17 });
  assert.ok(lines.some((l) => l.where === 'guidance tool_plans claude-code.bulk' && l.model_id === 'claude-haiku-4-5'));
  assert.ok(lines.some((l) => l.where === 'guidance tool_plans claude-code.helpers.push_down' && l.model_id === 'claude-sonnet-5-5'));
  assert.ok(!lines.some((l) => /cursor|copilot|antigravity|openrouter/.test(l.where)), 'a "your pick" slot names no model');
  assert.ok(!lines.some((l) => /basis/.test(l.where)));
});

test('plans group passes on the frozen fixture pair (the preview example-board line is outside the GA rule)', () => {
  assert.deepEqual(runChecks({ models: FX.planModels, guidance: FX.guidance, samples: FX.samples }, { group: 'plans' }), []);
  assert.ok(planLines(FX.guidance, FX.samples).some((l) => l.kind === 'sample' && l.model_id === 'gemini-3-1-pro'), 'the fixture still carries its preview sample');
});

test('mutation: deprecating claude-haiku-4-5 gives 3 not-deprecated problems and 2 not-GA problems', () => {
  const models = deprecate(FX.planModels, 'claude-haiku-4-5');
  const lines = planLines(FX.guidance, FX.samples);
  const retired = checkNoRetiredPlans(lines, models.models);
  assert.equal(retired.length, 3, retired.join('\n'));
  assert.ok(retired.some((p) => /tool_plans claude-code\.bulk/.test(p)));
  assert.ok(retired.some((p) => /role_defaults claude-code\/scout/.test(p)));
  assert.ok(retired.some((p) => /model_refs claude-code\/haiku/.test(p)));
  const ga = checkPlanLinesGA(lines, models.models);
  assert.equal(ga.length, 2, ga.join('\n'));
  assert.ok(ga.every((p) => /not GA \(status deprecated\)/.test(p)));
});

test('mutation: a deprecated model on an example board fails the not-deprecated rule only', () => {
  const models = deprecate(FX.planModels, 'deepseek-v4-flash');
  const lines = planLines(FX.guidance, FX.samples);
  assert.equal(checkPlanLinesGA(lines, models.models).length, 0);
  assert.ok(checkNoRetiredPlans(lines, models.models).length >= 1);
  assert.ok(checkNoRetiredPlans(lines, models.models).every((p) => /board-samples/.test(p)));
});

test('GA rule: a preview or unknown model on a recommendation line fails; a ga one passes', () => {
  const models = [{ id: 'a', status: 'ga' }, { id: 'b', status: 'preview' }];
  const lines = [
    { where: 'x', kind: 'plan', model_id: 'a' },
    { where: 'y', kind: 'role_default', model_id: 'b' },
    { where: 'z', kind: 'personal_default', model_id: 'nope' },
    { where: 'w', kind: 'sample', model_id: 'b' },
  ];
  const p = checkPlanLinesGA(lines, models);
  assert.equal(p.length, 2);
  assert.match(p[0], /y -> b is not GA \(status preview\)/);
  assert.match(p[1], /z -> nope is not in models\.json/);
});

test('feed group passes on the frozen models fixture (timeline sources, ladder provenance)', () => {
  assert.deepEqual(runChecks({ models: FX.feedModels }, { group: 'feed', today: new Date('2026-10-04T00:00:00Z') }), []);
});

test('mutation: a release without an http(s) source fails, naming its title', () => {
  const rel = clone(FX.feedModels.releases);
  rel[0].source = '';
  const p = checkTimelineSources(rel);
  assert.equal(p.length, 1);
  assert.ok(p[0].includes(rel[0].title));
});

test('mutation: a ladder without a method fails once per series; a point or series override passes', () => {
  const ladders = clone(FX.feedModels.effort_ladders);
  const L = ladders[0];
  delete L.method;
  const p = checkLadderProvenance(ladders);
  assert.equal(p.length, L.series.length, p.join('\n'));
  assert.ok(p.every((x) => /resolve no method/.test(x)));
  L.series[0].method = 'series-level method';
  for (const s of L.series.slice(1)) for (const pt of s.points) pt.method = 'point-level method';
  assert.deepEqual(checkLadderProvenance(ladders), []);
  L.series[0].points[0].method = '  ';
  assert.equal(checkLadderProvenance(ladders).length, 1, 'an empty point override does not inherit');
});

test('runChecks: feed never reports plan problems; plans never reports feed problems; all reports both', () => {
  const models = deprecate(FX.planModels, 'claude-haiku-4-5');
  models.as_of = '2099-01-01';
  const files = { models, guidance: FX.guidance, samples: FX.samples };
  const today = new Date('2026-10-04T00:00:00Z');
  const feed = runChecks(files, { group: 'feed', today });
  const plans = runChecks(files, { group: 'plans', today });
  assert.ok(feed.length === 1 && /future/.test(feed[0]), feed.join('\n'));
  assert.ok(plans.length === 5 && plans.every((p) => p.startsWith('plans:')));
  assert.equal(runChecks(files, { group: 'all', today }).length, 6);
  assert.throws(() => runChecks(files, { group: 'nope' }), /unknown group/);
});

test('parseArgs: --group defaults to all; unknown group or flag throws', () => {
  assert.deepEqual(parseArgs([]), { group: 'all', dataDir: null });
  assert.deepEqual(parseArgs(['--group', 'feed', '--data=/x']), { group: 'feed', dataDir: '/x' });
  assert.throws(() => parseArgs(['--group', 'prices']), /unknown group/);
  assert.throws(() => parseArgs(['--fast']), /unknown argument/);
});

test('CLI --group exit codes on a mutated fixture copy: feed 0, plans 1, all 1, bad group 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'live-data-groups-'));
  const models = deprecate(FX.planModels, 'claude-haiku-4-5');
  models.as_of = '2026-10-03';
  writeFileSync(join(dir, 'models.json'), JSON.stringify(models));
  writeFileSync(join(dir, 'guidance.json'), JSON.stringify(FX.guidance));
  writeFileSync(join(dir, 'board-samples.json'), JSON.stringify(FX.samples));
  const script = fileURLToPath(new URL('./check-live-data.mjs', import.meta.url));
  const run = (...a) => spawnSync('node', [script, '--data', dir, ...a], { encoding: 'utf8' });
  assert.equal(run('--group', 'feed').status, 0);
  const plans = run('--group', 'plans');
  assert.equal(plans.status, 1);
  assert.match(plans.stderr, /claude-haiku-4-5 points at a deprecated model/);
  assert.equal(run('--group', 'all').status, 1);
  assert.equal(run().status, 1, 'default group is all');
  assert.equal(run('--group', 'prices').status, 2);
});
