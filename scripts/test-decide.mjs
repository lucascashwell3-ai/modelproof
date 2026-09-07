import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  decide, filterCandidates, isReachable, vendorCountry, WHY_FIELDS, VENDOR_KEY_DISPLAY, STANCES,
  taskFitFor, basisFromClaims, judgedBandOf, bandRank, confidenceRank, isEnterpriseInput,
  isDisqualifiedFromStartHere, topClaimSentence, rankByStance, dominates,
} from '../assets/decide.mjs';
import { TASK_IDS, BASIS_TOKENS } from './derive-task-fit.mjs';

const ROOT = new URL('../', import.meta.url);
const readJson = (p) => JSON.parse(readFileSync(new URL(p, ROOT)));

const models = readJson('data/models.json').models;
const plans = readJson('data/plans.json').plans;
const presets = readJson('data/usage-presets.json').presets;
const vendors = readJson('data/vendors.json').vendors;
const data = { models, plans, presets, vendors };

// ---------------------------------------------------------------------------------------------
// Registry consistency: assets/decide.mjs's why-text vocabulary and scripts/derive-task-fit.mjs's
// basis vocabulary must be the exact same set, or "why mentions only fields in fit_basis" would
// be unenforceable (a basis token with no template, or a template for a token no task ever
// emits) without either file knowing the other drifted.
// ---------------------------------------------------------------------------------------------
test('registry: WHY_FIELDS keys and derive-task-fit BASIS_TOKENS are the same set', () => {
  const whyKeys = Object.keys(WHY_FIELDS).sort();
  const basisTokens = [...BASIS_TOKENS].sort();
  assert.deepEqual(whyKeys, basisTokens);
});

// (the "situations only reference real task ids" sanity check now lives in
// scripts/test-eval-situations.mjs, alongside the rest of the situations.json-driven eval)

// ---------------------------------------------------------------------------------------------
// The situations eval used to live here as a hard-coded 20-case test. It's superseded (2026-09-07)
// by scripts/test-eval-situations.mjs, which runs every situation in data/eval/situations.json
// PLUS data/eval/must-never.json and prints a pass rate — situations.json itself now holds a cold
// answer key (drafted by a separate pass with no visibility into this engine's internals, not by
// running decide() and reading off the winner) precisely so this eval can't grade its own
// homework. See that file for the real eval; this file keeps the structural/property tests below.
// ---------------------------------------------------------------------------------------------

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

            // (c) under 'cheapest', start_here is the cheapest model WITHIN THE TOP (band,
            //     confidence) tier among candidates (rule 4, rewritten 2026-09-07: band and
            //     confidence come before any stance's cost/fit comparator, "cheapest" included —
            //     a cheaper but lower-judged model never outranks a better-judged one). Recomputed
            //     independently from the full pre-ranking candidate set, not just the top 3.
            if (stance === 'cheapest') {
              const { candidates } = filterCandidates(taskId, input, data);
              if (candidates.length) {
                const topBand = Math.max(...candidates.map((c) => bandRank(c.band)));
                const topConfidence = Math.max(...candidates.filter((c) => bandRank(c.band) === topBand).map((c) => confidenceRank(c.confidence)));
                const topTier = candidates.filter((c) => bandRank(c.band) === topBand && confidenceRank(c.confidence) === topConfidence);
                const withCost = topTier.filter((c) => typeof c.monthly_cost_usd === 'number');
                const startHere = shortlist.find((x) => x.start_here);
                if (!startHere) {
                  failures.push(`${label}: candidates exist but no start_here was returned`);
                } else if (withCost.length) {
                  const minCost = Math.min(...withCost.map((c) => c.monthly_cost_usd));
                  // start_here can legitimately be pricier than minCost only if the actual
                  // cheapest-in-tier model(s) were disqualified from start_here (preview/low
                  // adoption) — never for any other reason.
                  if (Math.abs(startHere.monthly_cost_usd - minCost) > 1e-9) {
                    const ranked = rankByStance(candidates, stance);
                    const cheapestInTier = topTier.find((c) => Math.abs(c.monthly_cost_usd - minCost) < 1e-9);
                    const cheapestDisqualified = cheapestInTier && isDisqualifiedFromStartHere(cheapestInTier, ranked, stance, input);
                    if (!cheapestDisqualified) {
                      failures.push(`${label}: start_here "${startHere.id}" costs ${startHere.monthly_cost_usd}, cheapest in its (band,confidence) tier is ${minCost} and wasn't disqualified`);
                    }
                  }
                }
              }
            }

            // (d) never a pricier, lower-fit model dominated by a cheaper one IN THE SAME JUDGED
            // TIER (band, then confidence) — rewritten 2026-09-07 alongside dropDominated/
            // dominates(): a pricier model with a lower raw fit number can legitimately survive
            // now if its judged band is higher (that's the whole point of the rewrite — a
            // 'capable' model can never eliminate a 'strong' one just by being cheaper), so the
            // old "pricier AND lower-fit" check only still applies within one (band, confidence)
            // tier, where dominates() falls back to exactly that comparison.
            const bandOf = (id) => { const mm = models.find((x) => x.id === id); return judgedBandOf(mm, taskId); };
            for (const a of shortlist) {
              for (const b of shortlist) {
                if (a === b || typeof a.monthly_cost_usd !== 'number' || typeof b.monthly_cost_usd !== 'number') continue;
                const ba = bandOf(a.id), bb = bandOf(b.id);
                const shaped = (item, band) => ({ ...item, band: band.band, confidence: band.confidence, model: { adoption: item.adoption } });
                if (dominates(shaped(b, bb), shaped(a, ba))) {
                  failures.push(`${label}: "${a.id}" ($${a.monthly_cost_usd}, fit ${a.fit}, band ${ba.band}) is dominated by "${b.id}" ($${b.monthly_cost_usd}, fit ${b.fit}, band ${bb.band}) but both survived to the shortlist`);
                }
              }
            }

            // (e) every shortlist item carries a real basis/status/adoption/why — the judgment-
            // first shape every candidate must have now that a judged record is mandatory to be
            // a candidate at all (rule 3, rewritten 2026-09-07).
            for (const item of shortlist) {
              if (!['reported', 'lab-stated'].includes(item.basis)) failures.push(`${label}: "${item.id}" basis "${item.basis}" must be reported|lab-stated now that judgment gates every candidate`);
              if (!item.claims || !item.claims.length) failures.push(`${label}: "${item.id}" has no claims backing its judged band`);
              if (typeof item.why !== 'string' || !item.why.length) failures.push(`${label}: "${item.id}" has no why text`);
              if (item.status == null) failures.push(`${label}: "${item.id}" is missing status`);
              if (item.adoption == null) failures.push(`${label}: "${item.id}" is missing adoption`);
            }

            // (f) NEW RULE — status:'preview' never gets start_here under stance 'best' or an
            // enterprise-style input, UNLESS every candidate is preview-disqualified (nothing
            // better to prefer).
            if (stance === 'best' || isEnterpriseInput(input)) {
              const startHere = shortlist.find((x) => x.start_here);
              if (startHere && startHere.status === 'preview') {
                const { candidates } = filterCandidates(taskId, input, data);
                const hadNonPreviewAlternative = candidates.some((c) => c.model.status !== 'preview');
                if (hadNonPreviewAlternative) {
                  failures.push(`${label}: start_here "${startHere.id}" is a preview model but a non-preview candidate existed`);
                }
              }
            }

            // (f2) NEW RULE — an enterprise-style input excludes status:'preview' from the
            // shortlist ENTIRELY, not just from start_here.
            if (isEnterpriseInput(input)) {
              for (const item of shortlist) {
                if (item.status === 'preview') failures.push(`${label}: "${item.id}" is a preview model but the input is enterprise-style — it must be fully excluded, not just demoted`);
              }
            }

            // (g) NEW RULE — adoption:'low' never gets start_here while a broad/moderate model of
            // the SAME judged band is also a candidate.
            {
              const startHere = shortlist.find((x) => x.start_here);
              if (startHere && startHere.adoption === 'low') {
                const { candidates } = filterCandidates(taskId, input, data);
                // band isn't on the shortlist item itself — look it back up from the candidate set.
                const startHereCandidate = candidates.find((c) => c.model.id === startHere.id);
                const hadBetterAdoptionSameBand = startHereCandidate && candidates.some((c) => (
                  c !== startHereCandidate && c.band === startHereCandidate.band &&
                  (c.model.adoption === 'broad' || c.model.adoption === 'moderate')
                ));
                if (hadBetterAdoptionSameBand) {
                  failures.push(`${label}: start_here "${startHere.id}" has low adoption but a broader-adoption same-band candidate existed`);
                }
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
// that vendor's own model. Before this fix, direct_api !== true wrongly hid: claude-fable-5-1
// (1/6 Anthropic), gpt-6-astra + gpt-6-astra-pro (2/7 OpenAI), gemini-3-8-flash (1/6 Google),
// grok-4-6 (1/2 xAI) — all real, sellable, first-party models with a sourced task_fit.
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
  // This fixture must keep at least one direct_api !== true first-party model per vendor, or
  // this test stops exercising the bug it's guarding against.
  const byVendor = {};
  for (const m of stillUnsourced) byVendor[m.vendor] = (byVendor[m.vendor] || 0) + 1;
  assert.deepEqual(byVendor, { Anthropic: 1, OpenAI: 2, Google: 1, xAI: 1 });
  for (const m of stillUnsourced) {
    const key = Object.keys(VENDOR_KEY_DISPLAY).find((k) => VENDOR_KEY_DISPLAY[k] === m.vendor);
    assert.ok(isReachable(m, [key]), `"${m.id}" (${m.vendor}, direct_api=${m.availability?.direct_api}) must be reachable via its own vendor key`);
  }
});

// ---------------------------------------------------------------------------------------------
// Performance: a single call for all 10 tasks at once must stay well under the 50ms/query budget
// the spec sets for browser use (this dataset is 67 models — trivial for plain JS, but this is
// the guard that would catch an accidental O(n^2)-over-everything regression).
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

// ---------------------------------------------------------------------------------------------
// Judged task fit (2026-09-06): a model with no quantitative task_fit for a task can still clear
// rule 3's floor on a judged band, and it must always carry a 'reported'/'lab-stated' basis (not
// 'measured') plus the claims that back it — see assets/decide.mjs's taskFitFor()/JUDGED_BAND_SCORE.
// ---------------------------------------------------------------------------------------------
const JUDGED_CLAIM = {
  sentence: 'Acme Corp published a coding benchmark score of 82% for Judged Test Model on August 1, 2026.',
  source_url: 'https://vendor.example/judged-test-model',
  tier: 'reported',
  date: '2026-08-01',
  quote: 'Judged Test Model scores 82% on our internal coding benchmark.',
};
function judgedFixtureModel(overrides = {}) {
  return {
    id: 'judged-test-model', name: 'Judged Test Model', vendor: 'Acme',
    price_input: 0.1, price_output: 0.1, context_window: 100000,
    benchmarks: {}, best_for: [], availability: { openrouter: true, sources: [] },
    task_fit: Object.fromEntries(TASK_IDS.map((t) => [t, { score: null, basis: [], reason: 'fixture — no quantitative basis' }])),
    task_fit_judged: { coding: { band: 'strong', confidence: 'high', claims: [JUDGED_CLAIM], reconciliation: null, as_of: '2026-09-01' } },
    ...overrides,
  };
}

test('taskFitFor: quantitative fit always wins over a judged band when both exist', () => {
  const m = judgedFixtureModel({ task_fit: { ...judgedFixtureModel().task_fit, coding: { score: 71, basis: ['coding_score'] } } });
  const fit = taskFitFor(m, 'coding');
  assert.equal(fit.source, 'measured');
  assert.equal(fit.score, 71);
});

test('taskFitFor: "weak"/"unknown" judged bands never clear the floor (score stays null)', () => {
  for (const band of ['weak', 'unknown']) {
    const m = judgedFixtureModel({ task_fit_judged: { coding: { band, confidence: 'low', claims: [JUDGED_CLAIM], reconciliation: null, as_of: '2026-09-01' } } });
    const fit = taskFitFor(m, 'coding');
    assert.equal(fit.score, null, `band "${band}" must not clear the floor`);
  }
});

test('basisFromClaims: "lab-stated" when every claim is the vendor\'s own, "reported" when any claim names a third party', () => {
  assert.equal(basisFromClaims([{ tier: 'lab' }, { tier: 'lab' }]), 'lab-stated');
  assert.equal(basisFromClaims([{ tier: 'lab' }, { tier: 'reported' }]), 'reported');
  assert.equal(basisFromClaims([{ tier: 'measured' }]), 'reported');
});

test('judged fit: a model with only a judged band appears in the shortlist with a non-measured basis and its claims', () => {
  const fixture = judgedFixtureModel();
  const judgedData = { models: [fixture], plans, presets, vendors };
  const out = decide({ tasks: ['coding'], have: ['any'], stance: 'best', volume: 'typical', dataRule: {} }, judgedData);
  const item = out.tasks.coding.shortlist.find((x) => x.id === 'judged-test-model');
  assert.ok(item, 'expected the judged-only model to clear the floor and appear in the shortlist');
  assert.equal(item.basis, 'reported');
  assert.notEqual(item.basis, 'measured');
  assert.equal(item.claims.length, 1);
  assert.equal(item.claims[0].source_url, JUDGED_CLAIM.source_url);
  // why (rewritten 2026-09-07): the record's own top claim sentence, verbatim — not a generic
  // "judged X fit" restatement.
  assert.equal(item.why, JUDGED_CLAIM.sentence);
});

test('judged fit: a "weak" band never appears in the shortlist (same as no basis at all)', () => {
  const fixture = judgedFixtureModel({ task_fit_judged: { coding: { band: 'weak', confidence: 'medium', claims: [JUDGED_CLAIM], reconciliation: null, as_of: '2026-09-01' } } });
  const judgedData = { models: [fixture], plans, presets, vendors };
  const out = decide({ tasks: ['coding'], have: ['any'], stance: 'best', volume: 'typical', dataRule: {} }, judgedData);
  assert.equal(out.tasks.coding.shortlist.length, 0);
});

// ---------------------------------------------------------------------------------------------
// Judged-ranking rewrite (2026-09-07): the whole point of this change is that adoption/status —
// NOT just a benchmark number — now DOES change ranking (the opposite of the pre-rewrite
// invariant this test file used to assert). This is the regression test for the exact bug the
// rewrite exists to fix: a low-adoption preview model must never win start_here over a
// broad/moderate-adoption GA model of the SAME judged band on fit/price alone.
// ---------------------------------------------------------------------------------------------
function bandedFixture(id, overrides = {}) {
  return judgedFixtureModel({
    id, name: overrides.name || id,
    price_input: 0.1, price_output: 0.1,
    task_fit_judged: { coding: { band: 'strong', confidence: 'high', claims: [{ ...JUDGED_CLAIM, sentence: `${id} claim` }], reconciliation: null, as_of: '2026-09-01' } },
    status: 'ga', adoption: 'unknown',
    ...overrides,
  });
}

test('adoption gate: a low-adoption model never gets start_here over a broad/moderate model of the SAME band, even with a higher raw fit', () => {
  // Priced so neither dominates the other (dropDominated would otherwise remove whichever one
  // has both a lower-or-equal fit AND a lower-or-equal cost, defeating the point of this test) —
  // the higher-fit model costs more, the broader-adoption model costs less.
  const low = bandedFixture('low-adopt-strong', { adoption: 'low', price_output: 10, task_fit: { ...judgedFixtureModel().task_fit, coding: { score: 99, basis: ['coding_score'] } } });
  const broad = bandedFixture('broad-adopt-strong', { adoption: 'broad', price_output: 0.1, task_fit: { ...judgedFixtureModel().task_fit, coding: { score: 60, basis: ['coding_score'] } } });
  const out = decide({ tasks: ['coding'], have: ['any'], stance: 'best', volume: 'typical', dataRule: {} }, { models: [low, broad], plans, presets, vendors });
  const shortlist = out.tasks.coding.shortlist;
  const startHere = shortlist.find((x) => x.start_here);
  assert.equal(startHere.id, 'broad-adopt-strong', 'the higher-fit but low-adoption model must not win start_here over a same-band broad-adoption model');
  assert.ok(shortlist.some((x) => x.id === 'low-adopt-strong'), 'the low-adoption model should still appear in the shortlist, just not first');
});

test('adoption gate: a low-adoption model DOES get start_here when no broad/moderate model of the same band exists', () => {
  const low = bandedFixture('lonely-low-adopt', { adoption: 'low' });
  const out = decide({ tasks: ['coding'], have: ['any'], stance: 'best', volume: 'typical', dataRule: {} }, { models: [low], plans, presets, vendors });
  assert.equal(out.tasks.coding.shortlist.find((x) => x.start_here)?.id, 'lonely-low-adopt');
});

test('preview gate: a preview model never gets start_here under stance "best" when a non-preview candidate exists', () => {
  const preview = bandedFixture('preview-model', { status: 'preview', price_output: 10, task_fit: { ...judgedFixtureModel().task_fit, coding: { score: 99, basis: ['coding_score'] } } });
  const ga = bandedFixture('ga-model', { status: 'ga', price_output: 0.1, task_fit: { ...judgedFixtureModel().task_fit, coding: { score: 60, basis: ['coding_score'] } } });
  const out = decide({ tasks: ['coding'], have: ['any'], stance: 'best', volume: 'typical', dataRule: {} }, { models: [preview, ga], plans, presets, vendors });
  assert.equal(out.tasks.coding.shortlist.find((x) => x.start_here)?.id, 'ga-model');
});

test('preview gate: stance "cheapest" with no enterprise-style input does NOT disqualify a preview model', () => {
  const preview = bandedFixture('preview-cheapest-ok', { status: 'preview', price_output: 0.01 });
  const out = decide({ tasks: ['coding'], have: ['any'], stance: 'cheapest', volume: 'typical', dataRule: {} }, { models: [preview], plans, presets, vendors });
  assert.equal(out.tasks.coding.shortlist.find((x) => x.start_here)?.id, 'preview-cheapest-ok');
});

test('preview gate: an enterprise-style input (single named vendor + heavy volume) EXCLUDES preview entirely, not just from start_here', () => {
  // (2026-09-07, against the independently-drafted 40-situation answer key: enterprise + preview
  // must be a full exclusion — "must_not_include", not just "must_not_start" — see
  // data/eval/must-never.json's "a preview-labeled SKU must never be the enterprise starting
  // recommendation" entries.)
  const preview = bandedFixture('preview-enterprise', { status: 'preview', vendor: 'Anthropic', price_output: 10, task_fit: { ...judgedFixtureModel().task_fit, coding: { score: 99, basis: ['coding_score'] } } });
  const ga = bandedFixture('ga-enterprise', { status: 'ga', vendor: 'Anthropic', price_output: 0.1, task_fit: { ...judgedFixtureModel().task_fit, coding: { score: 60, basis: ['coding_score'] } } });
  const out = decide({ tasks: ['coding'], have: ['anthropic'], stance: 'balanced', volume: 'heavy', dataRule: {} }, { models: [preview, ga], plans, presets, vendors });
  const shortlist = out.tasks.coding.shortlist;
  assert.equal(shortlist.find((x) => x.start_here)?.id, 'ga-enterprise');
  assert.ok(!shortlist.some((x) => x.id === 'preview-enterprise'), 'a preview model must not appear anywhere in an enterprise-style shortlist');
});

test('isEnterpriseInput: an explicit input.enterprise overrides the heuristic in both directions', () => {
  // true overrides a heuristic that would otherwise say false (openrouter-anything + a custom volume)
  assert.equal(isEnterpriseInput({ enterprise: true, have: ['openrouter'], volume: { tokens_in_month: 1, tokens_out_month: 1 }, dataRule: {} }), true);
  // false overrides a heuristic that would otherwise say true (a dataRule is set)
  assert.equal(isEnterpriseInput({ enterprise: false, have: ['any'], volume: 'typical', dataRule: { noChinaHosted: true } }), false);
});

test('preview gate: explicit input.enterprise:true excludes preview entirely even when the heuristic alone would not', () => {
  const preview = bandedFixture('preview-explicit-enterprise', { status: 'preview' });
  const out = decide({ tasks: ['coding'], have: ['any'], stance: 'balanced', volume: 'typical', dataRule: {}, enterprise: true }, { models: [preview], plans, presets, vendors });
  assert.equal(out.tasks.coding.shortlist.length, 0, 'the only candidate is a preview model excluded by explicit enterprise:true, so the shortlist is empty');
});

test('isEnterpriseInput: single named vendor needs BOTH the vendor and heavy volume; a dataRule alone is enough on its own', () => {
  assert.equal(isEnterpriseInput({ have: ['anthropic'], volume: 'heavy', dataRule: {} }), true);
  assert.equal(isEnterpriseInput({ have: ['anthropic'], volume: 'typical', dataRule: {} }), false);
  assert.equal(isEnterpriseInput({ have: ['any'], volume: 'heavy', dataRule: {} }), false);
  assert.equal(isEnterpriseInput({ have: ['openrouter'], volume: 'heavy', dataRule: {} }), false);
  assert.equal(isEnterpriseInput({ have: ['any'], volume: 'light', dataRule: { noChinaHosted: true } }), true);
});

test('judgedBandOf: no task_fit_judged record at all reads the same as an explicit "unknown" band', () => {
  assert.deepEqual(judgedBandOf({ task_fit_judged: null }, 'coding'), { band: 'unknown', confidence: null, judged: null });
  assert.deepEqual(judgedBandOf({ task_fit_judged: {} }, 'coding'), { band: 'unknown', confidence: null, judged: null });
  const rec = { band: 'strong', confidence: 'high', claims: [] };
  assert.deepEqual(judgedBandOf({ task_fit_judged: { coding: rec } }, 'coding'), { band: 'strong', confidence: 'high', judged: rec });
});

test('topClaimSentence: prefers a non-usage claim over a usage claim, falls back to usage if that\'s all there is', () => {
  const usageOnly = [{ tier: 'usage', sentence: 'usage sentence' }];
  assert.equal(topClaimSentence(usageOnly), 'usage sentence');
  const mixed = [{ tier: 'usage', sentence: 'usage sentence' }, { tier: 'lab', sentence: 'lab sentence' }];
  assert.equal(topClaimSentence(mixed), 'lab sentence');
  assert.equal(topClaimSentence([]), 'No sourced claim on file for this pick.');
});
