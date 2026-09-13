#!/usr/bin/env node
/* THROWAWAY audit helper for the tester registry (brain v2 step 1). NOT wired into any pipeline,
   NOT imported by anything else — reads scripts/naming.mjs and scripts/auto-refresh.mjs's existing
   exported helpers (read-only) rather than reinventing matching, and adds one thing neither of
   those already do: stripping the reasoning-effort / date-run suffixes that testers hang off a
   model's own name ("-max-effort", "-thinking-auto-high-effort", "-20251101", "_high") so a bare
   catalog name like "claude-fable-5" can still match "claude-fable-5-max-effort". Never edits
   naming.mjs or model-aliases.json — only reads them.

   Usage: node scripts/_audit/map-names.mjs <names.json>
     names.json: a plain JSON array of raw name/id strings pulled from one tester's feed.
   Prints: { feed_models, mapped_models, matches: [[raw, our_id]], unmapped_sample: [...] }
   "unmapped_sample" is the top 10 unmapped names whose slug shares a prefix with one of our
   catalog ids or names — i.e. plausible future alias candidates — never a guessed match.

   The effort/date-suffix stripping this file used to own locally now lives in
   scripts/naming.mjs (effortDateSuffixCandidates) — promoted so
   scripts/derive-standings.mjs's benchmark-row matching shares the same rule instead of a third
   copy. This file only reads it. */
import { readFileSync } from 'node:fs';
import { matchAlias, canonicalKey, stripProviderPrefix } from '../auto-refresh.mjs';
import { slug, effortDateSuffixCandidates } from '../naming.mjs';

const modelsFile = JSON.parse(readFileSync(new URL('../../data/models.json', import.meta.url)));
const aliases = JSON.parse(readFileSync(new URL('../model-aliases.json', import.meta.url)));
const models = modelsFile.models;

const namesPath = process.argv[2];
if (!namesPath) { console.error('usage: node map-names.mjs <names.json>'); process.exit(1); }
const rawNames = JSON.parse(readFileSync(namesPath, 'utf8'));

function baseCandidates(raw) {
  const s0 = slug(stripProviderPrefix(String(raw || '')));
  return effortDateSuffixCandidates(s0);
}

const catalogSlugs = models.map((m) => ({ id: m.id, s: slug(m.name) }));

function tryMatch(raw) {
  for (const cand of baseCandidates(raw)) {
    const hit = matchAlias(cand, models, aliases) || matchAlias(cand.replace(/-/g, ' '), models, aliases);
    if (hit) return hit;
    const exact = catalogSlugs.find((c) => c.s === cand || c.id === cand);
    if (exact) return exact.id;
  }
  return null;
}

const feedSlugs = [...new Set(rawNames.map((n) => slug(stripProviderPrefix(String(n || '')))))];
const matches = [];
const unmatched = [];
for (const raw of feedSlugs) {
  const hit = tryMatch(raw);
  if (hit) matches.push([raw, hit]);
  else unmatched.push(raw);
}

// "Looks like our catalog" = shares a slug prefix (>=5 chars) with some catalog id/name — a
// plausible future alias, never asserted as a match.
function looksLikeOurs(raw) {
  return catalogSlugs.some((c) => {
    const a = raw, b = c.s;
    const n = Math.min(a.length, b.length, 8);
    return n >= 5 && (a.slice(0, n) === b.slice(0, n));
  });
}

const unmappedSample = unmatched.filter(looksLikeOurs).slice(0, 10);

console.log(JSON.stringify({
  feed_models: feedSlugs.length,
  mapped_models: matches.length,
  matches,
  unmapped_sample: unmappedSample.length ? unmappedSample : unmatched.slice(0, 10),
}, null, 2));
