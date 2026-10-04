// New-release drill: a model that does not exist yet lands in a copy of data/, and every page and
// tool picks it up with no code change. The copy gets a made-up Anthropic model (admitted through
// the Judge writer's own functions, then given the derived fields Collect computes), a release
// entry dated one day after the newest one on file (never past tomorrow, UTC, the latest date the
// honesty gate allows), a basis claim, a model_refs row whose claim
// quotes the model string, and Claude Code's bulk default moved onto it. Then, with the shipped code untouched:
//   (a) the board's data module lists it in the pickers, and the board's install package (the
//       same buildPackage call board.html makes) names it as the bulk default with its source;
//   (b) the index timeline (assets/app.js in a vm) renders its release title and date;
//   (c) `install.mjs plan --data <copy>` names it;
//   (d) `validate-data.mjs --data <copy>` passes;
//   (e) the no-typed-facts test still passes with the drill model's name and id added to its
//       frozen fixture list (NO_TYPED_FACTS_NAMES). It never reads the live names in data/: this
//       suite gates the scheduled Collect run, and a real model whose name happens to match some
//       shipped text must not stop Collect. The live-name scan runs on pull requests (tests.yml).
// The stale drill (f) dates a copy of every dated file one day past its limit (today minus the
// limit plus one, computed): every section on index and table, the board's stamps and the vendor
// list show the stale notice, and validate-data still passes (stale is shown, never a gate).
// Nothing here counts models or releases or fixes a date: the drill reads whatever data/ holds
// today and must pass on any valid future data. Temp dirs are removed at the end.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizeJudgment, validateJudgment, applyOne } from './apply-judgment.mjs';
import { deriveTaskFit } from './derive-task-fit.mjs';
import { deriveSignalsForCatalog } from './derive-signals.mjs';
import { assembleStandings } from './derive-standings.mjs';
import { deriveAvailabilityForModel } from './derive-availability.mjs';
import { deriveStatusAdoptionForCatalog } from './derive-status-adoption.mjs';
import { planLabel, utcToday, FEEDS } from './validate-data.mjs';
import * as FR from '../assets/freshness.mjs';
import * as BD from '../assets/board-data.mjs';
import { scannedFiles, scanText } from './test-no-typed-facts.mjs';
import { buildPackage, profileFromBoard, packageText, renderPreview } from '../assets/instructions.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DRILL_NAME = 'Claude Drill 9.1';
const DRILL_CLAIM = 'drill-cc-bulk-basis';
const DRILL_REF_CLAIM = 'drill-cc-model-string';
const DRILL_URL = 'https://www.anthropic.com/news/claude-drill-9-1';

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const writeJson = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n');
const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
// The drill's release date: the day after the newest release on file, but never later than
// tomorrow (UTC), the latest date the honesty gate allows.
const drillDay = (newest, today = utcToday()) => { const a = addDays(newest, 1); const b = addDays(today, 1); return a < b ? a : b; };
// A child process of this test must not inherit the test runner's context or a real tool home.
function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const k of ['NODE_TEST_CONTEXT', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME']) delete env[k];
  return env;
}
function run(args, extra) {
  try {
    return { status: 0, out: execFileSync(process.execPath, args, { cwd: ROOT, env: childEnv(extra), stdio: 'pipe', encoding: 'utf8' }) };
  } catch (e) {
    return { status: e.status, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

let TMP, DATA, drill, release, files;

before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'modelproof-drill-'));
  DATA = path.join(TMP, 'data');
  fs.cpSync(path.join(ROOT, 'data'), DATA, { recursive: true });
  ({ drill, release, files } = buildDrill(DATA));
});

// Writes the drill model, its release, claims and Claude Code's bulk slot into the data copy at
// `dir`, and returns what the checks below read.
function buildDrill(dir) {
  // 1. The model: dated one day after the newest release on file (at most tomorrow), admitted by
  //    the Judge writer (normalizeJudgment -> validateJudgment -> applyOne, which also writes its
  //    timeline entry).
  const models = readJson(path.join(dir, 'models.json'));
  const newest = (models.releases || []).map((r) => r.date).filter(Boolean).sort().at(-1);
  assert.ok(newest, 'data/models.json has at least one dated release');
  const day = drillDay(newest);
  const raw = {
    id: 'new:drill', kind: 'new-model',
    reason: 'drill: a release that is not in the data yet',
    sources: [{ url: DRILL_URL, date: day }],
    value: { name: DRILL_NAME, vendor: 'Anthropic', released: day, context_window: 200000, price_input: 2, price_output: 9 },
  };
  const { judgment } = normalizeJudgment(raw);
  assert.deepEqual(validateJudgment(judgment), [], 'the drill judgment is valid');
  assert.ok(applyOne(models, judgment, day), 'apply-judgment admitted the drill model');
  const drill = models.models.find((m) => m.name === DRILL_NAME);
  assert.ok(drill, 'the drill model is in the copy');
  // 2. The fields Collect derives for every model, from the derive scripts' own functions with no
  //    live feeds (what a day-0 model gets before any usage or tester data names it).
  drill.task_fit = deriveTaskFit(models).taskFitById.get(drill.id);
  drill.signals = deriveSignalsForCatalog([drill], {}, readJson(path.join(dir, 'tasks.json')), new Map(), [], null, null).get(drill.id);
  drill.standings = assembleStandings([drill], { asOf: day }).get(drill.id);
  drill.availability = deriveAvailabilityForModel(drill, {});
  const release = models.releases.find((r) => r.title && r.title.includes(DRILL_NAME));
  assert.ok(release, 'the writer added a timeline entry');
  writeJson(path.join(dir, 'models.json'), models);

  // 3. Guidance: a basis claim for the new default, and Claude Code's bulk slot moved onto it.
  const guidance = readJson(path.join(dir, 'guidance.json'));
  guidance.claims.push({
    id: DRILL_CLAIM, subject: { kind: 'tool', name: 'Claude Code' }, topic: 'model-per-job',
    sentence: `Claude Code's drill page names ${DRILL_NAME} for quick mechanical work.`,
    source_url: DRILL_URL, tier: 'tool', date: day,
    quote: `${DRILL_NAME} for quick mechanical work`,
  });
  // The bulk helper file takes Claude Code's own string for the model, so a model_refs row maps
  // it, resting on a claim that quotes that string (validate-data checks both).
  guidance.claims.push({
    id: DRILL_REF_CLAIM, subject: { kind: 'tool', name: 'Claude Code' }, topic: 'model-per-job',
    sentence: `Claude Code's drill page gives ${drill.id} as the model string for ${DRILL_NAME}.`,
    source_url: DRILL_URL, tier: 'tool', date: day,
    quote: `set model: ${drill.id} in your subagent configuration`,
  });
  guidance.model_refs.push({ tool: 'claude-code', ref: drill.id, model_id: drill.id, basis: [DRILL_REF_CLAIM] });
  const cc = (guidance.tool_plans || []).find((t) => t.tool === 'claude-code');
  assert.ok(cc && cc.bulk, 'guidance.json has a Claude Code tool plan with a bulk slot');
  cc.bulk = { ...cc.bulk, model_id: drill.id, basis: [DRILL_CLAIM] };
  writeJson(path.join(dir, 'guidance.json'), guidance);

  const files = {
    models, guidance,
    plans: readJson(path.join(dir, 'plans.json')),
    samples: readJson(path.join(dir, 'board-samples.json')),
    perRequest: fs.existsSync(path.join(dir, 'per-request.json')) ? readJson(path.join(dir, 'per-request.json')) : null,
  };
  return { drill, release, files };
}

after(() => { if (TMP) fs.rmSync(TMP, { recursive: true, force: true }); });

// A personal board on a priced Anthropic seat plan, so the package covers Claude Code. Picked by
// property from plans.json, not by name.
function personalProfile() {
  const row = files.plans.plans.find((p) => p.vendor === 'Anthropic' && typeof p.price_usd_month === 'number' && p.price_usd_month > 0);
  assert.ok(row, 'plans.json has a priced Anthropic plan');
  const state = { mode: 'personal', personal: { me: { plans: [planLabel(row)], uses: [] }, roles: [], taskDefs: [] } };
  return profileFromBoard(state, { models: files.models.models, guidance: files.guidance, plans: files.plans.plans });
}

test('drill (a): the board pickers list the new model', () => {
  const view = BD.boardView({ models: files.models.models, plans: files.plans.plans, perRequest: files.perRequest, samples: files.samples });
  assert.ok(view.picker.includes(drill.id), 'boardView picker');
  const lists = BD.pickerLists(files.models.models, { query: DRILL_NAME });
  assert.ok(lists.rest.some((m) => m.id === drill.id), 'picker search by name');
});

test('drill (a): the board install package shows the new bulk default with its source', () => {
  const profile = personalProfile();
  assert.ok(profile.tools.includes('claude-code'), 'the profile covers Claude Code');
  const pkg = buildPackage(profile, { models: files.models.models, guidance: files.guidance, plans: files.plans.plans });
  const text = packageText(pkg);
  const preview = renderPreview(pkg);
  for (const [label, s] of [['package text', text], ['preview', preview]]) {
    assert.ok(s.includes(DRILL_NAME), `${label} names the drill model`);
    assert.ok(s.includes(DRILL_URL), `${label} cites the drill basis source`);
  }
  const bulkLine = text.split('\n').find((l) => /^(?:- )?Bulk:/.test(l.trim()));
  assert.ok(bulkLine && bulkLine.includes(DRILL_NAME), `the Bulk line names it: ${bulkLine}`);
  // The bulk helper file the installer would write sets the new model by its id.
  const bulkFile = text.split(/^=== /m).find((part) => /modelproof-bulk\.md ===/.test(part.split('\n')[0]));
  assert.ok(bulkFile, 'the package writes a bulk helper file');
  assert.match(bulkFile, new RegExp(`^model: ${drill.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'), 'the bulk helper file sets the drill model');
});

// assets/app.js in a vm, with just enough of a document for renderFeed to write #feed.
function loadTimeline() {
  const feed = { innerHTML: '' };
  const noop = () => {};
  const document = {
    readyState: 'loading', addEventListener: noop,
    querySelector: (s) => (s === '#feed' ? feed : null), querySelectorAll: () => [],
    documentElement: { classList: { contains: () => false } },
  };
  const ctx = vm.createContext({ document, addEventListener: noop, setTimeout: noop, setInterval: noop, clearInterval: noop, console });
  const src = fs.readFileSync(path.join(ROOT, 'assets', 'app.js'), 'utf8');
  return { feed, app: vm.runInContext(`${src}\n;({ state, renderFeed, relWhen })`, ctx) };
}

test('drill (b): the index timeline renders the new release', () => {
  const { feed, app } = loadTimeline();
  app.state.data = files.models;
  app.renderFeed();
  assert.ok(feed.innerHTML.includes(release.title), 'the release title is on the timeline');
  const items = feed.innerHTML.split('<li class="rel"').slice(1);
  const mine = items.findIndex((x) => x.includes(release.title));
  const when = app.relWhen(release.date, release.date_precision);
  // Newest first: nothing on file is dated later, and only entries of the same day come before it.
  assert.ok(!files.models.releases.some((r) => r.date > release.date), 'the drill release is on the newest day');
  assert.ok(mine >= 0 && mine < files.models.releases.filter((r) => r.date === release.date).length, 'the newest release is listed first');
  assert.ok(items[mine].includes(`<span class="rel__mon">${when.mon}</span><span class="rel__day">${when.day}</span>`), `dated ${release.date}`);
});

test('drill (b): a month, quarter or year release shows no day the source never gave', () => {
  const { feed, app } = loadTimeline();
  const at = (date, date_precision) => ({ kind: 'model', date, date_precision, vendor: 'X', title: `t-${date_precision}`, summary: 's', source: 'https://x.example' });
  const cases = [
    [at('2026-07-01', 'month'), 'JUL', "'26"],
    [at('2026-07-01', 'quarter'), 'Q3', "'26"],
    [at('2026-01-01', 'year'), '', '2026'],
    [at('2026-07-01'), 'JUL', '01'],
  ];
  for (const [entry, mon, day] of cases) {
    app.state.data = { releases: [entry] };
    app.renderFeed();
    const when = (feed.innerHTML.match(/<div class="rel__when">.*?<\/div>/) || [''])[0];
    assert.equal(when, `<div class="rel__when"><span class="rel__mon">${mon}</span><span class="rel__day">${day}</span></div>`, `${entry.date} at ${entry.date_precision || 'day'} precision`);
  }
});

test('drill (c): install.mjs plan with the copied data names the new model', () => {
  const home = path.join(TMP, 'home');
  fs.mkdirSync(home);
  const profileFile = path.join(TMP, 'profile.json');
  writeJson(profileFile, personalProfile());
  const r = run([path.join(ROOT, 'assets', 'install.mjs'), 'plan', '--profile', profileFile, '--data', DATA, '--home', home],
    { HOME: home, MODELPROOF_HOME: path.join(TMP, 'state') });
  assert.equal(r.status, 0, r.out);
  assert.ok(r.out.includes(DRILL_NAME), 'plan output names the drill model');
});

test('drill (d): validate-data passes on the copy', () => {
  const r = run([path.join(ROOT, 'scripts', 'validate-data.mjs'), '--data', DATA]);
  assert.equal(r.status, 0, r.out.split('\n').slice(-30).join('\n'));
});

// How drill (e) runs the no-typed-facts test: the frozen fixture names plus the drill model's
// name and id, never a live name from data/ (NO_TYPED_FACTS_DATA is dropped even when the caller
// set it, as tests.yml does for its own live scan).
function noTypedFacts(extra) {
  return run(['--test', path.join(ROOT, 'scripts', 'test-no-typed-facts.mjs')], { NO_TYPED_FACTS_DATA: '', ...extra });
}

test('drill (e): no-typed-facts still passes with the drill model added to its names', () => {
  const r = noTypedFacts({ NO_TYPED_FACTS_NAMES: JSON.stringify([DRILL_NAME, drill.id]) });
  assert.equal(r.status, 0, r.out.split('\n').slice(-30).join('\n'));
});

test('drill (e): a live model whose name matches shipped text does not turn the scheduled unit run red', () => {
  // A digit-bearing word some shipped file really shows, used as a model name in a data copy.
  let token = null;
  for (const f of scannedFiles(ROOT)) {
    if (f.endsWith('.md')) continue;
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const [w] of text.matchAll(/(?<![A-Za-z0-9-])[A-Za-z][A-Za-z0-9-]*\d[A-Za-z0-9]*(?![A-Za-z0-9])/g)) {
      if (w.length >= 3 && scanText(text, f, { terms: [w] }).some((h) => h.kind === 'name')) { token = w; break; }
    }
    if (token) break;
  }
  assert.ok(token, 'some shipped file shows a digit-bearing word');
  const dir = path.join(TMP, 'collide');
  fs.mkdirSync(dir);
  writeJson(path.join(dir, 'models.json'), { models: [{ id: `collide-${token.toLowerCase()}`, name: token }] });
  // The live-name scan (pull requests only) would flag it ...
  assert.notEqual(noTypedFacts({ NO_TYPED_FACTS_DATA: dir }).status, 0, `the live scan sees "${token}"`);
  // ... while the drill's own run, the one the scheduled unit run makes, never reads data/ names.
  const r = noTypedFacts({ NO_TYPED_FACTS_NAMES: JSON.stringify([DRILL_NAME, drill.id]) });
  assert.equal(r.status, 0, r.out.split('\n').slice(-30).join('\n'));
});

test('drill date: a release on file dated tomorrow keeps the drill inside the honesty gate', () => {
  const dir = path.join(TMP, 'tomorrow');
  fs.cpSync(path.join(ROOT, 'data'), dir, { recursive: true });
  const models = readJson(path.join(dir, 'models.json'));
  const tomorrow = addDays(utcToday(), 1);
  const like = models.releases.find((r) => r.kind === 'model' && !r.date_precision);
  models.releases.push({ ...like, date: tomorrow, title: `${like.title} (drill copy)` });
  writeJson(path.join(dir, 'models.json'), models);
  const built = buildDrill(dir);
  assert.equal(built.release.date, tomorrow, 'the drill is dated tomorrow, not the day after');
  const r = run([path.join(ROOT, 'scripts', 'validate-data.mjs'), '--data', dir]);
  assert.equal(r.status, 0, r.out.split('\n').slice(-30).join('\n'));
});

/* ---------- (f) the stale drill ---------- */

// A copy of data/ with each dated file's as_of set to `daysPast(limit)` days before today (UTC).
// The effort ladders carry their own dates inside models.json: every ladder's as_of is set for them.
function datedCopy(name, daysPast) {
  const dir = path.join(TMP, name);
  fs.cpSync(path.join(ROOT, 'data'), dir, { recursive: true });
  const asOf = {};
  for (const [feed, lim] of Object.entries(FR.FEED_FRESHNESS)) {
    const file = FEEDS.find((f) => f.id === feed).file;
    const p = path.join(dir, file);
    if (!fs.existsSync(p)) continue;
    const j = readJson(p);
    if (feed === 'effort-ladders') {
      asOf[feed] = addDays(utcToday(), -daysPast(lim.maxDays));
      for (const L of j.effort_ladders) L.as_of = asOf[feed];
      writeJson(p, j);
      continue;
    }
    j.as_of = addDays(utcToday(), -daysPast(lim.maxDays));
    // models.json's as_of is also the day its adoption labels are worked out against; re-derive
    // them for the older day, as the last Collect run on that day would have written them.
    if (feed === 'models') {
      const derived = deriveStatusAdoptionForCatalog(j.models, j.as_of);
      for (const m of j.models) m.adoption = derived.get(m.id).adoption;
    }
    writeJson(p, j);
    asOf[feed] = j.as_of;
  }
  return { dir, asOf };
}

// assets/app.js in a vm with one stub element per [data-fresh] slot the real page carries, plus the
// nav badge and the footer date.
function loadSlots(page) {
  const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
  const slots = [...html.matchAll(/data-fresh="([^"]+)"/g)].map((m) => ({ dataset: { fresh: m[1] }, innerHTML: '' }));
  const nav = { innerHTML: '', title: '', classList: { on: false, toggle(c, v) { this.on = v; } } };
  const foot = { textContent: '' };
  const noop = () => {};
  const document = {
    readyState: 'loading', addEventListener: noop,
    querySelector: (s) => ({ '#navAsof': nav, '#footAsof': foot }[s] || null),
    querySelectorAll: (s) => (s === '[data-fresh]' ? slots : []),
    documentElement: { classList: { contains: () => false } },
  };
  const ctx = vm.createContext({ document, addEventListener: noop, setTimeout: noop, setInterval: noop, clearInterval: noop, console });
  const src = fs.readFileSync(path.join(ROOT, 'assets', 'app.js'), 'utf8');
  return { slots, nav, foot, app: vm.runInContext(`${src}\n;({ state, renderFreshness })`, ctx) };
}

test('drill (f): one day past every limit, every section shows the stale notice', () => {
  const { dir, asOf } = datedCopy('stale', (max) => max + 1);
  const models = readJson(path.join(dir, 'models.json'));
  const age = FR.FEED_FRESHNESS.models.maxDays + 1;
  for (const page of ['index.html', 'table.html']) {
    const { slots, nav, foot, app } = loadSlots(page);
    assert.ok(slots.length >= 1, `${page} has freshness slots`);
    app.state.data = models;
    app.state.fresh = FR;
    app.renderFreshness();
    for (const s of slots) {
      const feed = FR.FEED_ALIASES[s.dataset.fresh] || s.dataset.fresh;
      const slotAge = FR.FEED_FRESHNESS[feed].maxDays + 1;
      assert.match(s.innerHTML, /class="mp-stale" role="note"/, `${page} [data-fresh=${s.dataset.fresh}] shows the notice`);
      assert.ok(s.innerHTML.includes(`Not updated in ${slotAge} days.`), `${page} [data-fresh=${s.dataset.fresh}] says how old`);
      assert.ok(s.innerHTML.includes(`datetime="${asOf[feed]}"`), `${page} stamp carries the data date`);
    }
    assert.ok(nav.classList.on && nav.innerHTML.includes(`Not updated in ${age} days`), `${page} nav badge`);
    assert.equal(foot.textContent, FR.dayLabel(asOf.models));
  }
  // The board and how-we-pick build theirs from the same module with the file's own date.
  const files = { models: 'Model prices', plans: 'Plan prices', 'tool-defaults': 'Tool defaults', 'per-request': 'Request sizes', vendors: 'Vendor countries' };
  for (const [feed, label] of Object.entries(files)) {
    if (!asOf[feed]) continue;
    const html = FR.freshHtml(feed, asOf[feed], { label });
    assert.match(html, /mp-asof--stale/, `${feed} stamp`);
    assert.ok(html.includes(`${label} not updated in ${FR.FEED_FRESHNESS[feed].maxDays + 1} days.`), `${feed} notice`);
  }
  // Stale is a display state: the copy still passes the data gate, so Collect is never blocked.
  const r = run([path.join(ROOT, 'scripts', 'validate-data.mjs'), '--data', dir]);
  assert.equal(r.status, 0, r.out.split('\n').slice(-30).join('\n'));
});

test('drill (f): at exactly every limit, no section shows the notice', () => {
  const { dir, asOf } = datedCopy('at-limit', (max) => max);
  const models = readJson(path.join(dir, 'models.json'));
  for (const page of ['index.html', 'table.html']) {
    const { slots, nav, app } = loadSlots(page);
    app.state.data = models;
    app.state.fresh = FR;
    app.renderFreshness();
    for (const s of slots) {
      const feed = FR.FEED_ALIASES[s.dataset.fresh] || s.dataset.fresh;
      assert.doesNotMatch(s.innerHTML, /mp-stale/, `${page} [data-fresh=${s.dataset.fresh}]`);
      assert.ok(s.innerHTML.includes(`As of ${FR.dayLabel(asOf[feed])}`), `${page} stamp`);
    }
    assert.ok(!nav.classList.on && nav.innerHTML.includes(`As of ${FR.dayLabel(asOf.models)}`), `${page} nav badge`);
  }
  for (const feed of Object.keys(asOf)) assert.equal(FR.staleHtml(feed, asOf[feed]), '', feed);
});

test('drill (f): with no module loaded, the sections keep the facts and show no broken stamp', () => {
  const { slots, app } = loadSlots('index.html');
  app.state.data = readJson(path.join(ROOT, 'data', 'models.json'));
  app.state.fresh = null;
  app.renderFreshness();
  assert.ok(slots.every((s) => s.innerHTML === ''));
});

test('section 03 stamps the date of the effort ladder on screen, not models.json\'s, and follows a switch', () => {
  const { slots, app } = loadSlots('index.html');
  const models = readJson(path.join(ROOT, 'data', 'models.json'));
  models.as_of = '2026-10-04';
  models.effort_ladders = [{ ...models.effort_ladders[0], as_of: '2026-07-24' }, { ...models.effort_ladders[0], as_of: '2026-09-22' }];
  app.state.data = models;
  app.state.fresh = FR;
  const now = Date.parse('2026-10-04T12:00:00Z');
  app.state.now = now;
  const slot = slots.find((s) => s.dataset.fresh === 'effort-ladders');
  assert.ok(slot, 'index.html has the effort-ladders slot');
  app.state.ladder = 0;
  app.renderFreshness();
  assert.ok(slot.innerHTML.includes('datetime="2026-07-24"') && slot.innerHTML.includes('As of 24 Jul 2026'), slot.innerHTML);
  assert.ok(!slot.innerHTML.includes('2026-10-04'), 'never the catalog date');
  app.state.ladder = 1;
  app.renderFreshness();
  assert.ok(slot.innerHTML.includes('datetime="2026-09-22"'), slot.innerHTML);
  // an old ladder shows its own notice
  models.effort_ladders[1].as_of = '2026-05-01';
  app.renderFreshness();
  assert.match(slot.innerHTML, /Not updated in 156 days\. Usually updated when the publisher posts new runs\./);
  // the ladder switch fills the stamp again
  const src = fs.readFileSync(path.join(ROOT, 'assets', 'app.js'), 'utf8');
  assert.match(src, /state\.ladder = \+b\.getAttribute\('data-lad'\);[^\n]*renderEffort\(\); renderFreshness\(\);/);
});
