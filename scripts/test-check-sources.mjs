import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeText, quoteFoundIn, collectClaims, collectGuidanceClaims, checkClaims } from './check-sources.mjs';

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
