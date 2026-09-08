import test from 'node:test';
import assert from 'node:assert/strict';
import {
  matchTesterModel, rankBenchmarkRows, unmatchedNames, parseCsvRobust,
  extractLiveBenchDates, livebenchCompositeScore, rankLivebenchTask,
  mergeChosenForTags, chosenForBulk, rankArcPrizeRows, preferredForTask,
  assembleStandings, epochBenchmarkUrl, EPOCH_FILE_CONFIG, EPOCH_SKIP_FILES,
  LIVEBENCH_TASK_COLUMNS, ARC_PRIZE_DATASET_ID,
} from './derive-standings.mjs';

const MODELS = [
  { id: 'claude-fable-5-1', name: 'Claude Fable 5.1' },
  { id: 'claude-opus-5', name: 'Claude Opus 5' },
  { id: 'gemini-3-7-flash', name: 'Gemini 3.7 Flash' },
  { id: 'gemini-3-1-pro', name: 'Gemini 3.1 Pro' },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
  { id: 'qwen3-8-max', name: 'Qwen3.8 Max' },
  { id: 'gpt-5-6-sol', name: 'GPT-5.6 Sol' },
];
const ALIASES = {};

// --- matchTesterModel ---------------------------------------------------------------------------
test('matchTesterModel strips a hyphen-joined vendor prefix + an effort suffix, in one pass', () => {
  assert.equal(matchTesterModel('anthropic-claude-fable-5-1-high', MODELS, ALIASES), 'claude-fable-5-1');
  assert.equal(matchTesterModel('google-gemini-3-7-flash-high', MODELS, ALIASES), 'gemini-3-7-flash');
});
test('matchTesterModel tries the LEAST-stripped candidate first, so a real id is never over-stripped', () => {
  // "qwen3-8-max" IS the catalog id — "max" here is part of the product name, not an effort rung.
  // An over-eager strip would peel "-max" off as if it were an effort rung and land on
  // "qwen3-8", which doesn't exist in the catalog — the least-stripped candidate must win first.
  assert.equal(matchTesterModel('qwen3.8-max', MODELS, ALIASES), 'qwen3-8-max');
  assert.equal(matchTesterModel('qwen3-8-max', MODELS, ALIASES), 'qwen3-8-max');
});
test('matchTesterModel never matches a vendor word that is also a real catalog id\'s own first word', () => {
  assert.equal(matchTesterModel('gemini-3-1-pro', MODELS, ALIASES), 'gemini-3-1-pro');
  assert.equal(matchTesterModel('deepseek-v4-pro', MODELS, ALIASES), 'deepseek-v4-pro');
});
test('matchTesterModel returns null for a name with no catalog match — never guesses', () => {
  assert.equal(matchTesterModel('claude-opus-4-5-20251101-thinking-64k-high-effort', MODELS, ALIASES), null);
  assert.equal(matchTesterModel('totally-unknown-model', MODELS, ALIASES), null);
  assert.equal(matchTesterModel('', MODELS, ALIASES), null);
});

// --- rankBenchmarkRows ---------------------------------------------------------------------------
test('rankBenchmarkRows ranks by score descending and reports n_models as the WHOLE feed, not just matches', () => {
  const rows = [
    { 'Model version': 'claude-opus-5_high', Score: '0.70' },
    { 'Model version': 'unrelated-old-model', Score: '0.90' },
    { 'Model version': 'gemini-3-7-flash', Score: '0.65' },
  ];
  const out = rankBenchmarkRows(rows, { scoreCol: 'Score' }, MODELS, ALIASES);
  assert.equal(out.get('claude-opus-5').rank, 2); // beaten by the unmatched 0.90 row
  assert.equal(out.get('claude-opus-5').n_models, 3);
  assert.equal(out.get('gemini-3-7-flash').rank, 3);
  assert.equal(out.has('unrelated-old-model'), false); // never keyed by a non-catalog name
});
test('rankBenchmarkRows collapses multiple rungs of the same model to its single best-scoring row', () => {
  const rows = [
    { 'Model version': 'claude-opus-5_low', Score: '0.40', 'Reasoning level': 'Low' },
    { 'Model version': 'claude-opus-5_high', Score: '0.55', 'Reasoning level': 'High' },
    { 'Model version': 'claude-opus-5_max', Score: '0.70', 'Reasoning level': 'Max' },
    { 'Model version': 'gemini-3-7-flash', Score: '0.60' },
  ];
  const out = rankBenchmarkRows(rows, { scoreCol: 'Score', rungCol: 'Reasoning level' }, MODELS, ALIASES);
  assert.equal(out.get('claude-opus-5').score, 0.70);
  assert.equal(out.get('claude-opus-5').rung, 'Max');
  assert.equal(out.get('claude-opus-5').rungCount, 3);
  assert.equal(out.get('claude-opus-5').rank, 1); // best rung (0.70) beats gemini's 0.60
  // n_models counts 2 distinct base models (3 rungs collapsed to 1 + gemini), not 4 raw rows
  assert.equal(out.get('claude-opus-5').n_models, 2);
});
test('rankBenchmarkRows drops a row with a non-numeric or missing score, never fabricating one', () => {
  const rows = [{ 'Model version': 'claude-opus-5', Score: '' }, { 'Model version': 'gemini-3-7-flash', Score: 'n/a' }];
  const out = rankBenchmarkRows(rows, { scoreCol: 'Score' }, MODELS, ALIASES);
  assert.equal(out.size, 0);
});
test('rankBenchmarkRows supports lower-is-better metrics via higherIsBetter: false', () => {
  const rows = [
    { 'Model version': 'claude-opus-5', Cost: '2.5' },
    { 'Model version': 'gemini-3-7-flash', Cost: '1.0' },
  ];
  const out = rankBenchmarkRows(rows, { scoreCol: 'Cost', higherIsBetter: false }, MODELS, ALIASES);
  assert.equal(out.get('gemini-3-7-flash').rank, 1);
  assert.equal(out.get('claude-opus-5').rank, 2);
});

test('unmatchedNames lists each distinct raw name that never matched, deduplicated', () => {
  const rows = [
    { 'Model version': 'unrelated-a' }, { 'Model version': 'unrelated-a' },
    { 'Model version': 'unrelated-b' }, { 'Model version': 'claude-opus-5' },
  ];
  assert.deepEqual(unmatchedNames(rows, {}, MODELS, ALIASES), ['unrelated-a', 'unrelated-b']);
});

// --- parseCsvRobust -------------------------------------------------------------------------------
test('parseCsvRobust handles a quoted field with an embedded newline and comma (Epoch\'s notes column)', () => {
  const csv = 'Model version,Score,Notes\nclaude-opus-5,0.7,"multi-line,\nnote here"\ngemini-3-7-flash,0.6,plain\n';
  const rows = parseCsvRobust(csv);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]['Model version'], 'claude-opus-5');
  assert.equal(rows[0].Notes, 'multi-line,\nnote here');
  assert.equal(rows[1].Score, '0.6');
});
test('parseCsvRobust returns [] for empty/header-only input', () => {
  assert.deepEqual(parseCsvRobust(''), []);
  assert.deepEqual(parseCsvRobust('Model version,Score\n'), []);
});

// --- LiveBench ------------------------------------------------------------------------------------
test('extractLiveBenchDates finds the largest ISO-date array literal in a JS bundle, ignoring smaller ones', () => {
  const js = 'const x=["2024-01-01"];const pe=["2024-06-24","2025-04-02","2026-06-25"];';
  assert.deepEqual(extractLiveBenchDates(js), ['2024-06-24', '2025-04-02', '2026-06-25']);
});
test('extractLiveBenchDates returns [] when no date array is present', () => {
  assert.deepEqual(extractLiveBenchDates('const x = 5;'), []);
});

test('livebenchCompositeScore averages only the columns that parse as numbers on this row', () => {
  const row = { python: '80', javascript: '', typescript: '60' };
  assert.equal(livebenchCompositeScore(row, ['python', 'javascript', 'typescript']), 70);
});
test('livebenchCompositeScore returns null when nothing parses — never a fabricated partial average', () => {
  assert.equal(livebenchCompositeScore({ python: '' }, ['python']), null);
});
test('rankLivebenchTask maps a task id to its column group and ranks the composite', () => {
  const rows = [
    { model: 'claude-opus-5-max-effort', python: '90', javascript: '80', code_generation: '85', code_completion: '85', typescript: '85' },
    { model: 'gemini-3.7-flash-high', python: '50', javascript: '50', code_generation: '50', code_completion: '50', typescript: '50' },
  ];
  const out = rankLivebenchTask(rows, 'coding', MODELS, ALIASES);
  assert.equal(out.get('claude-opus-5').rank, 1);
  assert.equal(out.get('gemini-3-7-flash').rank, 2);
});
test('rankLivebenchTask returns an empty map for a task with no LIVEBENCH_TASK_COLUMNS entry', () => {
  assert.equal(rankLivebenchTask([{ model: 'claude-opus-5' }], 'chat', MODELS, ALIASES).size, 0);
  assert.ok(!('chat' in LIVEBENCH_TASK_COLUMNS));
});

// --- OpenRouter chosen ------------------------------------------------------------------------
test('mergeChosenForTags weights each tag by its own spendShareOfTotal, sums a model\'s share across tags', () => {
  const taskSpendMap = new Map([
    ['code:general_impl', { spendShareOfTotal: 0.3, models: [{ model: 'anthropic/claude-opus-5-20260723', share: 0.5 }] }],
    ['code:debugging', { spendShareOfTotal: 0.1, models: [{ model: 'anthropic/claude-opus-5-20260723', share: 0.2 }, { model: 'google/gemini-3.7-flash-20260601', share: 0.3 }] }],
  ]);
  const out = mergeChosenForTags(['code:general_impl', 'code:debugging'], taskSpendMap, MODELS, ALIASES);
  // weight(general_impl)=0.3/0.4=0.75, weight(debugging)=0.1/0.4=0.25
  // opus5 combined = 0.75*0.5 + 0.25*0.2 = 0.425 -> 42.5%
  assert.equal(out.get('claude-opus-5').share, 42.5);
  assert.equal(out.get('claude-opus-5').rank, 1);
  // gemini only in debugging: 0.25*0.3 = 0.075 -> 7.5%
  assert.equal(out.get('gemini-3-7-flash').share, 7.5);
  assert.equal(out.get('gemini-3-7-flash').rank, 2);
  assert.equal(out.get('claude-opus-5').n_models, 2); // union across both tags
});
test('mergeChosenForTags returns an empty map when no tag is found or every tag has zero weight', () => {
  assert.equal(mergeChosenForTags(['nonexistent-tag'], new Map(), MODELS, ALIASES).size, 0);
  const zeroWeight = new Map([['t', { spendShareOfTotal: 0, models: [{ model: 'x', share: 1 }] }]]);
  assert.equal(mergeChosenForTags(['t'], zeroWeight, MODELS, ALIASES).size, 0);
});
test('mergeChosenForTags never fabricates a share for a model missing from a merged tag (treated as 0, not interpolated)', () => {
  const taskSpendMap = new Map([
    ['a', { spendShareOfTotal: 0.5, models: [{ model: 'anthropic/claude-opus-5-20260723', share: 0.9 }] }],
    ['b', { spendShareOfTotal: 0.5, models: [{ model: 'google/gemini-3.7-flash-20260601', share: 0.9 }] }],
  ]);
  const out = mergeChosenForTags(['a', 'b'], taskSpendMap, MODELS, ALIASES);
  assert.equal(out.get('claude-opus-5').share, 45); // 0.5*0.9 + 0.5*0 = 0.45
  assert.equal(out.get('gemini-3-7-flash').share, 45);
});

test('chosenForBulk ranks by raw completion-token volume, full feed (not capped), share of the whole feed', () => {
  const rows = [
    { model_permaslug: 'anthropic/claude-opus-5-20260723', total_completion_tokens: 900, date: '2026-09-06' },
    { model_permaslug: 'zzz-vendor/zzz-model-20260101', total_completion_tokens: 100, date: '2026-09-06' },
  ];
  const out = chosenForBulk(rows, MODELS, ALIASES);
  const rec = out.get('claude-opus-5');
  assert.equal(rec.share, 90);
  assert.equal(rec.rank, 1);
  assert.equal(rec.n_models, 2); // includes the unmatched row in the denominator
  assert.equal(rec.as_of, '2026-09-06');
});
test('chosenForBulk never invents a rank for a model with zero completion tokens', () => {
  const rows = [{ model_permaslug: 'anthropic/claude-opus-5-20260723', total_completion_tokens: 0, date: '2026-09-06' }];
  assert.equal(chosenForBulk(rows, MODELS, ALIASES).size, 0);
});

// --- ARC Prize --------------------------------------------------------------------------------
test('rankArcPrizeRows filters to the named dataset only, ignoring other cuts in the same feed', () => {
  const rows = [
    { datasetId: 'v2_Semi_Private', modelId: 'anthropic-claude-opus-5-high', score: 0.5 },
    { datasetId: 'v1_Semi_Private', modelId: 'anthropic-claude-opus-5-high', score: 0.9 }, // wrong cut — must be ignored
    { datasetId: 'v2_Semi_Private', modelId: 'google-gemini-3-7-flash-high', score: 0.3 },
  ];
  const out = rankArcPrizeRows(rows, MODELS, ALIASES);
  assert.equal(out.get('claude-opus-5').score, 0.5); // not the 0.9 from the wrong dataset
  assert.equal(out.get('claude-opus-5').rank, 1);
  assert.equal(out.get('gemini-3-7-flash').rank, 2);
  assert.equal(out.get('claude-opus-5').n_models, 2);
});
test('rankArcPrizeRows respects ARC_PRIZE_DATASET_ID default ("v2_Semi_Private")', () => {
  assert.equal(ARC_PRIZE_DATASET_ID, 'v2_Semi_Private');
});

// --- Arena preferred --------------------------------------------------------------------------
test('preferredForTask reads rank/n_models/board_url straight off the snapshot, first-match-wins on a duplicate model_id', () => {
  const arenaFile = { as_of: '2026-09-07', tasks: { coding: { category: 'Text-Arena "Coding" (395 models)', board_url: 'https://arena.ai/leaderboard/text', n_models: 395, ranks: [{ model_id: 'claude-opus-5', rank: 8, votes: 100 }, { model_id: 'claude-opus-5', rank: 99 }] } } };
  const out = preferredForTask(arenaFile, 'coding');
  assert.equal(out.get('claude-opus-5').rank, 8); // first occurrence wins, not the later duplicate
  assert.equal(out.get('claude-opus-5').n_models, 395);
  assert.equal(out.get('claude-opus-5').board, 'Text-Arena "Coding" (395 models)');
  assert.equal(out.get('claude-opus-5').url, 'https://arena.ai/leaderboard/text');
});
test('preferredForTask falls back to ranks.length for n_models when the board never disclosed a total', () => {
  const arenaFile = { tasks: { agents: { category: 'top-10 card', ranks: [{ model_id: 'claude-opus-5', rank: 1 }] } } };
  assert.equal(preferredForTask(arenaFile, 'agents').get('claude-opus-5').n_models, 1);
});
test('preferredForTask returns an empty map for a task the snapshot never captured', () => {
  assert.equal(preferredForTask({ tasks: {} }, 'vision').size, 0);
  assert.equal(preferredForTask(null, 'vision').size, 0);
});

// --- assembleStandings ----------------------------------------------------------------------
test('assembleStandings gives every model every task, measured: [] / chosen: null / preferred: null when nothing was found — never a missing key', () => {
  const out = assembleStandings(MODELS, { asOf: '2026-09-07' });
  const rec = out.get('claude-opus-5');
  assert.equal(rec.as_of, '2026-09-07');
  for (const t of ['coding', 'agents', 'bulk', 'writing', 'research', 'extraction', 'chat', 'vision', 'frontend', 'exec-summaries']) {
    assert.ok(t in rec, `missing task key "${t}"`);
    assert.deepEqual(rec[t].measured, []);
    assert.equal(rec[t].chosen, null);
    assert.equal(rec[t].preferred, null);
  }
});
test('assembleStandings assembles measured rows from Epoch + ARC Prize + LiveBench for the right task, with the right tester id + licence', () => {
  const epochRanked = new Map([
    ['gpqa_diamond.csv', new Map([['claude-opus-5', { rank: 3, n_models: 40, score: 0.82, rung: null, rungCount: 1 }]])],
  ]);
  const epochTaskOf = new Map([['gpqa_diamond.csv', 'research']]);
  const arcRanked = new Map([['claude-opus-5', { rank: 5, n_models: 60, score: 0.4 }]]);
  const livebenchByTask = new Map([['research', new Map([['claude-opus-5', { rank: 2, n_models: 30, score: 55.5 }]])]]);
  const out = assembleStandings(MODELS, { epochRanked, epochTaskOf, arcRanked, livebenchByTask, asOf: '2026-09-07' });
  const research = out.get('claude-opus-5').research;
  assert.equal(research.measured.length, 3);
  const epochRow = research.measured.find((r) => r.tester === 'epoch-ai');
  assert.equal(epochRow.benchmark, 'GPQA Diamond');
  assert.equal(epochRow.rank, 3);
  assert.equal(epochRow.n_models, 40);
  assert.equal(epochRow.licence, 'display-ok');
  assert.equal(research.measured.some((r) => r.tester === 'arc-prize'), true);
  assert.equal(research.measured.some((r) => r.tester === 'livebench'), true);
  // a sibling task with no epoch mapping for gpqa gets nothing from it
  assert.deepEqual(out.get('claude-opus-5').chat.measured, []);
});
test('assembleStandings labels a multi-rung measured row with which rung won', () => {
  const epochRanked = new Map([['cursorbench_external.csv', new Map([['claude-opus-5', { rank: 1, n_models: 10, score: 0.7, rung: 'Max', rungCount: 3 }]])]]);
  const epochTaskOf = new Map([['cursorbench_external.csv', 'coding']]);
  const out = assembleStandings(MODELS, { epochRanked, epochTaskOf, asOf: '2026-09-07' });
  const row = out.get('claude-opus-5').coding.measured[0];
  assert.match(row.benchmark, /CursorBench \(best rung: Max\)/);
});
test('assembleStandings carries chosen.tags and preferred.board through from the ranked maps', () => {
  const chosenByTask = new Map([['coding', new Map([['claude-opus-5', { rank: 1, share: 40, n_models: 5 }]])]]);
  const chosenTagsOf = new Map([['coding', ['code:general_impl', 'code:debugging']]]);
  const preferredByTask = new Map([['coding', new Map([['claude-opus-5', { board: 'Text-Arena "Coding"', rank: 8, n_models: 395, url: 'https://arena.ai/leaderboard/text' }]])]]);
  const out = assembleStandings(MODELS, { chosenByTask, chosenTagsOf, preferredByTask, asOf: '2026-09-07' });
  const coding = out.get('claude-opus-5').coding;
  assert.deepEqual(coding.chosen, { rank: 1, share: 40, tags: ['code:general_impl', 'code:debugging'], n_models: 5, as_of: '2026-09-07', url: 'https://openrouter.ai/rankings' });
  assert.deepEqual(coding.preferred, { board: 'Text-Arena "Coding"', rank: 8, n_models: 395, as_of: '2026-09-07', url: 'https://arena.ai/leaderboard/text' });
});

// --- sanity on the static config tables (never let one drift silently) -----------------------
test('EPOCH_SKIP_FILES excludes the ARC-AGI-2 mirror (arc-prize is the primary source instead)', () => {
  assert.ok(EPOCH_SKIP_FILES.has('arc_agi_2_external.csv'));
  assert.ok(!('arc_agi_2_external.csv' in EPOCH_FILE_CONFIG));
});
test('epochBenchmarkUrl builds a stable epoch.ai benchmarks-page slug from the CSV filename', () => {
  assert.equal(epochBenchmarkUrl('swe_bench_verified.csv'), 'https://epoch.ai/benchmarks/swe-bench-verified');
});
