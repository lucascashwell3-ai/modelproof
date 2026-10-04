// R1-07: the installed text and the site print a claim's `sentence`, while check-sources.mjs only
// verifies its `quote`. So a sentence may say only what its quote says. This pins the KAT-Coder-Pro
// V2.5 claims that cite the results in the model's arXiv technical report (HTML version): an
// earlier wording once added a model version and a test setup its quote lacked. The rule is about
// the sentence and its quote, not the live page — check-sources.mjs is what reads the page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const DATA = JSON.parse(readFileSync(new URL('../data/models.json', import.meta.url), 'utf8'));
const KAT_REPORT = 'https://arxiv.org/html/2607.05471';

/** Problems with a sentence that says more than its quote: a number, or one of a few named
 * comparators / test setups, in the sentence but not in the quote. */
function sentenceOverreach(c) {
  const out = [];
  const said = c.sentence.replace(/\(checked \d{4}-\d{2}-\d{2}\)/, '').replace(/KAT-Coder-V2\.5/g, '');
  for (const n of said.match(/\d+(\.\d+)?/g) || []) if (!c.quote.includes(n)) out.push(`"${n}" is in the sentence but not the quote: ${c.sentence}`);
  for (const w of ['Opus 4.8', 'harness', 'Claude Code']) if (said.includes(w) && !c.quote.includes(w)) out.push(`"${w}" is in the sentence but not the quote: ${c.sentence}`);
  return out;
}

test('R1-07: the KAT-Coder-Pro V2.5 report sentences say only what their quotes say', () => {
  const kat = DATA.models.find((m) => m.id === 'kat-coder-pro-v2-5');
  assert.ok(kat, 'kat-coder-pro-v2-5 is in the catalog');
  const claims = Object.values(kat.task_fit_judged || {}).flatMap((e) => e.claims || []).filter((c) => c.source_url === KAT_REPORT);
  assert.ok(claims.length >= 2, 'a report claim is on file for coding and for agents');
  for (const c of claims) assert.deepEqual(sentenceOverreach(c), []);
});

test('R1-07: the rule catches a sentence that adds a number, a comparator or a setup', () => {
  const quote = 'SWE-Bench Pro 65.2 58.4 62.1 58.6 69.2';
  assert.deepEqual(sentenceOverreach({ sentence: 'The report lists 65.2 on SWE-Bench Pro against 69.2.', quote }), []);
  assert.equal(sentenceOverreach({ sentence: 'The report lists 65.2 on SWE-Bench Pro against 70.1.', quote }).length, 1);
  assert.ok(sentenceOverreach({ sentence: 'The report lists 65.2 against Opus 4.8.', quote }).some((p) => /Opus 4\.8/.test(p)));
  assert.ok(sentenceOverreach({ sentence: 'The report lists 65.2 in a Claude Code harness.', quote }).some((p) => /harness/.test(p)));
  // the checked date and the model's own version are not facts the quote has to carry
  assert.deepEqual(sentenceOverreach({ sentence: 'The KAT-Coder-V2.5 report (checked 2026-10-04) lists 65.2.', quote }), []);
});
