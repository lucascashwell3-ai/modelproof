// R1-02: the facts table must not open sorted by coding_score (for many models Modelproof's own
// estimate), and the MCP must say which coding scores are estimates. assets/app.js is a browser
// script, so it runs here in a vm with a document that never finishes loading (boot never fires).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { brief, disclaimer } from '../mcp/facts.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODELS = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'models.json'), 'utf8'));

function loadApp() {
  const noop = () => {};
  const document = { readyState: 'loading', addEventListener: noop, querySelector: () => null, querySelectorAll: () => [] };
  const ctx = vm.createContext({ document, addEventListener: noop, setTimeout: noop, setInterval: noop, clearInterval: noop, console });
  const src = fs.readFileSync(path.join(ROOT, 'assets', 'app.js'), 'utf8');
  return vm.runInContext(`${src}\n;({ state, sortedModels })`, ctx);
}

test('R1-02: the table opens newest release first, not by coding score', () => {
  const { state, sortedModels } = loadApp();
  assert.equal(state.sort.key, 'released');
  assert.equal(state.sort.dir, 'desc');
  state.data = MODELS;
  for (const showAll of [false, true]) {
    state.showAll = showAll;
    const key = (d) => (/^\d{4}-Q[1-4]$/.test(d) ? `${d.slice(0, 4)}-${String((d[6] - 1) * 3 + 1).padStart(2, '0')}` : d);
    const dates = sortedModels().map((m) => key(String(m.released || '')));
    const dated = dates.filter((d) => /^\d{4}(-\d{2}){0,2}$/.test(d));
    for (let i = 1; i < dated.length; i++) assert.ok(dated[i - 1] >= dated[i], `${dated[i - 1]} before ${dated[i]}`);
    assert.deepEqual(dates.slice(0, dated.length), dated, 'undated models sort last');
  }
});

test('R1-02: the MCP marks estimated coding scores and never calls them unguessed', () => {
  let est = 0;
  for (const m of MODELS.models) {
    const b = brief(m);
    const published = typeof m.benchmarks?.swe_bench === 'number';
    assert.equal(b.coding_score_is_estimate, b.coding_score !== null && !published, m.id);
    if (b.coding_score_is_estimate) est += 1;
  }
  assert.ok(est > 0, 'the live data has estimates, so the flag is exercised');
  const d = disclaimer('2026-09-27');
  assert.ok(!/not guessed/i.test(d));
  assert.match(d, /estimate/);
  assert.match(d, /coding_score_is_estimate/);
});
