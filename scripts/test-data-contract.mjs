// The data contract (scripts/validate-data.mjs FEEDS + validateFeeds): every data file a page shows
// says when it was true (file as_of), and every line it shows carries a source and a date of its
// own or inherits them. Each feed: a good fixture passes; a missing as_of, a missing source and a
// bad date each fail with a message that names the file and the field. No network, no live data —
// every case builds its own small fixture (scripts/fixtures/README.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, mkdirSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  FEEDS, validateFeeds, asOfProblems, utcToday, basisOwnerProblems, PLAN_QUOTE_FROM, planLabel, loadFeeds,
} from './validate-data.mjs';
import { normalizeReleased, releaseDateFor } from './timeline.mjs';

const TODAY = '2026-10-03';
const U = (p) => `https://docs.example/${p}`;

/** One small, valid copy of every feed. Each test mutates one field of a fresh copy. */
function good() {
  return {
    'models.json': {
      as_of: '2026-10-02',
      models: [
        { id: 'claude-one', name: 'Claude One', vendor: 'Anthropic', released: '2026-09-01', sources: [U('anthropic')] },
        { id: 'gpt-one', name: 'GPT-One', vendor: 'OpenAI', released: '2026-Q1', sources: [U('openai')] },
        { id: 'stub-one', name: 'Stub One', vendor: 'Google', released: null, sources: ['https://openrouter.ai/google/stub-one'] },
      ],
      releases: [
        { kind: 'model', date: '2026-09-01', vendor: 'Anthropic', title: 'Anthropic releases Claude One', summary: 'Listed.', source: U('anthropic'), why: 'New.' },
        { kind: 'model', date: '2026-05-01', date_precision: 'month', vendor: 'OpenAI', title: 'GPT-One', summary: 'Listed.', source: U('openai'), why: 'New.' },
      ],
      effort_ladders: [
        { id: 'ladder-one', suite: 'Bench', as_of: '2026-09-01', source: U('ladder'), series: [{ model_id: 'claude-one', points: [{ effort: 'low', cost: 1, score: 10 }, { effort: 'high', cost: 2, score: 20 }] }] },
      ],
    },
    'guidance.json': {
      as_of: '2026-10-03',
      claims: [
        { id: 'cc-alias', subject: { kind: 'tool', name: 'Claude Code' }, topic: 'enforced-model', sentence: 's', source_url: U('cc'), tier: 'tool', date: '2026-10-03', quote: 'q' },
        { id: 'anthropic-ids', subject: { kind: 'lab', name: 'Anthropic' }, topic: 'model-per-job', sentence: 's', source_url: U('a'), tier: 'lab', date: '2026-10-03', quote: 'q' },
        { id: 'openai-roles', subject: { kind: 'lab', name: 'OpenAI' }, topic: 'model-per-job', sentence: 's', source_url: U('o'), tier: 'lab', date: '2026-10-03', quote: 'q' },
        { id: 'cursor-inherit', subject: { kind: 'tool', name: 'Cursor' }, topic: 'lead-helper', sentence: 's', source_url: U('c'), tier: 'tool', date: '2026-10-03', quote: 'q' },
      ],
      role_defaults: [{ tool: 'claude-code', role: 'scout', lab: 'Anthropic', model_ref: 'one', model_id: 'claude-one', basis: ['cc-alias', 'anthropic-ids'] }],
      model_refs: [{ tool: 'claude-code', ref: 'one', model_id: 'claude-one', basis: ['cc-alias'] }],
      effort_pages: [],
    },
    'plans.json': {
      as_of: '2026-10-03',
      plans: [
        { vendor: 'Anthropic', plan: 'Max 5x', price_usd_month: 100, source_url: U('pricing'), quote: 'Max 5x $100', as_of: '2026-10-03' },
        { vendor: 'Anthropic', plan: 'Enterprise', price_usd_month: null, source_url: U('pricing'), as_of: '2026-10-03' },
        { vendor: 'Cursor', plan: 'Pro', price_usd_month: 20, source_url: U('cursor'), as_of: '2026-09-20', reaches: 'all', covers_tokens: true },
        { vendor: 'Devin', plan: 'Teams', price_usd_month: 40, base_usd_month: 80, source_url: U('devin'), quote: 'Teams $80 /month', as_of: '2026-10-03', reaches: 'all', covers_tokens: true, renamed_from: ['Windsurf Teams'] },
        { vendor: 'Microsoft 365 Copilot', plan: 'Business', price_usd_month: 18, source_url: U('m365'), as_of: '2026-09-20', reaches: ['OpenAI', 'Anthropic'], covers_tokens: true },
      ],
    },
    'vendors.json': { as_of: '2026-09-06', vendors: [{ vendor: 'Anthropic', country: 'US', source: U('about') }] },
    'tasks.json': { as_of: '2026-09-27', tasks: [{ id: 'coding', label: 'Coding' }] },
    'usage-presets.json': { as_of: '2026-09-06', presets: { light: {}, typical: {}, heavy: {} } },
    'board-samples.json': {
      as_of: '2026-10-03',
      org: { name: 'Example', divisions: [{ name: 'Eng', people: [{ who: 'Team', model: 'claude-one', plan: 'Anthropic Max 5x' }] }] },
      modelMode: { have: ['claude-one', 'gpt-one'], roles: [{ role: 'Lead', model: 'claude-one' }] },
      personal_default: { plans: ['Anthropic Max 5x'], models: ['claude-one', 'gpt-one'] },
    },
    'per-request.json': { as_of: '2026-09-14', source_url: U('per-request'), rows: [{ model_id: 'claude-one', in: 6068, out: 282 }] },
  };
}
const errorsOf = (files, today = TODAY) => validateFeeds(files, { today }).errors;
const oneError = (files, re, msg) => {
  const errs = errorsOf(files);
  assert.ok(errs.some((e) => re.test(e)), `${msg}: expected an error matching ${re}, got ${JSON.stringify(errs)}`);
};
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('a good copy of every feed passes', () => {
  assert.deepEqual(errorsOf(good()), []);
});

test('FEEDS lists every data file a page fetches or names (root *.html, assets/*.js|mjs)', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const pages = [
    ...readdirSync(root).filter((f) => f.endsWith('.html')).map((f) => join(root, f)),
    ...readdirSync(join(root, 'assets')).filter((f) => /\.m?js$/.test(f)).map((f) => join(root, 'assets', f)),
  ];
  const named = new Set();
  for (const p of pages) for (const m of readFileSync(p, 'utf8').matchAll(/data\/([a-z0-9_-]+\.json)/g)) named.add(m[1]);
  assert.ok(named.has('models.json') && named.has('plans.json'), 'the scan finds the files the pages read');
  const covered = new Set(FEEDS.map((f) => f.file));
  for (const f of named) assert.ok(covered.has(f), `a page reads data/${f}, which has no FEEDS entry`);
});

test('every feed has an id, a file, what it shows, and a check', () => {
  for (const f of FEEDS) assert.ok(f.id && f.file && f.shows && typeof f.check === 'function', JSON.stringify(f));
  assert.equal(new Set(FEEDS.map((f) => f.id)).size, FEEDS.length);
});

// --- file-level as_of, for every file --------------------------------------------------------
for (const file of ['models.json', 'guidance.json', 'plans.json', 'vendors.json', 'tasks.json', 'usage-presets.json', 'board-samples.json', 'per-request.json']) {
  test(`${file}: missing as_of fails, a bad date fails, a future date fails`, () => {
    const where = esc(`data/${file}:`);
    let f = good(); delete f[file].as_of;
    oneError(f, new RegExp(`${where} as_of is missing`), 'missing as_of');
    f = good(); f[file].as_of = '2026-13-01';
    oneError(f, new RegExp(`${where} as_of "2026-13-01" must be a real YYYY-MM-DD date`), 'bad as_of');
    f = good(); f[file].as_of = '2026-10-09';
    oneError(f, new RegExp(`${where} as_of "2026-10-09" is in the future`), 'future as_of');
  });
}

test('as_of: compared in UTC with one day of slack', () => {
  assert.deepEqual(asOfProblems('2026-10-04', 'x', { today: '2026-10-03' }), [], 'a UTC stamp read on a machine a day behind passes');
  assert.equal(asOfProblems('2026-10-05', 'x', { today: '2026-10-03' }).length, 1);
  assert.equal(utcToday(), new Date().toISOString().slice(0, 10));
});

// --- models ----------------------------------------------------------------------------------
test('models: every row needs at least one source URL', () => {
  let f = good(); f['models.json'].models[0].sources = [];
  oneError(f, /claude-one: sources\[\] is empty/, 'empty sources');
  f = good(); f['models.json'].models[0].sources = ['not a url'];
  oneError(f, /claude-one: sources\[\] has a non-URL entry/, 'bad source');
});

test('models: released is YYYY-MM-DD | YYYY-MM | YYYY-Qn | YYYY | null — never "unknown"', () => {
  for (const ok of ['2026-09-01', '2026-09', '2026-Q1', '2026', null]) {
    const f = good(); f['models.json'].models[0].released = ok;
    assert.deepEqual(errorsOf(f), [], `released ${ok} passes`);
  }
  for (const bad of ['unknown', 'May 2026', '2026-13', '2026-Q5', '']) {
    const f = good(); f['models.json'].models[0].released = bad;
    oneError(f, /claude-one: released ".*" must be YYYY-MM-DD \| YYYY-MM \| YYYY-Qn \| YYYY \| null/, `released ${bad}`);
  }
});

// --- releases (the timeline) -----------------------------------------------------------------
test('releases: source, full date, kind, vendor, title, summary are all required', () => {
  let f = good(); delete f['models.json'].releases[0].source;
  oneError(f, /releases\[0\] .*source "undefined" must be an http\(s\) URL/, 'missing source');
  f = good(); f['models.json'].releases[0].date = '2026-05';
  oneError(f, /releases\[0\] .*date "2026-05" must be a real YYYY-MM-DD date/, 'month-only date');
  f = good(); f['models.json'].releases[0].date = '2026-10-09';
  oneError(f, /releases\[0\] .*date "2026-10-09" is in the future/, 'future date');
  f = good(); delete f['models.json'].releases[0].kind;
  oneError(f, /releases\[0\] .*kind "undefined" must be one of model, price, retired/, 'missing kind');
  for (const k of ['vendor', 'title', 'summary']) {
    f = good(); delete f['models.json'].releases[0][k];
    oneError(f, new RegExp(`releases\\[0\\] .*${k} is required`), `missing ${k}`);
  }
  f = good(); f['models.json'].releases[1].date_precision = 'week';
  oneError(f, /releases\[1\] .*date_precision "week"/, 'bad precision');
});

// --- effort ladders --------------------------------------------------------------------------
test('effort ladders: as_of and source per ladder; points inherit the source, or carry a URL', () => {
  let f = good(); delete f['models.json'].effort_ladders[0].as_of;
  oneError(f, /effort_ladders\[0\] \(ladder-one\): as_of is missing/, 'missing ladder as_of');
  f = good(); delete f['models.json'].effort_ladders[0].source;
  oneError(f, /effort_ladders\[0\] \(ladder-one\): source must be an http\(s\) URL/, 'missing ladder source');
  f = good(); f['models.json'].effort_ladders[0].as_of = '07/2026';
  oneError(f, /effort_ladders\[0\] \(ladder-one\): as_of "07\/2026" must be a real/, 'bad ladder date');
  f = good(); f['models.json'].effort_ladders[0].series[0].points[0].source = 'chart';
  oneError(f, /point "low" source must be an http\(s\) URL/, 'bad point source');
});

// --- tool defaults + helper pairs (guidance.json) --------------------------------------------
test('guidance: every claim needs source_url, quote and a real date', () => {
  let f = good(); delete f['guidance.json'].claims[0].source_url;
  oneError(f, /claim cc-alias: source_url is required/, 'missing claim source');
  f = good(); delete f['guidance.json'].claims[0].quote;
  oneError(f, /claim cc-alias: quote is required/, 'missing quote');
  f = good(); f['guidance.json'].claims[0].date = '2026-9-1';
  oneError(f, /claim cc-alias: date "2026-9-1" must be a real/, 'bad claim date');
});

test('guidance: role_defaults / model_refs need basis ids that exist and belong to the tool or its lab', () => {
  let f = good(); f['guidance.json'].role_defaults[0].basis = [];
  oneError(f, /role_defaults\[0\] \(claude-code\/scout\)\.basis must name at least one claim id/, 'empty basis');
  f = good(); f['guidance.json'].model_refs[0].basis = ['no-such-claim'];
  oneError(f, /model_refs\[0\] \(claude-code\/one\)\.basis names "no-such-claim"/, 'unknown id');
  f = good(); f['guidance.json'].model_refs[0].basis = ['cursor-inherit'];
  oneError(f, /model_refs\[0\] .*basis "cursor-inherit" is a claim about Cursor/, 'another tool');
  f = good(); f['guidance.json'].role_defaults[0].basis = ['openai-roles'];
  oneError(f, /role_defaults\[0\] .*basis "openai-roles" is a claim about OpenAI/, 'another lab');
});

test('guidance tool_plans: each slot\'s basis follows the same rule; a multi-lab tool may cite the lab of the slot\'s model', () => {
  const f = good();
  f['guidance.json'].tool_plans = [{
    tool: 'cursor', as_of: '2026-10-03',
    lead: { choice: 'your pick', basis: ['cursor-inherit'] },
    helpers: { model: 'inherit', basis: ['cursor-inherit'], push_down: { model_id: 'gpt-one', basis: ['openai-roles'] } },
    bulk: { choice: 'your pick', basis: ['cursor-inherit'] },
  }];
  assert.deepEqual(errorsOf(f), [], 'Cursor citing OpenAI for an OpenAI model is allowed');
  f['guidance.json'].tool_plans[0].helpers.push_down.basis = ['anthropic-ids'];
  oneError(f, /tool_plans\[0\] \(cursor\)\.helpers\.push_down\.basis "anthropic-ids" is a claim about Anthropic/, 'wrong lab for the slot model');
  const g = good();
  g['guidance.json'].tool_plans = [{ tool: 'claude-code', as_of: '2026-10-03', lead: { model_id: 'claude-one', basis: ['cursor-inherit'] } }];
  oneError(g, /tool_plans\[0\] \(claude-code\)\.lead\.basis "cursor-inherit" is a claim about Cursor/, 'single-lab tool');
  const h = good();
  h['guidance.json'].tool_plans = [{ tool: 'claude-code', as_of: 'soon', lead: { model_id: 'claude-one', basis: ['cc-alias'] } }];
  oneError(h, /tool_plans\[0\] \(claude-code\): as_of "soon"/, 'bad tool_plans as_of');
});

test('basisOwnerProblems: own tool, own lab, or the lab of the line\'s model', () => {
  const claims = new Map(good()['guidance.json'].claims.map((c) => [c.id, c]));
  const modelsById = new Map(good()['models.json'].models.map((m) => [m.id, m]));
  const run = (tool, modelId, basis) => basisOwnerProblems(basis, { tool, modelId, label: 'x', claims, modelsById });
  assert.deepEqual(run('claude-code', null, ['cc-alias', 'anthropic-ids']), []);
  assert.deepEqual(run('openrouter', 'gpt-one', ['openai-roles']), []);
  assert.equal(run('openrouter', 'claude-one', ['openai-roles']).length, 1);
  assert.equal(run('codex', null, ['anthropic-ids']).length, 1);
});

// --- plans -----------------------------------------------------------------------------------
test('plans: source_url and as_of per row', () => {
  let f = good(); delete f['plans.json'].plans[2].source_url;
  oneError(f, /Cursor \/ Pro: source_url is required/, 'missing row source');
  f = good(); delete f['plans.json'].plans[2].as_of;
  oneError(f, /Cursor \/ Pro: as_of is missing/, 'missing row as_of');
  f = good(); f['plans.json'].plans[2].as_of = '2026-02-30';
  oneError(f, /Cursor \/ Pro: as_of "2026-02-30" must be a real/, 'impossible row date');
});

test(`plans: a priced row checked on or after ${PLAN_QUOTE_FROM} needs a quote; a null price or an older check does not`, () => {
  let f = good(); delete f['plans.json'].plans[0].quote;
  oneError(f, /Anthropic \/ Max 5x: a price checked on or after 2026-10-03 needs a verbatim quote/, 'priced row without quote');
  f = good(); f['plans.json'].plans[1].as_of = '2026-10-03';
  assert.deepEqual(errorsOf(f), [], 'contact-sales row (null price) needs no quote');
  f = good(); f['plans.json'].plans[2].as_of = '2026-09-20';
  assert.deepEqual(errorsOf(f), [], 'a row last checked before the rule needs no quote yet');
  f = good(); f['plans.json'].plans[0].quote = Array(30).fill('word').join(' ');
  oneError(f, /Max 5x: quote is 30 words/, 'long quote');
  f = good(); f['plans.json'].plans[0].quote_url = 'docs page';
  oneError(f, /Max 5x: quote_url must be an http\(s\) URL/, 'bad quote_url');
});

test('plans: optional reach / fee / rename fields are checked when present', () => {
  let f = good(); delete f['plans.json'].plans[2].covers_tokens;
  oneError(f, /Cursor \/ Pro: reaches and covers_tokens go together/, 'reaches without covers');
  f = good(); f['plans.json'].plans[4].reaches = ['OpenAI', 'Not A Lab'];
  oneError(f, /Business: reaches must be "all" or a non-empty list of canonical model vendors/, 'unknown lab');
  f = good(); f['plans.json'].plans[3].base_usd_month = -1;
  oneError(f, /Devin \/ Teams: base_usd_month must be a non-negative number/, 'negative fee');
  f = good(); f['plans.json'].plans[3].renamed_from = ['Anthropic Max 5x'];
  oneError(f, /renamed_from "Anthropic Max 5x" is still the label of a current row/, 'rename collision');
  f = good(); f['plans.json'].plans[3].renamed_from = [];
  oneError(f, /renamed_from must be a non-empty list/, 'empty rename list');
  assert.equal(planLabel({ vendor: 'Devin', plan: 'Teams' }), 'Devin Teams');
  assert.equal(planLabel({ vendor: 'Google', plan: 'Google AI Pro' }), 'Google AI Pro');
});

// --- vendors ---------------------------------------------------------------------------------
test('vendors: every row needs a source URL', () => {
  const f = good(); delete f['vendors.json'].vendors[0].source;
  oneError(f, /data\/vendors\.json "Anthropic": source is required/, 'missing vendor source');
});

// --- tasks / usage presets / board samples ---------------------------------------------------
test('board-samples, tasks, usage-presets: any model id they name must exist; board plan labels must exist', () => {
  let f = good(); f['board-samples.json'].personal_default.models = ['claude-gone'];
  oneError(f, /board-samples\.json: names model "claude-gone"/, 'unknown personal model');
  f = good(); f['board-samples.json'].org.divisions[0].people[0].model = 'claude-gone';
  oneError(f, /board-samples\.json: names model "claude-gone"/, 'unknown org model');
  f = good(); f['board-samples.json'].personal_default.plans = ['Windsurf Teams'];
  oneError(f, /board-samples\.json: names plan "Windsurf Teams"/, 'renamed plan label');
  f = good(); f['board-samples.json'].personal_default = { plans: 'Anthropic Max 5x' };
  oneError(f, /personal_default must be \{plans: \[plan labels\], models: \[model ids\]\}/, 'bad personal_default');
  f = good(); f['tasks.json'].tasks[0].model = 'claude-gone';
  oneError(f, /tasks\.json: names model "claude-gone"/, 'task names an unknown model');
  f = good(); f['usage-presets.json'].presets.light.model_id = 'claude-gone';
  oneError(f, /usage-presets\.json: names model "claude-gone"/, 'preset names an unknown model');
});

// --- per-request (optional until the board's file lands) -------------------------------------
test('per-request: optional; when present needs as_of, source_url and rows of known ids with token counts', () => {
  let f = good(); delete f['per-request.json'];
  assert.deepEqual(errorsOf(f), [], 'absent is fine');
  f = good(); delete f['per-request.json'].source_url;
  oneError(f, /per-request\.json: source_url is required/, 'missing source');
  f = good(); f['per-request.json'].rows = [];
  oneError(f, /per-request\.json: rows must be a non-empty array/, 'no rows');
  f = good(); f['per-request.json'].rows[0].model_id = 'claude-gone';
  oneError(f, /rows\[0\] \(claude-gone\): model_id is not an id/, 'unknown id');
  f = good(); f['per-request.json'].rows[0].out = '282';
  oneError(f, /rows\[0\] \(claude-one\): out must be a non-negative number/, 'string count');
});

test('a required file that is missing is an error; models.json is always required', () => {
  let f = good(); delete f['plans.json'];
  oneError(f, /data\/plans\.json: missing/, 'plans missing');
  f = good(); delete f['models.json'];
  oneError(f, /data\/models\.json: missing/, 'models missing');
});

// --- the writers stamp what the contract accepts ---------------------------------------------
test('writers: normalizeReleased only ever yields a form the contract accepts', () => {
  for (const raw of ['2026-09-28', '2026-09-28T10:00:00Z', '2026-09', '2026-q3', '2026', 'unknown', 'TBD', '', null, undefined, '2026-02-30', 'Sept 2026']) {
    const f = good(); f['models.json'].models[0].released = normalizeReleased(raw);
    assert.deepEqual(errorsOf(f), [], `released from ${JSON.stringify(raw)}`);
  }
});

test('writers: a timeline entry dated by releaseDateFor passes, whatever released was', () => {
  for (const raw of ['2026-09-28', '2026-09', '2026-Q1', '2026', null, 'unknown']) {
    const f = good();
    const when = releaseDateFor(raw, TODAY);
    f['models.json'].releases.push({ kind: 'model', ...when, vendor: 'Google', title: `t ${raw}`, summary: 's', source: 'https://openrouter.ai/google/stub-one', why: 'w' });
    assert.deepEqual(errorsOf(f), [], `entry from released ${JSON.stringify(raw)}`);
  }
});

test('writers: a Collect day-0 stub (auto-refresh shape) passes the models feed', () => {
  const f = good();
  f['models.json'].models.push({ id: 'new-one', name: 'New One', vendor: 'Google', released: normalizeReleased(null), sources: ['https://openrouter.ai/google/new-one'] });
  assert.deepEqual(errorsOf(f), []);
});

// --- CLI: --data runs the whole gate on a temp copy ------------------------------------------
test('CLI --data: the gate runs on a copy, and a contract break in the copy fails it', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const dir = join(mkdtempSync(join(tmpdir(), 'data-contract-test-')), 'data');
  mkdirSync(dir);
  // frozen fixtures, never live data
  for (const f of ['models', 'plans', 'vendors', 'usage-presets', 'tasks', 'board-samples']) {
    cpSync(join(root, 'scripts', 'fixtures', `${f}.json`), join(dir, `${f}.json`));
  }
  const script = join(root, 'scripts', 'validate-data.mjs');
  const run = () => {
    try { execFileSync('node', [script, '--data', dir], { stdio: 'pipe' }); return { status: 0 }; }
    catch (e) { return { status: e.status, out: String(e.stderr) }; }
  };
  assert.equal(run().status, 0);
  const { files } = loadFeeds(pathToFileURL(`${dir}/`));
  assert.ok(files['models.json'] && files['plans.json'] && !files['per-request.json']);
  const m = JSON.parse(readFileSync(join(dir, 'models.json'), 'utf8'));
  m.models[0].released = 'unknown';
  writeFileSync(join(dir, 'models.json'), JSON.stringify(m));
  const r = run();
  assert.equal(r.status, 1);
  assert.match(r.out, /released "unknown" must be/);
});
