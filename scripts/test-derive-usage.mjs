import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateUsageRows, deriveUsageForCatalog } from './derive-usage.mjs';

const MODELS = [
  { id: 'gemini-3-8-flash', name: 'Gemini 3.8 Flash' },
  { id: 'claude-fable-5-1', name: 'Claude Fable 5.1' },
  { id: 'unrelated-model', name: 'Unrelated Model' },
];

test('aggregateUsageRows: sums prompt+completion tokens per permaslug across variant rows', () => {
  const rows = [
    { date: '2026-09-06 00:00:00', model_permaslug: 'google/gemini-3.8-flash-20260902', variant: 'standard', total_prompt_tokens: 100, total_completion_tokens: 20, count: 5 },
    { date: '2026-09-06 00:00:00', model_permaslug: 'google/gemini-3.8-flash-20260902', variant: 'thinking', total_prompt_tokens: 50, total_completion_tokens: 10, count: 2 },
    { date: '2026-09-06 00:00:00', model_permaslug: 'anthropic/claude-fable-5.1-20260831', total_prompt_tokens: 200, total_completion_tokens: 50, count: 9 },
  ];
  const agg = aggregateUsageRows(rows);
  const gemini = agg.find((a) => a.permaslug.includes('gemini'));
  assert.equal(gemini.tokens, 180); // 100+20+50+10
  assert.equal(gemini.requests, 7);
  assert.equal(gemini.date, '2026-09-06 00:00:00');
});

test('aggregateUsageRows: skips rows with no model_permaslug, never throws on garbage input', () => {
  assert.deepEqual(aggregateUsageRows([null, {}, { model_permaslug: '' }]), []);
  assert.deepEqual(aggregateUsageRows(null), []);
});

test('deriveUsageForCatalog: share is a straight percentage of the WHOLE feed (not just matched models)', () => {
  const rows = [
    { date: '2026-09-06 00:00:00', model_permaslug: 'google/gemini-3.8-flash-20260902', total_prompt_tokens: 900, total_completion_tokens: 0, count: 1 },
    { date: '2026-09-06 00:00:00', model_permaslug: 'some-other-vendor/some-other-model-20260101', total_prompt_tokens: 100, total_completion_tokens: 0, count: 1 },
  ];
  const map = deriveUsageForCatalog(rows, MODELS, {});
  const u = map.get('gemini-3-8-flash');
  assert.ok(u, 'expected gemini-3-8-flash to be matched');
  assert.equal(u.share, 90); // 900 / (900+100) * 100
  assert.equal(u.rank, 1);
  assert.equal(u.category, 'overall');
  assert.equal(u.as_of, '2026-09-06');
  assert.equal(u.source_url, 'https://openrouter.ai/api/frontend/v1/rankings/models');
  assert.equal(map.has('unrelated-model'), false, 'a model absent from the feed gets no entry (caller keeps its prior value)');
});

test('deriveUsageForCatalog: rank reflects the whole feed, including rows that never match a catalog model', () => {
  const rows = [
    { date: '2026-09-06 00:00:00', model_permaslug: 'zzz-vendor/zzz-model-20260101', total_prompt_tokens: 1000, total_completion_tokens: 0, count: 1 },
    { date: '2026-09-06 00:00:00', model_permaslug: 'anthropic/claude-fable-5.1-20260831', total_prompt_tokens: 500, total_completion_tokens: 0, count: 1 },
  ];
  const map = deriveUsageForCatalog(rows, MODELS, {});
  assert.equal(map.get('claude-fable-5-1').rank, 2); // #1 is the unmatched zzz-model
});

test('deriveUsageForCatalog: empty/zero-total feed returns an empty map, never a guessed share', () => {
  assert.deepEqual(deriveUsageForCatalog([], MODELS, {}), new Map());
  const zeroRows = [{ date: '2026-09-06 00:00:00', model_permaslug: 'a/b-20260101', total_prompt_tokens: 0, total_completion_tokens: 0, count: 0 }];
  assert.deepEqual(deriveUsageForCatalog(zeroRows, MODELS, {}), new Map());
});

test('deriveUsageForCatalog: a model with zero tokens never gets a fabricated 0% entry', () => {
  const rows = [
    { date: '2026-09-06 00:00:00', model_permaslug: 'google/gemini-3.8-flash-20260902', total_prompt_tokens: 100, total_completion_tokens: 0, count: 1 },
    { date: '2026-09-06 00:00:00', model_permaslug: 'anthropic/claude-fable-5.1-20260831', total_prompt_tokens: 0, total_completion_tokens: 0, count: 0 },
  ];
  const map = deriveUsageForCatalog(rows, MODELS, {});
  assert.equal(map.has('claude-fable-5-1'), false);
});
