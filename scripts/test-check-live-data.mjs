import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  checkAsOf, checkModelCountRatio, checkDecideRuns, checkMustNotInclude,
} from './check-live-data.mjs';

// Frozen fixture, not live data/ — see scripts/fixtures/README.md.
const FIXTURES = new URL('./fixtures/', import.meta.url);
const readJson = (p) => JSON.parse(readFileSync(new URL(p, FIXTURES)));
const models = readJson('models.json').models;
const plans = readJson('plans.json').plans;
const presets = readJson('usage-presets.json').presets;
const vendors = readJson('vendors.json').vendors;
const situations = readJson('eval/situations.json').situations;
const data = { models, plans, presets, vendors };

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

test('checkDecideRuns does not throw against the frozen fixture and never cites an unknown id', () => {
  const { problems } = checkDecideRuns(data);
  assert.deepEqual(problems, []);
});

test('checkMustNotInclude holds against the frozen fixture', () => {
  const problems = checkMustNotInclude(situations, data);
  assert.deepEqual(problems, []);
});
