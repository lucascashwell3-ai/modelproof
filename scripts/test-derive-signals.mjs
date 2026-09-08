import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  taskSignalMap, rankTaskSpendTag, rankBulkTokenVolume, arenaRanksForTask, expertDefaultsForTask,
  deriveSignalsForCatalog, TOP_N,
} from './derive-signals.mjs';
import { TASK_IDS } from './derive-task-fit.mjs';

const ROOT = new URL('../', import.meta.url);
const readJson = (p) => JSON.parse(readFileSync(new URL(p, ROOT)));

const models = readJson('data/models.json').models;
const aliases = readJson('scripts/model-aliases.json');
const tasksFile = readJson('data/tasks.json');
const arenaFile = readJson('data/signals/arena-2026-09.json');
const expertFile = readJson('data/signals/expert-defaults.json');

// ---------------------------------------------------------------------------------------------
// taskSignalMap
// ---------------------------------------------------------------------------------------------
test('taskSignalMap: every product task has an entry, and the shapes match data/tasks.json', () => {
  const map = taskSignalMap(tasksFile);
  for (const id of TASK_IDS) assert.ok(map.has(id), `missing openrouter_signal mapping for "${id}"`);
  assert.equal(map.get('coding').type, 'task_spend_tag');
  assert.equal(map.get('coding').tag, 'code:general_impl');
  assert.equal(map.get('bulk').type, 'token_volume');
  assert.equal(map.get('vision').type, null);
});

// ---------------------------------------------------------------------------------------------
// rankTaskSpendTag
// ---------------------------------------------------------------------------------------------
test('rankTaskSpendTag: matches known permaslugs, ranks in given order, caps at TOP_N, skips unmatched', () => {
  const tagModels = [
    { model: 'anthropic/claude-opus-5-20260723', share: 0.5 },
    { model: 'totally/unknown-model-xyz', share: 0.3 }, // unmatched — skipped, doesn't consume a rank
    { model: 'moonshotai/kimi-k3-20260715', share: 0.2 },
  ];
  const ranked = rankTaskSpendTag(tagModels, models, aliases);
  assert.equal(ranked.get('claude-opus-5').rank, 1);
  assert.equal(ranked.get('claude-opus-5').share, 50);
  assert.equal(ranked.get('kimi-k3').rank, 2); // unmatched row didn't consume rank 2
  assert.equal(ranked.has('totally/unknown-model-xyz'), false);
});

test('rankTaskSpendTag: never returns more than TOP_N entries', () => {
  const tagModels = Array.from({ length: TOP_N + 5 }, (_, i) => ({ model: 'anthropic/claude-opus-5-20260723', share: 0.01 }));
  // all rows resolve to the same id, so only the first is kept (dedup — see the "first match wins" rule)
  const ranked = rankTaskSpendTag(tagModels, models, aliases);
  assert.ok(ranked.size <= 1);
});

test('rankTaskSpendTag: a null/missing share stays null, never a guessed number', () => {
  const ranked = rankTaskSpendTag([{ model: 'anthropic/claude-opus-5-20260723' }], models, aliases);
  assert.equal(ranked.get('claude-opus-5').share, null);
});

// ---------------------------------------------------------------------------------------------
// rankBulkTokenVolume
// ---------------------------------------------------------------------------------------------
test('rankBulkTokenVolume: ranks by completion tokens only (not prompt+completion), matched via matchAlias', () => {
  const rows = [
    { model_permaslug: 'anthropic/claude-opus-5-20260723', total_completion_tokens: 100, total_prompt_tokens: 100000 },
    { model_permaslug: 'moonshotai/kimi-k3-20260715', total_completion_tokens: 500, total_prompt_tokens: 10 },
  ];
  const ranked = rankBulkTokenVolume(rows, models, aliases);
  // kimi-k3 has fewer combined tokens but far more COMPLETION tokens, so it must rank #1
  assert.equal(ranked.get('kimi-k3').rank, 1);
  assert.equal(ranked.get('claude-opus-5').rank, 2);
});

test('rankBulkTokenVolume: sums multiple variant rows for the same permaslug before ranking', () => {
  const rows = [
    { model_permaslug: 'anthropic/claude-opus-5-20260723', total_completion_tokens: 100 },
    { model_permaslug: 'anthropic/claude-opus-5-20260723', total_completion_tokens: 200 },
  ];
  const ranked = rankBulkTokenVolume(rows, models, aliases);
  assert.equal(ranked.get('claude-opus-5').rank, 1);
});

test('rankBulkTokenVolume: zero/negative completion tokens never occupy a rank', () => {
  const rows = [{ model_permaslug: 'anthropic/claude-opus-5-20260723', total_completion_tokens: 0 }];
  const ranked = rankBulkTokenVolume(rows, models, aliases);
  assert.equal(ranked.size, 0);
});

// ---------------------------------------------------------------------------------------------
// arenaRanksForTask / expertDefaultsForTask — pure reads of the static snapshot files' own shape
// ---------------------------------------------------------------------------------------------
test('arenaRanksForTask: reads the static snapshot for a real task, empty for a task with no coverage', () => {
  const coding = arenaRanksForTask(arenaFile, 'coding');
  assert.ok(coding.size > 0);
  assert.equal(coding.get('claude-fable-5'), 1);
  const bulk = arenaRanksForTask(arenaFile, 'bulk');
  assert.equal(bulk.size, 0); // documented gap — arena has no bulk/cost coverage
});

test('arenaRanksForTask: unknown task id returns an empty set, never throws', () => {
  assert.equal(arenaRanksForTask(arenaFile, 'not-a-real-task').size, 0);
  assert.equal(arenaRanksForTask(null, 'coding').size, 0);
});

test('expertDefaultsForTask: unions across every source (OR, not "most sources agree")', () => {
  const coding = expertDefaultsForTask(expertFile, 'coding');
  assert.ok(coding.has('claude-opus-5')); // named by both Cursor and the Anthropic guide
  assert.ok(coding.has('claude-sonnet-5'));
});

test('expertDefaultsForTask: a model named for a DIFFERENT task never counts here', () => {
  const bulk = expertDefaultsForTask(expertFile, 'bulk');
  assert.ok(bulk.has('claude-haiku-4-5'));
  assert.ok(!bulk.has('claude-opus-5')); // opus is never named for bulk in any source entry
});

// ---------------------------------------------------------------------------------------------
// deriveSignalsForCatalog — the full assembly, with families as the derived count
// ---------------------------------------------------------------------------------------------
const taskSpendByTag = new Map([
  ['code:general_impl', [
    { model: 'anthropic/claude-opus-5-20260723', share: 0.5 },
    { model: 'z-ai/nothing-real-here', share: 0.1 },
  ]],
]);

test('deriveSignalsForCatalog: families is the count of the 3 families that actually hit, 0-3, never invented', () => {
  const derived = deriveSignalsForCatalog(models, aliases, tasksFile, taskSpendByTag, [], arenaFile, expertFile);
  const opusCoding = derived.get('claude-opus-5').coding;
  // usage (task-spend, rank 1) + expert_default (both Cursor and Anthropic name Opus for coding) = 2;
  // arena's coding snapshot doesn't include claude-opus-5 (see data/signals/arena-2026-09.json).
  assert.equal(opusCoding.usage_rank, 1);
  assert.equal(opusCoding.expert_default, true);
  assert.equal(opusCoding.arena_rank, null);
  assert.equal(opusCoding.families, 2);
});

test('deriveSignalsForCatalog: a model with zero support in any family gets families: 0, not null', () => {
  const derived = deriveSignalsForCatalog(models, aliases, tasksFile, taskSpendByTag, [], arenaFile, expertFile);
  const rec = derived.get('kat-coder-pro-v2-5').coding;
  assert.equal(rec.families, 0);
  assert.equal(rec.usage_rank, null);
  assert.equal(rec.arena_rank, null);
  assert.equal(rec.expert_default, null); // null (never false) — "not confirmed", not "confirmed absent"
});

test('deriveSignalsForCatalog: every model gets a record for every TASK_ID, even with empty inputs', () => {
  const derived = deriveSignalsForCatalog(models, aliases, tasksFile, new Map(), [], { tasks: {} }, { sources: [] });
  for (const m of models) {
    const rec = derived.get(m.id);
    assert.ok(rec, `no signals record for ${m.id}`);
    for (const t of TASK_IDS) {
      assert.ok(rec[t], `${m.id} missing signals.${t}`);
      assert.equal(rec[t].families, 0);
    }
  }
});

test('deriveSignalsForCatalog: vision never gets a usage_rank/usage_share (documented OpenRouter gap)', () => {
  const derived = deriveSignalsForCatalog(models, aliases, tasksFile, taskSpendByTag, [], arenaFile, expertFile);
  for (const m of models) {
    const rec = derived.get(m.id).vision;
    assert.equal(rec.usage_rank, null);
    assert.equal(rec.usage_share, null);
  }
});
