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
  for (const f of ['apply-judgment.mjs', 'validate-data.mjs', 'sources.json']) {
    writeFileSync(join(dir, 'scripts', f), readFileSync(join(SCRIPTS_DIR, f)));
  }
  const models = JSON.parse(readFileSync(REAL_DATA));
  writeFileSync(join(dir, 'data', 'models.json'), JSON.stringify(models, null, 2));
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
