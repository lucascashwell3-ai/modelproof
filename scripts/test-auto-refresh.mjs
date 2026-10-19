import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  normalize, matchAlias, withinTolerance, factAgreement, withinSanityBounds,
  newerWins, admitNewModel, isKnownVendor, trackDeprecation, canonicalKey, evaluateFact,
  buildWorklist, bestForLine, needsGuidance, pickGuidance, guidanceItem, parseCsv, rebuildCursorBench,
  cursorBenchSettings, cursorBenchModelId, latestReleaseDay, modelLine, nameVersion, ladderChangelogEntry, CURSORBENCH_METHOD, LADDER_LEVELS,
  admissionFacts, isCatalogVendor, hasOpenRouterPrice,
  releaseTitle, isKnownCandidate, findKnownModel, admissionFailReasons, formatDropLine,
  normalizeDisplayName, findNewCandidateIds, decideRefreshRun, FULL_PASS_MIN_HOURS, lastFullPassAt, hoursSinceFullPass, stampFullPass, collectReceipt,
  needsJudgedFit, pickJudgedFit, judgedFitItem, reJudgeWorklistItems, stripProviderPrefix,
} from './auto-refresh.mjs';
import { modelId, canonicalVendor, bareModelName, isCommunityListing, namingProblems, VENDORS, isCanonicalVendor, effortDateSuffixCandidates, stripEffortDateSuffix } from './naming.mjs';
import { validate } from './validate-data.mjs';
import { TASK_IDS } from './derive-task-fit.mjs';

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

test('releaseTitle: strips the vendor prefix already in the name, keeps its casing', () => {
  assert.equal(
    releaseTitle({ vendor: 'qwen', name: 'Qwen: Qwen3.8 Flash' }),
    'Qwen releases Qwen3.8 Flash',
  );
  assert.equal(
    releaseTitle({ vendor: 'google', name: 'Google: Gemini 3.8 Flash' }),
    'Google releases Gemini 3.8 Flash',
  );
});

test('releaseTitle: no vendor prefix in the name falls back to a display-cased vendor', () => {
  assert.equal(
    releaseTitle({ vendor: 'meta', name: 'Muse Spark 1.3' }),
    'Meta releases Muse Spark 1.3',
  );
  assert.equal(
    releaseTitle({ vendor: 'SomeNewLab', name: 'Foo 1' }),
    'SomeNewLab releases Foo 1',
  );
});

// --- normalizeDisplayName: strip "<Vendor>: " only when it names the vendor field ---------------
// Bug (2026-09-06, verified live): admission copied OpenRouter's "Vendor: Model Name" display
// name straight into `name`, so "Anthropic: Claude Fable 5.1", "OpenAI: GPT-6 Astra" and "OpenAI:
// GPT-6 Astra Pro" landed in the catalog verbatim, duplicating the vendor field in the model name.
test('normalizeDisplayName strips a leading vendor prefix that matches the vendor field', () => {
  assert.equal(normalizeDisplayName('Anthropic: Claude Fable 5.1', 'anthropic'), 'Claude Fable 5.1');
  assert.equal(normalizeDisplayName('OpenAI: GPT-6 Astra', 'openai'), 'GPT-6 Astra');
  assert.equal(normalizeDisplayName('OpenAI: GPT-6 Astra Pro', 'openai'), 'GPT-6 Astra Pro');
  assert.equal(normalizeDisplayName('Qwen: Qwen3.8 Max', 'qwen'), 'Qwen3.8 Max'); // casing differs, still matches
});

test('normalizeDisplayName leaves a prefix alone when it names a different vendor', () => {
  // A label naming some other vendor is not ours to remove — only strip a confirmed match.
  assert.equal(normalizeDisplayName('Acme: Grok 4.6', 'x-ai'), 'Acme: Grok 4.6');
  // "SpaceXAI" IS xAI written the way OpenRouter labels it — scripts/naming.mjs says so
  // explicitly (VENDOR_ALIASES), so this is a confirmed match, not a guess.
  assert.equal(normalizeDisplayName('SpaceXAI: Grok 4.6', 'x-ai'), 'Grok 4.6');
});

test('normalizeDisplayName is a no-op on a name with no vendor prefix', () => {
  assert.equal(normalizeDisplayName('Claude Opus 5', 'anthropic'), 'Claude Opus 5');
});

// --- cheap early exit: release watching every 2h without a second job -------------------------

// Frozen clock throughout: `now` is passed in, never read from the machine.
const NOW = new Date('2026-10-04T11:30:00Z');
const hoursAgo = (h) => new Date(NOW.getTime() - h * 36e5).toISOString();

test('decideRefreshRun: a full pass runs when the last one is 20 h or more ago, new ids or not', () => {
  assert.equal(FULL_PASS_MIN_HOURS, 20);
  assert.equal(decideRefreshRun([], { now: NOW, lastFullRunAt: hoursAgo(20) }), 'run');
  assert.equal(decideRefreshRun([], { now: NOW, lastFullRunAt: hoursAgo(26.5) }), 'run');
  assert.equal(decideRefreshRun([{ id: 'x', key: 'x' }], { now: NOW, lastFullRunAt: hoursAgo(30) }), 'run');
});

test('decideRefreshRun: skips inside 20 h with no new ids, whatever the clock hour', () => {
  assert.equal(decideRefreshRun([], { now: NOW, lastFullRunAt: hoursAgo(19.9) }), 'skip');
  assert.equal(decideRefreshRun([], { now: new Date('2026-10-04T06:00:00Z'), lastFullRunAt: '2026-10-03T23:00:00Z' }), 'skip', 'hour 06 is no longer special');
});

test('decideRefreshRun: a new id always runs, even right after a full pass', () => {
  assert.equal(decideRefreshRun([{ id: 'acme/new-1', key: 'new1' }], { now: NOW, lastFullRunAt: hoursAgo(1) }), 'run');
  assert.equal(decideRefreshRun(['anything'], { now: NOW, lastFullRunAt: hoursAgo(0) }), 'run');
});

test('decideRefreshRun: no receipt, a broken ran_at, or a future ran_at all count as "no full pass" -> run', () => {
  assert.equal(decideRefreshRun([], { now: NOW, lastFullRunAt: null }), 'run');
  assert.equal(decideRefreshRun([], { now: NOW, lastFullRunAt: 'not a date' }), 'run');
  assert.equal(decideRefreshRun([], { now: NOW, lastFullRunAt: '2026-10-05T00:00:00Z' }), 'run');
});

test('the real schedule (starts drift 10:12-12:55 and 19:57-00:05 UTC) gets exactly one full pass a day', () => {
  // Two late starts a day for a week, no new ids: count full passes per day.
  const starts = [];
  for (let d = 1; d <= 7; d += 1) {
    const day = `2026-10-${String(d).padStart(2, '0')}`;
    starts.push(`${day}T${d % 2 ? '10:12' : '12:55'}:00Z`, `${day}T${d % 2 ? '23:58' : '19:57'}:00Z`);
  }
  let last = null;
  const fullDays = [];
  for (const iso of starts) {
    if (decideRefreshRun([], { now: new Date(iso), lastFullRunAt: last }) === 'run') { last = iso; fullDays.push(iso.slice(0, 10)); }
  }
  assert.deepEqual(fullDays, ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07']);
});

test('lastFullPassAt: reads ran_at from a passing receipt; a failed or missing receipt is none', () => {
  assert.equal(lastFullPassAt({ job: 'collect', ran_at: '2026-10-02T21:45:46.071Z', ok: true }), '2026-10-02T21:45:46.071Z');
  assert.equal(lastFullPassAt({ job: 'collect', ran_at: '2026-10-02T21:45:46.071Z', ok: false }), null);
  assert.equal(lastFullPassAt(null), null);
  assert.equal(lastFullPassAt({ ok: true }), null);
  assert.equal(hoursSinceFullPass('2026-10-04T01:30:00Z', NOW), 10);
});

test('findNewCandidateIds: a candidate matching a known model is not new', () => {
  const models = [{ id: 'claude-fable-5-1', name: 'Claude Fable 5.1' }];
  const aliases = {};
  const orList = [{ id: 'anthropic/claude-fable-5.1', name: 'Anthropic: Claude Fable 5.1' }];
  assert.deepEqual(findNewCandidateIds({ orList, models, aliases, pending: [] }), []);
});

test('findNewCandidateIds: a genuinely unknown candidate is new, keyed for persistence', () => {
  const models = [{ id: 'claude-fable-5-1', name: 'Claude Fable 5.1' }];
  const aliases = {};
  const orList = [{ id: 'acme/brand-new-model', name: 'Acme: Brand New Model' }];
  const out = findNewCandidateIds({ orList, models, aliases, pending: [] });
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'acme/brand-new-model');
  assert.equal(out[0].key, canonicalKey('Acme: Brand New Model'));
});

test('findNewCandidateIds: a candidate already in `pending` (a prior cycle already flagged it) is not new again', () => {
  const models = [];
  const aliases = {};
  const orList = [{ id: 'acme/still-unresolved', name: 'Acme: Still Unresolved' }];
  const key = canonicalKey('Acme: Still Unresolved');
  assert.equal(findNewCandidateIds({ orList, models, aliases, pending: [key] }).length, 0);
});

test('findNewCandidateIds: variant tags and free/preview suffixes never count as new', () => {
  const models = [];
  const aliases = {};
  const orList = [
    { id: 'acme/model-x:online', name: 'Acme: Model X (online)' },
    { id: 'acme/model-y:free', name: 'Acme: Model Y' },
    { id: 'acme/model-z-preview-3', name: 'Acme: Model Z Preview 3' },
  ];
  assert.deepEqual(findNewCandidateIds({ orList, models, aliases, pending: [] }), []);
});

// Regression (found testing this against the live OpenRouter feed, 2026-09-06): a candidate
// listed months ago that our narrow curated catalog never picked up is NOT a launch — without a
// staleness cutoff, every long-standing OpenRouter listing outside the catalog counts as "new"
// forever, which is exactly the noise release watching is supposed to ignore.
test('findNewCandidateIds: a listing older than maxAgeDays is stale, not a launch', () => {
  const models = [];
  const aliases = {};
  const orList = [{ id: 'acme/ancient-model', name: 'Acme: Ancient Model', created: '2026-01-01' }];
  assert.deepEqual(findNewCandidateIds({ orList, models, aliases, pending: [], today: '2026-09-06' }), []);
});

test('findNewCandidateIds: a listing inside the staleness window still counts as new', () => {
  const models = [];
  const aliases = {};
  const orList = [{ id: 'acme/fresh-model', name: 'Acme: Fresh Model', created: '2026-08-20' }];
  const out = findNewCandidateIds({ orList, models, aliases, pending: [], today: '2026-09-06' });
  assert.equal(out.length, 1);
});

// LiteLLM's price table is not scanned for new candidates — see the function's own doc comment
// for why (~3,200 "new" ids on a single live run, almost the whole table). This test just pins
// that a caller passing llmList through has no effect; it's the OR-only scope that matters.
test('findNewCandidateIds: an extra llmList argument is ignored — only orList is scanned', () => {
  const models = [];
  const aliases = {};
  const orList = [];
  const llmList = [{ id: 'acme/only-on-litellm', name: 'acme/only-on-litellm' }];
  assert.deepEqual(findNewCandidateIds({ orList, llmList, models, aliases, pending: [] }), []);
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

// 2026-09 fix round: OpenRouter's rankings/models feed dates some permaslugs with a full ISO
// calendar date ("openai/o4-mini-2025-04-16") instead of the contiguous 8-digit form
// ("anthropic/claude-opus-5-20260723") — both must strip down to the same bare id, or a model's
// real usage silently reads as null forever (o4-mini's exact bug).
test('canonicalKey also strips the ISO-hyphenated date form some feeds use ("-2025-04-16")', () => {
  assert.equal(canonicalKey('openai/o4-mini-2025-04-16'), canonicalKey('o4-mini'));
  assert.equal(canonicalKey('openai/o4-mini-high-2025-04-16'), canonicalKey('o4-mini-high'));
});

// --- isKnownCandidate: point releases are NEW models, real aliases still dedupe ----------------
// Bug (2026-09-06, verified live): isKnownCandidate compared fully-stripped canonicalKey values
// with substring containment. canonicalKey deletes every separator, so "claude-fable-5" ->
// "claudefable5" is a plain PREFIX of "claude-fable-5.1" -> "claudefable51" — the point release
// was silently treated as already-known and dropped before ever reaching the admission rule.
//
// Fix: exact key match only, never containment. A "prefix/suffix boundary" exception (allow a
// non-digit word suffix to still count as the same model) was tried and rejected — verifying it
// against the live OpenRouter feed showed it ALSO merges genuinely different models that share a
// word stem ("Z.ai: GLM 5.3" vs "GLM 5.3 Flash", "Ling 3.0 Flash" vs "Ling 3.0 Flash Fin"), which
// is exactly the silent-merge bug class being fixed. The only leniency kept is prefix-stripping:
// provider ids ("anthropic/x"), display vendor names ("MoonshotAI: x"), and date/variant suffixes
// — all resolved via findKnownModel()'s dedupKey, then compared for EQUALITY, never containment.

test('isKnownCandidate: a point-release bump is a NEW model, not a known one', () => {
  const models = [{ id: 'claude-fable-5', name: 'Claude Fable 5' }];
  const aliases = {};
  assert.equal(isKnownCandidate('anthropic/claude-fable-5.1', models, aliases), false);
  assert.equal(isKnownCandidate('Anthropic: Claude Fable 5.1', models, aliases), false);
  assert.equal(findKnownModel('anthropic/claude-fable-5.1', models, aliases), null);
  // a genuinely different, differently-suffixed model never dedupes just for sharing a stem
  assert.equal(isKnownCandidate('Claude Fable 5 Pro', models, aliases), false);
});

test('isKnownCandidate: provider-prefixed ids still dedupe (equality, not containment)', () => {
  const models = [{ id: 'claude-opus-5', name: 'Claude Opus 5' }];
  const aliases = { 'claude-opus-5': ['claude opus 5'] };
  assert.equal(isKnownCandidate('anthropic/claude-opus-5', models, aliases), true);
  assert.equal(findKnownModel('anthropic/claude-opus-5', models, aliases), 'claude-opus-5');
  assert.equal(isKnownCandidate('claude-opus-5-20260723', models, aliases), true); // date suffix
});

// Regression case (found verifying this fix against the live feed): OpenRouter/LiteLLM display
// names come as "Vendor: Model Name" ("MoonshotAI: Kimi K3", "Z.ai: GLM 5.3", "Qwen: Qwen3 Max").
// A naive containment-to-equality swap would have newly (and wrongly) surfaced every one of these
// as a fake "new model", because canonicalKey doesn't strip that human-readable vendor prefix.
// findKnownModel() strips it (stripDisplayVendorPrefix) before comparing.
test('isKnownCandidate: a "Vendor: Model" display name still dedupes against the bare model', () => {
  const models = [
    { id: 'kimi-k3', name: 'Kimi K3' },
    { id: 'glm-5-3', name: 'GLM-5.3' },
    { id: 'qwen3-max', name: 'Qwen3-Max' },
  ];
  const aliases = {};
  assert.equal(isKnownCandidate('MoonshotAI: Kimi K3', models, aliases), true);
  assert.equal(findKnownModel('MoonshotAI: Kimi K3', models, aliases), 'kimi-k3');
  assert.equal(isKnownCandidate('Z.ai: GLM 5.3', models, aliases), true);
  assert.equal(isKnownCandidate('Qwen: Qwen3 Max', models, aliases), true);
  // but a real variant of that same vendor-prefixed model is still a distinct candidate
  assert.equal(isKnownCandidate('Z.ai: GLM 5.3 Flash', models, aliases), false);
});

// --- dropped: <id> — <reason> run-log line: no candidate disappears silently -------------------

test('formatDropLine + admissionFailReasons produce the exact dropped: log wording', () => {
  assert.equal(formatDropLine('vendor/model-x', 'known as claude-fable-5'), 'dropped: vendor/model-x — known as claude-fable-5');
  assert.deepEqual(admissionFailReasons({ sourceCount: 1, hasPricing: true, vendorKnown: true }), ['single source']);
  assert.deepEqual(admissionFailReasons({ sourceCount: 2, hasPricing: true, vendorKnown: false }), ['unknown vendor']);
  assert.deepEqual(admissionFailReasons({ sourceCount: 1, hasPricing: false, vendorKnown: false }), [
    'single source', 'no pricing data', 'unknown vendor',
  ]);
  assert.equal(
    formatDropLine('acme/new-thing', admissionFailReasons({ sourceCount: 1, hasPricing: true, vendorKnown: true }).join(', ')),
    'dropped: acme/new-thing — single source',
  );
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

test('buildWorklist places judged-fit after guidance, both below every other kind', () => {
  const items = [
    { id: 'j1', kind: 'judged-fit' }, { id: 'g1', kind: 'guidance' }, { id: 'r1', kind: 'release' },
  ];
  const out = buildWorklist(items);
  assert.deepEqual(out.map((i) => i.kind), ['release', 'guidance', 'judged-fit']);
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

test('a quiet full pass stamps as_of with the receipt date, so refresh-verify accepts it instead of reverting', async () => {
  const { verifyLive, EXIT } = await import('./verify-live.mjs');
  // Frozen clock: the same instant gives today (as_of) and the receipt's ran_at, as main() does.
  const now = new Date('2026-10-04T23:58:30Z');
  const today = now.toISOString().slice(0, 10);
  const data = { as_of: '2026-10-02', models: [] }; // nothing changed on this pass
  assert.equal(stampFullPass(data, today), true);
  assert.equal(data.as_of, '2026-10-04');
  const receipt = collectReceipt({ ranAt: now.toISOString(), ok: true });
  assert.equal(receipt.ran_at.slice(0, 10), data.as_of, "receipt date == as_of");
  // refresh-verify.yml: want = receipt ran_at[:10], --at-least, live = what Collect published.
  const run = (liveAsOf) => verifyLive({
    want: receipt.ran_at.slice(0, 10), atLeast: true, sha: 'abc', repo: 'acme/site', url: 'https://example.invalid/models.json',
    fetchLive: async () => ({ as_of: liveAsOf }), fetchPagesRun: async () => ({ status: 'completed', conclusion: 'success' }),
    now: (() => { let t = 0; return () => (t += 60_000); })(), sleep: async () => {}, log: () => {}, timeoutSec: 600, graceSec: 60,
  });
  assert.equal(await run(data.as_of), EXIT.VERIFIED, "stamped as_of passes verify");
  assert.equal(await run("2026-10-02"), EXIT.DEPLOY_WRONG, 'the old behavior (as_of left behind) fails verify: the revert case');
  assert.equal(stampFullPass(data, today), false, 'a second stamp the same day is a no-op');
});

test('collectReceipt: the documented shape; a failed gate carries ok:false + error', () => {
  const r = collectReceipt({ ranAt: '2026-10-04T11:30:00.000Z', applied: 2, ok: true });
  assert.deepEqual(Object.keys(r), ['job', 'ran_at', 'applied', 'held', 'confirmed', 'new_models', 'dropped', 'worklist_items', 'availability_changed', 'usage_changed', 'ok']);
  assert.deepEqual(collectReceipt({ ranAt: 'x', ok: false }).error, 'honesty gate failed');
  assert.equal(lastFullPassAt(collectReceipt({ ranAt: 'x', ok: false })), null, 'a failed pass never counts as the last full pass');
});

test('collect receipt has the documented shape', () => {
  const receipt = { job: 'collect', ran_at: new Date().toISOString(), applied: 0, held: 0, confirmed: 0, new_models: 0, dropped: 0, worklist_items: 0, ok: true };
  for (const k of ['job', 'ran_at', 'applied', 'held', 'confirmed', 'new_models', 'dropped', 'worklist_items', 'ok']) {
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

// --- judged task fit rotation (2026-09-06) --------------------------------------------------
const TF_NULL = (reason) => ({ score: null, basis: [], reason });
const J = (id, extra = {}) => ({
  id, name: id, price_input: 1, price_output: 2,
  task_fit: Object.fromEntries(TASK_IDS.map((t) => [t, TF_NULL('fixture')])),
  task_fit_judged: null,
  ...extra,
});
test('needsJudgedFit: a model with any null task and no judged record needs one; fully covered or deprecated models don\'t', () => {
  assert.equal(needsJudgedFit(J('a')), true);
  assert.equal(needsJudgedFit(J('b', { deprecated: true })), false);
  const fullyJudged = J('c', { task_fit_judged: Object.fromEntries(TASK_IDS.map((t) => [t, { claims: [{ sentence: 'x', source_url: 'https://acme.example', tier: 'lab', date: '2026-09-01', quote: 'x' }], reconciliation: null, as_of: '2026-09-01' }])) });
  assert.equal(needsJudgedFit(fullyJudged), false);
  const oneTaskLeft = J('d', { task_fit: { ...J('d').task_fit, coding: { score: 80, basis: ['coding_score'] } } });
  assert.equal(needsJudgedFit(oneTaskLeft), true); // still 9 other null tasks
});
test('pickJudgedFit takes at most perRun, newest-released first when usage is unsourced, then rotates by id', () => {
  const models = [J('m1', { released: '2026-01-01' }), J('m2', { released: '2026-06-01' }), J('m3', { released: '2026-03-01' })];
  const { picked, cursor } = pickJudgedFit(models, {}, 2);
  assert.deepEqual(picked, ['m2', 'm3']); // newest two by released date
  assert.equal(cursor, 'm3');
});
test('pickJudgedFit prefers a sourced usage share over release date', () => {
  const models = [
    J('old-but-popular', { released: '2026-01-01', usage: { openrouter: { share: 40 } } }),
    J('new-but-obscure', { released: '2026-08-01' }),
  ];
  const { picked } = pickJudgedFit(models, {}, 1);
  assert.deepEqual(picked, ['old-but-popular']);
});
test('pickJudgedFit rotates: the next run resumes after the cursor and wraps around', () => {
  const models = ['m1', 'm2', 'm3'].map((id) => J(id));
  const r1 = pickJudgedFit(models, {}, 2);
  assert.deepEqual(r1.picked, ['m1', 'm2']);
  const r2 = pickJudgedFit(models, { judgedFitCursor: r1.cursor }, 2);
  assert.deepEqual(r2.picked, ['m3', 'm1']);
});
test('pickJudgedFit: models with every task judged drop out; empty catalog returns nothing', () => {
  const fullyJudged = J('done', { task_fit_judged: Object.fromEntries(TASK_IDS.map((t) => [t, { claims: [{ sentence: 'x', source_url: 'https://acme.example', tier: 'lab', date: '2026-09-01', quote: 'x' }], reconciliation: null, as_of: '2026-09-01' }])) });
  assert.deepEqual(pickJudgedFit([fullyJudged, J('open')], {}, 5).picked, ['open']);
  assert.deepEqual(pickJudgedFit([], {}, 5).picked, []);
});
test('judgedFitItem names exactly the tasks still missing a basis, and is a judged-fit worklist item', () => {
  const m = J('m1', { name: 'M One', task_fit: { ...J('m1').task_fit, coding: { score: 80, basis: ['coding_score'] } } });
  const item = judgedFitItem(m, '2026-09-06');
  assert.equal(item.kind, 'judged-fit');
  assert.equal(item.id, 'm1:judged-fit');
  assert.doesNotMatch(item.ask, /\bcoding\b,/); // coding already has a quantitative score — not asked about
  assert.match(item.ask, /agents/);
});
test('reJudgeWorklistItems: a same-vendor successor queues every judged task the OTHER model already carries, and only that vendor', () => {
  const predecessor = J('old-1', { name: 'Old One', vendor: 'Acme', task_fit_judged: { coding: { claims: [{ sentence: 'x', source_url: 'https://acme.example', tier: 'lab', date: '2026-08-01', quote: 'x' }], reconciliation: null, as_of: '2026-08-01' } } });
  const otherVendor = J('other-1', { name: 'Other One', vendor: 'OtherCo', task_fit_judged: { coding: { claims: [{ sentence: 'x', source_url: 'https://acme.example', tier: 'lab', date: '2026-08-01', quote: 'x' }], reconciliation: null, as_of: '2026-08-01' } } });
  const noJudgedYet = J('old-2', { name: 'Old Two', vendor: 'Acme', task_fit_judged: null });
  const newModel = J('new-1', { name: 'New One', vendor: 'Acme' });
  const items = reJudgeWorklistItems(newModel, [predecessor, otherVendor, noJudgedYet, newModel], '2026-09-06');
  assert.equal(items.length, 1);
  assert.equal(items[0].model, 'Old One');
  assert.equal(items[0].kind, 'judged-fit');
  assert.match(items[0].ask, /New One/);
  assert.match(items[0].ask, /coding/);
});
test('reJudgeWorklistItems: no items when nothing from that vendor has a judged record yet', () => {
  const newModel = J('new-1', { name: 'New One', vendor: 'Acme' });
  assert.deepEqual(reJudgeWorklistItems(newModel, [J('sibling', { vendor: 'Acme' }), newModel], '2026-09-06'), []);
});

// --- CursorBench ladder: the model list rebuilt by one rule from Epoch's CSV -------------------
const CB_HEAD = 'Model version,Score,Reasoning level,Cost per task,Release date,Name,Notes';
const CB_ROWS = [
  'claude-opus-5_low,0.407,Low,4.87,2026-07-24,Opus 5 Low,',
  'claude-opus-5_medium,0.433,Medium,6.94,2026-07-24,Opus 5 Medium,',
  'claude-opus-5_max,0.466,Max,11.95,2026-07-24,"Opus 5, Max","a note, with a comma and a',
  'line break inside the quotes"',
  'claude-opus-5-5_low,0.43700000000000006,Low,1.17,2026-09-22,Opus 5.5 Low,',
  'claude-opus-5-5_medium,0.525,Medium,2.912,2026-09-22,Opus 5.5 Medium,',
  'claude-opus-5-5_max,0.578,Max,13.43,2026-09-22,Opus 5.5 Max,"says ""max"" twice"',
  'gpt-5.6-sol_low,0.246,Low,0.87,2026-07-09,GPT-5.6 Sol Low,',
  'gpt-5.6-sol_medium,0.311,Medium,1.77,2026-07-09,GPT-5.6 Sol Medium,',
  'gpt-5.6-sol_high,0.357,High,2.85,2026-07-09,GPT-5.6 Sol High,',
  'gpt-5.6-sol_max,,Max,8.23,2026-07-09,GPT-5.6 Sol Max,',
  'gpt-5.6-terra_low,0.252,Low,0.52,2026-07-09,GPT-5.6 Terra Low,',
  'gpt-5.6-terra_medium,0.276,Medium,,2026-07-09,GPT-5.6 Terra Medium,',
  'gpt-5.6-terra_high,0.307,High,1.11,2026-07-09,GPT-5.6 Terra High,',
  'gpt-5.6-terra_max,0.413,Max,5.14,2026-07-09,GPT-5.6 Terra Max,',
  'grok-4.6_low,0.334,Low,2.25,2026-08-12,Grok 4.6 Low,',
  'grok-4.6_medium,0.361,Medium,3.48,2026-08-12,Grok 4.6 Medium,',
  'grok-4.6_high,0.404,High,5.2,2026-08-12,Grok 4.6 High,',
  'muse-spark-1.3_minimal,0.243,,0.56,2026-09-02,Muse Spark 1.3 Minimal,',
  'muse-spark-1.3_low,0.293,Low,0.93,2026-09-02,Muse Spark 1.3 Low,',
  'muse-spark-1.3_max,0.416,Max,2.64,2026-09-02,Muse Spark 1.3 Max,',
  'gemini-3.8-flash_medium,0.373,Medium,4.06,2026-09-02,Gemini 3.8 Flash Medium,',
  'gemini-3.8-flash_high,0.396,High,4.7,2026-09-02,Gemini 3.8 Flash High,',
  'glm-5.3-flash_low,0.269,Low,0.15,2026-08-20,GLM 5.3 Flash Low,',
  'glm-5.3-flash_high,0.311,High,0.25,2026-08-20,GLM 5.3 Flash High,',
  'glm-5.3-flash_max,0.368,Max,0.39,2026-08-20,GLM 5.3 Flash Max,',
  'Composer 2.5,0.277,,0.68,2026-05-18,Composer 2.5,',
];
const cbCsv = (rows = CB_ROWS) => [CB_HEAD, ...rows].join('\n') + '\n';
const cbModel = (id, name, vendor, released, rank) => ({ id, name, vendor, released, usage: { openrouter: rank == null ? null : { rank } } });
const CB_PROVENANCE = {
  id: 'cursorbench-agentic-coding', suite: 'CursorBench', task: 'Agentic coding', x_label: 'Cost per task (USD, log scale)', y_label: 'Score (%)',
  as_of: '2026-09-22', publisher: 'Epoch AI (mirroring Cursor\'s CursorBench)', source_kind: 'third-party', source: 'https://epoch.ai/benchmarks/use-this-data',
  confidence: 'high', method: 'the old fixed list', harness: 'Cursor\'s agent', caveat: 'Run by Cursor.', levels: ['low', 'medium', 'high', 'xhigh', 'max'],
};
const ladderData = () => ({
  models: [
    cbModel('claude-opus-5', 'Claude Opus 5', 'Anthropic', '2026-07-23', 33),
    cbModel('claude-opus-5-5', 'Claude Opus 5.5', 'Anthropic', '2026-09-22', 7),
    cbModel('gpt-5-6-sol', 'GPT-5.6 Sol', 'OpenAI', '2026-07-09', 37),
    cbModel('gpt-5-6-terra', 'GPT-5.6 Terra', 'OpenAI', '2026-07-09', null),
    cbModel('grok-4-6', 'Grok 4.6', 'xAI', '2026-04-01', 85),
    cbModel('muse-spark-1-3', 'Muse Spark 1.3', 'Meta', '2026-09', 61),
    cbModel('gemini-3-8-flash', 'Gemini 3.8 Flash', 'Google', '2026-09-02', 19),
  ],
  effort_ladders: [
    { id: 'frontier-bench-v0-1-agentic-coding', suite: 'Frontier-Bench v0.1', as_of: '2026-07-24', series: [{ model_id: 'claude-opus-5', label: 'Opus 5', points: [{ effort: 'low', cost: 5.63, score: 25.8 }, { effort: 'max', cost: 16.48, score: 43.3 }] }] },
    { ...CB_PROVENANCE, series: [
      { model_id: 'claude-opus-5', label: 'Opus 5', color: '#e05c3e', source_key: 'claude-opus-5', points: [{ effort: 'low', cost: 4.87, score: 40.7 }, { effort: 'max', cost: 11.95, score: 46.6 }] },
      { model_id: 'grok-4-6', label: 'Grok 4.6', color: '#7fd9b4', source_key: 'grok-4.6', points: [{ effort: 'low', cost: 2.25, score: 33.4 }, { effort: 'high', cost: 5.2, score: 40.4 }] },
    ] },
  ],
});
const cbLadder = (d) => d.effort_ladders.find((l) => l.id === 'cursorbench-agentic-coding');
const TODAY_CB = '2026-10-18';

test('parseCsv reads quoted commas, quoted line breaks, doubled quotes and blank cells', () => {
  const rows = parseCsv(cbCsv());
  assert.equal(rows.length, CB_ROWS.length - 1, 'the quoted line break stays inside one row');
  assert.equal(rows[2].Name, 'Opus 5, Max');
  assert.equal(rows[2].Notes, 'a note, with a comma and a\nline break inside the quotes');
  assert.equal(rows[5].Notes, 'says "max" twice');
  assert.equal(rows[9].Score, '');
});

test('rebuildCursorBench: catalog models measured at 3+ settings, newest of each line, ordered by usage rank (unknown last)', () => {
  const d = ladderData();
  const r = rebuildCursorBench(d, parseCsv(cbCsv()), TODAY_CB);
  assert.equal(r.changed, true);
  const L = cbLadder(d);
  assert.deepEqual(L.series.map((s) => [s.label, s.usage_rank, s.points.length]), [
    ['Claude Opus 5.5', 7, 3], ['GPT-5.6 Sol', 37, 3], ['Muse Spark 1.3', 61, 3], ['GPT-5.6 Terra', null, 3],
  ]);
  assert.deepEqual(L.series[0], {
    model_id: 'claude-opus-5-5', label: 'Claude Opus 5.5', source_key: 'claude-opus-5-5', usage_rank: 7,
    points: [{ effort: 'low', cost: 1.17, score: 43.7 }, { effort: 'medium', cost: 2.91, score: 52.5 }, { effort: 'max', cost: 13.43, score: 57.8 }],
  });
  assert.equal(L.series[1].model_id, 'gpt-5-6-sol', 'the stem "gpt-5.6-sol" names catalog id gpt-5-6-sol');
  assert.equal(L.series[1].source_key, 'gpt-5.6-sol');
  assert.deepEqual(L.series[2].points.map((p) => p.effort), ['minimal', 'low', 'max'], 'minimal sorts first; points run in effort order');
  assert.deepEqual(r.before, ['Opus 5', 'Grok 4.6']);
  assert.deepEqual(r.after, ['Claude Opus 5.5', 'GPT-5.6 Sol', 'Muse Spark 1.3', 'GPT-5.6 Terra']);
  const why = r.notes.join('\n');
  assert.match(why, /Claude Opus 5: Claude Opus 5\.5 is the newest in its line/);
  assert.match(why, /Grok 4\.6: released 2026-04-01, over 150 days ago/);
  assert.match(why, /Gemini 3\.8 Flash: 2 measured setting\(s\), needs 3/);
  assert.match(why, /glm-5\.3-flash: not in the catalog/);
});

test('rebuildCursorBench: a row without both a cost and a score is dropped, never filled in', () => {
  const d = ladderData();
  rebuildCursorBench(d, parseCsv(cbCsv()), TODAY_CB);
  const byId = Object.fromEntries(cbLadder(d).series.map((s) => [s.model_id, s]));
  assert.deepEqual(byId['gpt-5-6-sol'].points.map((p) => p.effort), ['low', 'medium', 'high'], 'Sol max has no score');
  assert.deepEqual(byId['gpt-5-6-terra'].points.map((p) => p.effort), ['low', 'high', 'max'], 'Terra medium has no cost');
  // one more blank leaves Sol with 2 settings, below the bar: it leaves the chart
  const d2 = ladderData();
  rebuildCursorBench(d2, parseCsv(cbCsv(CB_ROWS.map((l) => (l.startsWith('gpt-5.6-sol_high') ? 'gpt-5.6-sol_high,0.357,High,,2026-07-09,x,' : l)))), TODAY_CB);
  assert.ok(!cbLadder(d2).series.some((s) => s.model_id === 'gpt-5-6-sol'));
});

test('rebuildCursorBench: ages a model out after 150 days, using the file\'s full date when the catalog only has a month', () => {
  const run = (today) => { const d = ladderData(); rebuildCursorBench(d, parseCsv(cbCsv()), today); return cbLadder(d).series.map((s) => s.model_id); };
  assert.ok(run('2026-12-06').includes('gpt-5-6-sol'), 'released 2026-07-09: day 150 is still shown');
  assert.ok(!run('2026-12-07').includes('gpt-5-6-sol'), 'day 151 is not');
  assert.ok(run('2027-01-30').includes('muse-spark-1-3'), 'catalog says 2026-09, the file says 2026-09-02: day 150');
  assert.ok(!run('2027-01-31').includes('muse-spark-1-3'));
});

test('latestReleaseDay: the last day a released value can mean', () => {
  assert.equal(latestReleaseDay('2026-09-01'), '2026-09-01');
  assert.equal(latestReleaseDay('2026-07'), '2026-07-31');
  assert.equal(latestReleaseDay('2026-02'), '2026-02-28');
  assert.equal(latestReleaseDay('2028-02'), '2028-02-29');
  assert.equal(latestReleaseDay('2026-Q1'), '2026-03-31');
  assert.equal(latestReleaseDay('2026-Q4'), '2026-12-31');
  assert.equal(latestReleaseDay('2026'), '2026-12-31');
  assert.equal(latestReleaseDay(null), null);
  assert.equal(latestReleaseDay('unknown'), null);
});

test('modelLine: the vendor plus the name without version numbers; size tags still tell models apart', () => {
  const line = (name, vendor = 'Anthropic') => modelLine({ name, vendor });
  assert.equal(line('Claude Opus 5'), line('Claude Opus 5.5'));
  assert.equal(line('Claude Opus 4.8'), line('Claude Opus 5.5'));
  assert.notEqual(line('Claude Opus 5'), line('Claude Sonnet 5'));
  assert.equal(line('GPT-5.6 Sol', 'OpenAI'), line('GPT-6.1 Sol', 'OpenAI'));
  assert.notEqual(line('GPT-5.6 Sol', 'OpenAI'), line('GPT-5.6 Terra', 'OpenAI'));
  assert.notEqual(line('GPT-6 Sol', 'OpenAI'), line('GPT-6 Sol Pro', 'OpenAI'));
  assert.equal(line('Kimi K2.6', 'Moonshot AI'), line('Kimi K3', 'Moonshot AI'));
  assert.notEqual(line('Qwen3.8 27B', 'Alibaba (Qwen)'), line('Qwen3.8 35B', 'Alibaba (Qwen)'));
  assert.notEqual(line('Muse Spark 1.3', 'Meta'), line('Muse Spark 1.3 Contributor', 'Meta'));
  assert.notEqual(line('Zeta 2', 'Meta'), line('Zeta 2', 'Google'), 'same name, other vendor: another line');
  assert.deepEqual(nameVersion('Claude Opus 5.5'), [5, 5]);
  assert.deepEqual(nameVersion('Qwen3.8 27B'), [3, 8]);
  assert.deepEqual(nameVersion('DeepSeek V4 Pro 0813'), [4, 813]);
});

test('rebuildCursorBench: same release day in one line -> the higher version number is the newest', () => {
  const d = ladderData();
  d.models.push(cbModel('muse-spark-1-2', 'Muse Spark 1.2', 'Meta', '2026-09-02', 3));
  const rows = [...CB_ROWS, 'muse-spark-1.2_low,0.2,Low,0.5,2026-09-02,a,', 'muse-spark-1.2_high,0.3,High,0.9,2026-09-02,b,', 'muse-spark-1.2_max,0.35,Max,1.2,2026-09-02,c,'];
  const r = rebuildCursorBench(d, parseCsv(cbCsv(rows)), TODAY_CB);
  const ids = cbLadder(d).series.map((s) => s.model_id);
  assert.ok(ids.includes('muse-spark-1-3') && !ids.includes('muse-spark-1-2'));
  assert.match(r.notes.join('\n'), /Muse Spark 1\.2: Muse Spark 1\.3 is the newest in its line/);
});

test('rebuildCursorBench: keeps provenance, writes the rule as method, sets default_count and levels, and goes first', () => {
  const d = ladderData();
  rebuildCursorBench(d, parseCsv(cbCsv()), TODAY_CB);
  const L = d.effort_ladders[0];
  assert.equal(L.id, 'cursorbench-agentic-coding');
  assert.equal(d.effort_ladders[1].id, 'frontier-bench-v0-1-agentic-coding', 'the other ladders keep their order behind it');
  for (const k of ['suite', 'task', 'x_label', 'y_label', 'publisher', 'source_kind', 'source', 'confidence', 'harness', 'caveat']) assert.equal(L[k], CB_PROVENANCE[k], k);
  assert.equal(L.method, CURSORBENCH_METHOD);
  assert.match(L.method, /3 or more effort settings/);
  assert.match(L.method, /150 days/);
  assert.equal(L.default_count, 5);
  assert.deepEqual(L.levels, LADDER_LEVELS);
  assert.deepEqual(LADDER_LEVELS, ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(L.as_of, TODAY_CB);
  assert.ok(L.series.every((s) => !('color' in s)), 'series carry no colours; the page picks them');
});

test('rebuildCursorBench: as_of moves only when the shown models or points change, not on a new usage order', () => {
  const d = ladderData();
  rebuildCursorBench(d, parseCsv(cbCsv()), TODAY_CB);
  const again = rebuildCursorBench(d, parseCsv(cbCsv()), '2026-10-20');
  assert.equal(again.changed, false);
  assert.equal(cbLadder(d).as_of, TODAY_CB);
  // fresher usage ranks reorder the series but are not new benchmark data
  const reordered = rebuildCursorBench(d, parseCsv(cbCsv()), '2026-10-21', { rankOf: (m) => (m.id === 'gpt-5-6-terra' ? 1 : m.usage?.openrouter?.rank ?? null) });
  assert.equal(reordered.changed, false);
  assert.equal(cbLadder(d).series[0].label, 'GPT-5.6 Terra');
  assert.equal(cbLadder(d).series[0].usage_rank, 1);
  assert.equal(cbLadder(d).as_of, TODAY_CB);
  // a changed score is new data
  const moved = rebuildCursorBench(d, parseCsv(cbCsv(CB_ROWS.map((l) => l.replace('gpt-5.6-terra_max,0.413', 'gpt-5.6-terra_max,0.42')))), '2026-10-22');
  assert.equal(moved.changed, true);
  assert.equal(cbLadder(d).as_of, '2026-10-22');
});

test('rebuildCursorBench never blanks: an empty feed, a rule with no series, or no ladder leaves the data untouched', () => {
  const d = ladderData();
  const before = JSON.stringify(d);
  assert.equal(rebuildCursorBench(d, [], TODAY_CB).changed, false);
  assert.equal(JSON.stringify(d), before);
  const none = rebuildCursorBench(d, parseCsv(cbCsv(['grok-4.6_low,0.334,Low,2.25,2026-08-12,a,', 'glm-5.3-flash_low,0.2,Low,0.1,2026-08-20,b,'])), TODAY_CB);
  assert.equal(none.changed, false);
  assert.match(none.notes.join('\n'), /the rule yields no series — ladder kept as is/);
  assert.equal(JSON.stringify(d), before);
  const noLadder = { models: d.models, effort_ladders: [d.effort_ladders[0]] };
  assert.equal(rebuildCursorBench(noLadder, parseCsv(cbCsv()), TODAY_CB).changed, false);
  assert.equal(noLadder.effort_ladders.length, 1);
});

test('cursorBenchSettings: a row that disagrees with itself, a setting listed twice with two values, and out-of-range numbers are dropped', () => {
  const notes = [];
  const rows = parseCsv(cbCsv([
    'm-1_high,0.5,Low,2,2026-09-01,a,',          // suffix says high, column says Low
    'm-1_low,0.4,Low,1,2026-09-01,b,',
    'm-1_low,0.41,Low,1,2026-09-01,c,',          // a second, different low
    'm-1_max,0.6,Max,4,2026-09-01,d,',
    'm-1_max,0.6,Max,4,2026-09-01,e,',           // an identical repeat is one setting
    'm-1_xhigh,46.6,Extra High,3,2026-09-01,f,', // a percent, not the file's fraction
    'm-1_medium,0.45,Medium,0,2026-09-01,g,',    // a zero cost can't sit on a log axis
    'm-1_turbo,0.45,,1,2026-09-01,h,',           // not an effort setting
  ]));
  const s = cursorBenchSettings(rows, notes).get('m-1');
  assert.deepEqual([...s.points.keys()], ['max']);
  assert.equal(s.released, '2026-09-01');
  assert.match(notes.join('\n'), /m-1_high: its reasoning level says "Low" — row dropped/);
  assert.match(notes.join('\n'), /m-1 @ low: listed twice with different values — dropped/);
  assert.equal(cursorBenchModelId('GPT-5.6-Sol'), 'gpt-5-6-sol');
});

test('ladderChangelogEntry: old and new model lists, the Epoch source, a note when only points moved', () => {
  assert.deepEqual(ladderChangelogEntry({ before: ['Opus 5', 'Grok 4.6'], after: ['Claude Opus 5.5'] }, TODAY_CB), {
    date: TODAY_CB, model: 'CursorBench ladder', field: 'effort_ladders', old: 'Opus 5, Grok 4.6', new: 'Claude Opus 5.5',
    sources: ['https://epoch.ai/data/benchmark_data.zip'],
  });
  assert.equal(ladderChangelogEntry({ before: ['A'], after: ['A'] }, TODAY_CB).note, 'same models; measured points changed');
});

// --- new-model admission: a vendor already in the catalog gets in on OpenRouter alone ------------
test('admission: a vendor the catalog already carries is admitted on its priced OpenRouter listing alone', () => {
  const catalog = [{ id: 'muse-spark-1-3', name: 'Muse Spark 1.3', vendor: 'Meta' }];
  const wonder = { id: 'meta/muse-wonder', name: 'Meta: Muse Wonder', priceInput: 4, priceOutput: 20, created: '2026-10-12' };
  const facts = admissionFacts(wonder, catalog);
  assert.deepEqual(facts, { sourceCount: 1, hasPricing: true, vendorKnown: true, vendorInCatalog: true, openRouterPriced: true });
  assert.equal(admitNewModel(facts), true);
  assert.deepEqual(admissionFailReasons(facts), []);
  const unpriced = admissionFacts({ ...wonder, priceInput: null, priceOutput: null }, catalog);
  assert.equal(admitNewModel(unpriced), false);
  assert.deepEqual(admissionFailReasons(unpriced), ['no OpenRouter price']);
  assert.equal(formatDropLine(wonder.id, admissionFailReasons(unpriced).join(', ')), 'dropped: meta/muse-wonder — no OpenRouter price');
  // a catalog vendor that is not on the auto-admit list gets the same one-source path
  assert.equal(admitNewModel(admissionFacts({ id: 'tencent/hy5', name: 'Tencent: Hy5', priceInput: 1, priceOutput: 2 }, [{ id: 'hy3', vendor: 'Tencent' }])), true);
});

test('admission: a vendor the catalog does not carry keeps the two-source rule', () => {
  const catalog = [{ id: 'muse-spark-1-3', name: 'Muse Spark 1.3', vendor: 'Meta' }];
  const nova = { id: 'amazon/nova-9', name: 'Amazon: Nova 9', priceInput: 1, priceOutput: 4 };
  const one = admissionFacts(nova, catalog);
  assert.equal(one.vendorInCatalog, false);
  assert.equal(admitNewModel(one), false);
  assert.deepEqual(admissionFailReasons(one), ['single source']);
  assert.equal(admitNewModel(admissionFacts(nova, catalog, { id: 'amazon/nova-9', priceInput: 1 })), true, 'a second source still admits it');
  const acme = { id: 'acme/zeta-1', name: 'Acme: Zeta 1', priceInput: 1, priceOutput: 2 };
  assert.equal(admitNewModel(admissionFacts(acme, catalog, { id: 'zeta-1', priceInput: 1 })), false, 'an unknown vendor never auto-admits');
  assert.deepEqual(admissionFailReasons(admissionFacts(acme, catalog)), ['single source', 'unknown vendor']);
});

test('isCatalogVendor matches by canonical vendor; hasOpenRouterPrice needs a price above zero', () => {
  const catalog = [{ id: 'llama-4-maverick', vendor: 'Meta' }, { id: 'hy3', vendor: 'Tencent' }];
  assert.equal(isCatalogVendor('meta', catalog), true);
  assert.equal(isCatalogVendor('meta-llama', catalog), true);
  assert.equal(isCatalogVendor('tencent', catalog), true);
  assert.equal(isCatalogVendor('~meta', catalog), false);
  assert.equal(isCatalogVendor('google', catalog), false);
  assert.equal(isCatalogVendor('acme', catalog), false);
  assert.equal(hasOpenRouterPrice({ priceInput: 4, priceOutput: null }), true);
  assert.equal(hasOpenRouterPrice({ priceInput: null, priceOutput: 0.5 }), true);
  assert.equal(hasOpenRouterPrice({ priceInput: null, priceOutput: null }), false);
  assert.equal(hasOpenRouterPrice({ priceInput: -1e6, priceOutput: -1e6 }), false, 'OpenRouter lists -1 for a router, not a price');
  assert.equal(hasOpenRouterPrice({ priceInput: 0, priceOutput: 0 }), false);
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

// --- the naming rule (scripts/naming.mjs), 2026-09 -------------------------------------------
// Auto-admitted records used to carry OpenRouter's routing path as the id ("google-gemini-3-8-flash",
// "qwen-qwen3-8-flash", "-deepseek-deepseek-v4-flash-latest") and the feed's lowercase vendor key
// ("google", "qwen", "~deepseek") next to hand-written "Google" / "Alibaba (Qwen)". One rule now:
// id = slug of the model's own name, vendor = one canonical spelling, enforced by the honesty gate.

test('modelId: slug of the name, no vendor glued on, parentheticals dropped', () => {
  assert.equal(modelId('Gemini 3.8 Flash'), 'gemini-3-8-flash');
  assert.equal(modelId('Google: Gemini 3.8 Flash'), 'gemini-3-8-flash');        // feed label stripped
  assert.equal(modelId('Muse Spark 1.3'), 'muse-spark-1-3');
  assert.equal(modelId('Qwen: Qwen3.8 Flash'), 'qwen3-8-flash');
  assert.equal(modelId('DeepSeek: DeepSeek V4 Pro 0813'), 'deepseek-v4-pro-0813'); // the name itself says DeepSeek
  assert.equal(modelId('Tencent: Hy4 preview'), 'hy4-preview');
  assert.equal(modelId('Gemini 3.1 Pro (Preview)'), 'gemini-3-1-pro');
  assert.equal(modelId('Hy-MT2-1.8B'), 'hy-mt2-1-8b');
  assert.equal(modelId('o4-mini'), 'o4-mini');
  assert.equal(modelId('Claude Fable 5.1'), 'claude-fable-5-1');
});

test('canonicalVendor: every feed spelling lands on one display name; unknown and ~community are null', () => {
  assert.equal(canonicalVendor('google'), 'Google');
  assert.equal(canonicalVendor('x-ai'), 'xAI');
  assert.equal(canonicalVendor('SpaceXAI'), 'xAI');
  assert.equal(canonicalVendor('qwen'), 'Alibaba (Qwen)');
  assert.equal(canonicalVendor('Qwen (Alibaba)'), 'Alibaba (Qwen)');
  assert.equal(canonicalVendor('moonshotai'), 'Moonshot AI');
  assert.equal(canonicalVendor('Mistral AI'), 'Mistral AI');
  assert.equal(canonicalVendor('z-ai'), 'Z.ai (Zhipu)');
  assert.equal(canonicalVendor('Thinking Machines'), 'Thinking Machines Lab');
  assert.equal(canonicalVendor('~deepseek'), null);          // community re-host is not the vendor
  assert.equal(canonicalVendor('SomeRandomStartup'), null);
  for (const v of VENDORS) assert.equal(canonicalVendor(v), v);   // canonical names are fixed points
  assert.equal(isCanonicalVendor('deepseek'), false);
});

test('bareModelName: strips a label that names this vendor, keeps one that names another', () => {
  assert.equal(bareModelName('Google: Gemini 3.8 Flash', 'Google'), 'Gemini 3.8 Flash');
  assert.equal(bareModelName('ByteDance Seed: Seed 2.1 Turbo', 'ByteDance'), 'Seed 2.1 Turbo');
  assert.equal(bareModelName('Sakana: Sakana Namazu', 'Sakana AI'), 'Sakana Namazu');
  assert.equal(bareModelName('Acme: Zeta 1', 'Upstage'), 'Acme: Zeta 1');
  assert.equal(bareModelName('Claude Opus 5', 'Anthropic'), 'Claude Opus 5');
});

test('isCommunityListing: "~vendor/…" OpenRouter ids are community re-hosts', () => {
  assert.equal(isCommunityListing('~deepseek/deepseek-v4-flash-latest'), true);
  assert.equal(isCommunityListing('deepseek/deepseek-v4-flash-0731'), false);
});

test('findNewCandidateIds never treats a community listing as a launch', () => {
  const orList = [{ id: '~deepseek/deepseek-v4-flash-latest', name: 'DeepSeek V4 Flash Latest', created: '2026-09-05' }];
  assert.deepEqual(findNewCandidateIds({ orList, models: [], aliases: {}, pending: [], today: '2026-09-06' }), []);
});

test('isKnownVendor (auto-admit policy) resolves through the canonical map', () => {
  assert.equal(isKnownVendor('x-ai'), true);
  assert.equal(isKnownVendor('qwen'), true);
  assert.equal(isKnownVendor('tencent'), false);      // listed vendor, but admits via the Judge only
  assert.equal(isKnownVendor('~deepseek'), false);
});

test('canonicalKey strips ANY routing segment, so a clean id still meets its OpenRouter path', () => {
  assert.equal(canonicalKey('tencent/hy4-preview'), canonicalKey('hy4-preview'));
  assert.equal(canonicalKey('meta/muse-spark-1.3'), canonicalKey('muse-spark-1-3'));
  assert.equal(canonicalKey('x-ai/grok-4.6'), canonicalKey('grok-4-6'));
  assert.equal(canonicalKey('qwen/qwen3.8-flash'), canonicalKey('qwen3-8-flash'));
  const models = [{ id: 'hy4-preview', name: 'Hy4 preview' }];
  assert.equal(matchAlias('tencent/hy4-preview', models, {}), 'hy4-preview');
});

// --- stripProviderPrefix: hyphen-joined vendor prefixes (2026-09-07) ---------------------------
// ARC Prize's own modelId strings ("anthropic-claude-fable-5-1-high") join the vendor with a
// hyphen instead of a "/" or a ".", which the pre-fix PROVIDER_PREFIX regex never matched
// (data/testers.json's arc-prize entry flagged this live, 2026-09-07).
test('stripProviderPrefix strips a hyphen-joined vendor prefix ARC Prize actually publishes', () => {
  assert.equal(stripProviderPrefix('anthropic-claude-fable-5-1-high'), 'claude-fable-5-1-high');
  assert.equal(stripProviderPrefix('google-gemini-3-7-flash-high'), 'gemini-3-7-flash-high');
  assert.equal(stripProviderPrefix('x-ai-grok-4-6'), 'grok-4-6');
  assert.equal(stripProviderPrefix('meta-muse-spark-1-2'), 'muse-spark-1-2');
  // 2026-09 fix round: Epoch's own shorthand for Thinking Machines Lab — no catalog id starts
  // with "thinky", checked against the whole catalog before adding this.
  assert.equal(stripProviderPrefix('thinky-inkling'), 'inkling');
});
test('stripProviderPrefix never strips a vendor word that is also a real catalog id\'s own first word', () => {
  // "gemini"/"deepseek"/"qwen" are both vendor aliases AND the literal first word of a real
  // catalog id — stripping them here would corrupt canonicalKey for our own models.
  assert.equal(stripProviderPrefix('gemini-3-1-pro'), 'gemini-3-1-pro');
  assert.equal(stripProviderPrefix('deepseek-v4-pro'), 'deepseek-v4-pro');
  assert.equal(stripProviderPrefix('qwen-turbo'), 'qwen-turbo');
  assert.equal(canonicalKey('gemini-3-1-pro'), canonicalKey('Gemini 3.1 Pro'));
  assert.equal(canonicalKey('deepseek-v4-pro'), canonicalKey('DeepSeek V4 Pro'));
});
test('stripProviderPrefix still strips the existing slash/dot forms unchanged', () => {
  assert.equal(stripProviderPrefix('anthropic/claude-opus-5'), 'claude-opus-5');
  assert.equal(stripProviderPrefix('vertex_ai.gemini-3.5-flash'), 'gemini-3.5-flash');
});

// --- effortDateSuffixCandidates / stripEffortDateSuffix (promoted from scripts/_audit/map-names.mjs) ---
test('stripEffortDateSuffix peels reasoning-effort, thinking-mode and date suffixes down to a bare slug', () => {
  assert.equal(stripEffortDateSuffix('claude-opus-4-5-20251101-thinking-64k-high-effort'), 'claude-opus-4-5');
  assert.equal(stripEffortDateSuffix('claude-fable-5-1_high'), 'claude-fable-5-1');
  assert.equal(stripEffortDateSuffix('gemini-3-7-flash-high'), 'gemini-3-7-flash');
  assert.equal(stripEffortDateSuffix('gpt-5-6-sol'), 'gpt-5-6-sol'); // no known suffix — unchanged
});
test('effortDateSuffixCandidates includes every intermediate peel, starting with the input itself', () => {
  const cands = effortDateSuffixCandidates('claude-fable-5-1-max-effort');
  assert.ok(cands.includes('claude-fable-5-1-max-effort'));
  assert.ok(cands.includes('claude-fable-5-1'));
});

// 2026-09 fix round: a tester row can carry "no reasoning-effort setting reported" (none/unknown),
// a vendor-tier noise word (minimal/promax), or a context-window suffix (16k/32k/59k/128k) — all
// of these were previously left unstripped, silently dropping real coverage (see the PR notes for
// the exact standings-unmapped.md names this fixes: claude-opus-5_unknown, gpt-5.6-sol_none,
// claude-haiku-4-5-20251001_32K, etc. — every example below is one of those real names, slugged).
test('stripEffortDateSuffix: none/unknown/minimal/promax and context-window (…k) suffixes are noise, not part of the id', () => {
  assert.equal(stripEffortDateSuffix('claude-opus-5-unknown'), 'claude-opus-5');
  assert.equal(stripEffortDateSuffix('gpt-5-6-sol-none'), 'gpt-5-6-sol');
  assert.equal(stripEffortDateSuffix('deepseek-v4-flash-none'), 'deepseek-v4-flash');
  assert.equal(stripEffortDateSuffix('grok-4-5-unknown'), 'grok-4-5');
  assert.equal(stripEffortDateSuffix('some-model-minimal'), 'some-model');
  assert.equal(stripEffortDateSuffix('some-model-promax'), 'some-model');
  assert.equal(stripEffortDateSuffix('claude-haiku-4-5-20251001-32k'), 'claude-haiku-4-5', 'both the date suffix and the context-size suffix peel off, in either order');
  assert.equal(stripEffortDateSuffix('some-model-16k'), 'some-model');
  assert.equal(stripEffortDateSuffix('some-model-128k'), 'some-model');
});

// This is candidate GENERATION only (effortDateSuffixCandidates never asserts a real id exists) —
// the actual safety comes from matchAlias() requiring an EXACT key match, tested here end to end
// against real fixture models so a peeled candidate that happens not to be a real catalog id
// simply matches nothing, and a genuinely different version is never silently conflated with one
// that merely shares a prefix.
test('matchAlias safety: a fully-peeled candidate that names a DIFFERENT real version never matches the wrong one', () => {
  const models = JSON.parse(readFileSync(new URL('./fixtures/models.json', import.meta.url))).models;
  const aliases = JSON.parse(readFileSync(new URL('./model-aliases.json', import.meta.url)));
  const peeledButUnreal = [
    stripEffortDateSuffix('claude-opus-4-5-20251101'), // NOT claude-opus-5
    stripEffortDateSuffix('gpt-5-2025-08-07'), // NOT gpt-5-5
  ];
  for (const cand of peeledButUnreal) assert.equal(matchAlias(cand, models, aliases), null, `"${cand}" must not match any catalog model`);
  // deepseek-v4-flash-0731 is its OWN catalog id (a 4-digit date, not an 8-digit run/snapshot
  // date) — the date-suffix regex only strips 8-digit dates, so this must survive unstripped.
  assert.equal(stripEffortDateSuffix('deepseek-v4-flash-0731'), 'deepseek-v4-flash-0731');
});

test('namingProblems: a clean record has none', () => {
  assert.deepEqual(namingProblems({ id: 'gemini-3-8-flash', name: 'Gemini 3.8 Flash', vendor: 'Google' }), []);
  assert.deepEqual(namingProblems({ id: 'gemini-3-1-pro', name: 'Gemini 3.1 Pro (Preview)', vendor: 'Google' }), []);
  assert.deepEqual(namingProblems({ id: 'deepseek-v4-pro-0813', name: 'DeepSeek V4 Pro 0813', vendor: 'DeepSeek' }), []);
});

const REGISTRY = { sources: [] };
// These naming-rule fixtures don't care about task_fit — give every one a minimal-but-valid
// task_fit{} + task_fit_judged so the (separate) task_fit gate never fires here and each test
// stays about the one naming rule it names.
const BLANK_TASK_FIT = Object.fromEntries(TASK_IDS.map((t) => [t, { score: null, basis: [], reason: 'naming-rule test fixture — task fit not exercised here' }]));
const BLANK_SIGNALS = Object.fromEntries(TASK_IDS.map((t) => [t, { usage_rank: null, usage_share: null, arena_rank: null, expert_default: null, families: 0 }]));
const BLANK_STANDINGS = { as_of: '2026-09-07', ...Object.fromEntries(TASK_IDS.map((t) => [t, { measured: [], chosen: null, preferred: null }])) };
const cleanData = (models) => ({
  models: models.map((m) => ({ task_fit: BLANK_TASK_FIT, task_fit_judged: null, usage: { openrouter: null }, status: 'ga', adoption: 'unknown', signals: BLANK_SIGNALS, standings: BLANK_STANDINGS, ...m })),
  releases: [],
  effort_ladders: [],
});
const errorsFor = (m) => validate(cleanData([m]), REGISTRY).errors;

test('honesty gate REJECTS a vendor-glued id', () => {
  const e = errorsFor({ id: 'google-gemini-3-8-flash', name: 'Gemini 3.8 Flash', vendor: 'Google' });
  assert.ok(e.some((x) => /id "google-gemini-3-8-flash" must be derived from the name/.test(x)), e.join('\n'));
});

test('honesty gate REJECTS a lowercase feed vendor and names the canonical spelling', () => {
  const e = errorsFor({ id: 'gemini-3-8-flash', name: 'Gemini 3.8 Flash', vendor: 'google' });
  assert.ok(e.some((x) => /vendor "google" must be written "Google"/.test(x)), e.join('\n'));
});

test('honesty gate REJECTS a ~community vendor and a junk id shape', () => {
  const e = errorsFor({ id: '-deepseek-deepseek-v4-flash-latest', name: 'DeepSeek V4 Flash Latest', vendor: '~deepseek' });
  assert.ok(e.some((x) => /not a clean slug/.test(x)), e.join('\n'));
  assert.ok(e.some((x) => /vendor "~deepseek" is not in scripts\/naming.mjs VENDORS/.test(x)), e.join('\n'));
});

test('honesty gate REJECTS a name that repeats the vendor as a label', () => {
  const e = errorsFor({ id: 'gemini-3-8-flash', name: 'Google: Gemini 3.8 Flash', vendor: 'Google' });
  assert.ok(e.some((x) => /repeats the vendor as a label/.test(x)), e.join('\n'));
});

test('honesty gate REJECTS an unknown free-form vendor and duplicate ids', () => {
  const e = errorsFor({ id: 'zeta-1', name: 'Zeta 1', vendor: 'Acme' });
  assert.ok(e.some((x) => /vendor "Acme" is not in scripts\/naming.mjs VENDORS/.test(x)), e.join('\n'));
  const d = validate(cleanData([
    { id: 'zeta-1', name: 'Zeta 1', vendor: 'Upstage' },
    { id: 'zeta-1', name: 'Zeta 1', vendor: 'Upstage' },
  ]), REGISTRY).errors;
  assert.ok(d.some((x) => /duplicate id "zeta-1"/.test(x)), d.join('\n'));
});

test('honesty gate REJECTS a release whose vendor is a feed spelling', () => {
  const { errors } = validate({ models: [], releases: [{ title: 'Google releases Gemini 3.8 Flash', vendor: 'google', kind: 'model', source: 'https://x' }], effort_ladders: [] }, REGISTRY);
  assert.ok(errors.some((x) => /vendor "google" must be written "Google"/.test(x)));
});

test('honesty gate passes a clean record and the frozen fixture catalog', () => {
  assert.deepEqual(errorsFor({ id: 'gemini-3-8-flash', name: 'Gemini 3.8 Flash', vendor: 'Google' }), []);
  // Frozen fixture, not live data/ — see scripts/fixtures/README.md. sources.json is static
  // config (not written by Collect), so reading it directly here is fine.
  const frozen = JSON.parse(readFileSync(new URL('./fixtures/models.json', import.meta.url)));
  const reg = JSON.parse(readFileSync(new URL('./sources.json', import.meta.url)));
  assert.deepEqual(validate(frozen, reg).errors, []);
});

test('honesty gate passes a rebuilt CursorBench ladder: a minimal rung, six levels, points in order', () => {
  const d = ladderData();
  rebuildCursorBench(d, parseCsv(cbCsv()), TODAY_CB);
  const data = cleanData(d.models.map(({ usage, ...m }) => m));
  data.effort_ladders = d.effort_ladders;
  const { errors, warnings } = validate(data, REGISTRY);
  assert.deepEqual(errors.filter((e) => /cursorbench/.test(e)), []);
  assert.deepEqual(warnings.filter((w) => /cursorbench/.test(w) && /levels|order|rising/.test(w)), []);
});

test('the admission shape: a feed candidate becomes a clean id + bare name + canonical vendor', () => {
  const c = { id: 'google/gemini-3.8-flash', name: 'Google: Gemini 3.8 Flash' };
  const vendor = canonicalVendor(c.id.split('/')[0]);
  const name = bareModelName(c.name, vendor);
  assert.equal(vendor, 'Google');
  assert.equal(name, 'Gemini 3.8 Flash');
  assert.equal(modelId(name), 'gemini-3-8-flash');
  assert.deepEqual(namingProblems({ id: modelId(name), name, vendor }), []);
});

// --- held-items issue: through the guarded helper (scripts/lib/gh-issue.mjs) --------------------
import { reportIssue } from './auto-refresh.mjs';

test('reportIssue: opens the held-items issue on main; a branch run (or DRY_RUN) only reads', async () => {
  const requests = [];
  const issues = [];
  const fetchImpl = async (url, init = {}) => {
    const method = init.method || 'GET';
    requests.push(method);
    const ok = (v) => ({ ok: true, status: 200, json: async () => v, text: async () => '' });
    if (method === 'GET') return ok(new URL(url).searchParams.get('page') === '1' ? issues.filter((i) => i.state === 'open') : []);
    const created = { number: 13, state: 'open', ...JSON.parse(init.body) };
    issues.push(created);
    return ok(created);
  };
  const held = [{ model: 'M', field: 'price_input', reason: 'single source' }];
  const base = { GH_TOKEN: 't', GITHUB_REPOSITORY: 'acme/site', GITHUB_EVENT_NAME: 'workflow_dispatch' };
  for (const env of [{ ...base, GITHUB_REF: 'refs/heads/c2/feature' }, { ...base, GITHUB_REF: 'refs/heads/main', DRY_RUN: 'true' }]) {
    assert.equal((await reportIssue(held, { env, fetchImpl, log: () => {} })).action, 'skipped');
  }
  assert.ok(requests.every((m) => m === 'GET'), 'no write from a branch or a dry run');
  const r = await reportIssue(held, { env: { ...base, GITHUB_REF: 'refs/heads/main' }, fetchImpl, log: () => {} });
  assert.equal(r.action, 'created');
  assert.equal(issues[0].title, 'Held for review — modelproof data refresh');
  assert.deepEqual(issues[0].labels, ['data-refresh']);
});

// --- static checks on .github/workflows/auto-refresh.yml: every remote write is guarded to main,
// nothing re-arms a schedule, and the gates Collect runs are exactly the feed gates. ----------
const WORKFLOW = readFileSync(new URL('../.github/workflows/auto-refresh.yml', import.meta.url), 'utf8');
/** [{name, if, body}] for each step of the one job (text-level split; no YAML dependency). */
function workflowSteps(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^    steps:\s*$/.test(l));
  const steps = [];
  for (const l of lines.slice(start + 1)) {
    if (/^      - /.test(l)) steps.push({ body: [l] });
    else if (steps.length) steps[steps.length - 1].body.push(l);
  }
  return steps.map((s) => {
    const body = s.body.join('\n');
    const name = (body.match(/^ {6}- name: (.+)$/m) || body.match(/^ {6}- uses: (.+)$/m) || [])[1];
    const cond = (body.match(/^ {8}if: (.+)$/m) || [])[1] || null;
    return { name, if: cond, body };
  });
}
const STEPS = workflowSteps(WORKFLOW);
/** The workflow without comment lines — what actually runs. */
const WORKFLOW_CODE = WORKFLOW.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
const MAIN_ONLY = /env\.DRY_RUN != 'true' && github\.ref == 'refs\/heads\/main'/;

test('auto-refresh.yml: DRY_RUN is on for every branch run and every dispatch that asks for it', () => {
  assert.match(WORKFLOW, /DRY_RUN: \$\{\{ inputs\.dry_run == true \|\| github\.ref != 'refs\/heads\/main' \}\}/);
  assert.doesNotMatch(WORKFLOW, /^\s*pull_request/m, 'no pull_request trigger');
});

test('auto-refresh.yml: every step that pushes, reverts or verifies runs only on main with DRY_RUN off', () => {
  const writers = STEPS.filter((s) => /git push|git revert|verify-live\.mjs/.test(s.body));
  assert.deepEqual(writers.map((s) => s.name), ['Commit and push straight to main', 'Wait for Pages deploy, then verify as_of matches']);
  for (const s of writers) assert.match(s.if || '', MAIN_ONLY, `${s.name} must be guarded to main`);
});

test('auto-refresh.yml: the token reaches Collect only on the live branch of its own DRY_RUN check', () => {
  const run = STEPS.find((s) => /auto-refresh\.mjs/.test(s.body) && /^ {6}- name: Run collect/m.test(s.body));
  const body = run.body;
  assert.ok(body.indexOf('if [ "$DRY_RUN" = "true" ]') < body.indexOf('GH_TOKEN='), 'dry-run branch comes first');
  assert.ok(body.indexOf('else') < body.indexOf('GH_TOKEN='), 'GH_TOKEN only in the else (live) branch');
});

test('auto-refresh.yml: Collect gates on --group feed before publish; no source sweep, no plans group, no continue-on-error', () => {
  const gate = STEPS.findIndex((s) => /check-live-data\.mjs --group feed/.test(s.body));
  const push = STEPS.findIndex((s) => /git push/.test(s.body));
  assert.ok(gate > -1 && gate < push, 'feed gate runs before the push');
  assert.equal(STEPS[gate].if, null, 'the feed gate always runs');
  assert.doesNotMatch(WORKFLOW_CODE, /check-sources\.mjs|report-claim-rot\.mjs/, 'the full source sweep is not Collect\'s job');
  assert.doesNotMatch(WORKFLOW_CODE, /--group (plans|all)/);
  assert.doesNotMatch(WORKFLOW_CODE, /continue-on-error/);
});

test('auto-refresh.yml + auto-refresh.mjs: nothing creates or re-arms a trigger', () => {
  const script = readFileSync(new URL('./auto-refresh.mjs', import.meta.url), 'utf8');
  for (const [name, text] of [['auto-refresh.yml', WORKFLOW_CODE], ['auto-refresh.mjs', script]]) {
    assert.doesNotMatch(text, /gh workflow|\/dispatches|repository_dispatch|workflow_run|createWorkflowDispatch/i, name);
    assert.doesNotMatch(text, /api\.anthropic\.com|@anthropic-ai|ANTHROPIC_API_KEY|anthropics\//i, `${name}: 0 model tokens`);
  }
});
