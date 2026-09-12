import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  decide, filterCandidates, isReachable, vendorCountry, WHY_FIELDS, VENDOR_KEY_DISPLAY, STANCES,
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
const situations = readJson('eval/situations.json').situations;
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

// ---------------------------------------------------------------------------------------------
// Sanity: every task id used in the frozen situations fixture is one derive-task-fit.mjs knows.
// ---------------------------------------------------------------------------------------------
test('eval situations only reference real task ids', () => {
  for (const s of situations) {
    for (const t of s.input.tasks) assert.ok(TASK_IDS.includes(t), `situation "${s.id}" uses unknown task "${t}"`);
  }
});

// ---------------------------------------------------------------------------------------------
// The 20-situation eval. Each situation's `expected` was drafted by running decide() against the
// catalog frozen in scripts/fixtures/ (see data/eval/situations.json's _readme for how the
// numbers were picked). This runs on that frozen snapshot only — it is a code-contract test on
// decide()'s logic, not a check on live data. The live catalog after a Collect is checked
// separately, by invariants only, in scripts/check-live-data.mjs.
// ---------------------------------------------------------------------------------------------
test('eval: 20 realistic situations match their drafted expectations', () => {
  const failures = [];
  for (const s of situations) {
    const taskId = s.input.tasks[0];
    const out = decide(s.input, data);
    const shortlist = out.tasks[taskId]?.shortlist || [];
    const { start_here_any_of, must_not_include } = s.expected;

    if (start_here_any_of.length === 0) {
      if (shortlist.length !== 0) failures.push(`${s.id}: expected an empty shortlist, got [${shortlist.map((x) => x.id)}]`);
    } else {
      const startHere = shortlist.find((x) => x.start_here);
      if (!startHere) failures.push(`${s.id}: no start_here item in shortlist`);
      else if (!start_here_any_of.includes(startHere.id)) {
        failures.push(`${s.id}: start_here "${startHere.id}" not in expected [${start_here_any_of}]`);
      }
    }
    for (const id of must_not_include || []) {
      if (shortlist.some((x) => x.id === id)) failures.push(`${s.id}: "${id}" must not appear in the shortlist but does`);
    }
  }
  assert.equal(failures.length, 0, `\n${failures.join('\n')}`);
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

            // (c) under 'cheapest', start_here is the cheapest model that clears every filter
            //     (recomputed independently from the full pre-ranking candidate set, not just
            //     the top 3, so this checks against the WHOLE eligible universe).
            if (stance === 'cheapest') {
              const { candidates } = filterCandidates(taskId, input, data);
              const withCost = candidates.filter((c) => typeof c.monthly_cost_usd === 'number');
              if (withCost.length) {
                const minCost = Math.min(...withCost.map((c) => c.monthly_cost_usd));
                const startHere = shortlist.find((x) => x.start_here);
                if (!startHere) failures.push(`${label}: candidates exist but no start_here was returned`);
                else if (Math.abs(startHere.monthly_cost_usd - minCost) > 1e-9) {
                  failures.push(`${label}: start_here "${startHere.id}" costs ${startHere.monthly_cost_usd}, cheapest eligible is ${minCost}`);
                }
              } else if (candidates.length && shortlist.length === 0) {
                failures.push(`${label}: candidates existed (all unpriced) but shortlist was empty`);
              }
            }

            // (d) never a pricier model with a lower fit than a cheaper one in the same shortlist
            for (const a of shortlist) {
              for (const b of shortlist) {
                if (a === b || typeof a.monthly_cost_usd !== 'number' || typeof b.monthly_cost_usd !== 'number') continue;
                if (a.monthly_cost_usd > b.monthly_cost_usd && a.fit < b.fit) {
                  failures.push(`${label}: "${a.id}" ($${a.monthly_cost_usd}, fit ${a.fit}) is pricier AND lower-fit than "${b.id}" ($${b.monthly_cost_usd}, fit ${b.fit})`);
                }
              }
            }

            // (e) every `why` mentions only fields present in that item's fit_basis
            for (const item of shortlist) {
              const mentioned = Object.entries(WHY_FIELDS).filter(([, v]) => v.mention.test(item.why)).map(([k]) => k);
              const extra = mentioned.filter((k) => !item.fit_basis.includes(k));
              if (extra.length) failures.push(`${label}: "${item.id}" why="${item.why}" mentions ${extra} not in fit_basis [${item.fit_basis}]`);
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
