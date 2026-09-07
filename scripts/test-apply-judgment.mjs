import test from 'node:test';
import assert from 'node:assert/strict';
import { validateJudgment, applyOne } from './apply-judgment.mjs';

const SOURCES = [{ url: 'https://vendor.example.com/pricing', date: '2026-08-16' }];
const REASON = 'confirmed on vendor pricing page';

test('validateJudgment rejects an unknown field', () => {
  const errs = validateJudgment({ id: 'm:foo', kind: 'conflict', field: 'made_up_field', value: 5, sources: SOURCES, reason: REASON });
  assert.ok(errs.some((e) => /does not exist/.test(e)));
});

test('validateJudgment rejects a non-http source', () => {
  const errs = validateJudgment({ id: 'm:price_input', kind: 'conflict', field: 'price_input', value: 5, sources: [{ url: 'ftp://x.com', date: '2026-08-16' }], reason: REASON });
  assert.ok(errs.some((e) => /not http/.test(e)));
});

test('validateJudgment rejects empty sources', () => {
  const errs = validateJudgment({ id: 'm:price_input', kind: 'conflict', field: 'price_input', value: 5, sources: [], reason: REASON });
  assert.ok(errs.some((e) => /sources\[\] must be non-empty/.test(e)));
});

test('validateJudgment rejects a reason under 12 chars', () => {
  const errs = validateJudgment({ id: 'm:price_input', kind: 'conflict', field: 'price_input', value: 5, sources: SOURCES, reason: 'short' });
  assert.ok(errs.some((e) => /reason must be/.test(e)));
});

test('validateJudgment rejects a non-numeric value on a numeric field', () => {
  const errs = validateJudgment({ id: 'm:price_input', kind: 'conflict', field: 'price_input', value: '5', sources: SOURCES, reason: REASON });
  assert.ok(errs.some((e) => /numeric but value/.test(e)));
});

test('validateJudgment accepts a well-formed conflict judgment', () => {
  const errs = validateJudgment({ id: 'm:price_input', kind: 'conflict', field: 'price_input', value: 5, sources: SOURCES, reason: REASON });
  assert.deepEqual(errs, []);
});

test('validateJudgment accepts a benchmark field written into benchmarks{}', () => {
  const errs = validateJudgment({ id: 'm:gpqa', kind: 'benchmark', field: 'gpqa', value: 91.2, sources: SOURCES, reason: REASON });
  assert.deepEqual(errs, []);
});

test('validateJudgment accepts a hold with a real reason, rejects a hold without one', () => {
  assert.deepEqual(validateJudgment({ id: 'm:price_input', hold: true, reason: 'no corroborating source found' }), []);
  const errs = validateJudgment({ id: 'm:price_input', hold: true, reason: 'nah' });
  assert.ok(errs.length);
});

test('applyOne writes a conflict field onto the matching model and records sources', () => {
  const data = { models: [{ id: 'acme-1', name: 'Acme One', price_input: 3, sources: [] }] };
  const entry = applyOne(data, { id: 'acme-1:price_input', kind: 'conflict', field: 'price_input', value: 4, sources: SOURCES, reason: REASON }, '2026-08-16');
  assert.equal(data.models[0].price_input, 4);
  assert.deepEqual(data.models[0].sources, [SOURCES[0].url]);
  assert.equal(entry.old, 3);
  assert.equal(entry.new, 4);
});

test('applyOne writes a benchmark field into model.benchmarks', () => {
  const data = { models: [{ id: 'acme-1', name: 'Acme One', benchmarks: { gpqa: null }, sources: [] }] };
  applyOne(data, { id: 'acme-1:gpqa', kind: 'benchmark', field: 'gpqa', value: 88.5, sources: SOURCES, reason: REASON }, '2026-08-16');
  assert.equal(data.models[0].benchmarks.gpqa, 88.5);
});

test('applyOne throws on a conflict judgment pointing at an unknown model id', () => {
  const data = { models: [] };
  assert.throws(() => applyOne(data, { id: 'ghost:price_input', kind: 'conflict', field: 'price_input', value: 4, sources: SOURCES, reason: REASON }, '2026-08-16'));
});

test('applyOne returns null for a hold (nothing applied)', () => {
  const data = { models: [] };
  assert.equal(applyOne(data, { id: 'x', hold: true, reason: REASON }, '2026-08-16'), null);
});

// --- integration: gate-failure restore + worklist removal, via the CLI --------------------------
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = fileURLToPath(new URL('.', import.meta.url));
const REAL_DATA = fileURLToPath(new URL('../data/models.json', import.meta.url));
const REAL_PLANS = fileURLToPath(new URL('../data/plans.json', import.meta.url));
const REAL_VENDORS = fileURLToPath(new URL('../data/vendors.json', import.meta.url));
const REAL_PRESETS = fileURLToPath(new URL('../data/usage-presets.json', import.meta.url));

function withSandbox(fn) {
  // apply-judgment.mjs resolves paths relative to its own file (../data/models.json etc), so we
  // run it against a throwaway copy of the repo's scripts+data dirs to avoid touching the real files.
  const dir = mktempRepo();
  try {
    fn(dir);
  } finally {
    // best-effort cleanup left to the OS tmp reaper — keeps the test fast and side-effect free on repo files.
  }
}

function mktempRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'apply-judgment-test-'));
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  mkdirSync(join(dir, 'data', 'refresh'), { recursive: true });
  for (const f of ['apply-judgment.mjs', 'validate-data.mjs', 'check-sources.mjs', 'sources.json', 'timeline.mjs', 'naming.mjs', 'derive-task-fit.mjs']) {
    writeFileSync(join(dir, 'scripts', f), readFileSync(join(SCRIPTS_DIR, f)));
  }
  const models = JSON.parse(readFileSync(REAL_DATA));
  writeFileSync(join(dir, 'data', 'models.json'), JSON.stringify(models, null, 2));
  // validate-data.mjs (copied above) also gates data/plans.json, data/vendors.json and
  // data/usage-presets.json — give the sandbox the real copies so the honesty-gate subprocess
  // it runs doesn't fail on a missing sibling file.
  writeFileSync(join(dir, 'data', 'plans.json'), readFileSync(REAL_PLANS));
  writeFileSync(join(dir, 'data', 'vendors.json'), readFileSync(REAL_VENDORS));
  writeFileSync(join(dir, 'data', 'usage-presets.json'), readFileSync(REAL_PRESETS));
  writeFileSync(join(dir, 'data', 'changelog.json'), '[]');
  writeFileSync(join(dir, 'data', 'refresh', 'worklist.json'), JSON.stringify({ generated: '2026-08-16', items: [{ id: 'm1:price_input', kind: 'conflict' }] }));
  return dir;
}

test('CLI: a bad value that breaks the gate is restored, exit code 1', () => {
  withSandbox((dir) => {
    const models = JSON.parse(readFileSync(join(dir, 'data', 'models.json')));
    const target = models.models[0];
    // Force a gate failure by corrupting confidence directly in the fixture before running.
    target.confidence = 'not-a-real-level';
    writeFileSync(join(dir, 'data', 'models.json'), JSON.stringify(models, null, 2));
    const before = readFileSync(join(dir, 'data', 'models.json'), 'utf8');
    // confidence enum is gate-checked — an out-of-vocab value trips validate-data.mjs, not our own schema.
    const judgments = [{ id: `${target.id}:confidence-break`, kind: 'benchmark', field: 'gpqa', value: 55, sources: SOURCES, reason: REASON }];
    const jFile = join(dir, 'judgments.json');
    writeFileSync(jFile, JSON.stringify(judgments));
    let failed = false;
    try {
      execFileSync('node', [join(dir, 'scripts', 'apply-judgment.mjs'), jFile], { cwd: dir, stdio: 'pipe' });
    } catch (e) {
      failed = true;
      assert.equal(e.status, 1);
    }
    assert.equal(failed, true, 'expected apply-judgment to exit non-zero on gate failure');
    const after = readFileSync(join(dir, 'data', 'models.json'), 'utf8');
    // restored to the pre-run (corrupted-confidence) fixture — gpqa=55 must NOT have been left applied
    assert.equal(after, before);
    // look for the exact field write, not a bare ": 55" — real data legitimately contains 55.5-style scores
    assert.ok(!/"gpqa":\s*55\b/.test(after), 'gate-rejected value must not survive in the restored file');
    // 2026-09-07 regression: changelog.json used to be written BEFORE the gate ran and was never
    // restored on failure, leaving a permanent stale entry for a change that never actually
    // published (caught for real while sourcing the judged-fit first batch — see git history).
    const changelogAfter = JSON.parse(readFileSync(join(dir, 'data', 'changelog.json'), 'utf8'));
    assert.deepEqual(changelogAfter, [], 'changelog.json must stay untouched when a gate rejects the run');
  });
});

test('CLI: a valid judgment applies, passes the gate, and removes the item from worklist.json', () => {
  withSandbox((dir) => {
    const models = JSON.parse(readFileSync(join(dir, 'data', 'models.json')));
    const target = models.models.find((m) => m.benchmarks && 'gpqa' in m.benchmarks);
    const judgments = [{ id: `${target.id}:gpqa`, kind: 'benchmark', field: 'gpqa', value: 77.7, sources: SOURCES, reason: REASON }];
    const jFile = join(dir, 'judgments.json');
    writeFileSync(jFile, JSON.stringify(judgments));
    writeFileSync(join(dir, 'data', 'refresh', 'worklist.json'), JSON.stringify({ generated: '2026-08-16', items: [{ id: `${target.id}:gpqa`, kind: 'benchmark' }, { id: 'keep:this', kind: 'conflict' }] }));
    execFileSync('node', [join(dir, 'scripts', 'apply-judgment.mjs'), jFile], { cwd: dir, stdio: 'pipe' });
    const after = JSON.parse(readFileSync(join(dir, 'data', 'models.json'), 'utf8'));
    assert.equal(after.models.find((m) => m.id === target.id).benchmarks.gpqa, 77.7);
    const worklist = JSON.parse(readFileSync(join(dir, 'data', 'refresh', 'worklist.json'), 'utf8'));
    assert.deepEqual(worklist.items.map((i) => i.id), ['keep:this']);
    const receipt = JSON.parse(readFileSync(join(dir, 'data', 'refresh', 'receipt-judge.json'), 'utf8'));
    assert.equal(receipt.job, 'judge');
    assert.equal(receipt.ok, true);
  });
});

// --- guidance (2026-08-22): fills best_for + use_well on blank models, growth-only ------------
const GOOD_GUIDANCE = {
  id: 'blank-model:guidance', kind: 'guidance', reason: 'vendor model card lists intended uses and a batch discount',
  sources: [{ url: 'https://vendor.example/docs/model', date: '2026-08-22' }],
  value: { best_for: ['cheap-bulk', 'speed'], use_well: ['Turn thinking off for extraction — it only adds cost here.', 'Use the batch endpoint for anything overnight; the vendor halves the price.'] },
};
test('validateJudgment accepts a well-formed guidance judgment', () => {
  assert.deepEqual(validateJudgment(GOOD_GUIDANCE), []);
});
test('validateJudgment rejects a guidance tag outside the vocab', () => {
  const errs = validateJudgment({ ...GOOD_GUIDANCE, value: { ...GOOD_GUIDANCE.value, best_for: ['marketing'] } });
  assert.ok(errs.some((e) => /not in vocab/.test(e)));
});
test('validateJudgment rejects guidance with one tip, five tips, or a tip under 20 chars', () => {
  assert.ok(validateJudgment({ ...GOOD_GUIDANCE, value: { ...GOOD_GUIDANCE.value, use_well: ['Only one tip that is long enough to pass.'] } }).length);
  assert.ok(validateJudgment({ ...GOOD_GUIDANCE, value: { ...GOOD_GUIDANCE.value, use_well: Array(5).fill('A perfectly fine tip that is long enough.') } }).length);
  assert.ok(validateJudgment({ ...GOOD_GUIDANCE, value: { ...GOOD_GUIDANCE.value, use_well: ['too short', 'A perfectly fine tip that is long enough.'] } }).length);
});
test('validateJudgment rejects guidance that tries to set a price', () => {
  const errs = validateJudgment({ ...GOOD_GUIDANCE, value: { ...GOOD_GUIDANCE.value, price_input: 0.1 } });
  assert.ok(errs.some((e) => /can't set "price_input"/.test(e)));
});
test('applyOne fills empty guidance fields and records the source', () => {
  const data = { models: [{ id: 'blank-model', name: 'Blank', best_for: [], use_well: [], sources: [] }] };
  const entry = applyOne(data, GOOD_GUIDANCE, '2026-08-22');
  assert.equal(entry.field, 'best_for+use_well');
  assert.deepEqual(data.models[0].best_for, ['cheap-bulk', 'speed']);
  assert.equal(data.models[0].use_well.length, 2);
  assert.ok(data.models[0].sources.includes('https://vendor.example/docs/model'));
});
test('applyOne never overwrites guidance that already exists (growth-only)', () => {
  const data = { models: [{ id: 'blank-model', name: 'Blank', best_for: ['coding'], use_well: ['A human wrote this tip and it must survive.'], sources: [] }] };
  const entry = applyOne(data, GOOD_GUIDANCE, '2026-08-22');
  assert.equal(entry, null);
  assert.deepEqual(data.models[0].best_for, ['coding']);
  assert.equal(data.models[0].use_well[0], 'A human wrote this tip and it must survive.');
});
test('applyOne fills only the empty half when one field already has guidance', () => {
  const data = { models: [{ id: 'blank-model', name: 'Blank', best_for: ['coding'], use_well: [], sources: [] }] };
  const entry = applyOne(data, GOOD_GUIDANCE, '2026-08-22');
  assert.equal(entry.field, 'use_well');
  assert.deepEqual(data.models[0].best_for, ['coding']);
});

// --- new-model → timeline entry (2026-08-22) ---------------------------------------------------
const NEW_MODEL = {
  id: 'new:acme-zeta-1', kind: 'new-model', reason: 'listed on OpenRouter and LiteLLM with matching pricing; vendor page confirms',
  sources: [{ url: 'https://acme.example/zeta', date: '2026-08-22' }],
  value: { id: 'acme-zeta-1', name: 'Zeta 1', vendor: 'Acme', price_input: 1, price_output: 3, released: '2026-08-20' },
};
test('applyOne on a new model also writes a timeline entry with the model\'s release date and source', () => {
  const data = { models: [], releases: [] };
  applyOne(data, NEW_MODEL, '2026-08-22');
  assert.equal(data.releases.length, 1);
  assert.equal(data.releases[0].title, 'Acme releases Zeta 1');
  assert.equal(data.releases[0].date, '2026-08-20');
  assert.equal(data.releases[0].source, 'https://acme.example/zeta');
  assert.ok(data.releases[0].summary.length > 20);
});
test('applyOne uses the Judge\'s release copy when given, validates it, and never duplicates a title', () => {
  const j = { ...NEW_MODEL, value: { ...NEW_MODEL.value, release: { summary: 'Zeta 1 ships with 1M context.', why: 'Cheap long-context option.', source: 'https://acme.example/blog' } } };
  assert.deepEqual(validateJudgment(j), []);
  assert.ok(validateJudgment({ ...j, value: { ...j.value, release: { summary: 5 } } }).some((e) => /release\.summary/.test(e)));
  assert.ok(validateJudgment({ ...j, value: { ...j.value, release: { source: 'ftp://x' } } }).some((e) => /release\.source/.test(e)));
  const data = { models: [], releases: [{ title: 'Acme releases Zeta 1', date: '2026-08-20' }] };
  applyOne(data, j, '2026-08-22');
  assert.equal(data.releases.length, 1);            // already there — not added twice
  assert.equal(data.models[0].release, undefined);  // release copy never lands on the model record
});

// --- timeline from price moves + deprecations (2026-08-22) --------------------------------------
test('a Judge price resolution of 20%+ writes a tagged price entry; a small move does not', () => {
  const data = { models: [{ id: 'm1', name: 'M One', vendor: 'Acme', price_input: 5, price_output: 30, sources: [] }], releases: [] };
  applyOne(data, { id: 'm1:price_output', kind: 'conflict', field: 'price_output', value: 20, sources: SOURCES, reason: 'vendor pricing page shows $20 since Aug 21' }, '2026-08-25');
  assert.equal(data.releases.length, 1);
  assert.equal(data.releases[0].kind, 'price');
  assert.match(data.releases[0].title, /output price cut — \$30 → \$20 per 1M \(-33%\)/);
  applyOne(data, { id: 'm1:price_input', kind: 'conflict', field: 'price_input', value: 4.5, sources: SOURCES, reason: 'vendor pricing page shows 4.50' }, '2026-08-25');
  assert.equal(data.releases.length, 1);   // −10%: changelog only
});
test('a deprecation judgment must be value:true, marks the model, and writes a retired entry once', () => {
  assert.ok(validateJudgment({ id: 'm1:deprecation', kind: 'deprecation', value: false, sources: SOURCES, reason: 'vendor says retired on Sept 1' }).length);
  const j = { id: 'm1:deprecation', kind: 'deprecation', value: true, sources: SOURCES, reason: 'vendor deprecation notice: retired Sept 1, 2026' };
  assert.deepEqual(validateJudgment(j), []);
  const data = { models: [{ id: 'm1', name: 'M One', vendor: 'Acme', sources: [] }], releases: [] };
  applyOne(data, j, '2026-08-25');
  applyOne(data, j, '2026-08-25');
  assert.equal(data.models[0].deprecated, true);
  assert.equal(data.releases.length, 1);
  assert.equal(data.releases[0].kind, 'retired');
  assert.equal(data.releases[0].title, 'Acme retires M One');
});
test('validateJudgment rejects a release with an unknown kind', () => {
  const j = { id: 'x:release', kind: 'release', sources: SOURCES, reason: 'launch post read in full', value: { date: '2026-08-25', vendor: 'Acme', title: 'T', summary: 'S', source: 'https://a.example', why: 'W', kind: 'rumour' } };
  assert.ok(validateJudgment(j).some((e) => /release kind/.test(e)));
});

// --- ladder judgments: provenance required, feed-maintained ladders off limits (2026-08-22) ------
const LADDER = { id: 'x:ladder', kind: 'ladder', sources: SOURCES, reason: 'launch post chart read in a browser',
  value: { id: 'acme-bench', suite: 'AcmeBench', task: 'Agentic coding', as_of: '2026-08-25', publisher: 'Acme', source_kind: 'vendor-reported',
    source: 'https://acme.example/launch', confidence: 'medium', method: 'Values read off the chart, ±1 point.', harness: 'Acme run', caveat: 'Vendor-run.',
    levels: ['low', 'medium', 'high'], series: [{ model_id: 'm1', label: 'M One', points: [{ effort: 'low', cost: 1, score: 10 }, { effort: 'medium', cost: 2, score: 20 }, { effort: 'high', cost: 3, score: 30 }] }] } };
test('validateJudgment accepts a full ladder and rejects one without provenance, method, or ≥3 points', () => {
  assert.deepEqual(validateJudgment(LADDER), []);
  const { caveat, ...noCaveat } = LADDER.value;
  assert.ok(validateJudgment({ ...LADDER, value: noCaveat }).some((e) => /missing "caveat"/.test(e)));
  assert.ok(validateJudgment({ ...LADDER, value: { ...LADDER.value, method: 'numbers' } }).some((e) => /method must say/.test(e)));
  const two = { ...LADDER.value, series: [{ model_id: 'm1', label: 'M One', points: LADDER.value.series[0].points.slice(0, 2) }] };
  assert.ok(validateJudgment({ ...LADDER, value: two }).some((e) => /needs ≥3 points/.test(e)));
});
test('applyOne adds a ladder, refuses an unknown model_id, and refuses to overwrite a feed-maintained ladder', () => {
  const data = { models: [{ id: 'm1', name: 'M One', vendor: 'Acme' }], effort_ladders: [{ id: 'cursorbench-agentic-coding', series: [{ model_id: 'm1', source_key: 'm-one', points: [] }] }] };
  applyOne(data, LADDER, '2026-08-25');
  assert.equal(data.effort_ladders.length, 2);
  assert.throws(() => applyOne(data, { ...LADDER, value: { ...LADDER.value, series: [{ ...LADDER.value.series[0], model_id: 'ghost' }] } }, '2026-08-25'), /unknown model_id/);
  assert.throws(() => applyOne(data, { ...LADDER, value: { ...LADDER.value, id: 'cursorbench-agentic-coding' } }, '2026-08-25'), /feed-maintained/);
});

// --- judged-fit + usage judgments (2026-09-06, sourced qualitative evidence) ---------------------
const GOOD_CLAIM = {
  sentence: 'Acme Corp published a coding benchmark score of 82% for M One on August 1, 2026.',
  source_url: 'https://acme.example/m-one-launch', tier: 'lab', date: '2026-08-01',
  quote: 'M One scores 82% on our internal coding benchmark.',
};
const JUDGED_FIT = {
  id: 'm1:coding:judged-fit', kind: 'judged-fit', reason: 'vendor launch post has a concrete, quoted benchmark claim',
  sources: [{ url: GOOD_CLAIM.source_url, date: GOOD_CLAIM.date }],
  value: { taskId: 'coding', band: 'capable', confidence: 'medium', claims: [GOOD_CLAIM], reconciliation: null },
};
test('validateJudgment accepts a well-formed judged-fit judgment', () => {
  assert.deepEqual(validateJudgment(JUDGED_FIT), []);
});
test('validateJudgment rejects an unknown taskId, band, or confidence', () => {
  assert.ok(validateJudgment({ ...JUDGED_FIT, value: { ...JUDGED_FIT.value, taskId: 'not-a-task' } }).some((e) => /taskId/.test(e)));
  assert.ok(validateJudgment({ ...JUDGED_FIT, value: { ...JUDGED_FIT.value, band: 'amazing' } }).some((e) => /band/.test(e)));
  assert.ok(validateJudgment({ ...JUDGED_FIT, value: { ...JUDGED_FIT.value, confidence: 'super-high' } }).some((e) => /confidence/.test(e)));
});
test('validateJudgment rejects a claim with a banned relative phrase in its sentence', () => {
  const bad = { ...GOOD_CLAIM, sentence: 'M One is the best available model for coding as of August 2026.' };
  const errs = validateJudgment({ ...JUDGED_FIT, value: { ...JUDGED_FIT.value, claims: [bad] } });
  assert.ok(errs.some((e) => /banned relative phrase/.test(e)));
});
test('validateJudgment rejects a claim quote over 25 words', () => {
  const bad = { ...GOOD_CLAIM, quote: Array(26).fill('word').join(' ') };
  const errs = validateJudgment({ ...JUDGED_FIT, value: { ...JUDGED_FIT.value, claims: [bad] } });
  assert.ok(errs.some((e) => /quote is 26 word/.test(e)));
});
test('validateJudgment rejects a claim missing source_url, tier, or quote', () => {
  const { source_url, ...noUrl } = GOOD_CLAIM;
  assert.ok(validateJudgment({ ...JUDGED_FIT, value: { ...JUDGED_FIT.value, claims: [noUrl] } }).some((e) => /source_url/.test(e)));
  const bad = { ...GOOD_CLAIM, tier: 'vibes' };
  assert.ok(validateJudgment({ ...JUDGED_FIT, value: { ...JUDGED_FIT.value, claims: [bad] } }).some((e) => /tier/.test(e)));
});
test('applyOne writes a judged-fit record onto the matching model\'s task_fit_judged', () => {
  const data = { models: [{ id: 'm1', name: 'M One', task_fit_judged: null, sources: [] }] };
  const entry = applyOne(data, JUDGED_FIT, '2026-09-06');
  assert.deepEqual(data.models[0].task_fit_judged.coding, { band: 'capable', confidence: 'medium', claims: [GOOD_CLAIM], reconciliation: null, as_of: '2026-09-06' });
  assert.equal(entry.field, 'task_fit_judged.coding');
  assert.ok(data.models[0].sources.includes(GOOD_CLAIM.source_url));
});
test('applyOne judged-fit is growth-only: never lets an older-as_of write clobber a newer one on file', () => {
  const data = { models: [{ id: 'm1', name: 'M One', task_fit_judged: { coding: { band: 'strong', confidence: 'high', claims: [GOOD_CLAIM], reconciliation: null, as_of: '2026-09-10' } }, sources: [] }] };
  const entry = applyOne(data, JUDGED_FIT, '2026-09-06'); // "today" is BEFORE the existing as_of
  assert.equal(entry, null);
  assert.equal(data.models[0].task_fit_judged.coding.band, 'strong'); // unchanged
});
const USAGE_JUDGMENT = {
  id: 'm1:usage', kind: 'usage', reason: 'OpenRouter rankings JSON shows this model\'s token share',
  sources: [{ url: 'https://openrouter.ai/api/frontend/v1/rankings/models', date: '2026-09-06' }],
  value: { category: 'overall', share: 3.4, rank: 12 },
};
test('validateJudgment accepts a well-formed usage judgment, rejects a bad share/rank', () => {
  assert.deepEqual(validateJudgment(USAGE_JUDGMENT), []);
  assert.ok(validateJudgment({ ...USAGE_JUDGMENT, value: { ...USAGE_JUDGMENT.value, share: 150 } }).some((e) => /share/.test(e)));
  assert.ok(validateJudgment({ ...USAGE_JUDGMENT, value: { ...USAGE_JUDGMENT.value, rank: 0 } }).some((e) => /rank/.test(e)));
});
test('applyOne writes usage.openrouter onto the matching model, growth-only against a newer as_of', () => {
  const data = { models: [{ id: 'm1', name: 'M One', usage: { openrouter: null }, sources: [] }] };
  applyOne(data, USAGE_JUDGMENT, '2026-09-06');
  assert.deepEqual(data.models[0].usage.openrouter, { category: 'overall', share: 3.4, rank: 12, as_of: '2026-09-06', source_url: USAGE_JUDGMENT.sources[0].url });
  const dataNewer = { models: [{ id: 'm1', name: 'M One', usage: { openrouter: { category: 'overall', share: 9, rank: 1, as_of: '2026-09-20', source_url: 'x' } }, sources: [] }] };
  const entry = applyOne(dataNewer, USAGE_JUDGMENT, '2026-09-06');
  assert.equal(entry, null);
  assert.equal(dataNewer.models[0].usage.openrouter.rank, 1); // unchanged
});
test('a usage field never changes the fill-vs-change guard on judged-fit (independent fields)', () => {
  // sanity: applying both kinds to the same model touches only their own field
  const data = { models: [{ id: 'm1', name: 'M One', task_fit_judged: null, usage: { openrouter: null }, sources: [] }] };
  applyOne(data, JUDGED_FIT, '2026-09-06');
  applyOne(data, USAGE_JUDGMENT, '2026-09-06');
  assert.ok(data.models[0].task_fit_judged.coding);
  assert.ok(data.models[0].usage.openrouter);
});
