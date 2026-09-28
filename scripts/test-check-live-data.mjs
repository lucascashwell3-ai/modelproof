import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkAsOf, checkModelCountRatio, checkFeedHealth,
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
