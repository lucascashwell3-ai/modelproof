import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  normalize, matchAlias, withinTolerance, factAgreement, withinSanityBounds,
  newerWins, admitNewModel, isKnownVendor, trackDeprecation, canonicalKey, evaluateFact,
  buildWorklist, bestForLine, needsGuidance, pickGuidance, guidanceItem, parseCsv, refreshCursorBench,
  releaseTitle, isKnownCandidate, findKnownModel, admissionFailReasons, formatDropLine,
  normalizeDisplayName, findNewCandidateIds, decideRefreshRun, DAILY_FULL_RUN_HOUR_UTC,
  needsJudgedFit, pickJudgedFit, judgedFitItem, reJudgeWorklistItems,
} from './auto-refresh.mjs';
import { modelId, canonicalVendor, bareModelName, isCommunityListing, namingProblems, VENDORS, isCanonicalVendor } from './naming.mjs';
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

test('decideRefreshRun: skips when there are no new ids and it is not the daily hour', () => {
  assert.equal(decideRefreshRun([], 8), 'skip');
  assert.equal(decideRefreshRun([], 0), 'skip');
});

test('decideRefreshRun: runs when there is at least one new id, any hour', () => {
  assert.equal(decideRefreshRun([{ id: 'acme/new-1', key: 'new1' }], 8), 'run');
  assert.equal(decideRefreshRun(['anything'], 23), 'run');
});

test('decideRefreshRun: always runs at the daily full-run hour (06:00 UTC), new ids or not', () => {
  assert.equal(DAILY_FULL_RUN_HOUR_UTC, 6);
  assert.equal(decideRefreshRun([], DAILY_FULL_RUN_HOUR_UTC), 'run');
  assert.equal(decideRefreshRun([{ id: 'x', key: 'x' }], DAILY_FULL_RUN_HOUR_UTC), 'run');
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
  const fullyJudged = J('c', { task_fit_judged: Object.fromEntries(TASK_IDS.map((t) => [t, { band: 'capable', confidence: 'low', claims: [], reconciliation: null, as_of: '2026-09-01' }])) });
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
  const fullyJudged = J('done', { task_fit_judged: Object.fromEntries(TASK_IDS.map((t) => [t, { band: 'weak', confidence: 'low', claims: [], reconciliation: null, as_of: '2026-09-01' }])) });
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
  const predecessor = J('old-1', { name: 'Old One', vendor: 'Acme', task_fit_judged: { coding: { band: 'capable', confidence: 'medium', claims: [], reconciliation: null, as_of: '2026-08-01' } } });
  const otherVendor = J('other-1', { name: 'Other One', vendor: 'OtherCo', task_fit_judged: { coding: { band: 'strong', confidence: 'high', claims: [], reconciliation: null, as_of: '2026-08-01' } } });
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
  { model_id: 'grok-4-6', label: 'Grok 4.6', source_key: 'grok-4.6', points: [{ effort: 'low', cost: 0.7, score: 61 }, { effort: 'high', cost: 2.3, score: 69.9 }] },
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
const cleanData = (models) => ({
  models: models.map((m) => ({ task_fit: BLANK_TASK_FIT, task_fit_judged: null, usage: { openrouter: null }, status: 'ga', adoption: 'unknown', signals: BLANK_SIGNALS, ...m })),
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

test('honesty gate passes a clean record and the live catalog', () => {
  assert.deepEqual(errorsFor({ id: 'gemini-3-8-flash', name: 'Gemini 3.8 Flash', vendor: 'Google' }), []);
  const live = JSON.parse(readFileSync(new URL('../data/models.json', import.meta.url)));
  const reg = JSON.parse(readFileSync(new URL('./sources.json', import.meta.url)));
  assert.deepEqual(validate(live, reg).errors, []);
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
