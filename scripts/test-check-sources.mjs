import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeText, quoteFoundIn, collectClaims, collectGuidanceClaims, collectPlanClaims, collectAllClaims, selectClaims, skipClaims, checkClaims, parseArgs, classifyFailure, runFailed, fetchNormalizedPage, CACHE_MAX_AGE_MS } from './check-sources.mjs';

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
  assert.deepEqual(parseArgs(['--data', '/tmp/d', '--only', 'a/b,c', '--only=d']), { dataDir: '/tmp/d', only: ['a/b', 'c', 'd'], fresh: false, blockedOk: false, skipIds: [], jsonOut: null });
  assert.throws(() => parseArgs(['--ids', 'x']), /unknown argument/);
});

test('parseArgs: --fresh, --blocked-ok, --skip-ids (comma list, repeatable), --json-out', () => {
  assert.deepEqual(parseArgs(['--fresh', '--blocked-ok', '--skip-ids', 'guidance/a,b', '--skip-ids=c', '--json-out', '/tmp/r.json']),
    { dataDir: null, only: [], fresh: true, blockedOk: true, skipIds: ['guidance/a', 'b', 'c'], jsonOut: '/tmp/r.json' });
});

test('parseArgs: --blocked-ok is refused with --only (a write-time gate must read its page)', () => {
  assert.throws(() => parseArgs(['--only', 'm/coding', '--blocked-ok']), /cannot be combined with --only/);
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

// --- failure kinds: a vanished quote / a dead page are errors, a page we could not read is not ---
import { createHash } from 'node:crypto';
import { mkdirSync, utimesSync, readFileSync } from 'node:fs';

test('classifyFailure: 404/410 are gone; 403/429/5xx, timeouts, network errors, short bodies are blocked', () => {
  assert.equal(classifyFailure(Object.assign(new Error('HTTP 404'), { status: 404 })), 'gone');
  assert.equal(classifyFailure('HTTP 410'), 'gone');
  assert.equal(classifyFailure(new Error('HTTP 404 (not in pages.json)')), 'gone', 'status parsed from the message when not set');
  for (const s of [403, 429, 500, 502, 503]) assert.equal(classifyFailure(Object.assign(new Error(`HTTP ${s}`), { status: s })), 'blocked', `HTTP ${s}`);
  assert.equal(classifyFailure(new Error('timed out after 20s')), 'blocked');
  assert.equal(classifyFailure(new Error('network error (getaddrinfo ENOTFOUND)')), 'blocked');
  assert.equal(classifyFailure(new Error('page body too short after fetch (12 chars)')), 'blocked');
});

test('checkClaims: every result carries kind ok | not_found | gone | blocked', async () => {
  const pages = { 'https://p.example/ok': normalizeText('<p>loads the file at start</p>') };
  const fetchImpl = async (u) => {
    if (u === 'https://p.example/gone') throw Object.assign(new Error('HTTP 410'), { status: 410 });
    if (u === 'https://p.example/blocked') throw Object.assign(new Error('HTTP 403'), { status: 403 });
    return pages[u];
  };
  const claims = [
    { key: 'a', source_url: 'https://p.example/ok', quote: 'loads the file at start' },
    { key: 'b', source_url: 'https://p.example/ok', quote: 'this left the page' },
    { key: 'c', source_url: 'https://p.example/gone', quote: 'x' },
    { key: 'd', source_url: 'https://p.example/blocked', quote: 'x' },
    { key: 'e', source_url: null, quote: 'x' },
  ];
  const results = await checkClaims(claims, { fetchImpl });
  assert.deepEqual(results.map((r) => r.kind), ['ok', 'not_found', 'gone', 'blocked', 'not_found']);
  assert.deepEqual(results.map((r) => r.ok), [true, false, false, false, false]);
});

test('checkClaims: a blocked page is fetched once for every claim that cites it', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw Object.assign(new Error('HTTP 429'), { status: 429 }); };
  const results = await checkClaims([{ source_url: 'https://p.example/x', quote: 'a' }, { source_url: 'https://p.example/x', quote: 'b' }], { fetchImpl });
  assert.equal(calls, 1);
  assert.ok(results.every((r) => r.kind === 'blocked'));
});

test('runFailed: default mode fails on any failure; --blocked-ok fails only on not_found / gone', () => {
  const r = (kind) => ({ ok: kind === 'ok', kind });
  assert.equal(runFailed([r('ok'), r('blocked')]), true, 'default stays strict (apply-judgment relies on it)');
  assert.equal(runFailed([r('ok'), r('blocked')], { blockedOk: true }), false);
  assert.equal(runFailed([r('blocked'), r('not_found')], { blockedOk: true }), true);
  assert.equal(runFailed([r('gone')], { blockedOk: true }), true);
  assert.equal(runFailed([r('ok')]), false);
});

test('superseded claims are never collected (guidance and judged fit)', () => {
  const g = { claims: [{ ...GUIDANCE.claims[0], superseded_by: 'tool-a-2' }, { ...GUIDANCE.claims[0], id: 'tool-a-2', quote: 'new words' }] };
  assert.deepEqual(collectGuidanceClaims(g).map((c) => c.claimId), ['tool-a-2']);
  const models = { models: [{ id: 'm', name: 'M', task_fit_judged: { coding: { claims: [
    { source_url: 'https://a.example', quote: 'old', tier: 'lab', superseded_by: 'x' },
    { source_url: 'https://a.example', quote: 'new', tier: 'lab' },
  ] } } }] };
  assert.deepEqual(collectClaims(models).map((c) => c.quote), ['new']);
});

test('skipClaims: by key, by key prefix, by bare guidance claim id; the rest stay', () => {
  const all = collectAllClaims({ guidance: GUIDANCE, plans: PLANS });
  const { claims, skipped } = skipClaims(all, ['lab-b', 'plan/Devin']);
  assert.deepEqual(skipped.map((c) => c.key), ['guidance/lab-b', 'plan/Devin/Teams']);
  assert.deepEqual(claims.map((c) => c.key), ['guidance/tool-a', 'plan/GitHub Copilot/Pro']);
  assert.equal(skipClaims(all, []).claims.length, all.length);
});

test('fetchNormalizedPage: a cached page is reused for at most 12 h; --fresh always refetches', async () => {
  const url = `https://cache-test.example/${process.pid}-${Date.now()}`;
  const dir = join(tmpdir(), 'modelproof-check-sources-cache');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${createHash('sha1').update(url).digest('hex')}.txt`);
  writeFileSync(file, 'cached copy');
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return { ok: true, status: 200, text: async () => `<p>${'fresh page text '.repeat(20)}</p>` }; };
  try {
    assert.equal(await fetchNormalizedPage(url, { fresh: false }), 'cached copy');
    assert.equal(calls, 0, 'a young cache entry is reused');
    assert.match(await fetchNormalizedPage(url, { fresh: true }), /fresh page text/);
    assert.equal(calls, 1, '--fresh skips the cache');
    writeFileSync(file, 'cached copy');
    const old = (Date.now() - CACHE_MAX_AGE_MS - 60_000) / 1000;
    utimesSync(file, old, old);
    assert.match(await fetchNormalizedPage(url, { fresh: false }), /fresh page text/);
    assert.equal(calls, 2, 'an entry older than 12 h is fetched again');
    assert.equal(CACHE_MAX_AGE_MS, 12 * 60 * 60 * 1000);
    globalThis.fetch = async () => ({ ok: false, status: 403, text: async () => '' });
    await assert.rejects(fetchNormalizedPage(`${url}/403`, { fresh: true }), (e) => e.status === 403 && classifyFailure(e) === 'blocked');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('CLI modes: default fails on a blocked page; --blocked-ok passes it as a warning but still fails a vanished quote; --only stays strict', () => {
  const dir = mkdtempSync(join(tmpdir(), 'check-sources-modes-'));
  const models = { models: [{ id: 'm', name: 'M', task_fit_judged: { coding: { claims: [{ source_url: 'https://a.example/m', quote: 'writes code well', tier: 'lab' }] } } }] };
  const guidance = { claims: [
    { id: 'walled', subject: { kind: 'tool', name: 'Cursor' }, topic: 'context', sentence: 's', source_url: 'https://a.example/403', tier: 'tool', date: '2026-10-03', quote: 'anything' },
    { id: 'old', subject: { kind: 'tool', name: 'Cursor' }, topic: 'context', sentence: 's', source_url: 'https://a.example/m', tier: 'tool', date: '2026-10-03', quote: 'left the page', superseded_by: 'new' },
  ] };
  writeFileSync(join(dir, 'models.json'), JSON.stringify(models));
  writeFileSync(join(dir, 'guidance.json'), JSON.stringify(guidance));
  const pagesFile = join(dir, 'pages.json');
  writeFileSync(pagesFile, JSON.stringify({ 'https://a.example/m': '<p>It writes code well.</p>', 'https://a.example/403': 403 }));
  const script = fileURLToPath(new URL('./check-sources.mjs', import.meta.url));
  const run = (...args) => spawnSync('node', [script, '--data', dir, ...args], { encoding: 'utf8', env: { ...process.env, CHECK_SOURCES_PAGES: pagesFile } });
  assert.equal(run().status, 1, 'default mode: a blocked page fails (unchanged behavior)');
  const ok = run('--blocked-ok');
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /⚠ Cursor \/ context \(walled\)/);
  assert.match(ok.stdout, /verifying 2 claim\(s\)/, 'the superseded claim is not checked');
  assert.equal(run('--only', 'guidance/walled').status, 1, '--only: a blocked page is an error');
  assert.equal(run('--only', 'guidance/walled', '--blocked-ok').status, 1, '--only with --blocked-ok is refused');
  assert.equal(run('--skip-ids', 'walled').status, 0, 'a skipped claim is not checked');
  const out = join(dir, 'results.json');
  run('--blocked-ok', '--json-out', out);
  const json = JSON.parse(readFileSync(out, 'utf8'));
  assert.deepEqual(json.results.map((r) => r.kind).sort(), ['blocked', 'ok']);
  writeFileSync(pagesFile, JSON.stringify({ 'https://a.example/m': '<p>The page moved on.</p>', 'https://a.example/403': 403 }));
  assert.equal(run('--blocked-ok').status, 1, '--blocked-ok: a vanished quote still fails');
  writeFileSync(pagesFile, JSON.stringify({ 'https://a.example/403': 403 }));
  assert.equal(run('--blocked-ok').status, 1, '--blocked-ok: a 404 page (gone) still fails');
});

// --- report-claim-rot.mjs: rot and blocked are listed apart; blocked alone never keeps the issue open
import { splitResults, reportLines, reportIssue, ISSUE_TITLE } from './report-claim-rot.mjs';

const RES = (kind, extra = {}) => ({ ok: kind === 'ok', kind, file: 'guidance', modelName: 'Cursor', taskId: 'context', tier: 'tool', source_url: `https://a.example/${kind}`, reason: kind === 'ok' ? null : `${kind} reason`, ...extra });

test('splitResults: not_found and gone are rot, blocked is apart; a failed result without a kind is rot', () => {
  const s = splitResults([RES('ok'), RES('not_found'), RES('gone'), RES('blocked'), { ok: false, reason: 'old file' }]);
  assert.equal(s.verified.length, 1);
  assert.equal(s.rot.length, 3);
  assert.equal(s.blocked.length, 1);
});

test('reportLines: separate sections for rot, could-not-read and skipped', () => {
  const text = reportLines({ results: [RES('ok'), RES('not_found'), RES('blocked')], skipped: ['guidance/x'] }).join('\n');
  assert.match(text, /1\/3 claim\(s\) verified/);
  assert.match(text, /Rotted: 1\. Could not read: 1\. Skipped \(pending\): 1\./);
  assert.match(text, /## Rotted[\s\S]*not_found reason[\s\S]*## Could not read[\s\S]*blocked reason[\s\S]*## Skipped[\s\S]*guidance\/x/);
});

function fakeIssues(open) {
  const state = { issues: open, writes: [] };
  state.fetchImpl = async (url, init = {}) => {
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    const ok = (v) => ({ ok: true, status: 200, json: async () => v, text: async () => '' });
    if (method === 'GET') return ok(new URL(url).searchParams.get('page') === '1' ? state.issues.filter((i) => i.state === 'open') : []);
    state.writes.push({ method, path: new URL(url).pathname, body });
    const m = new URL(url).pathname.match(/\/issues\/(\d+)$/);
    if (m) { Object.assign(state.issues.find((i) => i.number === Number(m[1])), body); return ok({}); }
    const created = { number: 50, state: 'open', ...body };
    state.issues.push(created);
    return ok(created);
  };
  return state;
}
const LIVE_ENV = { GH_TOKEN: 't', GITHUB_REPOSITORY: 'acme/site', GITHUB_REF: 'refs/heads/main' };

test('reportIssue: blocked pages alone close the issue (legacy title included); rot opens it', async () => {
  const gh = fakeIssues([{ number: 35, state: 'open', title: 'Judged claims no longer verifiable', body: 'x' }]);
  const o = { env: LIVE_ENV, fetchImpl: gh.fetchImpl, log: () => {} };
  assert.equal((await reportIssue(splitResults([RES('blocked')]), o)).action, 'closed');
  assert.equal(gh.issues[0].state, 'closed');
  const r = await reportIssue(splitResults([RES('gone'), RES('blocked')]), o);
  assert.equal(r.action, 'created');
  const made = gh.issues.find((i) => i.number === 50);
  assert.equal(made.title, ISSUE_TITLE);
  assert.match(made.body, /## Rotted \(1\)[\s\S]*## Could not read from the runner \(1\)/);
});

test('report-claim-rot --results reads a check-sources --json-out file instead of fetching', () => {
  const dir = mkdtempSync(join(tmpdir(), 'claim-rot-results-'));
  const file = join(dir, 'results.json');
  writeFileSync(file, JSON.stringify({ results: [RES('ok'), RES('blocked')], skipped: [] }));
  const script = fileURLToPath(new URL('./report-claim-rot.mjs', import.meta.url));
  const r = spawnSync('node', [script, '--results', file], { encoding: 'utf8', env: { ...process.env, DRY_RUN: 'true', CHECK_SOURCES_PAGES: join(dir, 'missing.json') } });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /1\/2 claim\(s\) verified/);
  assert.match(r.stdout, /Rotted: 0\. Could not read: 1\./);
});
