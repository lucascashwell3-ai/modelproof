import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeText, quoteFoundIn, collectClaims, collectGuidanceClaims, collectPlanClaims, collectAllClaims, selectClaims, checkClaims, parseArgs } from './check-sources.mjs';

test('normalizeText strips tags/scripts/styles, decodes entities, collapses whitespace, lowercases', () => {
  const html = '<html><head><style>.x{color:red}</style></head><body><script>evil()</script>' +
    '<h1>Hello &amp; Welcome</h1><p>Line one\n   Line   two &mdash; done&nbsp;now.</p></body></html>';
  const out = normalizeText(html);
  assert.equal(out, 'hello & welcome line one line two - done now.');
});

test('normalizeText decodes numeric HTML entities (WordPress-style curly quotes) the same as literal unicode', () => {
  const numeric = normalizeText('The team called it &#8216;second only to Fable 5&#8217; in the post.');
  const literal = normalizeText('The team called it ‘second only to Fable 5’ in the post.');
  assert.equal(numeric, literal);
  assert.equal(numeric, "the team called it 'second only to fable 5' in the post.");
});

test('normalizeText normalizes curly quotes and dashes the same way on both sides', () => {
  const a = normalizeText('The model’s score is “91.2” — verified.');
  const b = normalizeText("The model's score is \"91.2\" - verified.");
  assert.equal(a, b);
});

test('quoteFoundIn: true when the normalized quote is a substring of the normalized page', () => {
  const page = normalizeText('<p>Our model scores 91.2% on the benchmark, a new record for the line.</p>');
  assert.equal(quoteFoundIn('scores 91.2% on the benchmark', page), true);
});

test('quoteFoundIn: false when the quote is not actually on the page (fabricated/misquoted)', () => {
  const page = normalizeText('<p>Our model scores 91.2% on the benchmark.</p>');
  assert.equal(quoteFoundIn('scores 99.9% on the benchmark', page), false);
});

test('quoteFoundIn: false on an empty quote (never treat "nothing" as found)', () => {
  const page = normalizeText('<p>Some real content.</p>');
  assert.equal(quoteFoundIn('', page), false);
  assert.equal(quoteFoundIn(null, page), false);
});

test('collectClaims: flattens every claim across every model/task, skips models with no judged fit', () => {
  const data = {
    models: [
      { id: 'a', name: 'Model A', task_fit_judged: null },
      {
        id: 'b', name: 'Model B',
        task_fit_judged: {
          coding: { claims: [{ source_url: 'https://x.example/1', quote: 'q1', tier: 'lab' }] },
          agents: { claims: [{ source_url: 'https://x.example/2', quote: 'q2', tier: 'reported' }] },
        },
      },
    ],
  };
  const claims = collectClaims(data);
  assert.equal(claims.length, 2);
  assert.deepEqual(claims.map((c) => c.taskId).sort(), ['agents', 'coding']);
  assert.equal(claims[0].modelId, 'b');
});

test('collectClaims: a model with no task_fit_judged at all contributes nothing', () => {
  assert.deepEqual(collectClaims({ models: [{ id: 'a', name: 'A' }] }), []);
});

test('checkClaims: a claim whose quote is on the fetched page passes', async () => {
  const claims = [{ modelId: 'a', taskId: 'coding', source_url: 'https://x.example/page', quote: 'the score is 91.2' }];
  const fetchImpl = async () => normalizeText('<p>Vendor says: the score is 91.2 on our internal suite.</p>');
  const results = await checkClaims(claims, { fetchImpl });
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, true);
  assert.equal(results[0].reason, null);
});

test('checkClaims: a claim whose quote is NOT on the fetched page fails — the anti-fabrication case', async () => {
  const claims = [{ modelId: 'a', taskId: 'coding', source_url: 'https://x.example/page', quote: 'the score is 99.9' }];
  const fetchImpl = async () => normalizeText('<p>Vendor says: the score is 91.2 on our internal suite.</p>');
  const results = await checkClaims(claims, { fetchImpl });
  assert.equal(results[0].ok, false);
  assert.match(results[0].reason, /not found/);
});

test('checkClaims: a fetch failure is a FAILED claim, not a skip', async () => {
  const claims = [{ modelId: 'a', taskId: 'coding', source_url: 'https://x.example/gone', quote: 'anything' }];
  const fetchImpl = async () => { throw new Error('HTTP 404'); };
  const results = await checkClaims(claims, { fetchImpl });
  assert.equal(results[0].ok, false);
  assert.match(results[0].reason, /could not fetch/);
});

test('checkClaims: a claim missing source_url fails without attempting a fetch', async () => {
  const claims = [{ modelId: 'a', taskId: 'coding', source_url: undefined, quote: 'anything' }];
  let fetchCalled = false;
  const fetchImpl = async () => { fetchCalled = true; return ''; };
  const results = await checkClaims(claims, { fetchImpl });
  assert.equal(results[0].ok, false);
  assert.equal(fetchCalled, false);
});

test('checkClaims: two claims sharing one source_url only fetch the page once', async () => {
  const claims = [
    { modelId: 'a', taskId: 'coding', source_url: 'https://x.example/shared', quote: 'alpha fact' },
    { modelId: 'a', taskId: 'agents', source_url: 'https://x.example/shared', quote: 'beta fact' },
  ];
  let fetchCount = 0;
  const fetchImpl = async () => { fetchCount++; return normalizeText('<p>alpha fact and beta fact both live here.</p>'); };
  const results = await checkClaims(claims, { fetchImpl });
  assert.equal(fetchCount, 1);
  assert.ok(results.every((r) => r.ok));
});

// --- data/guidance.json claims (the instruction package's sourced facts) ----------------------
const GUIDANCE = {
  claims: [
    { id: 'tool-a', subject: { kind: 'tool', name: 'Claude Code' }, topic: 'instruction-files', sentence: 's', source_url: 'https://docs.example/a', tier: 'tool', date: '2026-09-27', quote: 'loads the file at start' },
    { id: 'lab-b', subject: { kind: 'lab', name: 'OpenAI' }, topic: 'effort', sentence: 's', source_url: 'https://docs.example/b', tier: 'lab', date: '2026-09-27', quote: 'defaults to medium effort' },
  ],
};

test('collectGuidanceClaims: one record per claim, same shape as collectClaims plus claimId', () => {
  const out = collectGuidanceClaims(GUIDANCE);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], {
    modelId: null, modelName: 'Claude Code', taskId: 'instruction-files', index: 0,
    source_url: 'https://docs.example/a', quote: 'loads the file at start', tier: 'tool', claimId: 'tool-a', file: 'guidance',
    key: 'guidance/tool-a',
  });
  for (const k of Object.keys(collectClaims({ models: [{ id: 'x', name: 'X', task_fit_judged: { coding: { claims: [{ source_url: 'u', quote: 'q', tier: 'lab' }] } } }] })[0])) {
    assert.ok(k in out[1], `guidance record carries "${k}"`);
  }
});

test('collectGuidanceClaims: missing file or empty claims contributes nothing', () => {
  assert.deepEqual(collectGuidanceClaims(null), []);
  assert.deepEqual(collectGuidanceClaims({}), []);
  assert.deepEqual(collectGuidanceClaims({ claims: [] }), []);
});

test('checkClaims over guidance claims: a quote on the page passes, a changed page fails', async () => {
  const pages = {
    'https://docs.example/a': normalizeText('<p>Claude Code loads the file at start of every session.</p>'),
    'https://docs.example/b': normalizeText('<p>The model now defaults to high effort.</p>'),
  };
  const results = await checkClaims(collectGuidanceClaims(GUIDANCE), { fetchImpl: async (u) => pages[u] });
  assert.equal(results.find((r) => r.claimId === 'tool-a').ok, true);
  const b = results.find((r) => r.claimId === 'lab-b');
  assert.equal(b.ok, false);
  assert.match(b.reason, /not found/);
});

test('checkClaims over models + guidance together shares one fetch per URL across both files', async () => {
  const models = { models: [{ id: 'm', name: 'M', task_fit_judged: { coding: { claims: [{ source_url: 'https://docs.example/a', quote: 'loads the file', tier: 'lab' }] } } }] };
  let fetches = 0;
  const fetchImpl = async () => { fetches++; return normalizeText('<p>Claude Code loads the file at start. It defaults to medium effort.</p>'); };
  const claims = [...collectClaims(models), ...collectGuidanceClaims({ claims: [GUIDANCE.claims[0]] })];
  const results = await checkClaims(claims, { fetchImpl });
  assert.equal(fetches, 1);
  assert.ok(results.every((r) => r.ok));
});

test('checkClaims over guidance claims: a 404 source is a FAILED claim', async () => {
  const results = await checkClaims(collectGuidanceClaims(GUIDANCE), { fetchImpl: async () => { throw new Error('HTTP 404'); } });
  assert.ok(results.every((r) => !r.ok && /could not fetch/.test(r.reason)));
});

// --- version-boundary rule ----------------------------------------------------------------------
test('quoteFoundIn: a quote ending in a version number does not pass on a longer version', () => {
  const page = normalizeText('<td>Anthropic API</td><td>Opus 5.5</td><td>Sonnet 5.5</td>');
  assert.equal(quoteFoundIn('Anthropic API Opus 5.5 Sonnet 5', page), false);
  assert.equal(quoteFoundIn('Anthropic API Opus 5.5 Sonnet 5.5', page), true);
  assert.equal(quoteFoundIn('Sonnet 5', normalizeText('<p>Sonnet 50 is not Sonnet 5.</p>')), true, 'a later, exact occurrence still counts');
  assert.equal(quoteFoundIn('Sonnet 5', normalizeText('<p>Sonnet 50 only</p>')), false);
});

test('quoteFoundIn: a quote starting with a number does not pass inside a longer number', () => {
  assert.equal(quoteFoundIn('20 per month', normalizeText('<p>$120 per month</p>')), false);
  assert.equal(quoteFoundIn('20 per month', normalizeText('<p>$1.20 per month</p>')), false);
  assert.equal(quoteFoundIn('20 per month', normalizeText('<p>$20 per month</p>')), true);
});

test('quoteFoundIn: zero cents are the same number, real decimals and dotted versions are not', () => {
  assert.equal(quoteFoundIn('Teams $40', normalizeText('<p>Teams $40.00 per seat</p>')), true);
  assert.equal(quoteFoundIn('Teams $40', normalizeText('<p>Teams $40.50 per seat</p>')), false);
  assert.equal(quoteFoundIn('version 5', normalizeText('<p>version 5.0.1</p>')), false);
  assert.equal(quoteFoundIn('ends in 5', normalizeText('<p>it ends in 5. Next sentence.</p>')), true, 'a full stop is not a decimal');
});

test('quoteFoundIn: quotes that neither start nor end with a digit keep plain substring matching', () => {
  assert.equal(quoteFoundIn('opus 5.5 and', normalizeText('<p>Use Opus 5.5 and Sonnet 5.5.</p>')), true);
});

// --- data/plans.json rows that carry a quote --------------------------------------------------
const PLANS = {
  plans: [
    { vendor: 'Devin', plan: 'Teams', price_usd_month: 40, source_url: 'https://pricing.example/devin', quote: 'Teams $80 /month for team plan + $40/mo per full dev seat' },
    { vendor: 'GitHub Copilot', plan: 'Pro', price_usd_month: 10, source_url: 'https://pricing.example/copilot', quote_url: 'https://docs.example/copilot-plans', quote: 'Copilot Pro $10 USD 1,000 500 1,500' },
    { vendor: 'Anthropic', plan: 'Free', price_usd_month: 0, source_url: 'https://pricing.example/anthropic' },
  ],
};

test('collectPlanClaims: one record per row with a quote; quote_url wins over source_url', () => {
  const out = collectPlanClaims(PLANS);
  assert.equal(out.length, 2);
  assert.equal(out[0].source_url, 'https://pricing.example/devin');
  assert.equal(out[1].source_url, 'https://docs.example/copilot-plans');
  assert.equal(out[1].key, 'plan/GitHub Copilot/Pro');
  assert.equal(out[1].file, 'plans');
  assert.deepEqual(collectPlanClaims(null), []);
});

test('checkClaims over plan rows: a changed price page fails the row', async () => {
  const pages = {
    'https://pricing.example/devin': normalizeText('<p>Teams $80 /month for team plan + $40/mo per full dev seat</p>'),
    'https://docs.example/copilot-plans': normalizeText('<td>Copilot Pro</td><td>$12 USD</td><td>1,000</td>'),
  };
  const results = await checkClaims(collectPlanClaims(PLANS), { fetchImpl: async (u) => pages[u] });
  assert.deepEqual(results.map((r) => r.ok), [true, false]);
});

// --- scoped runs (--only) ---------------------------------------------------------------------
test('selectClaims: keys pick judged-fit records, guidance ids and plan rows; unknown keys are reported', () => {
  const models = { models: [{ id: 'm', name: 'M', task_fit_judged: {
    coding: { claims: [{ source_url: 'https://a.example', quote: 'q', tier: 'lab' }] },
    vision: { claims: [{ source_url: 'https://b.example', quote: 'q', tier: 'lab' }] },
  } }] };
  const all = collectAllClaims({ models, guidance: GUIDANCE, plans: PLANS });
  assert.equal(all.length, 6);
  const one = selectClaims(all, ['m/coding']);
  assert.deepEqual(one.claims.map((c) => c.key), ['m/coding']);
  assert.deepEqual(one.unmatched, []);
  assert.equal(selectClaims(all, ['m']).claims.length, 2, 'a model key selects all of its tasks');
  assert.deepEqual(selectClaims(all, ['guidance/lab-b', 'plan/Devin/Teams']).claims.map((c) => c.key), ['guidance/lab-b', 'plan/Devin/Teams']);
  assert.deepEqual(selectClaims(all, ['m/agents']).unmatched, ['m/agents']);
  assert.equal(selectClaims(all, []).claims.length, 6, 'no keys = everything');
});

test('parseArgs: --data and --only (comma list, repeatable); unknown flags throw', () => {
  assert.deepEqual(parseArgs(['--data', '/tmp/d', '--only', 'a/b,c', '--only=d']), { dataDir: '/tmp/d', only: ['a/b', 'c', 'd'] });
  assert.throws(() => parseArgs(['--ids', 'x']), /unknown argument/);
});

// --- CLI: a scoped run checks only what it names (pages served from a fixture map, no network) --
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('CLI --only: a rotten quote outside the scope does not fail the run; inside the scope it does', () => {
  const dir = mkdtempSync(join(tmpdir(), 'check-sources-test-'));
  const models = { models: [{ id: 'm', name: 'M', task_fit_judged: { coding: { claims: [{ source_url: 'https://a.example/m', quote: 'writes code well', tier: 'lab' }] } } }] };
  const guidance = { claims: [{ id: 'rotten', subject: { kind: 'tool', name: 'Cursor' }, topic: 'context', sentence: 's', source_url: 'https://a.example/g', tier: 'tool', date: '2026-10-03', quote: 'this sentence left the page' }] };
  writeFileSync(join(dir, 'models.json'), JSON.stringify(models));
  writeFileSync(join(dir, 'guidance.json'), JSON.stringify(guidance));
  const pagesFile = join(dir, 'pages.json');
  writeFileSync(pagesFile, JSON.stringify({ 'https://a.example/m': '<p>It writes code well.</p>', 'https://a.example/g': '<p>The page moved on.</p>' }));
  const script = fileURLToPath(new URL('./check-sources.mjs', import.meta.url));
  const run = (...args) => {
    try { execFileSync('node', [script, '--data', dir, ...args], { stdio: 'pipe', env: { ...process.env, CHECK_SOURCES_PAGES: pagesFile } }); return 0; }
    catch (e) { return e.status; }
  };
  assert.equal(run('--only', 'm/coding'), 0);
  assert.equal(run(), 1, 'the full run still sees the rotten quote');
  assert.equal(run('--only', 'guidance/rotten'), 1);
  assert.equal(run('--only', 'm/vision'), 1, 'a scope that selects nothing fails');
});

// --- report-claim-rot.mjs: the alert covers exactly what the gate checks ----------------------
import { spawnSync } from 'node:child_process';
import { loadReportClaims } from './report-claim-rot.mjs';

const verifyingCount = (out) => Number((out.match(/verifying (\d+) claim\(s\)/) || [])[1]);

test('report-claim-rot checks the same claim count as a full check-sources run (live data/)', () => {
  const dataDir = fileURLToPath(new URL('../data/', import.meta.url));
  const empty = join(mkdtempSync(join(tmpdir(), 'claim-rot-count-')), 'pages.json');
  writeFileSync(empty, '{}'); // every fetch fails fast — only the count line matters here
  const script = fileURLToPath(new URL('./check-sources.mjs', import.meta.url));
  const r = spawnSync('node', [script, '--data', dataDir], { encoding: 'utf8', env: { ...process.env, CHECK_SOURCES_PAGES: empty } });
  const gated = verifyingCount(r.stdout);
  assert.ok(gated > 0, `check-sources printed a count: ${r.stdout.slice(0, 200)}`);
  const reported = loadReportClaims(dataDir);
  assert.equal(reported.length, gated, 'every claim check-sources gates is also reported when it rots');
  for (const f of ['models', 'guidance', 'plans']) assert.ok(reported.some((c) => c.file === f), `reporter covers ${f}`);
});

test('report-claim-rot names the file of a rotten guidance quote and a rotten plan quote', () => {
  const dir = mkdtempSync(join(tmpdir(), 'claim-rot-file-'));
  writeFileSync(join(dir, 'models.json'), JSON.stringify({ models: [{ id: 'm', name: 'M', task_fit_judged: { coding: { claims: [{ source_url: 'https://a.example/m', quote: 'writes code well', tier: 'lab' }] } } }] }));
  writeFileSync(join(dir, 'guidance.json'), JSON.stringify({ claims: [{ id: 'rotten', subject: { kind: 'tool', name: 'Cursor' }, topic: 'context', sentence: 's', source_url: 'https://a.example/g', tier: 'tool', date: '2026-10-03', quote: 'this sentence left the page' }] }));
  writeFileSync(join(dir, 'plans.json'), JSON.stringify({ plans: [{ vendor: 'V', plan: 'Pro', source_url: 'https://a.example/p', quote: 'Pro $20/month' }] }));
  const pagesFile = join(dir, 'pages.json');
  writeFileSync(pagesFile, JSON.stringify({ 'https://a.example/m': '<p>It writes code well.</p>', 'https://a.example/g': '<p>The page moved on.</p>', 'https://a.example/p': '<p>Pro $25/month</p>' }));
  const script = fileURLToPath(new URL('./report-claim-rot.mjs', import.meta.url));
  const env = { ...process.env, REPORT_DATA_DIR: dir, CHECK_SOURCES_PAGES: pagesFile, DRY_RUN: 'true' };
  const r = spawnSync('node', [script], { encoding: 'utf8', env });
  assert.equal(r.status, 0, 'a report, never a gate');
  assert.match(r.stdout, /1\/3 claim\(s\) verified/);
  assert.match(r.stdout, /`data\/guidance\.json` \*\*Cursor\*\*/);
  assert.match(r.stdout, /`data\/plans\.json` \*\*V \/ Pro\*\*/);
  assert.doesNotMatch(r.stdout, /`data\/models\.json`/, 'the verified judged-fit quote is not listed');
});
