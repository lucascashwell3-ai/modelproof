import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  decide, filterCandidates, isReachable, vendorCountry, WHY_FIELDS, VENDOR_KEY_DISPLAY, STANCES,
  basisFromClaims, isEnterpriseInput, isDisqualifiedFromStartHere, topClaimSentence, rankByStance,
  standardCompare, withinTierCompare, nearTopThreshold, buildEvidenceIndex, classifyModelForTask,
  baseTierNumber, hasNegativeClaim, MAX_TIER, THIN_RULE, CHEAPEST_MAX_TIER, schemeFor,
} from '../assets/decide.mjs';
import { TASK_IDS, BASIS_TOKENS } from './derive-task-fit.mjs';

// This suite runs on a frozen fixture, never on live data/ (scripts/fixtures/README.md) — a
// data refresh must never make CI red on a golden-value test.
const FIXTURES = new URL('./fixtures/', import.meta.url);
const readJson = (p) => JSON.parse(readFileSync(new URL(p, FIXTURES)));

const models = readJson('models.json').models;
const plans = readJson('plans.json').plans;
const presets = readJson('usage-presets.json').presets;
const vendors = readJson('vendors.json').vendors;
const data = { models, plans, presets, vendors };

// ---------------------------------------------------------------------------------------------
// Registry consistency: assets/decide.mjs's why-text vocabulary and scripts/derive-task-fit.mjs's
// basis vocabulary must be the exact same set, or "why mentions only fields in fit_basis" would
// be unenforceable without either file knowing the other drifted.
// ---------------------------------------------------------------------------------------------
test('registry: WHY_FIELDS keys and derive-task-fit BASIS_TOKENS are the same set', () => {
  const whyKeys = Object.keys(WHY_FIELDS).sort();
  const basisTokens = [...BASIS_TOKENS].sort();
  assert.deepEqual(whyKeys, basisTokens);
});

// ---------------------------------------------------------------------------------------------
// Full-grid property test: task (10) x have (7) x stance (3) x volume (3) x dataRule (2)
// = 1260 combinations. "have" options: the 6 single-key arrays decide() recognizes, plus one
// multi-vendor combo (anthropic+openrouter) exercising the "reachable via ANY key in have" OR
// logic — that multi-key case is the 7th option.
// ---------------------------------------------------------------------------------------------
const HAVE_OPTIONS = [
  ['anthropic'], ['openai'], ['google'], ['xai'], ['openrouter'], ['any'],
  ['anthropic', 'openrouter'],
];
const VOLUME_OPTIONS = ['light', 'typical', 'heavy'];
const DATA_RULE_OPTIONS = [{}, { noChinaHosted: true }];

test(`full grid: ${TASK_IDS.length} tasks x ${HAVE_OPTIONS.length} have x ${STANCES.length} stance x ${VOLUME_OPTIONS.length} volume x ${DATA_RULE_OPTIONS.length} dataRule`, () => {
  const t0 = Date.now();
  let n = 0;
  const failures = [];

  for (const taskId of TASK_IDS) {
    for (const have of HAVE_OPTIONS) {
      for (const stance of STANCES) {
        for (const volume of VOLUME_OPTIONS) {
          for (const dataRule of DATA_RULE_OPTIONS) {
            n++;
            const input = { tasks: [taskId], have, stance, volume, dataRule };
            const out = decide(input, data);
            const shortlist = out.tasks[taskId].shortlist;
            const label = `task=${taskId} have=${JSON.stringify(have)} stance=${stance} volume=${volume} noChina=${!!dataRule.noChinaHosted}`;

            // (a) never recommends an unreachable model
            for (const item of shortlist) {
              const model = models.find((m) => m.id === item.id);
              if (!isReachable(model, have)) failures.push(`${label}: unreachable model "${item.id}" in shortlist`);
            }

            // (b) never a China-HQ model under noChinaHosted
            if (dataRule.noChinaHosted) {
              for (const item of shortlist) {
                const model = models.find((m) => m.id === item.id);
                if (vendorCountry(model.vendor, vendors) === 'China') {
                  failures.push(`${label}: China-hosted model "${item.id}" (${model.vendor}) survived noChinaHosted`);
                }
              }
            }

            // (c) an enterprise-style input excludes every preview model ENTIRELY, not just from
            //     start_here.
            if (isEnterpriseInput(input)) {
              for (const item of shortlist) {
                if (item.status === 'preview') failures.push(`${label}: "${item.id}" is a preview model but the input is enterprise-style — it must be fully excluded, not just demoted`);
              }
            }

            // (d) every shortlist item is evidenced (measured, chosen, or preferred present) —
            //     invariant (b): a no-evidence model is never in a shortlist. A quantitative
            //     task_fit score alone (fit != null) never substitutes for this any more.
            for (const item of shortlist) {
              const anyEvidence = item.evidence.measured.present || !!item.evidence.chosen || !!item.evidence.preferred;
              if (!anyEvidence) failures.push(`${label}: "${item.id}" has no measured/chosen/preferred evidence at all but is in the shortlist`);
              if (typeof item.tier !== 'number') failures.push(`${label}: "${item.id}" has no numeric tier`);
              if (typeof item.tier_name !== 'string' || !item.tier_name) failures.push(`${label}: "${item.id}" has no tier_name`);
              if (item.status == null) failures.push(`${label}: "${item.id}" is missing status`);
              if (item.adoption == null) failures.push(`${label}: "${item.id}" is missing adoption`);
              if (typeof item.why !== 'string' || !item.why.length) failures.push(`${label}: "${item.id}" has no why text`);
            }

            // (e) invariant (a) — in a NON-THIN task, a model absent from every tester (measured)
            //     never outranks (ranks ahead of) a model present in at least one tester, within
            //     this shortlist.
            for (let i = 0; i < shortlist.length; i++) {
              if (shortlist[i].thin_task) continue;
              if (shortlist[i].evidence.measured.present) continue; // measured-absent check only
              for (let j = i + 1; j < shortlist.length; j++) {
                if (!shortlist[j].thin_task && shortlist[j].evidence.measured.present) {
                  failures.push(`${label}: measured-absent "${shortlist[i].id}" outranks measured-present "${shortlist[j].id}" in a non-thin task`);
                }
              }
            }

            // (f) invariant (d) — "early" or (non-thin only) "tests-only" is never start_here
            //     while a T1 candidate exists for this (task, access) combination.
            const startHere = shortlist.find((x) => x.start_here);
            if (startHere && (startHere.tier_name === 'early' || (!startHere.thin_task && startHere.tier_name === 'tests-only'))) {
              const { candidates } = filterCandidates(taskId, input, data);
              if (candidates.some((c) => c.tier === 1)) {
                failures.push(`${label}: start_here "${startHere.id}" is tier_name "${startHere.tier_name}" but a tier-1 candidate also exists`);
              }
            }
          }
        }
      }
    }
  }

  const elapsed = Date.now() - t0;
  assert.equal(failures.length, 0, `\n${failures.slice(0, 25).join('\n')}${failures.length > 25 ? `\n...and ${failures.length - 25} more` : ''}`);
  assert.ok(elapsed < 3000, `full grid took ${elapsed}ms, want < 3000ms (${n} combinations)`);
});

// ---------------------------------------------------------------------------------------------
// Rule 1 regression (2026-09-06): a vendor sells its own models through its own API by
// definition, so a stale/unsourced availability.direct_api must never veto reachability for
// that vendor's own model.
// ---------------------------------------------------------------------------------------------
test("rule 1: an Anthropic/OpenAI/Google/xAI-only user reaches every one of that vendor's own models", () => {
  for (const [key, vendorName] of Object.entries(VENDOR_KEY_DISPLAY)) {
    const vendorModels = models.filter((m) => m.vendor === vendorName);
    assert.ok(vendorModels.length > 0, `no catalog models found for vendor "${vendorName}"`);
    for (const m of vendorModels) {
      assert.ok(
        isReachable(m, [key]),
        `have=['${key}'] should reach its own vendor's model "${m.id}" regardless of availability.direct_api (=${m.availability?.direct_api}), but isReachable() said no`,
      );
    }
  }
});

test('rule 1 regression: direct_api !== true no longer excludes a vendor\'s own model', () => {
  const firstPartyVendors = Object.values(VENDOR_KEY_DISPLAY);
  const stillUnsourced = models.filter((m) => firstPartyVendors.includes(m.vendor) && m.availability?.direct_api !== true);
  assert.ok(stillUnsourced.length > 0, 'fixture assumption: at least one first-party model with direct_api !== true');
  for (const m of stillUnsourced) {
    const key = Object.keys(VENDOR_KEY_DISPLAY).find((k) => VENDOR_KEY_DISPLAY[k] === m.vendor);
    assert.ok(isReachable(m, [key]), `"${m.id}" (${m.vendor}, direct_api=${m.availability?.direct_api}) must be reachable via its own vendor key`);
  }
});

// ---------------------------------------------------------------------------------------------
// Performance: a single call for all 10 tasks at once must stay well under the 50ms/query budget
// the spec sets for browser use.
// ---------------------------------------------------------------------------------------------
test('performance: all 10 tasks in one decide() call runs in under 50ms', () => {
  const t0 = Date.now();
  decide({ tasks: TASK_IDS, have: ['any'], stance: 'balanced', volume: 'typical', dataRule: {} }, data);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 50, `took ${elapsed}ms, want < 50ms`);
});

// ---------------------------------------------------------------------------------------------
// have: ['any'] never treats a vendor key as "already have a seat there" for the in-your-kit tag
// or the seat-plan lookup — 'any' means "no filter", not "I subscribe to everything".
// ---------------------------------------------------------------------------------------------
test("have: ['any'] never produces an in-your-kit tag or a seat-plan alternative", () => {
  const out = decide({ tasks: ['coding'], have: ['any'], stance: 'balanced', volume: 'typical', dataRule: {} }, data);
  for (const item of out.tasks.coding.shortlist) {
    assert.notEqual(item.tag, 'in-your-kit');
    assert.equal(item.seat_plan_alternative, null);
  }
});

test('VENDOR_KEY_DISPLAY matches the canonical spellings scripts/naming.mjs uses for these vendors', async () => {
  const { canonicalVendor } = await import('./naming.mjs');
  for (const [key, display] of Object.entries(VENDOR_KEY_DISPLAY)) {
    assert.equal(canonicalVendor(key), display, `have-key "${key}" should map to naming.mjs's canonical "${canonicalVendor(key)}"`);
  }
});

test('basisFromClaims: "lab-stated" when every claim is the vendor\'s own, "reported" when any claim names a third party', () => {
  assert.equal(basisFromClaims([{ tier: 'lab' }, { tier: 'lab' }]), 'lab-stated');
  assert.equal(basisFromClaims([{ tier: 'lab' }, { tier: 'reported' }]), 'reported');
  assert.equal(basisFromClaims([{ tier: 'measured' }]), 'reported');
});

test('topClaimSentence: prefers a non-usage claim over a usage claim, falls back to usage if that\'s all there is', () => {
  const usageOnly = [{ tier: 'usage', sentence: 'usage sentence' }];
  assert.equal(topClaimSentence(usageOnly), 'usage sentence');
  const mixed = [{ tier: 'usage', sentence: 'usage sentence' }, { tier: 'lab', sentence: 'lab sentence' }];
  assert.equal(topClaimSentence(mixed), 'lab sentence');
  assert.equal(topClaimSentence([]), 'No sourced claim on file for this pick.');
});

test('isEnterpriseInput: an explicit input.enterprise overrides the heuristic in both directions', () => {
  assert.equal(isEnterpriseInput({ enterprise: true, have: ['openrouter'], volume: { tokens_in_month: 1, tokens_out_month: 1 }, dataRule: {} }), true);
  assert.equal(isEnterpriseInput({ enterprise: false, have: ['any'], volume: 'typical', dataRule: { noChinaHosted: true } }), false);
});

test('isEnterpriseInput: single named vendor needs BOTH the vendor and heavy volume; a dataRule alone is enough on its own', () => {
  assert.equal(isEnterpriseInput({ have: ['anthropic'], volume: 'heavy', dataRule: {} }), true);
  assert.equal(isEnterpriseInput({ have: ['anthropic'], volume: 'typical', dataRule: {} }), false);
  assert.equal(isEnterpriseInput({ have: ['any'], volume: 'heavy', dataRule: {} }), false);
  assert.equal(isEnterpriseInput({ have: ['openrouter'], volume: 'heavy', dataRule: {} }), false);
  assert.equal(isEnterpriseInput({ have: ['any'], volume: 'light', dataRule: { noChinaHosted: true } }), true);
});

// ---------------------------------------------------------------------------------------------
// nearTopThreshold — the exact formula: max(3, min(10, ceil(of / 4))). Fixed 2026-09, round 2 —
// the old max(10, ceil(0.25*of)) made every of<=10 trivially "near top" (a frontend chosen
// position of 7 of 9 was wrongly "near top").
// ---------------------------------------------------------------------------------------------
test('nearTopThreshold: max(3, min(10, ceil(of / 4)))', () => {
  assert.equal(nearTopThreshold(0), 3);
  assert.equal(nearTopThreshold(1), 3);
  assert.equal(nearTopThreshold(9), 3, 'ceil(9/4)=3 -> the field is small enough that top-quartile is still only 3, not the old trivial 10');
  assert.equal(nearTopThreshold(12), 3);
  assert.equal(nearTopThreshold(13), 4);
  assert.equal(nearTopThreshold(36), 9);
  assert.equal(nearTopThreshold(37), 10);
  assert.equal(nearTopThreshold(56), 10, 'caps at 10 once a quarter of `of` would exceed it');
});

// ---------------------------------------------------------------------------------------------
// Task thinness — chat/frontend/vision/bulk are thin (0 measured each in the real catalog);
// agents (12) and every other task are not. THIN_RULE is parametric; the shipped default is
// { minTested: 8, minShareOfCatalog: 0 }.
// ---------------------------------------------------------------------------------------------
test('task thinness: chat/frontend/vision/bulk are thin, every other task is not (real catalog, default THIN_RULE)', () => {
  assert.deepEqual(THIN_RULE, { minTested: 8, minShareOfCatalog: 0 });
  const thin = ['chat', 'frontend', 'vision', 'bulk'];
  for (const taskId of TASK_IDS) {
    const index = buildEvidenceIndex(taskId, models);
    assert.equal(index.thin, thin.includes(taskId), `task "${taskId}": thin=${index.thin}, measured.size=${index.measured.size}`);
  }
});

test('buildEvidenceIndex: a minShareOfCatalog override can make a normally-non-thin task thin', () => {
  // agents has 12 measured models in the real catalog (>= the default minTested of 8, so not thin
  // by default) — a strict enough share requirement makes it thin anyway.
  const normal = buildEvidenceIndex('agents', models);
  assert.equal(normal.thin, false);
  const strict = buildEvidenceIndex('agents', models, { minTested: 8, minShareOfCatalog: 0.5 });
  assert.equal(strict.thin, true, '12 measured models is well under 50% of a ~67-model catalog');
});

test('buildEvidenceIndex: vision has no chosen kind at all in the catalog; bulk has no preferred kind at all', () => {
  const vision = buildEvidenceIndex('vision', models);
  assert.equal(vision.chosen.size, 0);
  assert.ok(vision.preferred.size > 0);
  assert.deepEqual([...vision.humanKinds], ['preferred']);
  const bulk = buildEvidenceIndex('bulk', models);
  assert.equal(bulk.preferred.size, 0);
  assert.ok(bulk.chosen.size > 0);
  assert.deepEqual([...bulk.humanKinds], ['chosen']);
});

test('schemeFor: nonThin / thinDual / thinSingle from an evidence index', () => {
  assert.equal(schemeFor({ thin: false, humanKinds: new Set() }), 'nonThin');
  assert.equal(schemeFor({ thin: true, humanKinds: new Set(['chosen', 'preferred']) }), 'thinDual');
  assert.equal(schemeFor({ thin: true, humanKinds: new Set(['chosen']) }), 'thinSingle');
});

// ---------------------------------------------------------------------------------------------
// Position computation — measured (median of rank/n_models, ties -> more rows -> lower best
// rank), chosen (share descending, re-derived rather than trusted off a stored rank), preferred
// (board rank ascending, re-positioned among just catalog models with that evidence).
// ---------------------------------------------------------------------------------------------
function fixtureModel(overrides = {}) {
  return {
    id: 'x', name: 'X', vendor: 'Acme', price_input: 1, price_output: 1, context_window: 1000,
    benchmarks: {}, best_for: [], availability: { openrouter: true, sources: [] },
    task_fit: Object.fromEntries(TASK_IDS.map((t) => [t, { score: null, basis: [] }])),
    task_fit_judged: null, standings: {}, status: 'ga', adoption: 'unknown',
    ...overrides,
  };
}

test('measured position: ordering key is the MEDIAN of rank/n_models across the model\'s own rows', () => {
  const a = fixtureModel({ id: 'a', standings: { coding: { measured: [{ tester: 't', benchmark: 'b1', rank: 1, n_models: 10 }], chosen: null, preferred: null } } }); // ratio 0.1
  const b = fixtureModel({ id: 'b', standings: { coding: { measured: [{ tester: 't', benchmark: 'b1', rank: 5, n_models: 10 }], chosen: null, preferred: null } } }); // ratio 0.5
  const index = buildEvidenceIndex('coding', [a, b]);
  assert.equal(index.measured.get('a').position, 1);
  assert.equal(index.measured.get('b').position, 2);
});

test('measured position: tie on the ordering key is broken by MORE tester rows, then the lower single best rank', () => {
  const a = fixtureModel({ id: 'a', standings: { coding: { measured: [{ tester: 't1', benchmark: 'b1', rank: 2, n_models: 10 }, { tester: 't2', benchmark: 'b2', rank: 2, n_models: 10 }], chosen: null, preferred: null } } }); // median 0.2, 2 rows
  const b = fixtureModel({ id: 'b', standings: { coding: { measured: [{ tester: 't1', benchmark: 'b1', rank: 2, n_models: 10 }], chosen: null, preferred: null } } }); // median 0.2, 1 row
  const index = buildEvidenceIndex('coding', [a, b]);
  assert.equal(index.measured.get('a').position, 1, 'more tester rows should win the tie');
  assert.equal(index.measured.get('b').position, 2);
});

test('chosen position: re-derived from share descending, not trusted off a stored rank that may be scoped to the whole external feed', () => {
  // "b" carries a stored rank of 1 (as if it were rank 1 of some much larger external feed) but a
  // much lower share than "a" — position must follow share, not the stored rank.
  const a = fixtureModel({ id: 'a', standings: { coding: { measured: [], chosen: { rank: 40, share: 30, n_models: 99, url: 'x' }, preferred: null } } });
  const b = fixtureModel({ id: 'b', standings: { coding: { measured: [], chosen: { rank: 1, share: 2, n_models: 99, url: 'x' }, preferred: null } } });
  const index = buildEvidenceIndex('coding', [a, b]);
  assert.equal(index.chosen.get('a').position, 1, 'higher share must win position 1 regardless of the stored rank');
  assert.equal(index.chosen.get('b').position, 2);
  assert.equal(index.chosen.size, 2, '"of" is the count of catalog models with a chosen record, not the feed\'s own n_models');
});

test('preferred position: re-positioned among just catalog models on the board, by rank ascending', () => {
  const a = fixtureModel({ id: 'a', standings: { coding: { measured: [], chosen: null, preferred: { rank: 50, board: 'b', n_models: 400, url: 'x' } } } });
  const b = fixtureModel({ id: 'b', standings: { coding: { measured: [], chosen: null, preferred: { rank: 5, board: 'b', n_models: 400, url: 'x' } } } });
  const index = buildEvidenceIndex('coding', [a, b]);
  assert.equal(index.preferred.get('b').position, 1);
  assert.equal(index.preferred.get('a').position, 2);
  assert.equal(index.preferred.get('a').of, 2, '"of" is 2 catalog models, not the board\'s 400');
});

// ---------------------------------------------------------------------------------------------
// Tiers — the exact waterfall from the file header, on synthetic (task, catalog) pairs so each
// combination can be checked in isolation, independent of the real catalog's own mix.
//
// nearTopThreshold caps at 10 and floors at 3, so a background of 15 mediocre filler models per
// evidence kind under test (pushing `of` to 16, threshold 4) is enough to create a genuine "not
// near top" case (position 16 > 4) without also accidentally putting a "near top" subject (which
// always lands at position 1 in these fixtures) past the threshold.
// ---------------------------------------------------------------------------------------------
const FILLER_N = 15;
/** Mediocre background rows for one evidence kind, distinct and worse than any "near top" subject
 * this file adds, but not so extreme they'd tie with a "not near top" subject either. */
function fillerModels(kinds) {
  return Array.from({ length: FILLER_N }, (_, i) => fixtureModel({
    id: `filler-${kinds.join('')}-${i}`,
    standings: {
      t: {
        measured: kinds.includes('measured') ? [{ tester: 't', benchmark: 'b', rank: 10 + i, n_models: 100 }] : [],
        chosen: kinds.includes('chosen') ? { rank: 10 + i, share: 5 - i * 0.1, n_models: 999, url: 'u' } : null,
        preferred: kinds.includes('preferred') ? { rank: 10 + i, board: 'b', n_models: 999, url: 'u' } : null,
      },
    },
  }));
}
/** A subject clearly near the top (position ~1) of whichever kinds it carries — ratio/share/rank
 * chosen to beat every filler row above. */
function nearTopSubject(id, { measured, chosen, preferred, adoption, status, judged } = {}) {
  return fixtureModel({
    id, adoption: adoption ?? 'unknown', status: status ?? 'ga',
    task_fit_judged: judged ? { t: judged } : null,
    standings: {
      t: {
        measured: measured ? [{ tester: 't', benchmark: 'b', rank: 1, n_models: 100 }] : [],
        chosen: chosen ? { rank: 1, share: 50, n_models: 5, url: 'u' } : null,
        preferred: preferred ? { rank: 1, board: 'b', n_models: 5, url: 'u' } : null,
      },
    },
  });
}
/** A subject clearly NOT near the top of whichever kinds it carries — worse than every filler
 * row, so it lands dead last once filler for that kind is present. */
function notNearTopSubject(id, { measured, chosen, preferred, adoption, status, judged } = {}) {
  return fixtureModel({
    id, adoption: adoption ?? 'unknown', status: status ?? 'ga',
    task_fit_judged: judged ? { t: judged } : null,
    standings: {
      t: {
        measured: measured ? [{ tester: 't', benchmark: 'b', rank: 99, n_models: 100 }] : [],
        chosen: chosen ? { rank: 999, share: 0.001, n_models: 999, url: 'u' } : null,
        preferred: preferred ? { rank: 9999, board: 'b', n_models: 999, url: 'u' } : null,
      },
    },
  });
}

test('tier T1 "agreed": measured near top AND a human kind near top', () => {
  const catalog = [...fillerModels(['measured']), nearTopSubject('x', { measured: true, chosen: true })];
  const index = buildEvidenceIndex('t', catalog);
  assert.equal(index.thin, false);
  const cls = classifyModelForTask(catalog.find((m) => m.id === 'x'), 't', index);
  assert.equal(cls.tier, 1);
  assert.equal(cls.tier_name, 'agreed');
  assert.equal(cls.label, null);
});

test('tier T3 "tests-only": measured near top, no human kind near top, NOT new — carries the spec\'s exact label', () => {
  const catalog = [...fillerModels(['measured']), nearTopSubject('x', { measured: true })];
  const index = buildEvidenceIndex('t', catalog);
  const cls = classifyModelForTask(catalog.find((m) => m.id === 'x'), 't', index);
  assert.equal(cls.tier, 3);
  assert.equal(cls.tier_name, 'tests-only');
  assert.equal(cls.label, 'strong on tests, low real-world use');
});

test('tier T2 "early": measured near top, no human kind near top, adoption "new" — its own tier, not T1\'s tail', () => {
  const catalog = [...fillerModels(['measured']), nearTopSubject('x', { measured: true, adoption: 'new' })];
  const index = buildEvidenceIndex('t', catalog);
  const cls = classifyModelForTask(catalog.find((m) => m.id === 'x'), 't', index);
  assert.equal(cls.tier, 2);
  assert.equal(cls.tier_name, 'early');
  assert.equal(cls.label, 'early: too new for usage data');
});

test('tier T4 "tested, people-backed": measured present but not near top, AND a human kind near top', () => {
  const catalog = [...fillerModels(['measured']), notNearTopSubject('x', { measured: true, preferred: true })];
  const index = buildEvidenceIndex('t', catalog);
  const cls = classifyModelForTask(catalog.find((m) => m.id === 'x'), 't', index);
  assert.equal(cls.tier, 4);
  assert.equal(cls.tier_name, 'tested, people-backed');
});

test('tier T5 "tested": measured present, nothing near top', () => {
  const catalog = [...fillerModels(['measured']), notNearTopSubject('x', { measured: true })];
  const index = buildEvidenceIndex('t', catalog);
  const cls = classifyModelForTask(catalog.find((m) => m.id === 'x'), 't', index);
  assert.equal(cls.tier, 5);
  assert.equal(cls.tier_name, 'tested');
});

test('tier T6 "not independently tested": measured absent, a human kind near top — carries the spec\'s exact label', () => {
  const catalog = [...fillerModels(['measured']), nearTopSubject('x', { chosen: true })];
  const index = buildEvidenceIndex('t', catalog);
  const cls = classifyModelForTask(catalog.find((m) => m.id === 'x'), 't', index);
  assert.equal(cls.tier, 6);
  assert.equal(cls.tier_name, 'not independently tested');
  assert.equal(cls.label, 'not independently tested');
});

test('tier T6 extension: measured absent, evidenced but no human kind near top either — still T6, sorts to the tail via kindsNearTopCount', () => {
  const catalog = [...fillerModels(['measured', 'chosen']), notNearTopSubject('x', { chosen: true })];
  const index = buildEvidenceIndex('t', catalog);
  const cls = classifyModelForTask(catalog.find((m) => m.id === 'x'), 't', index);
  assert.equal(cls.tier, 6);
  assert.equal(cls.kindsNearTopCount, 0);
});

test('MAX_TIER: 6 non-thin, 4 thin-dual, 2 thin-single ("early" is tier 2 in non-thin/thin-dual only — thin-single has no "early" tier at all, round 3)', () => {
  assert.deepEqual(MAX_TIER, { nonThin: 6, thinDual: 4, thinSingle: 2 });
});

test('evidence gate: a model with no measured/chosen/preferred record at all is not evidenced (excluded from candidacy)', () => {
  const catalog = [...fillerModels(['measured']), fixtureModel({ id: 'x', standings: { t: { measured: [], chosen: null, preferred: null } } })];
  const index = buildEvidenceIndex('t', catalog);
  const cls = classifyModelForTask(catalog.find((m) => m.id === 'x'), 't', index);
  assert.equal(cls.evidenced, false);
});

test('decide(): a model with zero evidence anywhere never appears in the shortlist, and a task with zero evidenced models reports the assumption', () => {
  const untested = fixtureModel({ id: 'untested' });
  const out = decide({ tasks: ['coding'], have: ['any'], stance: 'best', volume: 'typical', dataRule: {} }, { models: [untested], plans, presets, vendors });
  assert.equal(out.tasks.coding.shortlist.length, 0);
  assert.ok(out.tasks.coding.assumptions.some((a) => /no evidence of any kind/i.test(a)));
});

// ---------------------------------------------------------------------------------------------
// Thin-task tiers. THIN_RULE's default minTested is 8 — none of these catalogs ever add a
// measured row, so every one of them is thin regardless of size.
// ---------------------------------------------------------------------------------------------
test('thin task, both human kinds in the catalog (dual scheme): T1 both near top, T2 early, T3 one kind near top (not new), T4 evidenced/none near top', () => {
  const catalog = [
    ...fillerModels(['chosen', 'preferred']),
    nearTopSubject('a', { chosen: true, preferred: true }),
    nearTopSubject('b', { chosen: true }), // preferred absent -> only chosen is near top, not new
    nearTopSubject('new-b', { chosen: true, adoption: 'new' }), // same shape, but new -> "early"
    notNearTopSubject('c', { chosen: true, preferred: true }),
  ];
  const index = buildEvidenceIndex('t', catalog);
  assert.equal(index.thin, true);
  assert.equal(index.humanKinds.size, 2);
  const clsFor = (id) => classifyModelForTask(catalog.find((m) => m.id === id), 't', index);
  assert.equal(clsFor('a').tier, 1);
  assert.equal(clsFor('a').label, 'not independently tested');
  assert.equal(clsFor('b').tier, 3);
  assert.equal(clsFor('b').tier_name, 'one-signal');
  assert.equal(clsFor('new-b').tier, 2);
  assert.equal(clsFor('new-b').tier_name, 'early');
  assert.equal(clsFor('c').tier, 4);
  assert.equal(clsFor('c').tier_name, 'evidenced');
});

test('thin task, one human kind in the catalog (single scheme): T1 that kind near top ("one signal only"), T2 evidenced/not near top — NO "early" tier at all (round 3)', () => {
  const catalog = [
    ...fillerModels(['chosen']),
    nearTopSubject('a', { chosen: true }),
    notNearTopSubject('b', { chosen: true }),
    notNearTopSubject('new-b', { chosen: true, adoption: 'new' }),
  ];
  const index = buildEvidenceIndex('t', catalog);
  assert.equal(index.humanKinds.size, 1);
  const clsFor = (id) => classifyModelForTask(catalog.find((m) => m.id === id), 't', index);
  assert.equal(clsFor('a').tier, 1);
  assert.equal(clsFor('a').label, 'one signal only');
  assert.equal(clsFor('b').tier, 2);
  assert.equal(clsFor('b').tier_name, 'evidenced');
  // Round 3 fix: thin-single has NO "early" tier — a new-but-not-near-top model reads exactly
  // like a non-new one (round 2 wrongly gave every new model "early" here regardless of position;
  // this is the S13/S11 bug: a bulk model at chosen position 36 of 63 read as "early").
  assert.equal(clsFor('new-b').tier, 2);
  assert.equal(clsFor('new-b').tier_name, 'evidenced');
  assert.notEqual(clsFor('new-b').label, 'early: too new for usage data');
});

// ---------------------------------------------------------------------------------------------
// New-model override ("early") — its own numbered tier in non-thin and thin-dual (round 2; round
// 1 had it as an overlay promoting a model into the tail of T1). Round 3: thin-single has NO
// "early" tier at all (round 2 wrongly gave one to any new-but-not-near-top model there,
// regardless of how far from the top it actually was) — see the dedicated thin-single test above.
// ---------------------------------------------------------------------------------------------
test('new-model override: non-thin "early" (T2) sits strictly between "agreed" (T1) and "tests-only" (T3)', () => {
  const catalog = [
    ...fillerModels(['measured']),
    nearTopSubject('t1', { measured: true, chosen: true }),
    nearTopSubject('t2-early', { measured: true, adoption: 'new' }),
    nearTopSubject('t3-tests-only', { measured: true }),
  ];
  const index = buildEvidenceIndex('t', catalog);
  const clsFor = (id) => classifyModelForTask(catalog.find((m) => m.id === id), 't', index);
  assert.equal(clsFor('t1').tier, 1);
  assert.equal(clsFor('t2-early').tier, 2);
  assert.equal(clsFor('t2-early').tier_name, 'early');
  assert.equal(clsFor('t3-tests-only').tier, 3);
  assert.ok(standardCompare(clsFor('t2-early'), clsFor('t3-tests-only')) < 0, '"early" must outrank "tests-only" via tier order alone');
});

// ---------------------------------------------------------------------------------------------
// Negative-claim demotion (hasNegativeClaim/polarity: 'negative') — a schema extension this pass
// adds support for; no claim in the real data carries it yet (see the file header note in
// assets/decide.mjs), so this is exercised only with synthetic fixtures.
// ---------------------------------------------------------------------------------------------
test('hasNegativeClaim: true only when a claim explicitly carries polarity: "negative"', () => {
  const m = { task_fit_judged: { t: { claims: [{ sentence: 'x' }, { sentence: 'y', polarity: 'negative' }] } } };
  assert.equal(hasNegativeClaim(m, 't'), true);
  assert.equal(hasNegativeClaim({ task_fit_judged: { t: { claims: [{ sentence: 'x' }] } } }, 't'), false);
  assert.equal(hasNegativeClaim({ task_fit_judged: null }, 't'), false);
  assert.equal(hasNegativeClaim({}, 't'), false);
});

test('negative claim: drops a model exactly one tier, clamped at the scheme\'s worst tier', () => {
  const judged = { band: 'strong', confidence: 'high', claims: [{ sentence: 'ok' }, { sentence: 'bad', polarity: 'negative' }] };
  const catalog = [...fillerModels(['measured']), nearTopSubject('x', { measured: true, chosen: true, judged })];
  const index = buildEvidenceIndex('t', catalog);
  const cls = classifyModelForTask(catalog.find((m) => m.id === 'x'), 't', index);
  // T1 "agreed" -> demote by one -> would land on T2 "early", but "x" is NOT adoption:'new', so it
  // skips past "early" to T3 "tests-only" instead (see the file header's negative-claims guard).
  assert.equal(cls.tier, 3, 'a non-new model demoted from T1 must skip the "early" slot');
  assert.equal(cls.tier_name, 'tests-only');

  // At the worst tier already — dropping is a clamped no-op.
  const worstJudged = { band: 'strong', confidence: 'high', claims: [{ sentence: 'bad', polarity: 'negative' }] };
  const worst = [...fillerModels(['measured']), nearTopSubject('y', { chosen: true, judged: worstJudged })];
  const worstIndex = buildEvidenceIndex('t', worst);
  const worstCls = classifyModelForTask(worst.find((m) => m.id === 'y'), 't', worstIndex);
  assert.equal(worstCls.tier, MAX_TIER.nonThin);
});

test('negative claim: a genuinely NEW model demoted from T1 CAN land on "early" (it really is too new)', () => {
  const judged = { band: 'strong', confidence: 'high', claims: [{ sentence: 'ok' }, { sentence: 'bad', polarity: 'negative' }] };
  const catalog = [...fillerModels(['measured']), nearTopSubject('x', { measured: true, chosen: true, adoption: 'new', judged })];
  const index = buildEvidenceIndex('t', catalog);
  const cls = classifyModelForTask(catalog.find((m) => m.id === 'x'), 't', index);
  assert.equal(cls.tier, 2);
  assert.equal(cls.tier_name, 'early');
});

// ---------------------------------------------------------------------------------------------
// Within-tier order and standardCompare — the exact key sequence from the file header.
// ---------------------------------------------------------------------------------------------
test('withinTierCompare: more kinds near top wins first, regardless of every later key', () => {
  const a = { kindsNearTopCount: 2, measuredPosition: 50, bestHumanPosition: 50, measuredRows: 1, monthly_cost_usd: 100, model: { id: 'a', status: 'ga' } };
  const b = { kindsNearTopCount: 1, measuredPosition: 1, bestHumanPosition: 1, measuredRows: 99, monthly_cost_usd: 1, model: { id: 'b', status: 'ga' } };
  assert.ok(withinTierCompare(a, b) < 0);
});

test('withinTierCompare: GA before preview, within the same kindsNearTopCount/position tier', () => {
  const ga = { kindsNearTopCount: 1, measuredPosition: 1, bestHumanPosition: null, measuredRows: 1, monthly_cost_usd: 10, model: { id: 'ga', status: 'ga' } };
  const preview = { kindsNearTopCount: 1, measuredPosition: 1, bestHumanPosition: null, measuredRows: 1, monthly_cost_usd: 1, model: { id: 'preview', status: 'preview' } };
  assert.ok(withinTierCompare(ga, preview) < 0, 'GA must sort ahead of a cheaper preview item at an otherwise-identical tie');
});

test('standardCompare: a lower tier number always sorts ahead of a higher one, regardless of within-tier keys', () => {
  const t1 = { tier: 1, kindsNearTopCount: 0, measuredPosition: null, bestHumanPosition: null, measuredRows: 0, monthly_cost_usd: 999, model: { id: 't1', status: 'ga' } };
  const t2 = { tier: 2, kindsNearTopCount: 3, measuredPosition: 1, bestHumanPosition: 1, measuredRows: 99, monthly_cost_usd: 0.01, model: { id: 't2', status: 'ga' } };
  assert.ok(standardCompare(t1, t2) < 0);
});

// ---------------------------------------------------------------------------------------------
// Stances.
// ---------------------------------------------------------------------------------------------
function candidate(id, { tier, tier_name = 'x', cost, status = 'ga' } = {}) {
  return { tier, tier_name, monthly_cost_usd: cost, kindsNearTopCount: 0, measuredPosition: null, bestHumanPosition: null, measuredRows: 0, model: { id, status } };
}

test("stance 'cheapest': cost-primary among qualifying tiers (<=4 non-thin, <=3 thin-dual, <=2 thin-single); non-qualifying candidates are appended, never dropped", () => {
  const list = [candidate('t5-cheap', { tier: 5, cost: 1 }), candidate('t2-mid', { tier: 2, cost: 10 }), candidate('t1-priciest', { tier: 1, cost: 20 })];
  const ranked = rankByStance(list, 'cheapest', 'nonThin');
  assert.deepEqual(ranked.map((c) => c.model.id), ['t2-mid', 't1-priciest', 't5-cheap'], 'the tier-5 item never qualifies for cheapest (non-thin cap is tier<=4) despite being cheapest overall, but is still returned, ranked last');
});

test("stance 'cheapest': falls back to cost-primary among ANY candidate when none qualify", () => {
  const list = [candidate('a', { tier: 6, cost: 5 }), candidate('b', { tier: 5, cost: 1 })];
  const ranked = rankByStance(list, 'cheapest', 'nonThin');
  assert.equal(ranked[0].model.id, 'b');
});

test("stance 'cheapest': thin-dual caps qualifying tiers at 3, thin-single at 1 (round 3: thin-single has no \"early\" tier, so its only qualifying tier is T1)", () => {
  const dual = [candidate('t4-cheap', { tier: 4, cost: 1 }), candidate('t3-mid', { tier: 3, cost: 10 })];
  assert.equal(rankByStance(dual, 'cheapest', 'thinDual')[0].model.id, 't3-mid', 'tier 4 does not qualify for cheapest on thin-dual');

  const single = [candidate('t2-cheap', { tier: 2, cost: 1 }), candidate('t1-mid', { tier: 1, cost: 10 })];
  assert.equal(rankByStance(single, 'cheapest', 'thinSingle')[0].model.id, 't1-mid', 'tier 2 ("evidenced", nothing near top) does not qualify for cheapest on thin-single');
});

test("stance 'best': tier order, full stop — the full standardCompare order", () => {
  const list = [candidate('cheap-t2', { tier: 2, cost: 1 }), candidate('pricier-t1', { tier: 1, cost: 100 })];
  const ranked = rankByStance(list, 'best', 'nonThin');
  assert.equal(ranked[0].model.id, 'pricier-t1');
});

test("stance 'balanced': candidates within 2x the cheapest NON-early top-tier candidate's cost rank first (by the standard order), everyone else after", () => {
  const list = [
    candidate('top-tier-cheap', { tier: 1, cost: 10 }),
    candidate('top-tier-pricey', { tier: 1, cost: 50 }), // > 2x(10) = 20, over budget
    candidate('lower-tier-in-budget', { tier: 3, cost: 15 }), // <= 20, in budget
  ];
  const ranked = rankByStance(list, 'balanced', 'nonThin');
  assert.deepEqual(ranked.map((c) => c.model.id), ['top-tier-cheap', 'lower-tier-in-budget', 'top-tier-pricey']);
});

test("stance 'balanced': an \"early\" candidate never sets the budget floor, even if it's the cheapest and only tier-1-equivalent priced item", () => {
  // "early" (tier 2) is cheaper than the real top tier (tier 1) — the floor must still come from
  // tier 1, not from "early", even though "early" is numerically the next-best tier present.
  const list = [
    candidate('t1-real-floor', { tier: 1, tier_name: 'agreed', cost: 40 }),
    candidate('early-cheap', { tier: 2, tier_name: 'early', cost: 1 }), // must NOT set the floor
    candidate('t1-too-pricey', { tier: 1, tier_name: 'agreed', cost: 200 }), // > 2x(40) = 80, over budget
  ];
  const ranked = rankByStance(list, 'balanced', 'nonThin');
  // early-cheap is priced at 1, comfortably within 2x(40)=80, so it's in-budget and ranked by the
  // standard order (tier asc) alongside t1-real-floor; t1-too-pricey is over budget (ranked last).
  assert.deepEqual(ranked.map((c) => c.model.id), ['t1-real-floor', 'early-cheap', 't1-too-pricey']);
});

test("stance 'balanced': no priced non-\"early\" candidate falls back to plain 'best' order", () => {
  const list = [candidate('top-tier-unpriced', { tier: 1, cost: null }), candidate('lower-tier-priced', { tier: 3, cost: 5 })];
  const ranked = rankByStance(list, 'balanced', 'nonThin');
  assert.equal(ranked[0].model.id, 'top-tier-unpriced');
});

// ---------------------------------------------------------------------------------------------
// start_here disqualifiers.
// ---------------------------------------------------------------------------------------------
test('isDisqualifiedFromStartHere: a non-thin "tests-only" item is disqualified while a T1 item is also a candidate', () => {
  const t3 = { tier: 3, tier_name: 'tests-only', thin_task: false, model: { status: 'ga' } };
  const t1 = { tier: 1, tier_name: 'agreed', thin_task: false, model: { status: 'ga' } };
  assert.equal(isDisqualifiedFromStartHere(t3, [t3, t1], 'best'), true);
  assert.equal(isDisqualifiedFromStartHere(t3, [t3], 'best'), false, 'no T1 rival -> not disqualified');
});

test('isDisqualifiedFromStartHere: "tests-only"-vs-T1 rule never applies on a thin task', () => {
  const t3 = { tier: 3, tier_name: 'tests-only', thin_task: true, model: { status: 'ga' } };
  const t1 = { tier: 1, tier_name: 'agreed', thin_task: true, model: { status: 'ga' } };
  assert.equal(isDisqualifiedFromStartHere(t3, [t3, t1], 'best'), false);
});

test('isDisqualifiedFromStartHere: "early" is disqualified while a T1 item exists, in EVERY scheme (thin or not)', () => {
  const early = { tier: 2, tier_name: 'early', thin_task: false, model: { status: 'ga' } };
  const t1 = { tier: 1, tier_name: 'agreed', thin_task: false, model: { status: 'ga' } };
  assert.equal(isDisqualifiedFromStartHere(early, [early, t1], 'best'), true);
  assert.equal(isDisqualifiedFromStartHere(early, [early], 'best'), false, 'no T1 rival -> not disqualified');

  const earlyThin = { tier: 2, tier_name: 'early', thin_task: true, model: { status: 'ga' } };
  const t1Thin = { tier: 1, tier_name: 'human-agreed', thin_task: true, model: { status: 'ga' } };
  assert.equal(isDisqualifiedFromStartHere(earlyThin, [earlyThin, t1Thin], 'best'), true, 'unlike "tests-only", the early-vs-T1 rule DOES apply on thin tasks');
});

test('isDisqualifiedFromStartHere: preview never starts over a same-tier GA/deprecated item, except under "cheapest"', () => {
  const preview = { tier: 1, tier_name: 'agreed', thin_task: false, model: { status: 'preview' } };
  const ga = { tier: 1, tier_name: 'agreed', thin_task: false, model: { status: 'ga' } };
  assert.equal(isDisqualifiedFromStartHere(preview, [preview, ga], 'best'), true);
  assert.equal(isDisqualifiedFromStartHere(preview, [preview, ga], 'balanced'), true);
  assert.equal(isDisqualifiedFromStartHere(preview, [preview, ga], 'cheapest'), false, "'cheapest' stays cost-primary");
  assert.equal(isDisqualifiedFromStartHere(preview, [preview], 'best'), false, 'no same-tier GA rival -> not disqualified');
});

test('decide(): enterprise-style input excludes preview entirely at rule 3, before tiering ever runs', () => {
  const preview = fixtureModel({ id: 'p', status: 'preview', standings: { coding: { measured: [], chosen: { rank: 1, share: 50, n_models: 5, url: 'u' }, preferred: null } } });
  const out = decide({ tasks: ['coding'], have: ['any'], stance: 'balanced', volume: 'typical', dataRule: {}, enterprise: true }, { models: [preview], plans, presets, vendors });
  assert.equal(out.tasks.coding.shortlist.length, 0);
});

// ---------------------------------------------------------------------------------------------
// Parametric thin rule end to end (input.thin_rule) — round 2.
// ---------------------------------------------------------------------------------------------
test('decide(): input.thin_rule overrides THIN_RULE for that call only, without touching the default', () => {
  const out = decide({ tasks: ['agents'], have: ['any'], stance: 'best', volume: 'typical', dataRule: {}, thin_rule: { minTested: 8, minShareOfCatalog: 0.5 } }, data);
  const { index } = filterCandidates('agents', { have: ['any'], stance: 'best', volume: 'typical', dataRule: {}, thin_rule: { minTested: 8, minShareOfCatalog: 0.5 } }, data);
  assert.equal(index.thin, true, 'agents (12 measured models) must read as thin under a 50%-of-catalog share requirement');
  assert.deepEqual(THIN_RULE, { minTested: 8, minShareOfCatalog: 0 }, 'the module-level default must be untouched');
  assert.ok(out.tasks.agents); // sanity: decide() still ran to completion under the override
});

// ---------------------------------------------------------------------------------------------
// Real-catalog invariants.
// ---------------------------------------------------------------------------------------------
test("stance rewrite: for every task, 'cheapest' start_here never costs more than 'best' start_here", () => {
  const failures = [];
  for (const taskId of TASK_IDS) {
    const input = (stance) => ({ tasks: [taskId], have: ['any'], stance, volume: 'typical', dataRule: {} });
    const cheapest = decide(input('cheapest'), data).tasks[taskId].shortlist.find((x) => x.start_here);
    const best = decide(input('best'), data).tasks[taskId].shortlist.find((x) => x.start_here);
    if (!cheapest || !best) continue;
    if (typeof cheapest.monthly_cost_usd !== 'number' || typeof best.monthly_cost_usd !== 'number') continue;
    if (cheapest.monthly_cost_usd > best.monthly_cost_usd + 1e-9) {
      failures.push(`${taskId}: cheapest start_here "${cheapest.id}" costs ${cheapest.monthly_cost_usd} > best start_here "${best.id}" at ${best.monthly_cost_usd}`);
    }
  }
  assert.equal(failures.length, 0, failures.join('\n'));
});

test('cost coverage: for have=any/typical, at least 90% of shortlist items across every task carry a numeric monthly_cost_usd', () => {
  let total = 0;
  let withCost = 0;
  const missing = [];
  for (const taskId of TASK_IDS) {
    const out = decide({ tasks: [taskId], have: ['any'], stance: 'best', volume: 'typical', dataRule: {} }, data);
    for (const item of out.tasks[taskId].shortlist) {
      total++;
      if (typeof item.monthly_cost_usd === 'number') withCost++;
      else missing.push(`${taskId}: "${item.id}"`);
    }
  }
  assert.ok(total > 0, 'fixture assumption: at least one task returns a shortlist item for have=any');
  const coverage = withCost / total;
  assert.ok(coverage >= 0.9, `only ${withCost}/${total} shortlist items (${(coverage * 100).toFixed(1)}%) have a numeric cost, want >= 90%: ${missing.join(', ')}`);
});

// NOTE: GA-before-preview is the FOURTH within-tier tie-break key (after kinds-near-top,
// measured position, best-human position — see withinTierCompare/the file header's "order
// within a tier"), not a blanket rule — a preview item with strictly MORE corroborating evidence
// than a same-tier GA rival (e.g. gemini-3-1-pro vs. gemini-3-8-flash for "writing": 3 kinds near
// top vs. 2) legitimately outranks it in the returned array on that stronger evidence. What GA-
// before-preview actually guarantees, unconditionally, is the START_HERE pick — see the two tests
// below (a synthetic tie case for withinTierCompare's own ordering, already above, plus this real-
// catalog check that start_here itself never goes to a preview item over a same-tier GA rival).
test('invariant: start_here never goes to a preview item while a same-tier GA/deprecated item is also a candidate, for every task and every stance except "cheapest"', () => {
  const failures = [];
  for (const taskId of TASK_IDS) {
    for (const stance of STANCES) {
      if (stance === 'cheapest') continue;
      const input = { tasks: [taskId], have: ['any'], stance, volume: 'typical', dataRule: {} };
      const { candidates } = filterCandidates(taskId, input, data);
      const out = decide(input, data);
      const startHere = out.tasks[taskId].shortlist.find((x) => x.start_here);
      if (!startHere || startHere.status !== 'preview') continue;
      const gaSameTier = candidates.some((c) => c.model.id !== startHere.id && c.tier === startHere.tier && c.model.status !== 'preview');
      if (gaSameTier) failures.push(`${taskId}/${stance}: preview "${startHere.id}" got start_here despite a same-tier GA/deprecated candidate`);
    }
  }
  assert.equal(failures.length, 0, failures.join('\n'));
});

test('invariant: every shortlist item, for every task, carries the full evidence contract', () => {
  const out = decide({ tasks: TASK_IDS, have: ['any'], stance: 'balanced', volume: 'typical', dataRule: {} }, data);
  for (const taskId of TASK_IDS) {
    for (const item of out.tasks[taskId].shortlist) {
      assert.ok(item.evidence, `${taskId}/${item.id}: missing evidence`);
      assert.ok(item.evidence.measured, `${taskId}/${item.id}: missing evidence.measured`);
      assert.equal(typeof item.evidence.measured.present, 'boolean');
      assert.equal(typeof item.thin_task, 'boolean');
      assert.equal(typeof item.tier, 'number');
      assert.equal(typeof item.tier_name, 'string');
    }
  }
});

test('invariant: positions are monotonic — a strictly better measured ordering key never yields a worse (higher) position', () => {
  const catalog = [
    fixtureModel({ id: 'better', standings: { t: { measured: [{ tester: 't', benchmark: 'b', rank: 1, n_models: 40 }], chosen: null, preferred: null } } }),
    fixtureModel({ id: 'worse', standings: { t: { measured: [{ tester: 't', benchmark: 'b', rank: 30, n_models: 40 }], chosen: null, preferred: null } } }),
  ];
  const index = buildEvidenceIndex('t', catalog);
  const better = index.measured.get('better').position;
  const worse = index.measured.get('worse').position;
  assert.ok(better < worse);
});

test('invariant: no evidence anywhere -> excluded from candidacy, for every task in the real catalog (a plain task_fit score never substitutes)', () => {
  // A model with real task_fit but zero standings anywhere for a task must not be a candidate —
  // spot check with a synthetic clone of a real model, standings stripped for one task.
  const base = models.find((m) => m.id === 'claude-opus-5');
  const stripped = { ...base, standings: { ...base.standings, coding: { measured: [], chosen: null, preferred: null } } };
  const out = decide({ tasks: ['coding'], have: ['any'], stance: 'best', volume: 'typical', dataRule: {} }, { models: [stripped], plans, presets, vendors });
  assert.ok(!out.tasks.coding.shortlist.some((x) => x.id === stripped.id));
});

// ---------------------------------------------------------------------------------------------
// baseTierNumber — the raw waterfall function, unit-checked against every named combination in
// isolation (independent of a whole catalog/index). Signature (round 2): the 6th arg `isNew`
// directly determines whether the "near-top-on-one-kind-but-missing-the-other" state reads as
// "early" or the scheme's normal name for that state.
// ---------------------------------------------------------------------------------------------
test('baseTierNumber: every named combination in the file header, both isNew=false and isNew=true where it matters', () => {
  // nonThin: 1 agreed, 2 early, 3 tests-only, 4 tested+people-backed, 5 tested, 6 not-indep-tested
  assert.equal(baseTierNumber('nonThin', true, true, true, false, false), 1);
  assert.equal(baseTierNumber('nonThin', true, true, true, false, true), 1, 'isNew never touches "agreed" — it already has full corroboration');
  assert.equal(baseTierNumber('nonThin', true, true, false, false, false), 3, 'not new -> "tests-only"');
  assert.equal(baseTierNumber('nonThin', true, true, false, false, true), 2, 'new -> "early"');
  assert.equal(baseTierNumber('nonThin', true, false, true, false, false), 4);
  assert.equal(baseTierNumber('nonThin', true, false, false, false, false), 5);
  assert.equal(baseTierNumber('nonThin', false, false, true, false, false), 6);
  assert.equal(baseTierNumber('nonThin', false, false, false, true, false), 6);
  // thinDual: 1 both, 2 early, 3 one-signal, 4 evidenced
  assert.equal(baseTierNumber('thinDual', false, false, true, true, false), 1);
  assert.equal(baseTierNumber('thinDual', false, false, true, false, false), 3, 'not new -> "one-signal"');
  assert.equal(baseTierNumber('thinDual', false, false, true, false, true), 2, 'new -> "early"');
  assert.equal(baseTierNumber('thinDual', false, false, false, false, false), 4);
  // thinSingle: 1 near top, 2 evidenced — NO "early" tier at all (round 3): isNew is ignored.
  assert.equal(baseTierNumber('thinSingle', false, false, true, false, false), 1);
  assert.equal(baseTierNumber('thinSingle', false, false, true, false, true), 1, 'isNew never touches "near top" — already the best thin-single has');
  assert.equal(baseTierNumber('thinSingle', false, false, false, false, false), 2, 'not new -> "evidenced"');
  assert.equal(baseTierNumber('thinSingle', false, false, false, false, true), 2, 'new -> STILL "evidenced" (round 3 fix: thin-single has no "early" carve-out at all any more)');
});
