/* board.html ships as a single file that fetches the site's own data at runtime, so nothing here
   can catch a broken reference the way an import would. These checks stand in for that: the page
   must still name its data files and the one instruction generator (never the retired ranking
   engine), and every model id and plan name in the example boards must exist in the catalog —
   otherwise "Start from an example" quietly builds a board with a blank model or a plan that
   prices at nothing. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const readJson = (rel) => JSON.parse(read(rel));

const BOARD = read('board.html');

test('board.html loads the site data files, not a copy of its own', () => {
  for (const file of [
    'data/models.json',
    'data/plans.json',
    'data/vendors.json',
    'data/tasks.json',
    'data/usage-presets.json',
    'data/board-samples.json',
    'data/guidance.json',
    'data/per-request.json',
  ]) {
    assert.ok(BOARD.includes(`"./${file}"`), `board.html does not reference ${file}`);
    assert.ok(fs.existsSync(path.join(ROOT, file)), `${file} is missing from the repo`);
  }
});

const GENERATOR_IMPORT = /import\s*\{([^}]*)\}\s*from\s*["']\.\/assets\/instructions\.mjs["']/;

test('board.html imports the instruction generator, not the retired ranking engine', () => {
  const m = BOARD.match(GENERATOR_IMPORT);
  assert.ok(m, 'board.html does not import ./assets/instructions.mjs');
  const names = m[1].split(',').map((x) => x.trim());
  for (const name of ['buildPackage', 'renderPreview', 'profileFromBoard', 'roleDefaults']) {
    assert.ok(names.includes(name), `board.html does not import ${name}`);
  }
  assert.ok(fs.existsSync(path.join(ROOT, 'assets/instructions.mjs')));
  assert.doesNotMatch(BOARD, /decide\.mjs/, 'board.html still names decide.mjs');
  assert.doesNotMatch(BOARD, /\bdecide\s*\(/, 'board.html still calls decide()');
  assert.doesNotMatch(BOARD, /__mpEngine/, 'board.html still exposes the engine debug hook');
  assert.ok(!fs.existsSync(path.join(ROOT, 'assets/decide.mjs')), 'assets/decide.mjs belongs in archive/engine/');
  assert.ok(fs.existsSync(path.join(ROOT, 'archive/engine/assets/decide.mjs')), 'the archived engine is missing');
});

test('every name board.html imports is exported by assets/instructions.mjs', async () => {
  const mod = await import('../assets/instructions.mjs');
  const names = BOARD.match(GENERATOR_IMPORT)[1].split(',').map((x) => x.trim()).filter(Boolean);
  for (const name of names) assert.equal(typeof mod[name], 'function', `instructions.mjs does not export ${name}`);
});

test('board.html fetches the install prompt the installer skill ships', () => {
  assert.ok(BOARD.includes('"./assets/install-prompt.txt"'), 'the Install pane does not fetch ./assets/install-prompt.txt');
});

test('board.html carries no bundled sample data file', () => {
  assert.ok(!BOARD.includes('sample-data.json'), 'board.html still mentions the prototype bundle');
});

test('every model id in the example boards exists in data/models.json', () => {
  const samples = readJson('data/board-samples.json');
  const known = new Set(readJson('data/models.json').models.map((m) => m.id));

  const ids = [];
  for (const division of samples.org.divisions) {
    for (const person of division.people) if (person.model) ids.push(person.model);
  }
  for (const id of samples.modelMode.have) ids.push(id);
  for (const role of samples.modelMode.roles) if (role.model) ids.push(role.model);

  assert.ok(ids.length > 0, 'the example boards name no models at all');
  for (const id of ids) assert.ok(known.has(id), `example board uses unknown model id "${id}"`);
});

test('every plan name in the example boards exists in data/plans.json', () => {
  const samples = readJson('data/board-samples.json');
  // The board shows a plan as "<vendor> <plan>" unless the plan's own name already opens with the
  // vendor — the same rule board.html's planLabel() uses, so the two can never drift apart.
  const label = (p) => {
    if (p.plan.indexOf(p.vendor) === 0) return p.plan;
    const lead = String(p.vendor || '').split(' ')[0];
    if (lead && p.plan.indexOf(`${lead} `) === 0) return p.plan;
    return `${p.vendor} ${p.plan}`;
  };
  const known = new Set(readJson('data/plans.json').plans.map(label));

  const names = [];
  for (const division of samples.org.divisions) {
    for (const person of division.people) if (person.plan) names.push(person.plan);
  }

  assert.ok(names.length > 0, 'the example org board names no plans at all');
  for (const name of names) assert.ok(known.has(name), `example board uses unknown plan "${name}"`);
});

test('LC-12: no tracked file outside archive/ points at assets/decide.mjs; the engine lives in archive/engine/', () => {
  const files = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n')
    .filter((f) => f && !f.startsWith('archive/') && f !== 'scripts/test-board.mjs' && /\.(mjs|js|md|html|json|yml|yaml|txt)$/.test(f));
  const stale = [];
  for (const rel of files) {
    if (!fs.existsSync(path.join(ROOT, rel))) continue;
    read(rel).split('\n').forEach((line, i) => { if (/(?<!archive\/engine\/)assets\/decide\.mjs/.test(line)) stale.push(`${rel}:${i + 1}`); });
  }
  assert.ok(files.length > 50, 'git ls-files listed the repo');
  assert.deepEqual(stale, []);
});

/* ---------- assets/board-data.mjs: the board's data -> display rules, on fixture data ----------
   Fixture rows carry the plan keys the board reads (`reaches`, `covers_tokens`, `base_usd_month`,
   `renamed_from`) and board-samples' `personal_default`, so these checks hold whichever order the
   data and page changes land in. Names are neutral on purpose. */
const BD = await import('../assets/board-data.mjs');
const FX = {
  models: [
    { id: 'lab-a-big-2', name: 'Lab A Big 2', vendor: 'Lab A', status: 'ga', released: '2026-08-01', price_input: 4, price_output: 20, usage: { openrouter: { share: 1.2 } } },
    { id: 'lab-a-small-2', name: 'Lab A Small 2', vendor: 'Lab A', status: 'ga', released: '2026-07-01', price_input: 1, price_output: 5, usage: { openrouter: { share: 3.5 } } },
    { id: 'lab-b-mid-1', name: 'Lab B Mid 1', vendor: 'Lab B', status: 'ga', released: '2026-09-01', price_input: 2, price_output: 10 },
    { id: 'lab-c-x-1', name: 'Lab C X 1', vendor: 'Lab C AI', status: 'preview', released: null },
  ],
  plans: [
    { vendor: 'Lab A', plan: 'Seat', price_usd_month: 100, billing: 'monthly' },
    { vendor: 'Harness', plan: 'Teams', price_usd_month: 40, base_usd_month: 80, reaches: 'all', covers_tokens: true, billing: 'per seat', renamed_from: ['Old Teams'] },
    { vendor: 'Router', plan: 'Pay as you go', price_usd_month: 0, reaches: 'all', covers_tokens: false, billing: 'per token' },
    { vendor: 'Suite', plan: 'Suite Plus', price_usd_month: 30, reaches: ['Lab A', 'Lab B'], covers_tokens: true },
    { vendor: 'Mystery', plan: 'Box', price_usd_month: 9 },
    { vendor: 'Lab C', plan: 'Enterprise' },
  ],
  perRequest: { as_of: '2026-09-14', source_url: 'https://example.test/feed', median: { in: 100, out: 10, models: 5 },
                rows: [{ model_id: 'lab-a-big-2', in: 1000, out: 50 }, { model_id: 'lab-b-mid-1', in: 3000, out: 150 }] },
  samples: { personal_default: { plans: ['Seat', 'Harness Old Teams', 'Nope'], models: ['lab-a-big-2', 'gone-model', 'lab-a-big-2'] } },
};

test('board-data: plan reach and token coverage come from the row fields', () => {
  const r = (label) => BD.planReach(FX.plans, FX.models, label);
  assert.deepEqual(r('Harness Teams'), { reaches: 'all', covers: true });
  assert.deepEqual(r('Router Pay as you go'), { reaches: 'all', covers: false });
  assert.deepEqual(r('Suite Plus'), { reaches: ['Lab A', 'Lab B'], covers: true });
  // no fields: a lab's own plan reaches that lab; "Lab C" matches the catalog's "Lab C AI"
  assert.deepEqual(r('Lab A Seat'), { reaches: ['Lab A'], covers: true });
  assert.deepEqual(r('Lab C Enterprise'), { reaches: ['Lab C AI'], covers: true });
  // no fields, nothing to go on: every lab, and never credited with paying for tokens
  assert.deepEqual(r('Mystery Box'), { reaches: 'all', covers: false });
  // a per-token billing line wins over a row that says it covers tokens
  assert.equal(BD.planReachOf({ vendor: 'X', plan: 'Pay as you go', covers_tokens: true, reaches: 'all' }, FX.models).covers, false);
  assert.deepEqual(BD.reachableVendorsFor(FX.plans, FX.models, ['Lab A Seat', 'Suite Plus']), ['Lab A', 'Lab B']);
  assert.equal(BD.reachableVendorsFor(FX.plans, FX.models, ['Lab A Seat', 'Harness Teams']), null);
});

test('board-data: seat cost is seats x plan price plus a flat base fee, and nothing with no seats', () => {
  const c = BD.planSeatCost(FX.plans, ['Harness Teams'], 3);
  assert.equal(c.total, 3 * 40 + 80);
  assert.deepEqual(c.fees, [{ plan: 'Harness Teams', amount: 80 }]);
  assert.equal(BD.planSeatCost(FX.plans, ['Harness Teams'], 0).total, 0);
  assert.equal(BD.planSeatCost(FX.plans, ['Lab A Seat', 'Suite Plus'], 2).total, 2 * 130);
  assert.equal(BD.planSeatCost(FX.plans, ['Lab C Enterprise'], 5).total, 0, 'an unpriced plan adds nothing');
});

test('board-data: a renamed plan on a saved board moves to its new name', () => {
  const saved = { org: { blocks: [{ plans: ['Harness Old Teams', 'Lab A Seat'] }], divisions: [{ defaultPlans: ['Old Teams'] }] },
                  personal: { me: { plans: ['Harness Old Teams'] } }, startFilters: { plans: ['Mystery Box'] } };
  assert.equal(BD.migratePlanNames(saved, FX.plans), 3);
  assert.deepEqual(saved.org.blocks[0].plans, ['Harness Teams', 'Lab A Seat']);
  assert.deepEqual(saved.org.divisions[0].defaultPlans, ['Harness Teams']);
  assert.deepEqual(saved.personal.me.plans, ['Harness Teams']);
  assert.deepEqual(saved.startFilters.plans, ['Mystery Box']);
  assert.equal(BD.migratePlanNames({ plans: ['x'] }, [{ vendor: 'A', plan: 'B' }]), 0, 'no renames in data, nothing moves');
});

test('board-data: the default "me" comes from personal_default, keeping only what the data still has', () => {
  assert.deepEqual(BD.personalDefault(FX.samples, FX.plans, FX.models), { plans: ['Lab A Seat', 'Harness Teams'], models: ['lab-a-big-2'] });
  assert.deepEqual(BD.personalDefault({}, FX.plans, FX.models), { plans: [], models: [] }, 'missing key -> empty, no typed fallback');
  assert.deepEqual(BD.personalDefault(null, FX.plans, FX.models), { plans: [], models: [] });
});

test('board-data: the measured request comes from the per-request feed, with an honest gap', () => {
  assert.deepEqual(BD.perRequestFor(FX.perRequest, ['lab-a-big-2']), { in: 1000, out: 50, matched: 1, of: 1 });
  assert.deepEqual(BD.perRequestFor(FX.perRequest, ['lab-a-big-2', 'lab-b-mid-1']), { in: 2000, out: 100, matched: 2, of: 2 });
  assert.deepEqual(BD.perRequestFor(FX.perRequest, ['lab-a-small-2']), { in: 100, out: 10, matched: 0, of: 1, median: true });
  assert.equal(BD.perRequestFor(null, ['lab-a-big-2']).missing, true);
  assert.equal(BD.perRequestDate(FX.perRequest), '14 Sep 2026');
  assert.equal(BD.perRequestDate(null), null);
});

test('board-data: the picker lists every model by usage share, then newest; plans restrict it', () => {
  assert.deepEqual(BD.pickerLists(FX.models).rest.map((m) => m.id), ['lab-a-small-2', 'lab-a-big-2', 'lab-b-mid-1', 'lab-c-x-1']);
  const inPlan = BD.pickerLists(FX.models, { restrict: ['Lab B'] });
  assert.deepEqual(inPlan.rest.map((m) => m.id), ['lab-b-mid-1']);
  const searchOut = BD.pickerLists(FX.models, { restrict: ['Lab B'], query: 'big' });
  assert.deepEqual(searchOut.outside.map((m) => m.id), ['lab-a-big-2'], 'a search that finds nothing in the plan shows the rest');
  const yours = BD.pickerLists(FX.models, { ownedIds: ['lab-b-mid-1'] });
  assert.deepEqual(yours.owned.map((m) => m.id), ['lab-b-mid-1']);
  const view = BD.boardView({ ...FX });
  assert.equal(view.picker.length, FX.models.length);
  assert.deepEqual(view.plans.find((p) => p.label === 'Harness Teams'), { label: 'Harness Teams', reaches: 'all', covers: true, price: 40, base: 80 });
  assert.equal(view.perRequest.label, '14 Sep 2026');
});

test('board.html reads plan reach, the default "me" and the measured request from data, not typed tables', () => {
  assert.match(BOARD, /import \* as BD from "\.\/assets\/board-data\.mjs"/);
  assert.doesNotMatch(BOARD, /PLAN_REACH|PER_REQUEST\b/, 'typed plan-reach or per-request table is back');
  for (const name of new Set([...BOARD.matchAll(/\bBD\.([A-Za-z]+)/g)].map((m) => m[1]))) {
    assert.equal(typeof BD[name], 'function', `board-data.mjs does not export ${name}`);
  }
});

test('data/per-request.json: dated, sourced, and every row names a model in the catalog', () => {
  const feed = readJson('data/per-request.json');
  const known = new Set(readJson('data/models.json').models.map((m) => m.id));
  assert.match(feed.as_of, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(feed.source_url, /^https:\/\//);
  assert.ok(Array.isArray(feed.rows) && feed.rows.length > 0);
  for (const r of feed.rows) {
    assert.ok(known.has(r.model_id), `per-request row names unknown model ${r.model_id}`);
    assert.ok(Number.isFinite(r.in) && r.in >= 0 && Number.isFinite(r.out) && r.out >= 0, r.model_id);
  }
});
