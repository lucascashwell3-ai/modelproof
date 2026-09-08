import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  deriveStatus, deriveAdoption, deriveStatusAdoptionForCatalog, STATUS_VALUES, ADOPTION_VALUES,
  daysSinceRelease, RECENCY_WINDOW_DAYS,
} from './derive-status-adoption.mjs';

const ROOT = new URL('../', import.meta.url);
const catalogData = JSON.parse(readFileSync(new URL('data/models.json', ROOT)));
const models = catalogData.models;
const AS_OF = catalogData.as_of;

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
  const derived = deriveStatusAdoptionForCatalog(models, AS_OF);
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
  const a = deriveAdoption(m, AS_OF);
  assert.equal(d.status, 'preview');
  assert.equal(a.adoption, 'low');
  assert.equal(m.released, '2026', 'fixture assumption: released is year-only, so the 60-day recency rule can never fire for it (see the "only a year" test below)');
});

test('data/models.json: every model\'s stored status/adoption already matches the deriver (validate-data.mjs also gates this)', () => {
  const derived = deriveStatusAdoptionForCatalog(models, AS_OF);
  for (const m of models) {
    const d = derived.get(m.id);
    assert.equal(m.status, d.status, `${m.id}: stored status "${m.status}" != derived "${d.status}"`);
    assert.equal(m.adoption, d.adoption, `${m.id}: stored adoption "${m.adoption}" != derived "${d.adoption}"`);
  }
});

// -------------------------------------------------------------------------------------------
// 60-day recency rule (2026-09-07): a model released within RECENCY_WINDOW_DAYS days of the data
// snapshot's own as_of gets adoption 'new' instead of 'low'/'unknown' — see the file header and
// deriveAdoption's own comment for the full rationale (claude-fable-5-1 was the bug this fixes:
// 0.26% share, 6 days old, wrongly bucketed 'low' and demoted below older models it should not
// have been demoted below).
// -------------------------------------------------------------------------------------------
test('daysSinceRelease: a full YYYY-MM-DD released date against a full YYYY-MM-DD as_of', () => {
  assert.equal(daysSinceRelease('2026-09-01', '2026-09-07'), 6);
  assert.equal(daysSinceRelease('2026-07-09', '2026-09-07'), 60);
  assert.equal(daysSinceRelease('2026-07-08', '2026-09-07'), 61);
});

test('daysSinceRelease: null for anything short of a full YYYY-MM-DD on either side — never a guess', () => {
  assert.equal(daysSinceRelease('2026', '2026-09-07'), null, 'year-only');
  assert.equal(daysSinceRelease('2026-07', '2026-09-07'), null, 'month-only');
  assert.equal(daysSinceRelease('2026-Q1', '2026-09-07'), null, 'quarter');
  assert.equal(daysSinceRelease('unknown', '2026-09-07'), null, 'the literal string "unknown"');
  assert.equal(daysSinceRelease(null, '2026-09-07'), null, 'no released date at all');
  assert.equal(daysSinceRelease(undefined, '2026-09-07'), null, 'released field entirely absent');
  assert.equal(daysSinceRelease('2026-09-01', '2026'), null, 'as_of itself must also be a full date');
});

test('deriveAdoption: released within the 60-day window overrides an otherwise-"low" share to "new", not "low"', () => {
  const m = { released: '2026-09-01', usage: { openrouter: { share: 0.26 } } };
  assert.equal(deriveAdoption(m, '2026-09-07').adoption, 'new');
  assert.equal(deriveAdoption(m, '2026-09-07').share, 0.26, 'the raw share is still surfaced even under the "new" override');
});

test('deriveAdoption: released within the 60-day window overrides an otherwise-"unknown" (no share at all) to "new"', () => {
  const m = { released: '2026-09-01', usage: { openrouter: null } };
  assert.equal(deriveAdoption(m, '2026-09-07').adoption, 'new');
});

test('deriveAdoption: the 60-day override never touches an already-"broad"/"moderate" share — recency only rescues a thin reading, it never overrides a good one', () => {
  const broad = { released: '2026-09-01', usage: { openrouter: { share: 11.21 } } };
  assert.equal(deriveAdoption(broad, '2026-09-07').adoption, 'broad');
  const moderate = { released: '2026-09-01', usage: { openrouter: { share: 1.5 } } };
  assert.equal(deriveAdoption(moderate, '2026-09-07').adoption, 'moderate');
});

test('deriveAdoption: exactly RECENCY_WINDOW_DAYS days old is still "new"; one day older is not', () => {
  assert.equal(RECENCY_WINDOW_DAYS, 60);
  const atBoundary = { released: '2026-07-09', usage: { openrouter: { share: 0.1 } } };
  assert.equal(deriveAdoption(atBoundary, '2026-09-07').adoption, 'new');
  const pastBoundary = { released: '2026-07-08', usage: { openrouter: { share: 0.1 } } };
  assert.equal(deriveAdoption(pastBoundary, '2026-09-07').adoption, 'low');
});

test('deriveAdoption: a released date with only a year is treated as unknown recency, never "new"', () => {
  const yearOnly = { released: '2026', usage: { openrouter: null } };
  assert.equal(deriveAdoption(yearOnly, '2026-09-07').adoption, 'unknown');
  const yearOnlyLowShare = { released: '2026', usage: { openrouter: { share: 0.1 } } };
  assert.equal(deriveAdoption(yearOnlyLowShare, '2026-09-07').adoption, 'low');
});

test('deriveAdoption: omitting asOf entirely falls back to plain share-based bucketing, no recency check at all', () => {
  const m = { released: '2026-09-01', usage: { openrouter: { share: 0.1 } } };
  assert.equal(deriveAdoption(m).adoption, 'low');
});

test('regression: claude-fable-5-1 is adoption=new (not "low") — the exact bug the 60-day rule fixes, and its low-adoption gate is never triggered by assets/decide.mjs', () => {
  const m = models.find((x) => x.id === 'claude-fable-5-1');
  assert.ok(m, 'fixture assumption: claude-fable-5-1 is still in the catalog');
  assert.equal(m.released, '2026-09-01');
  const a = deriveAdoption(m, AS_OF);
  assert.equal(a.adoption, 'new');
  assert.notEqual(a.adoption, 'low');
});
