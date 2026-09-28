// R1-07: the installed text and the site print a claim's `sentence`, while check-sources.mjs only
// verifies its `quote`. So a sentence may say only what its quote says. This pins the re-sourced
// KAT-Coder-Pro V2.5 claims (MarkTechPost write-up) that once added a model version and a test
// setup their quotes lack.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const DATA = JSON.parse(readFileSync(new URL('../data/models.json', import.meta.url), 'utf8'));
const KAT_REPORT = 'https://www.marktechpost.com/2026/07/26/kwaikat-team-releases-kat-coder-v2-5-an-agentic-coding-model-trained-on-100000-verifiable-repository-environments/';

test('R1-07: the re-sourced KAT-Coder-Pro V2.5 sentences say only what their quotes say', () => {
  const kat = DATA.models.find((m) => m.id === 'kat-coder-pro-v2-5');
  assert.ok(kat, 'kat-coder-pro-v2-5 is in the catalog');
  const claims = Object.values(kat.task_fit_judged || {}).flatMap((e) => e.claims || []).filter((c) => c.source_url === KAT_REPORT);
  assert.ok(claims.length >= 2, 'both re-sourced claims are on file');
  for (const c of claims) {
    const said = c.sentence.replace(/\(checked \d{4}-\d{2}-\d{2}\)/, '').replace(/KAT-Coder-V2\.5/g, '');
    for (const n of said.match(/\d+(\.\d+)?/g) || []) assert.ok(c.quote.includes(n), `"${n}" is in the sentence but not the quote: ${c.sentence}`);
    for (const w of ['Opus 4.8', 'harness', 'Claude Code']) {
      if (said.includes(w)) assert.ok(c.quote.includes(w), `"${w}" is in the sentence but not the quote: ${c.sentence}`);
    }
  }
});
