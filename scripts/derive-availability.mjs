#!/usr/bin/env node
/* Per-model availability derivation — engine round 2, availability + plans.
   Answers "where can I actually reach this model?" alongside the existing price/benchmark
   facts. Runs as a step inside Collect (scripts/auto-refresh.mjs), reusing the OpenRouter feed
   Collect already fetches, plus one extra fetch of AWS's public Price List API (no key needed).

   Every field is a fact traced to a source URL, or null — never a guess (same honesty rule as
   the rest of data/models.json; see scripts/data-sources.md). Two fields are deliberately
   true-or-null, never false, because the check that would produce a "false" is a fuzzy
   name/URL match, not a definitive lookup: getting a false "not available" wrong is worse than
   leaving it blank.
     - direct_api: a vendor not matched here might still sell API access — we just have no
       stored pricing-page URL for it yet.
     - aws_bedrock: absence from the AWS Price List API's model names could be a naming
       mismatch, not real absence.
     - open_weights: same reasoning, doubly so — most vendors are closed by default.
   `openrouter` is the one field allowed to be a definite false: the OpenRouter models list is a
   complete live snapshot, membership is an exact id/alias match (the same one Collect already
   uses for price facts), so absence is a real, checked fact, not a guess.

   A field already true from a prior run is never regressed to null/false by a run that simply
   couldn't re-derive it this time (a failed fetch, a renamed vendor field) — see
   deriveAvailabilityForModel's `prev` handling. Matches the "fill blanks, don't overwrite a
   published fact" rule in scripts/data-sources.md.

   Usage: node scripts/derive-availability.mjs [--dry-run]   (standalone run/preview)
   Also imported by scripts/auto-refresh.mjs as part of the full Collect pass.
*/
import { readFileSync, writeFileSync } from 'node:fs';
import { normalize, matchAlias } from './auto-refresh.mjs';

export const OR_URL = 'https://openrouter.ai/api/v1/models';
// The AWS Price List API is public, unauthenticated, machine-readable JSON — unlike the Bedrock
// "list models" API (requires signed AWS credentials) or the models-supported docs page (HTML
// table, no stable structure). us-east-1 is Bedrock's most complete region for model rollout.
export const AWS_BEDROCK_PRICE_URL = 'https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrock/current/us-east-1/index.json';

// ---------------------------------------------------------------------------------------------
// direct_api: vendor -> known pricing-page domain(s), built from the domains already present in
// data/models.json's own sources[]/price_checked.url for that vendor group (2026-09-06 survey).
// ---------------------------------------------------------------------------------------------
export const VENDOR_DOMAINS = {
  anthropic: ['anthropic.com', 'claude.com'],
  openai: ['openai.com'],
  google: ['google.com', 'google.dev', 'deepmind.google'],
  xai: ['x.ai'],
  mistral: ['mistral.ai'],
  deepseek: ['deepseek.com'],
  moonshot: ['moonshot.ai', 'moonshot.cn', 'kimi.ai', 'kimi.com'],
  alibaba: ['alibabacloud.com', 'aliyun.com', 'qwencloud.com', 'qwen.ai', 'qwenlm.ai'],
  zai: ['z.ai', 'bigmodel.cn'],
};

/** Map a catalog vendor string (inconsistent casing/parens across the file) to one of the
 * direct_api-sourceable groups above, or null if it isn't one of the vendors this v1 covers. */
export function vendorGroup(vendor) {
  const v = String(vendor || '').toLowerCase().replace(/\(.*?\)/g, '').replace(/^~/, '').trim();
  if (!v) return null;
  if (v.includes('anthropic')) return 'anthropic';
  if (v.includes('openai')) return 'openai';
  if (v.includes('google')) return 'google';
  if (v === 'xai' || v === 'x-ai' || v === 'x.ai') return 'xai';
  if (v.includes('mistral')) return 'mistral';
  if (v.includes('deepseek')) return 'deepseek';
  if (v.includes('moonshot')) return 'moonshot';
  if (v.includes('alibaba') || v.includes('qwen')) return 'alibaba';
  if (v.includes('z.ai') || v.includes('zhipu') || v === 'zai') return 'zai';
  return null;
}

/** Does `url`'s host belong to vendor `group` (exact host or any subdomain)? */
export function urlMatchesVendorGroup(url, group) {
  if (!url || !group) return false;
  const domains = VENDOR_DOMAINS[group];
  if (!domains) return false;
  let host;
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { return false; }
  return domains.some((d) => host === d || host.endsWith('.' + d));
}

/** First URL already stored on `model` (price_checked.url, then sources[] in order) that
 * belongs to its own vendor's domain — i.e. a pricing/model page the vendor itself published. */
export function findVendorSourceUrl(model) {
  const group = vendorGroup(model.vendor);
  if (!group) return null;
  const pcUrl = model.price_checked?.url;
  if (pcUrl && urlMatchesVendorGroup(pcUrl, group)) return pcUrl;
  for (const u of model.sources || []) {
    if (urlMatchesVendorGroup(u, group)) return u;
  }
  return null;
}

/** direct_api: true+source only for the vendors known to sell API access, and only when we
 * already have one of their own URLs on file; null otherwise (never a guessed false). */
export function deriveDirectApi(model) {
  const url = findVendorSourceUrl(model);
  return url ? { value: true, source: url } : { value: null, source: null };
}

const OPEN_WEIGHT_TEXT_RE = /open[- ]weights?/i;

/** open_weights: true if OpenRouter's entry for this model carries a Hugging Face id, or the
 * catalog's own prose (verdict/strengths/weaknesses/best_for) already says "open weight(s)";
 * else null — never false, because most vendors simply don't publish weights and a name-match
 * miss on OpenRouter proves nothing either way. */
export function deriveOpenWeights(model, orMatch) {
  if (orMatch?.hfId) return true;
  const text = [model.verdict, ...(model.strengths || []), ...(model.weaknesses || []), ...(model.best_for || [])]
    .filter(Boolean).join(' \n ');
  if (OPEN_WEIGHT_TEXT_RE.test(text)) return true;
  return null;
}

/** openrouter: a definite true/false — OpenRouter's list is a complete live snapshot and
 * membership is the exact match Collect already uses for price facts, so absence is real. Only
 * null when the feed itself couldn't be checked this run (network failure). */
export function deriveOpenRouterFlag(orMatch, orFeedOk) {
  if (!orFeedOk) return null;
  return !!orMatch;
}

/** Find the OpenRouter feed entry (as produced by auto-refresh.mjs's feedOpenRouter(), which
 * must carry `hfId`) matching `model`, via the same id/name/alias matching Collect uses for
 * price facts — one matching rule for the whole pipeline, not a second copy that could drift. */
export function findOrMatch(model, orList, aliases) {
  return orList.find((c) => matchAlias(c.name, [model], aliases) === model.id || matchAlias(c.id, [model], aliases) === model.id) || null;
}

// ---------------------------------------------------------------------------------------------
// aws_bedrock — AWS Price List API
// ---------------------------------------------------------------------------------------------

// AWS's SKU `model` attribute prefixes a handful of vendors with a dotted or hyphenated route
// ("xai.grok-4.6", "google.gemma-3-4b-it") the way OpenRouter/LiteLLM prefix with a slash — but
// auto-refresh.mjs's own canonicalKey() strips ONLY the slash/dot form (it's tuned for those two
// feeds), so "xai.grok-4.6" -> "grok46" while our catalog id "x-ai-grok-4-6" -> "xaigrok46" don't
// collapse to the same key. This strips the same vendor token on any of /  .  -  _ instead.
const BEDROCK_VENDOR_PREFIX = /^(anthropic|openai|google|gemini|vertex_ai|bedrock|xai|x-ai|meta-llama|meta|mistralai|mistral|deepseek|qwen|alibaba|moonshot|zai|z-ai)[/.\-_]/i;

/** Normalize a name/id for exact cross-source comparison against the AWS Price List API. */
export const bedrockKey = (s) => normalize(String(s || '').replace(BEDROCK_VENDOR_PREFIX, ''));

/** Fetch AWS's public (unauthenticated) Price List API for Bedrock and return the set of
 * normalized model identifiers it lists (from each SKU's `attributes.model`), or null if the
 * fetch failed — callers must treat null as "couldn't check this run", not "nothing found". */
export async function fetchBedrockModelKeys(url = AWS_BEDROCK_PRICE_URL, fetchImpl = fetch) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20000);
    let json;
    try {
      const res = await fetchImpl(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      json = await res.json();
    } finally {
      clearTimeout(t);
    }
    const keys = new Set();
    for (const product of Object.values(json.products || {})) {
      const name = product?.attributes?.model;
      if (name) keys.add(bedrockKey(name));
    }
    return keys;
  } catch (e) {
    console.log(`availability: AWS Bedrock price list unreachable (${e.message}) — skipping.`);
    return null;
  }
}

/** aws_bedrock: true+source only on an exact id/name match against the live AWS list; null
 * (never false) when unmatched or when the fetch failed — see module doc comment for why. */
export function deriveAwsBedrock(model, bedrockKeys) {
  if (!bedrockKeys) return { value: null, matched: false };
  const matched = bedrockKeys.has(bedrockKey(model.name)) || bedrockKeys.has(bedrockKey(model.id));
  return matched ? { value: true, matched: true } : { value: null, matched: false };
}

// ---------------------------------------------------------------------------------------------
// merge — combine this run's derivations with whatever the model already had, never regressing
// a previously-established true/false to null just because this run couldn't re-check it.
// ---------------------------------------------------------------------------------------------

/**
 * Compute the full `availability` object for one model.
 * ctx: { orList, aliases, orFeedOk, bedrockKeys }
 *   orFeedOk    — did the OpenRouter fetch succeed this run (orList may legitimately be [] only
 *                 when it failed; an empty *result* after a successful fetch can't happen since
 *                 OpenRouter always lists hundreds of models).
 *   bedrockKeys — Set from fetchBedrockModelKeys(), or null if that fetch failed/was skipped.
 */
export function deriveAvailabilityForModel(model, ctx) {
  const { orList = [], aliases = {}, orFeedOk = false, bedrockKeys = null } = ctx || {};
  const prev = model.availability || {};
  const sources = new Set(prev.sources || []);

  const orMatch = orFeedOk ? findOrMatch(model, orList, aliases) : null;
  if (orFeedOk) sources.add(OR_URL);
  const openrouter = orFeedOk ? deriveOpenRouterFlag(orMatch, true) : (prev.openrouter ?? null);

  const direct = deriveDirectApi(model);
  if (direct.source) sources.add(direct.source);
  const direct_api = direct.value ?? (prev.direct_api ?? null);

  const openWeightsNow = deriveOpenWeights(model, orMatch);
  const open_weights = openWeightsNow ?? (prev.open_weights ?? null);

  const bedrock = deriveAwsBedrock(model, bedrockKeys);
  if (bedrock.matched) sources.add(AWS_BEDROCK_PRICE_URL);
  const aws_bedrock = bedrock.value ?? (prev.aws_bedrock ?? null);

  return {
    direct_api,
    openrouter,
    aws_bedrock,
    // v1 = always null, no automated derivation method found within budget — see
    // scripts/data-sources.md "Availability sourcing gaps" for the candidate URLs tried.
    google_vertex: prev.google_vertex ?? null,
    azure: prev.azure ?? null,
    open_weights,
    eu_hosting: prev.eu_hosting ?? null,
    sources: Array.from(sources).sort(),
  };
}

/** Cheap structural equality for deciding whether a model's availability actually changed
 * (arrays compared as sorted, order-independent). */
export function availabilityEquals(a, b) {
  if (!a || !b) return a === b;
  const keys = ['direct_api', 'openrouter', 'aws_bedrock', 'google_vertex', 'azure', 'open_weights', 'eu_hosting'];
  if (keys.some((k) => (a[k] ?? null) !== (b[k] ?? null))) return false;
  const as = [...(a.sources || [])].sort();
  const bs = [...(b.sources || [])].sort();
  return as.length === bs.length && as.every((v, i) => v === bs[i]);
}

// ---------------------------------------------------------------------------------------------
// standalone runner — lets this be previewed/tested outside a full Collect run
// ---------------------------------------------------------------------------------------------

async function feedOpenRouterStandalone() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20000);
    let json;
    try {
      const res = await fetch(OR_URL, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      json = await res.json();
    } finally { clearTimeout(t); }
    return (json.data || []).map((o) => ({ source: 'openrouter', id: o.id, name: o.name, hfId: o.hugging_face_id ?? null }));
  } catch (e) {
    console.log(`availability: OpenRouter unreachable (${e.message}) — skipping.`);
    return [];
  }
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const ROOT = new URL('../', import.meta.url);
  const dataUrl = new URL('data/models.json', ROOT);
  const aliasUrl = new URL('scripts/model-aliases.json', ROOT);
  const data = JSON.parse(readFileSync(dataUrl));
  const aliases = JSON.parse(readFileSync(aliasUrl));

  console.log('availability: fetching OpenRouter + AWS Bedrock price list...');
  const orList = await feedOpenRouterStandalone();
  const orFeedOk = orList.length > 0;
  const bedrockKeys = await fetchBedrockModelKeys();

  let changed = 0;
  const counts = { direct_api: 0, openrouter: 0, aws_bedrock: 0, open_weights: 0 };
  for (const m of data.models) {
    const next = deriveAvailabilityForModel(m, { orList, aliases, orFeedOk, bedrockKeys });
    if (!availabilityEquals(m.availability, next)) changed++;
    m.availability = next;
    if (next.direct_api) counts.direct_api++;
    if (next.openrouter) counts.openrouter++;
    if (next.aws_bedrock) counts.aws_bedrock++;
    if (next.open_weights) counts.open_weights++;
  }

  console.log(`availability: ${data.models.length} models processed, ${changed} changed.`);
  console.log(`availability: direct_api=${counts.direct_api} openrouter=${counts.openrouter} aws_bedrock=${counts.aws_bedrock} open_weights=${counts.open_weights}`);

  if (!dryRun) {
    writeFileSync(dataUrl, JSON.stringify(data, null, 2) + '\n');
    console.log('availability: data/models.json written.');
  } else {
    console.log('availability: --dry-run, nothing written.');
  }
}

import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
const isMain = (() => {
  if (!process.argv[1]) return false;
  try { return fileURLToPath(import.meta.url) === realpathSync(resolve(process.argv[1])); }
  catch { return fileURLToPath(import.meta.url) === process.argv[1]; }
})();
if (isMain) {
  main().catch((e) => { console.error(e); process.exitCode = 1; });
}
