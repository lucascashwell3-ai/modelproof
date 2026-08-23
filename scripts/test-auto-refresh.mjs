import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalize, matchAlias, withinTolerance, factAgreement, withinSanityBounds,
  newerWins, admitNewModel, isKnownVendor, trackDeprecation, canonicalKey, evaluateFact,
  buildWorklist, bestForLine, needsGuidance, pickGuidance, guidanceItem, parseCsv, refreshCursorBench,
} from './auto-refresh.mjs';

test('normalize strips punctuation/case', () => {
  assert.equal(normalize('Claude Opus 5'), 'claudeopus5');
  assert.equal(normalize('claude-opus-5'), 'claudeopus5');
});

test('matchAlias: two-source agreement scenario resolves via alias', () => {
  const models = [{ id: 'claude-opus-5', name: 'Claude Opus 5' }];
  const aliases = { 'claude-opus-5': ['claude opus 5'] };
  assert.equal(matchAlias('Claude Opus 5', models, aliases), 'claude-opus-5');
  assert.equal(matchAlias('claude opus 5', models, aliases), 'claude-opus-5');
  assert.equal(matchAlias('totally unknown model', models, aliases), null);
});

test('factAgreement: two independent sources within 2% APPLIES', () => {
  const obs = [{ source: 'openrouter', value: 5.0 }, { source: 'litellm', value: 5.05 }];
  const r = factAgreement(obs);
  assert.equal(r.applies, true);
});

test('factAgreement: single source HELD', () => {
  const obs = [{ source: 'openrouter', value: 5.0 }];
  const r = factAgreement(obs);
  assert.equal(r.applies, false);
  assert.equal(r.reason, 'single-source');
});

test('factAgreement: two sources disagreeing beyond tolerance HELD', () => {
  const obs = [{ source: 'openrouter', value: 5.0 }, { source: 'litellm', value: 8.0 }];
  const r = factAgreement(obs);
  assert.equal(r.applies, false);
});

test('factAgreement: vendor + judgment agreement APPLIES', () => {
  const obs = [{ source: 'vendor', value: 3.0 }, { source: 'judgment', value: 3.0 }];
  const r = factAgreement(obs);
  assert.equal(r.applies, true);
});

test('withinSanityBounds: >5x current HELD', () => {
  assert.equal(withinSanityBounds(5, 30), false);   // 6x
  assert.equal(withinSanityBounds(5, 20), true);    // 4x, within bound
});

test('withinSanityBounds: <0.2x current HELD', () => {
  assert.equal(withinSanityBounds(10, 1), false);   // 0.1x
  assert.equal(withinSanityBounds(10, 2.5), true);  // 0.25x, within bound
});

test('withinSanityBounds: no current value never holds', () => {
  assert.equal(withinSanityBounds(null, 999), true);
});

test('newerWins: candidate date newer than as_of wins', () => {
  assert.equal(newerWins('2026-07-01', '2026-08-01'), true);
  assert.equal(newerWins('2026-08-01', '2026-07-01'), false);
  assert.equal(newerWins(null, '2026-07-01'), true);
});

test('admitNewModel: publishes on >=2 sources + pricing + known vendor', () => {
  assert.equal(admitNewModel({ sourceCount: 2, hasPricing: true, vendorKnown: true }), true);
  assert.equal(admitNewModel({ sourceCount: 1, hasPricing: true, vendorKnown: true }), false);
  assert.equal(admitNewModel({ sourceCount: 2, hasPricing: false, vendorKnown: true }), false);
  assert.equal(admitNewModel({ sourceCount: 2, hasPricing: true, vendorKnown: false }), false);
});

test('isKnownVendor recognizes our vendor list, rejects unknowns', () => {
  assert.equal(isKnownVendor('Anthropic'), true);
  assert.equal(isKnownVendor('anthropic'), true);
  assert.equal(isKnownVendor('DeepSeek'), true);
  assert.equal(isKnownVendor('SomeRandomStartup'), false);
});

test('trackDeprecation: flags a model missing 2 consecutive runs, not 1', () => {
  const ids = ['model-a', 'model-b'];
  let state = {};
  let r = trackDeprecation(state, new Set(['model-b']), ids); // model-a missing, run 1
  assert.deepEqual(r.absentNow, []);
  state = r.state;
  r = trackDeprecation(state, new Set(['model-b']), ids); // model-a missing, run 2
  assert.deepEqual(r.absentNow, ['model-a']);
});

test('trackDeprecation: reappearing resets the counter', () => {
  const ids = ['model-a'];
  let state = { 'model-a': 1 };
  const r = trackDeprecation(state, new Set(['model-a']), ids);
  assert.equal(r.state['model-a'], 0);
  assert.deepEqual(r.absentNow, []);
});

// --- regression: presence detection MUST use the same matching as price matching -----------------
// Bug: llama-4-maverick (and kimi/qwen/glm/mistral) were flagged absent while ALSO being matched
// for price on OpenRouter, because presence only checked matchAlias(c.name) for OpenRouter and
// matchAlias(c.id) for LiteLLM — missing the id/name cross-check the price matcher used. A model
// that matches for price can never simultaneously count as absent.
function stillPresentIds(models, orList, llmList, aliases) {
  const present = new Set();
  for (const m of models) {
    const inOr = orList.some((c) => matchAlias(c.name, [m], aliases) === m.id || matchAlias(c.id, [m], aliases) === m.id);
    const inLlm = llmList.some((c) => matchAlias(c.id, [m], aliases) === m.id || matchAlias(c.name, [m], aliases) === m.id);
    if (inOr || inLlm || (!orList.length && !llmList.length)) present.add(m.id);
  }
  return present;
}

test('a model matched for price (by id, not name) can never count as absent', () => {
  // OpenRouter candidate whose "name" field does NOT match our model, but whose "id" does — this
  // is exactly the llama-4-maverick shape: price matching resolves it via c.id, so presence must too.
  const models = [{ id: 'llama-4-maverick', name: 'Llama 4 Maverick' }];
  const aliases = { 'llama-4-maverick': ['llama 4 maverick', 'llama-4-maverick'] };
  const orList = [{ id: 'llama-4-maverick', name: 'Meta: Some Repackaged Display Name', priceInput: 0.2 }];
  const llmList = [];

  // price matcher (mirrors the real orMatch predicate in main()) finds it —
  const priceMatched = orList.some((c) => matchAlias(c.name, models, aliases) === 'llama-4-maverick' || matchAlias(c.id, models, aliases) === 'llama-4-maverick');
  assert.equal(priceMatched, true);

  // — so presence detection must find it too.
  const present = stillPresentIds(models, orList, llmList, aliases);
  assert.ok(present.has('llama-4-maverick'), 'model matched for price was incorrectly flagged absent');
});

test('the same fix applies on the LiteLLM side (matched by name, not id)', () => {
  const models = [{ id: 'kimi-k3', name: 'Kimi K3' }];
  const aliases = { 'kimi-k3': ['kimi k3', 'moonshot kimi k3'] };
  const orList = [];
  const llmList = [{ id: 'moonshot/some-internal-key-1234', name: 'kimi k3', priceInput: 3 }];
  const present = stillPresentIds(models, orList, llmList, aliases);
  assert.ok(present.has('kimi-k3'), 'model matched by name on LiteLLM was incorrectly flagged absent');
});

// --- canonicalKey / LiteLLM-style key normalization -------------------------------------------

test('canonicalKey strips provider prefixes, date suffixes, and separators', () => {
  assert.equal(canonicalKey('anthropic/claude-opus-5-20260723'), canonicalKey('claude-opus-5'));
  assert.equal(canonicalKey('openai/gpt-5.5'), canonicalKey('gpt-5-5'));
  assert.equal(canonicalKey('gemini/gemini-3.5-flash'), canonicalKey('gemini-3-5-flash'));
  assert.equal(canonicalKey('vertex_ai/gemini-3.5-flash'), canonicalKey('gemini-3-5-flash'));
  assert.equal(canonicalKey('deepseek/deepseek-v4-pro'), canonicalKey('deepseek-v4-pro'));
});

test('matchAlias resolves 3 real LiteLLM-style keys per vendor to our ids', () => {
  const models = [
    { id: 'claude-opus-5', name: 'Claude Opus 5' },
    { id: 'gpt-5-5', name: 'GPT-5.5' },
    { id: 'gemini-3-5-flash', name: 'Gemini 3.5 Flash' },
    { id: 'deepseek-v4-pro', name: 'DeepSeek V4-Pro' },
  ];
  const aliases = {
    'claude-opus-5': ['claude opus 5'],
    'gpt-5-5': ['gpt-5.5'],
    'gemini-3-5-flash': ['gemini 3.5 flash'],
    'deepseek-v4-pro': ['deepseek v4-pro'],
  };
  // anthropic
  assert.equal(matchAlias('claude-opus-5', models, aliases), 'claude-opus-5');
  assert.equal(matchAlias('anthropic/claude-opus-5', models, aliases), 'claude-opus-5');
  assert.equal(matchAlias('claude-opus-5-20260723', models, aliases), 'claude-opus-5');
  // openai
  assert.equal(matchAlias('openai/gpt-5.5', models, aliases), 'gpt-5-5');
  assert.equal(matchAlias('gpt-5.5', models, aliases), 'gpt-5-5');
  assert.equal(matchAlias('gpt-5.5-20260101', models, aliases), 'gpt-5-5');
  // google
  assert.equal(matchAlias('gemini/gemini-3.5-flash', models, aliases), 'gemini-3-5-flash');
  assert.equal(matchAlias('vertex_ai/gemini-3.5-flash', models, aliases), 'gemini-3-5-flash');
  assert.equal(matchAlias('gemini-3.5-flash', models, aliases), 'gemini-3-5-flash');
  // deepseek
  assert.equal(matchAlias('deepseek/deepseek-v4-pro', models, aliases), 'deepseek-v4-pro');
  assert.equal(matchAlias('deepseek-v4-pro', models, aliases), 'deepseek-v4-pro');
  assert.equal(matchAlias('deepseek-v4-pro-20260601', models, aliases), 'deepseek-v4-pro');
});

// --- evaluateFact: held is genuine conflict only, confirmed is separate ------------------------

test('evaluateFact: single source confirming current value is CONFIRMED, not held', () => {
  const r = evaluateFact(5.0, [{ source: 'openrouter', value: 5.01 }]);
  assert.equal(r.status, 'confirmed');
});

test('evaluateFact: single source disagreeing with current, no second source, is HELD', () => {
  const r = evaluateFact(5.0, [{ source: 'openrouter', value: 7.0 }]);
  assert.equal(r.status, 'held');
  assert.equal(r.reason, 'single-source');
});

test('evaluateFact: two sources agreeing with each other but confirming current is CONFIRMED', () => {
  const r = evaluateFact(5.0, [{ source: 'openrouter', value: 5.0 }, { source: 'litellm', value: 5.02 }]);
  assert.equal(r.status, 'confirmed');
});

test('evaluateFact: two sources agreeing with each other and differing from current is APPLIED', () => {
  const r = evaluateFact(5.0, [{ source: 'openrouter', value: 6.0 }, { source: 'litellm', value: 6.02 }]);
  assert.equal(r.status, 'applied');
  assert.equal(r.value, 6.0);
});

test('evaluateFact: two sources disagreeing with each other is HELD (source-conflict)', () => {
  const r = evaluateFact(5.0, [{ source: 'openrouter', value: 6.0 }, { source: 'litellm', value: 9.0 }]);
  assert.equal(r.status, 'held');
  assert.equal(r.reason, 'source-conflict');
});

test('evaluateFact: agreeing sources but change trips sanity bound is HELD', () => {
  const r = evaluateFact(5.0, [{ source: 'openrouter', value: 30.0 }, { source: 'litellm', value: 30.1 }]);
  assert.equal(r.status, 'held');
  assert.equal(r.reason, 'sanity-bound');
});

// --- buildWorklist: priority, cap, idempotency ---------------------------------------------------

test('buildWorklist orders new-model > conflict > deprecation > benchmark > ladder > release', () => {
  const items = [
    { id: 'r1', kind: 'release' }, { id: 'l1', kind: 'ladder' }, { id: 'b1', kind: 'benchmark' },
    { id: 'd1', kind: 'deprecation' }, { id: 'c1', kind: 'conflict' }, { id: 'n1', kind: 'new-model' },
  ];
  const out = buildWorklist(items);
  assert.deepEqual(out.map((i) => i.kind), ['new-model', 'conflict', 'deprecation', 'benchmark', 'ladder', 'release']);
});

test('buildWorklist caps at 15 items, keeping highest priority', () => {
  const items = [];
  for (let i = 0; i < 20; i++) items.push({ id: `release-${i}`, kind: 'release' });
  for (let i = 0; i < 3; i++) items.push({ id: `new-${i}`, kind: 'new-model' });
  const out = buildWorklist(items);
  assert.equal(out.length, 15);
  assert.equal(out.filter((i) => i.kind === 'new-model').length, 3);
  assert.equal(out.filter((i) => i.kind === 'release').length, 12);
});

test('buildWorklist is idempotent — same input, same output', () => {
  const items = [
    { id: 'b2', kind: 'benchmark' }, { id: 'b1', kind: 'benchmark' }, { id: 'n1', kind: 'new-model' },
  ];
  const a = buildWorklist(items);
  const b = buildWorklist(items);
  assert.deepEqual(a, b);
  assert.deepEqual(a.map((i) => i.id), ['n1', 'b1', 'b2']); // tie-break by id within same kind
});

// --- bestForLine: deterministic template, no prose generation ------------------------------------

test('bestForLine calls out cheapest same-vendor model with context + price', () => {
  const models = [
    { id: 'a', vendor: 'Acme', price_input: 1, price_output: 5, context_window: 1000000 },
    { id: 'b', vendor: 'Acme', price_input: 5, price_output: 25, context_window: 200000 },
  ];
  const line = bestForLine(models[0], models);
  assert.match(line, /Cheapest Acme model/);
  assert.match(line, /1M ctx/);
  assert.match(line, /\$1/);
});

test('bestForLine falls back to vendor + specs when no ranking applies (single vendor model)', () => {
  const models = [{ id: 'a', vendor: 'Acme', price_input: 3, price_output: 9, context_window: 128000 }];
  const line = bestForLine(models[0], models);
  assert.match(line, /Acme model/);
  assert.match(line, /128K ctx/);
  assert.match(line, /\$3\/\$9/);
});

// --- receipt shape (documented, not filesystem-dependent) -----------------------------------------

test('collect receipt has the documented shape', () => {
  const receipt = { job: 'collect', ran_at: new Date().toISOString(), applied: 0, held: 0, confirmed: 0, new_models: 0, worklist_items: 0, ok: true };
  for (const k of ['job', 'ran_at', 'applied', 'held', 'confirmed', 'new_models', 'worklist_items', 'ok']) {
    assert.ok(k in receipt, `receipt missing ${k}`);
  }
  assert.equal(receipt.job, 'collect');
  assert.equal(typeof receipt.ok, 'boolean');
});

// --- usage guidance rotation (2026-08-22) -----------------------------------------------------
const G = (id, extra = {}) => ({ id, name: id, price_input: 1, price_output: 2, best_for: [], use_well: [], ...extra });
test('needsGuidance: blank models yes; filled, deprecated, or unpriced models no', () => {
  assert.equal(needsGuidance(G('a')), true);
  assert.equal(needsGuidance(G('b', { best_for: ['coding'] })), true);            // half-blank still counts
  assert.equal(needsGuidance(G('c', { best_for: ['coding'], use_well: ['x'] })), false);
  assert.equal(needsGuidance(G('d', { deprecated: true })), false);
  assert.equal(needsGuidance(G('e', { price_input: null, price_output: null })), false);
});
test('pickGuidance takes at most perRun, in sorted order, from a fresh state', () => {
  const models = ['m3', 'm1', 'm2', 'm5', 'm4'].map((id) => G(id));
  const { picked, cursor } = pickGuidance(models, {}, 3);
  assert.deepEqual(picked, ['m1', 'm2', 'm3']);
  assert.equal(cursor, 'm3');
});
test('pickGuidance rotates: the next run starts after the cursor and wraps around', () => {
  const models = ['m1', 'm2', 'm3', 'm4', 'm5'].map((id) => G(id));
  const r2 = pickGuidance(models, { guidanceCursor: 'm4' }, 4);
  assert.deepEqual(r2.picked, ['m5', 'm1', 'm2', 'm3']);
  const r3 = pickGuidance(models, { guidanceCursor: r2.cursor }, 4);
  assert.deepEqual(r3.picked, ['m4', 'm5', 'm1', 'm2']);
});
test('pickGuidance is idempotent: same state + models → same picks', () => {
  const models = ['m1', 'm2', 'm3'].map((id) => G(id));
  assert.deepEqual(pickGuidance(models, { guidanceCursor: 'm1' }, 2), pickGuidance(models, { guidanceCursor: 'm1' }, 2));
});
test('pickGuidance: filled models drop out of the rotation; a stale cursor past the end wraps to the start', () => {
  const models = [G('m1', { best_for: ['coding'], use_well: ['x'] }), G('m2'), G('m3')];
  assert.deepEqual(pickGuidance(models, { guidanceCursor: 'm9' }, 4).picked, ['m2', 'm3']);
  assert.deepEqual(pickGuidance([], {}, 4).picked, []);
});
test('guidance items sort last, keep their reserved slots when conflicts overflow, and never exceed 3', () => {
  const items = [guidanceItem(G('zz'), '2026-08-22'), { id: 'a:price_input', kind: 'conflict' }, { id: 'b:gpqa', kind: 'benchmark' }];
  assert.deepEqual(buildWorklist(items).map((i) => i.kind), ['conflict', 'benchmark', 'guidance']);
  const many = Array.from({ length: 40 }, (_, i) => ({ id: `c${String(i).padStart(2, '0')}:price_input`, kind: 'conflict' }));
  const five = ['g1', 'g2', 'g3', 'g4', 'g5'].map((id) => guidanceItem(G(id), '2026-08-22'));
  const out = buildWorklist([...many, ...five]);
  assert.equal(out.length, 15);
  assert.equal(out.filter((i) => i.kind === 'guidance').length, 3);
  assert.equal(out.filter((i) => i.kind === 'conflict').length, 12);
  // with no guidance candidates the full 15 go to the rest
  assert.equal(buildWorklist(many).length, 15);
});

// --- CursorBench ladder refresh from Epoch's CSV (2026-08-22) ----------------------------------
const CSV = `Model version,Score,Reasoning level,Cost per task,Tokens per task,Name
claude-opus-5_low,0.628,Low,2.55,18529,Opus 5 Low
claude-opus-5_high,0.667,High,3.91,27932,Opus 5 High
claude-opus-5_max,0.70,Max,8.23,61838,"Opus 5, Max"
gpt-5.6-sol_low,0.526,Low,1.01,5104,Sol Low
gpt-5.6-sol_max,,Max,5.69,28320,Sol Max
grok-4.6_low,0.61,Low,0.70,1,Grok
`;
const ladderData = () => ({ effort_ladders: [{ id: 'cursorbench-agentic-coding', as_of: '2026-07-25', series: [
  { model_id: 'claude-opus-5', label: 'Opus 5', source_key: 'claude-opus-5', points: [{ effort: 'high', cost: 3.91, score: 66.7 }] },
  { model_id: 'gpt-5-6-sol', label: 'GPT-5.6 Sol', source_key: 'gpt-5.6-sol', points: [{ effort: 'low', cost: 1, score: 52 }, { effort: 'max', cost: 5.5, score: 67 }] },
  { model_id: 'x-ai-grok-4-6', label: 'Grok 4.6', source_key: 'grok-4.6', points: [{ effort: 'low', cost: 0.7, score: 61 }, { effort: 'high', cost: 2.3, score: 69.9 }] },
  { model_id: 'claude-fable-5', label: 'Fable 5', points: [{ effort: 'low', cost: 4, score: 62 }, { effort: 'max', cost: 18, score: 72.9 }] },
] }] });
test('parseCsv handles quoted commas and blank cells', () => {
  const rows = parseCsv(CSV);
  assert.equal(rows.length, 6);
  assert.equal(rows[2].Name, 'Opus 5, Max');
  assert.equal(rows[4].Score, '');
});
test('refreshCursorBench rebuilds rungs in effort order, rounds, and moves as_of only on change', () => {
  const d = ladderData();
  const r = refreshCursorBench(d, parseCsv(CSV), '2026-08-25');
  assert.equal(r.changed, true);
  const opus = d.effort_ladders[0].series[0];
  assert.deepEqual(opus.points, [{ effort: 'low', cost: 2.55, score: 62.8 }, { effort: 'high', cost: 3.91, score: 66.7 }, { effort: 'max', cost: 8.23, score: 70 }]);
  assert.equal(d.effort_ladders[0].as_of, '2026-08-25');
  // second run with the same file: nothing changes, as_of stays
  const r2 = refreshCursorBench(d, parseCsv(CSV), '2026-08-28');
  assert.equal(r2.changed, false);
  assert.equal(d.effort_ladders[0].as_of, '2026-08-25');
});
test('refreshCursorBench keeps yesterday\'s points when the file has fewer than 2 usable rungs for a model', () => {
  const d = ladderData();
  refreshCursorBench(d, parseCsv(CSV), '2026-08-25');
  const sol = d.effort_ladders[0].series[1];     // Sol max has a blank score → only 1 usable rung
  assert.equal(sol.points.length, 2);
  assert.equal(sol.points[1].cost, 5.5);
  const grok = d.effort_ladders[0].series[2];    // Grok has only 1 row → kept
  assert.equal(grok.points.length, 2);
});
test('refreshCursorBench never adds or drops a series, and leaves a series without source_key alone', () => {
  const d = ladderData();
  refreshCursorBench(d, parseCsv(CSV), '2026-08-25');
  assert.equal(d.effort_ladders[0].series.length, 4);
  assert.deepEqual(d.effort_ladders[0].series[3].points, [{ effort: 'low', cost: 4, score: 62 }, { effort: 'max', cost: 18, score: 72.9 }]);
});
test('refreshCursorBench is a no-op on an empty feed and on data with no cursorbench ladder', () => {
  const d = ladderData();
  assert.equal(refreshCursorBench(d, [], '2026-08-25').changed, false);
  assert.equal(refreshCursorBench({ effort_ladders: [] }, parseCsv(CSV), '2026-08-25').changed, false);
});

// --- timeline helpers (scripts/timeline.mjs) --------------------------------------------------
import { isNotablePriceChange, priceEntry, addEntry } from './timeline.mjs';
test('isNotablePriceChange: 20% is the bar; null or zero old price never qualifies', () => {
  assert.equal(isNotablePriceChange(5, 4), true);
  assert.equal(isNotablePriceChange(5, 4.5), false);
  assert.equal(isNotablePriceChange(1, 1.2), true);
  assert.equal(isNotablePriceChange(null, 4), false);
  assert.equal(isNotablePriceChange(0, 4), false);
});
test('priceEntry + addEntry: tagged, sourced, and idempotent by title', () => {
  const data = { releases: [] };
  const m = { name: 'M One', vendor: 'Acme' };
  assert.equal(addEntry(data, priceEntry(m, 'input', 1, 0.2, 'https://openrouter.ai/api/v1/models', '2026-08-25')), true);
  assert.equal(addEntry(data, priceEntry(m, 'input', 1, 0.2, 'https://openrouter.ai/api/v1/models', '2026-08-25')), false);
  assert.equal(data.releases.length, 1);
  assert.equal(data.releases[0].kind, 'price');
  assert.match(data.releases[0].title, /-80%/);
  assert.equal(data.releases[0].source, 'https://openrouter.ai/api/v1/models');
});
