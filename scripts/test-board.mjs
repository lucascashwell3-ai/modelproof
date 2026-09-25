/* board.html ships as a single file that fetches the site's own data at runtime, so nothing here
   can catch a broken reference the way an import would. These checks stand in for that: the page
   must still name the five data files and the shipped engine, and every model id and plan name in
   the example boards must exist in the catalog — otherwise "Start from an example" quietly builds
   a board with a blank model or a plan that prices at nothing. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  ]) {
    assert.ok(BOARD.includes(`"./${file}"`), `board.html does not reference ${file}`);
    assert.ok(fs.existsSync(path.join(ROOT, file)), `${file} is missing from the repo`);
  }
});

test('board.html imports the shipped decision engine', () => {
  assert.match(BOARD, /import\s*\{\s*decide\s*\}\s*from\s*["']\.\/assets\/decide\.mjs["']/);
  assert.ok(fs.existsSync(path.join(ROOT, 'assets/decide.mjs')));
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
