// New-release drill: a model that does not exist yet lands in a copy of data/, and every page and
// tool picks it up with no code change. The copy gets a made-up Anthropic model (admitted through
// the Judge writer's own functions, then given the derived fields Collect computes), a release
// entry dated one day after the newest one on file, a basis claim, a model_refs row whose claim
// quotes the model string, and Claude Code's bulk default moved onto it. Then, with the shipped code untouched:
//   (a) the board's data module lists it in the pickers, and the board's install package (the
//       same buildPackage call board.html makes) names it as the bulk default with its source;
//   (b) the index timeline (assets/app.js in a vm) renders its release title and date;
//   (c) `install.mjs plan --data <copy>` names it;
//   (d) `validate-data.mjs --data <copy>` passes;
//   (e) the no-typed-facts test still passes with NO_TYPED_FACTS_DATA=<copy>.
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
import { planLabel } from './validate-data.mjs';
import * as BD from '../assets/board-data.mjs';
import { buildPackage, profileFromBoard, packageText, renderPreview } from '../assets/instructions.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DRILL_NAME = 'Claude Drill 9.1';
const DRILL_CLAIM = 'drill-cc-bulk-basis';
const DRILL_REF_CLAIM = 'drill-cc-model-string';
const DRILL_URL = 'https://www.anthropic.com/news/claude-drill-9-1';

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const writeJson = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n');
const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
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

  // 1. The model: dated one day after the newest release on file, admitted by the Judge writer
  //    (normalizeJudgment -> validateJudgment -> applyOne, which also writes its timeline entry).
  const models = readJson(path.join(DATA, 'models.json'));
  const newest = (models.releases || []).map((r) => r.date).filter(Boolean).sort().at(-1);
  assert.ok(newest, 'data/models.json has at least one dated release');
  const day = addDays(newest, 1);
  const raw = {
    id: 'new:drill', kind: 'new-model',
    reason: 'drill: a release that is not in the data yet',
    sources: [{ url: DRILL_URL, date: day }],
    value: { name: DRILL_NAME, vendor: 'Anthropic', released: day, context_window: 200000, price_input: 2, price_output: 9 },
  };
  const { judgment } = normalizeJudgment(raw);
  assert.deepEqual(validateJudgment(judgment), [], 'the drill judgment is valid');
  assert.ok(applyOne(models, judgment, day), 'apply-judgment admitted the drill model');
  drill = models.models.find((m) => m.name === DRILL_NAME);
  assert.ok(drill, 'the drill model is in the copy');
  // 2. The fields Collect derives for every model, from the derive scripts' own functions with no
  //    live feeds (what a day-0 model gets before any usage or tester data names it).
  drill.task_fit = deriveTaskFit(models).taskFitById.get(drill.id);
  drill.signals = deriveSignalsForCatalog([drill], {}, readJson(path.join(DATA, 'tasks.json')), new Map(), [], null, null).get(drill.id);
  drill.standings = assembleStandings([drill], { asOf: day }).get(drill.id);
  drill.availability = deriveAvailabilityForModel(drill, {});
  release = models.releases.find((r) => r.title && r.title.includes(DRILL_NAME));
  assert.ok(release, 'the writer added a timeline entry');
  writeJson(path.join(DATA, 'models.json'), models);

  // 3. Guidance: a basis claim for the new default, and Claude Code's bulk slot moved onto it.
  const guidance = readJson(path.join(DATA, 'guidance.json'));
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
  writeJson(path.join(DATA, 'guidance.json'), guidance);

  files = {
    models, guidance,
    plans: readJson(path.join(DATA, 'plans.json')),
    samples: readJson(path.join(DATA, 'board-samples.json')),
    perRequest: fs.existsSync(path.join(DATA, 'per-request.json')) ? readJson(path.join(DATA, 'per-request.json')) : null,
  };
});

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
  const first = feed.innerHTML.split('<li class="rel"')[1] || '';
  const when = app.relWhen(release.date, release.date_precision);
  assert.ok(first.includes(release.title), 'the newest release is listed first');
  assert.ok(first.includes(`<span class="rel__mon">${when.mon}</span><span class="rel__day">${when.day}</span>`), `dated ${release.date}`);
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

test('drill (e): no-typed-facts still passes with the copy as its data', () => {
  const r = run(['--test', path.join(ROOT, 'scripts', 'test-no-typed-facts.mjs')], { NO_TYPED_FACTS_DATA: DATA });
  assert.equal(r.status, 0, r.out.split('\n').slice(-30).join('\n'));
});
