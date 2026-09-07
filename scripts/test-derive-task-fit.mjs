import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TASK_IDS, BASIS_TOKENS, generalScoreOf, buildContext, deriveTaskFitForModel, deriveTaskFit,
  ladderModelIds,
} from './derive-task-fit.mjs';

const m = (overrides) => ({
  id: 'x', vendor: 'Test', coding_score: null, context_window: null, price_output: null,
  best_for: [], benchmarks: {}, ...overrides,
});

// --- generalScoreOf -----------------------------------------------------------------------

test('generalScoreOf: prefers GPQA over MMLU-Pro when both are sourced', () => {
  const g = generalScoreOf(m({ benchmarks: { gpqa: 91, mmlu_pro: 80 } }));
  assert.deepEqual(g, { score: 91, field: 'benchmarks.gpqa' });
});
test('generalScoreOf: falls back to MMLU-Pro when GPQA is null', () => {
  const g = generalScoreOf(m({ benchmarks: { gpqa: null, mmlu_pro: 77 } }));
  assert.deepEqual(g, { score: 77, field: 'benchmarks.mmlu_pro' });
});
test('generalScoreOf: null, null when neither is sourced — never a guess', () => {
  assert.deepEqual(generalScoreOf(m({})), { score: null, field: null });
});

// --- buildContext: cheapNorm must reward CHEAPNESS, not raw price --------------------------

test('buildContext.cheapNorm: the cheapest model in the catalog scores higher than the priciest', () => {
  const data = { models: [m({ id: 'a', price_output: 1 }), m({ id: 'b', price_output: 50 })], effort_ladders: [] };
  const ctx = buildContext(data);
  const cheap = ctx.cheapNorm(1);
  const pricey = ctx.cheapNorm(50);
  assert.ok(cheap > pricey, `expected cheap (${cheap}) > pricey (${pricey}) — cheapNorm must reward being cheaper, not just being more expensive`);
  assert.equal(Math.round(cheap), 100);
  assert.equal(Math.round(pricey), 0);
});
test('buildContext.cheapNorm/contextNorm: null input -> null output, never a guessed midpoint', () => {
  const data = { models: [m({ id: 'a', price_output: 1, context_window: 8000 }), m({ id: 'b', price_output: 50, context_window: 200000 })], effort_ladders: [] };
  const ctx = buildContext(data);
  assert.equal(ctx.cheapNorm(null), null);
  assert.equal(ctx.contextNorm(undefined), null);
});
test('buildContext: a single-value catalog normalizes every present value to 50, not 0/100', () => {
  const data = { models: [m({ id: 'a', price_output: 5 }), m({ id: 'b', price_output: 5 })], effort_ladders: [] };
  const ctx = buildContext(data);
  assert.equal(ctx.cheapNorm(5), 50);
});

// --- ladderModelIds ------------------------------------------------------------------------

test('ladderModelIds: collects every model_id across every ladder series', () => {
  const ladders = [
    { series: [{ model_id: 'a' }, { model_id: 'b' }] },
    { series: [{ model_id: 'b' }, { model_id: 'c' }] },
  ];
  assert.deepEqual([...ladderModelIds(ladders)].sort(), ['a', 'b', 'c']);
});

// --- per-task fitters, via deriveTaskFitForModel -------------------------------------------

function ctxFor(models, ladders = []) { return buildContext({ models, effort_ladders: ladders }); }

test('coding: score = coding_score as-is; null coding_score -> null with a reason, empty basis', () => {
  const models = [m({ id: 'a', coding_score: 82 }), m({ id: 'b', coding_score: null })];
  const ctx = ctxFor(models);
  assert.deepEqual(deriveTaskFitForModel(models[0], ctx).coding, { score: 82, basis: ['coding_score'] });
  const bNull = deriveTaskFitForModel(models[1], ctx).coding;
  assert.equal(bNull.score, null);
  assert.deepEqual(bNull.basis, []);
  assert.ok(bNull.reason);
});

test('agents: blends coding_score with context when context is known, and adds an effort_ladders bump when the model appears in a ladder', () => {
  const models = [
    m({ id: 'a', coding_score: 80, context_window: 1_000_000 }),
    m({ id: 'b', coding_score: 80, context_window: null }),
  ];
  const ctx = ctxFor(models, [{ series: [{ model_id: 'a' }] }]);
  const fitA = deriveTaskFitForModel(models[0], ctx).agents;
  const fitB = deriveTaskFitForModel(models[1], ctx).agents;
  assert.ok(fitA.basis.includes('context_window'));
  assert.ok(fitA.basis.includes('effort_ladders'));
  assert.ok(!fitB.basis.includes('context_window'));
  assert.equal(fitB.score, 80); // no context, no ladder appearance -> unchanged from coding_score
});

test('bulk: needs BOTH a general score and a price — either missing is null', () => {
  const models = [
    m({ id: 'a', benchmarks: { gpqa: 90 }, price_output: null }),
    m({ id: 'b', benchmarks: {}, price_output: 5 }),
    m({ id: 'c', benchmarks: { gpqa: 90 }, price_output: 5 }),
  ];
  const ctx = ctxFor(models);
  assert.equal(deriveTaskFitForModel(models[0], ctx).bulk.score, null);
  assert.equal(deriveTaskFitForModel(models[1], ctx).bulk.score, null);
  assert.notEqual(deriveTaskFitForModel(models[2], ctx).bulk.score, null);
});

test('bulk: cheaper wins more than a pricier model with the same general score', () => {
  const models = [
    m({ id: 'cheap', benchmarks: { gpqa: 80 }, price_output: 1 }),
    m({ id: 'pricey', benchmarks: { gpqa: 80 }, price_output: 50 }),
  ];
  const ctx = ctxFor(models);
  const cheapFit = deriveTaskFitForModel(models[0], ctx).bulk.score;
  const priceyFit = deriveTaskFitForModel(models[1], ctx).bulk.score;
  assert.ok(cheapFit > priceyFit, `cheap (${cheapFit}) should score higher than pricey (${priceyFit}) at equal capability`);
});

test('research: uses GPQA specifically — MMLU-Pro is never a substitute here', () => {
  const models = [m({ id: 'a', benchmarks: { mmlu_pro: 88 } })];
  const ctx = ctxFor(models);
  const fit = deriveTaskFitForModel(models[0], ctx).research;
  assert.equal(fit.score, null);
  assert.ok(/gpqa/i.test(fit.reason));
});

test('vision: binary on the best_for "vision" tag — present = 100, absent = null, never partial credit', () => {
  const models = [m({ id: 'a', best_for: ['vision'] }), m({ id: 'b', best_for: ['coding'] })];
  const ctx = ctxFor(models);
  assert.deepEqual(deriveTaskFitForModel(models[0], ctx).vision, { score: 100, basis: ['best_for:vision'] });
  assert.equal(deriveTaskFitForModel(models[1], ctx).vision.score, null);
});

test('frontend: coding_score plus a small best_for:speed bump, capped at 100', () => {
  const models = [
    m({ id: 'a', coding_score: 98, best_for: ['speed'] }),
    m({ id: 'b', coding_score: 60, best_for: [] }),
  ];
  const ctx = ctxFor(models);
  const withSpeed = deriveTaskFitForModel(models[0], ctx).frontend;
  assert.ok(withSpeed.score <= 100);
  assert.ok(withSpeed.basis.includes('best_for:speed'));
  const noSpeed = deriveTaskFitForModel(models[1], ctx).frontend;
  assert.equal(noSpeed.score, 60);
  assert.ok(!noSpeed.basis.includes('best_for:speed'));
});

test('every fitter only ever cites tokens from the shared BASIS_TOKENS vocabulary', () => {
  const models = [
    m({ id: 'a', coding_score: 80, context_window: 500000, benchmarks: { gpqa: 90 }, price_output: 5, best_for: ['vision', 'speed'] }),
  ];
  const ladders = [{ series: [{ model_id: 'a' }] }];
  const ctx = ctxFor(models, ladders);
  const fit = deriveTaskFitForModel(models[0], ctx);
  for (const t of TASK_IDS) {
    for (const token of fit[t].basis) assert.ok(BASIS_TOKENS.includes(token), `task "${t}" cites unknown basis token "${token}"`);
  }
});

// --- deriveTaskFit (whole-catalog pass) ------------------------------------------------------

test('deriveTaskFit: covers every task for every model and counts nulls correctly', () => {
  const models = [m({ id: 'a', coding_score: 80 }), m({ id: 'b' })];
  const { taskFitById, nullCounts } = deriveTaskFit({ models, effort_ladders: [] });
  assert.equal(taskFitById.size, 2);
  assert.equal(nullCounts.coding, 1); // only "b" is null on coding
  for (const t of TASK_IDS) assert.ok(t in nullCounts);
});
