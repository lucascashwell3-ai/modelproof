import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  deriveStatus, deriveAdoption, deriveStatusAdoptionForCatalog, STATUS_VALUES, ADOPTION_VALUES,
} from './derive-status-adoption.mjs';

const ROOT = new URL('../', import.meta.url);
const models = JSON.parse(readFileSync(new URL('data/models.json', ROOT))).models;

test('deriveStatus: "(Preview)"/"preview" in the model\'s own name -> preview', () => {
  assert.equal(deriveStatus({ name: 'Gemini 3.1 Pro (Preview)' }).status, 'preview');
  assert.equal(deriveStatus({ name: 'Hy4 preview' }).status, 'preview');
});

test('deriveStatus: deprecated flag wins regardless of name', () => {
  assert.equal(deriveStatus({ name: 'Some GA Model', deprecated: true }).status, 'deprecated');
  assert.equal(deriveStatus({ name: 'Some Preview Model (Preview)', deprecated: true }).status, 'deprecated');
});

test('deriveStatus: no signal -> ga, and a name merely containing "review" is not a false-positive match', () => {
  assert.equal(deriveStatus({ name: 'GPT-6 Astra' }).status, 'ga');
  assert.equal(deriveStatus({ name: 'Some Overview Model' }).status, 'ga'); // "overview" must not match \bpreview\b
});

test('deriveAdoption: buckets share at exactly the documented thresholds', () => {
  assert.equal(deriveAdoption({ usage: { openrouter: { share: 2 } } }).adoption, 'broad');
  assert.equal(deriveAdoption({ usage: { openrouter: { share: 1.99 } } }).adoption, 'moderate');
  assert.equal(deriveAdoption({ usage: { openrouter: { share: 0.5 } } }).adoption, 'moderate');
  assert.equal(deriveAdoption({ usage: { openrouter: { share: 0.49 } } }).adoption, 'low');
  assert.equal(deriveAdoption({ usage: { openrouter: { share: 0 } } }).adoption, 'low');
});

test('deriveAdoption: no sourced share -> unknown, never a guessed bucket', () => {
  assert.equal(deriveAdoption({ usage: { openrouter: null } }).adoption, 'unknown');
  assert.equal(deriveAdoption({ usage: null }).adoption, 'unknown');
  assert.equal(deriveAdoption({}).adoption, 'unknown');
});

test('deriveStatusAdoptionForCatalog: every catalog model gets a valid status + adoption', () => {
  const derived = deriveStatusAdoptionForCatalog(models);
  assert.equal(derived.size, models.length);
  for (const m of models) {
    const d = derived.get(m.id);
    assert.ok(STATUS_VALUES.includes(d.status), `${m.id}: bad status "${d.status}"`);
    assert.ok(ADOPTION_VALUES.includes(d.adoption), `${m.id}: bad adoption "${d.adoption}"`);
  }
});

test('regression: gemini-3-1-pro is status=preview, adoption=low — the exact case the judged-ranking rewrite exists to fix', () => {
  const m = models.find((x) => x.id === 'gemini-3-1-pro');
  assert.ok(m, 'fixture assumption: gemini-3-1-pro is still in the catalog');
  const d = deriveStatus(m);
  const a = deriveAdoption(m);
  assert.equal(d.status, 'preview');
  assert.equal(a.adoption, 'low');
});

test('data/models.json: every model\'s stored status/adoption already matches the deriver (validate-data.mjs also gates this)', () => {
  const derived = deriveStatusAdoptionForCatalog(models);
  for (const m of models) {
    const d = derived.get(m.id);
    assert.equal(m.status, d.status, `${m.id}: stored status "${m.status}" != derived "${d.status}"`);
    assert.equal(m.adoption, d.adoption, `${m.id}: stored adoption "${m.adoption}" != derived "${d.adoption}"`);
  }
});
