import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalize, matchAlias, withinTolerance, factAgreement, withinSanityBounds,
  newerWins, admitNewModel, isKnownVendor, trackDeprecation, canonicalKey, evaluateFact,
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
  assert.deepEqual(r.deprecatedNow, []);
  state = r.state;
  r = trackDeprecation(state, new Set(['model-b']), ids); // model-a missing, run 2
  assert.deepEqual(r.deprecatedNow, ['model-a']);
});

test('trackDeprecation: reappearing resets the counter', () => {
  const ids = ['model-a'];
  let state = { 'model-a': 1 };
  const r = trackDeprecation(state, new Set(['model-a']), ids);
  assert.equal(r.state['model-a'], 0);
  assert.deepEqual(r.deprecatedNow, []);
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
