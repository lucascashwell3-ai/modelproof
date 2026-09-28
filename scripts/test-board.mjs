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
