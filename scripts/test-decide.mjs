import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  decide, filterCandidates, isReachable, vendorCountry, WHY_FIELDS, VENDOR_KEY_DISPLAY, STANCES,
  taskFitFor, basisFromClaims, judgedBandOf, bandRank, confidenceRank, isEnterpriseInput,
  isDisqualifiedFromStartHere, topClaimSentence, rankByStance, dominates, dropDominated,
  calibrateBand,
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

            // (c) under 'cheapest', start_here is the overall cheapest candidate ACROSS EVERY
            //     (band, confidence) tier (rule 4, rewritten 2026-09-07: 'cheapest' now sorts on
            //     cost first, regardless of tier, as long as the candidate already cleared rule
            //     3's strong-or-capable floor — ties fall back to band, then confidence. A prior
            //     version of this rule put band/confidence ahead of cost for every stance, which
            //     made 'cheapest' silently identical to 'best' whenever candidates spanned more
            //     than one tier). Recomputed independently from the full pre-ranking candidate
            //     set (after the same domination pruning decide() itself applies), not just the
            //     top 3.
            if (stance === 'cheapest') {
              const { candidates } = filterCandidates(taskId, input, data);
              if (candidates.length) {
                const pruned = dropDominated(candidates);
                const withCost = pruned.filter((c) => typeof c.monthly_cost_usd === 'number');
                const startHere = shortlist.find((x) => x.start_here);
                if (!startHere) {
                  failures.push(`${label}: candidates exist but no start_here was returned`);
                } else if (withCost.length) {
                  const minCost = Math.min(...withCost.map((c) => c.monthly_cost_usd));
                  // start_here can legitimately be pricier than the overall cheapest only if
                  // every candidate at or under that cost was disqualified from start_here (low
                  // adoption) — never for any other reason.
                  if (Math.abs(startHere.monthly_cost_usd - minCost) > 1e-9) {
                    // Disqualification is checked against the FULL pre-domination candidate set,
                    // exactly like decide() itself does — a same-band broad/moderate alternative
                    // that dropDominated later pruned on pure price/fit still has to count here,
                    // or this check would wrongly flag a start_here decide() got right.
                    const cheaperCandidates = pruned.filter((c) => (
                      typeof c.monthly_cost_usd === 'number' && c.monthly_cost_usd < startHere.monthly_cost_usd - 1e-9
                    ));
                    const allCheaperDisqualified = cheaperCandidates.every((c) => isDisqualifiedFromStartHere(c, candidates, stance, input));
                    if (!allCheaperDisqualified) {
                      failures.push(`${label}: start_here "${startHere.id}" costs ${startHere.monthly_cost_usd}, a cheaper undisqualified candidate exists (cheapest overall: ${minCost})`);
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
            // Rule 3b calibration (2026-09-07): decide() ranks/gates/dominates on the CALIBRATED
            // band (a claimed "strong" with fewer than 2 signal families downgrades to
            // "capable" — see calibrateBand), never the raw judged record's own band, so this
            // re-derivation has to apply the same calibration or it would flag a domination
            // "violation" against a band decide() itself never actually used.
            const bandOf = (id) => {
              const mm = models.find((x) => x.id === id);
              const raw = judgedBandOf(mm, taskId);
              const { band } = calibrateBand(mm, taskId, raw.band);
              return { band, confidence: raw.confidence };
            };
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

            // (f) a plain stance 'best' with NO enterprise signal may legitimately pick a preview
            // model as start_here (removed 2026-09-07 — see isDisqualifiedFromStartHere's own
            // comment and data/eval/situations.json's S33). The only remaining preview rule is the
            // enterprise-style full exclusion, checked below as (f2).

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

test('preview gate: GA never loses start_here to a preview model in the SAME band, even when the preview has a higher raw fit (reintroduced 2026-09-07, narrower than the blanket rule removed earlier that day — see isDisqualifiedFromStartHere\'s comment; this is the exact shape of bug the real catalog showed for "writing": gemini-3-1-pro outranking claude-sonnet-5 on a families/fit tie-break despite both being "capable")', () => {
  const preview = bandedFixture('preview-model', { status: 'preview', price_output: 10, task_fit: { ...judgedFixtureModel().task_fit, coding: { score: 99, basis: ['coding_score'] } } });
  const ga = bandedFixture('ga-model', { status: 'ga', price_output: 0.1, task_fit: { ...judgedFixtureModel().task_fit, coding: { score: 60, basis: ['coding_score'] } } });
  const out = decide({ tasks: ['coding'], have: ['any'], stance: 'best', volume: 'typical', dataRule: {} }, { models: [preview, ga], plans, presets, vendors });
  const shortlist = out.tasks.coding.shortlist;
  // Same band for both fixtures ('strong') — GA wins start_here regardless of the preview
  // model's higher measured coding_score (99 vs 60); the preview model still appears lower in
  // the shortlist, just never as start_here.
  assert.equal(shortlist.find((x) => x.start_here)?.id, 'ga-model');
  assert.ok(shortlist.some((x) => x.id === 'preview-model'), 'the preview model should still appear in the shortlist, just not first');
});

test('preview gate: a preview model DOES win start_here under plain "best" when no GA model shares its band (data/eval/situations.json\'s S33 — Google-only vision, no GA candidate even clears the judged floor there)', () => {
  // families: 2 keeps the default 'strong' judged band from being calibration-downgraded to
  // 'capable' (rule 3b needs >= 2 real-world signal families for a claimed 'strong' to survive
  // as 'strong') — without it, this fixture's 'strong' would collapse to 'capable' same as the
  // GA rival below, defeating the point of this different-band test.
  const preview = bandedFixture('lonely-preview-strong', { status: 'preview', signals: { coding: { families: 2 } } });
  const gaOtherBand = bandedFixture('ga-weaker-band', { status: 'ga', task_fit_judged: { coding: { band: 'capable', confidence: 'high', claims: [{ ...JUDGED_CLAIM, sentence: 'ga-weaker-band claim' }], reconciliation: null, as_of: '2026-09-01' } } });
  const out = decide({ tasks: ['coding'], have: ['any'], stance: 'best', volume: 'typical', dataRule: {} }, { models: [preview, gaOtherBand], plans, presets, vendors });
  // Different bands ('strong' vs 'capable') — band still outranks status, so the preview model
  // legitimately wins start_here; the new GA-before-preview rule only ever applies WITHIN a band.
  assert.equal(out.tasks.coding.shortlist.find((x) => x.start_here)?.id, 'lonely-preview-strong');
});

test('preview gate: an enterprise-style input still prefers the non-preview candidate — the real exclusion (rule 3) still applies even though the plain-"best" demotion above was removed', () => {
  const preview = bandedFixture('preview-model-ent', { status: 'preview', vendor: 'Acme', price_output: 10, task_fit: { ...judgedFixtureModel().task_fit, coding: { score: 99, basis: ['coding_score'] } } });
  const ga = bandedFixture('ga-model-ent', { status: 'ga', vendor: 'Acme', price_output: 0.1, task_fit: { ...judgedFixtureModel().task_fit, coding: { score: 60, basis: ['coding_score'] } } });
  const out = decide({ tasks: ['coding'], have: ['any'], stance: 'best', volume: 'typical', dataRule: {}, enterprise: true }, { models: [preview, ga], plans, presets, vendors });
  const shortlist = out.tasks.coding.shortlist;
  assert.equal(shortlist.find((x) => x.start_here)?.id, 'ga-model-ent');
  assert.ok(!shortlist.some((x) => x.id === 'preview-model-ent'), 'enterprise:true still fully excludes the preview model at rule 3, regardless of its fit');
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

// ---------------------------------------------------------------------------------------------
// Stance rewrite (2026-09-07): the actual bug this rewrite exists to fix was 'cheapest' silently
// returning the exact same shortlist order as 'best' for every task, because band/confidence sat
// ahead of cost for every stance — price never got a chance to matter. These two tests run
// against the REAL catalog (have: ['any'], so every task has its full candidate pool) and check
// the property the fix is actually supposed to establish, not one hand-picked example.
// ---------------------------------------------------------------------------------------------
test("stance rewrite: for every task, 'cheapest' start_here never costs more than 'best' start_here", () => {
  const failures = [];
  for (const taskId of TASK_IDS) {
    const input = (stance) => ({ tasks: [taskId], have: ['any'], stance, volume: 'typical', dataRule: {} });
    const cheapest = decide(input('cheapest'), data).tasks[taskId].shortlist.find((x) => x.start_here);
    const best = decide(input('best'), data).tasks[taskId].shortlist.find((x) => x.start_here);
    if (!cheapest || !best) continue; // no candidate at all for this task — nothing to compare
    if (typeof cheapest.monthly_cost_usd !== 'number' || typeof best.monthly_cost_usd !== 'number') continue; // unknown cost can't be compared either way
    if (cheapest.monthly_cost_usd > best.monthly_cost_usd + 1e-9) {
      failures.push(`${taskId}: cheapest start_here "${cheapest.id}" costs ${cheapest.monthly_cost_usd} > best start_here "${best.id}" at ${best.monthly_cost_usd}`);
    }
  }
  assert.equal(failures.length, 0, failures.join('\n'));
});

test("stance rewrite: 'cheapest' and 'best' pick a genuinely different shortlist order for at least half of the real tasks — proof 'cheapest' is no longer a silent copy of 'best'", () => {
  let taskCount = 0;
  let differByOrder = 0;
  for (const taskId of TASK_IDS) {
    const input = (stance) => ({ tasks: [taskId], have: ['any'], stance, volume: 'typical', dataRule: {} });
    const cheapestList = decide(input('cheapest'), data).tasks[taskId].shortlist.map((x) => x.id);
    const bestList = decide(input('best'), data).tasks[taskId].shortlist.map((x) => x.id);
    if (cheapestList.length < 2 && bestList.length < 2) continue; // fewer than 2 candidates: no order to compare
    taskCount++;
    if (JSON.stringify(cheapestList) !== JSON.stringify(bestList)) differByOrder++;
  }
  assert.ok(taskCount > 0, 'fixture assumption: at least one real task has >= 2 candidates for have: [\'any\']');
  assert.ok(
    differByOrder >= Math.ceil(taskCount / 2),
    `expected cheapest != best for at least half of the ${taskCount} comparable tasks, got ${differByOrder}`,
  );
});

// ---------------------------------------------------------------------------------------------
// Cost coverage (2026-09-07): monthly_cost_usd must be a real number whenever a candidate has
// both price_input/price_output on file and a resolved volume preset — null only when a price
// is genuinely missing from data/models.json (see decide()'s missing-price assumption line,
// which fires per shortlist item that's still null for that reason). This is the regression test
// for the exact failure mode a malformed caller used to trigger SILENTLY: passing the whole
// parsed data/usage-presets.json file (with its _readme/as_of wrapper) as `data.presets` instead
// of that file's own `presets` sub-object made every monthly_cost_usd null, with no error
// anywhere — and because 'cheapest' has nothing left to break a tie on when cost is always null,
// it also silently collapsed to the exact same order as 'best' (see the two "stance rewrite"
// tests above, which already assert the other two halves of this: cheapest.start_here never
// costs more than best.start_here, and their orders differ for at least half the real tasks).
// unwrapPresets() in resolveVolume() now guards the specific caller mistake that caused this.
// ---------------------------------------------------------------------------------------------
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
  assert.ok(
    coverage >= 0.9,
    `only ${withCost}/${total} shortlist items (${(coverage * 100).toFixed(1)}%) have a numeric cost, want >= 90%: ${missing.join(', ')}`,
  );
});

// ---------------------------------------------------------------------------------------------
// GA-before-preview invariant (2026-09-07): within the SAME calibrated judged band, a
// status:'preview' item must never rank ahead of a GA item in the returned shortlist, for any
// stance except 'cheapest' (which stays cost-primary by design — see isDisqualifiedFromStartHere
// and byBandThenConfidence's own comments). Run against the real catalog, not a hand-built
// fixture, so it actually catches a real (task, stance) combination going stale — this is exactly
// how the bug surfaced originally (gemini-3-1-pro over claude-sonnet-5 for "writing").
// ---------------------------------------------------------------------------------------------
test("invariant: a GA shortlist item is never ranked below a preview item of the SAME judged band, for every task and every stance except 'cheapest'", () => {
  const failures = [];
  const bandOf = (taskId, id) => {
    const m = models.find((x) => x.id === id);
    const raw = judgedBandOf(m, taskId);
    return calibrateBand(m, taskId, raw.band).band;
  };
  for (const taskId of TASK_IDS) {
    for (const stance of STANCES) {
      if (stance === 'cheapest') continue;
      const out = decide({ tasks: [taskId], have: ['any'], stance, volume: 'typical', dataRule: {} }, data);
      const shortlist = out.tasks[taskId].shortlist;
      for (let i = 0; i < shortlist.length; i++) {
        if (shortlist[i].status !== 'preview') continue;
        const previewBand = bandOf(taskId, shortlist[i].id);
        for (let j = i + 1; j < shortlist.length; j++) {
          if (shortlist[j].status === 'preview') continue;
          if (bandOf(taskId, shortlist[j].id) === previewBand) {
            failures.push(`${taskId}/${stance}: GA "${shortlist[j].id}" ranked BELOW preview "${shortlist[i].id}" (both band "${previewBand}")`);
          }
        }
      }
    }
  }
  assert.equal(failures.length, 0, failures.join('\n'));
});
