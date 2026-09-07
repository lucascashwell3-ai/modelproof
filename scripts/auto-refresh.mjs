#!/usr/bin/env node
/* Collect v1.1 (automation/PIPELINE_V1.md "Modelproof refresh — v1.1"). Publishes facts, not
   proposals; hands anything it can't settle to worklist.json for the cloud Judge routine.
   Stages: feed -> check -> publish -> worklist -> report. See automation/jobs/auto-refresh/README.md.

   feed:     OpenRouter models API + LiteLLM price table (both Tier-A, public, no key) + Epoch
             (via scripts/collect-epoch.mjs, reused as a module)
   check:    deterministic rules decide what counts as a fact (see FACT RULES below). No LLM
             judgment here — that layer moved to the Judge cloud routine (scripts/refresh-judge.md).
   publish:  writes data/models.json + data/changelog.json, then runs the honesty gate.
   worklist: writes data/refresh/worklist.json — conflicts, new-model/benchmark/ladder/release
             candidates the Judge should research, capped at 15, priority-ordered.
   report:   writes data/refresh/receipt-collect.json and prints applied/held/worklist counts.

   Usage:
     node scripts/auto-refresh.mjs [--dry-run]
   Env:
     GH_TOKEN  required in CI to file/close the review issue (workflow_dispatch works without
               it locally; the script just skips the issue step).
*/
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isNotablePriceChange, priceEntry, addEntry } from './timeline.mjs';
import { deriveAvailabilityForModel, availabilityEquals, fetchBedrockModelKeys } from './derive-availability.mjs';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../', import.meta.url);
const dataUrl = new URL('data/models.json', ROOT);
const changelogUrl = new URL('data/changelog.json', ROOT);
const aliasUrl = new URL('scripts/model-aliases.json', ROOT);
const stateUrl = new URL('data/_auto_refresh_state.json', ROOT);
const worklistUrl = new URL('data/refresh/worklist.json', ROOT);
const receiptUrl = new URL('data/refresh/receipt-collect.json', ROOT);

const MAX_WORKLIST = 15;
const WORKLIST_PRIORITY = { 'new-model': 0, conflict: 1, deprecation: 2, benchmark: 3, ladder: 4, release: 5, guidance: 6 };
// Usage guidance (best_for + use_well) is what the advisor skill ranks on; Collect can't write
// prose, so blank models rotate through the Judge a few at a time. They get RESERVED slots
// inside the 15 — a live dry-run (2026-08-22) showed ~45 higher-priority candidates every run,
// so "lowest priority" alone meant guidance would never reach the Judge. 24 of 49 were blank.
const GUIDANCE_PER_RUN = 3;

const OR_URL = 'https://openrouter.ai/api/v1/models';
const LITELLM_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const AGREEMENT_PCT = 0.02;      // sources must agree within 2%
const SANITY_HIGH = 5;           // >5x current holds for review
const SANITY_LOW = 0.2;          // <0.2x current holds for review
const KNOWN_VENDORS = new Set([
  'anthropic', 'openai', 'google', 'meta', 'mistral', 'mistral ai', 'xai', 'x-ai', 'x.ai',
  'deepseek', 'alibaba', 'qwen', 'amazon', 'cohere', 'moonshot', 'moonshot ai',
]);

// ---------------------------------------------------------------------------------------------
// pure helpers (unit tested in scripts/test-auto-refresh.mjs)
// ---------------------------------------------------------------------------------------------

export const normalize = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Strip OpenRouter/LiteLLM mode suffixes ("(Fast)", "(batch)", ": free") — same model, different tier. */
export const stripVariantSuffix = (s) => String(s || '').replace(/\s*\((fast|batch|preview)\)\s*/gi, '').trim();

// LiteLLM (and some OpenRouter) keys prefix the vendor/routing path: "anthropic/claude-opus-5",
// "vertex_ai/gemini-3.5-flash", "bedrock/anthropic.claude-opus-5-v1:0". Strip it before comparing.
const PROVIDER_PREFIX = /^(anthropic|openai|google|gemini|vertex_ai|bedrock|xai|x-ai|meta-llama|mistralai|deepseek)[/.]/i;
/** Strip a trailing snapshot/date suffix: "-20260723", "@20260723". */
const DATE_SUFFIX = /[-@]\d{8}$/;

export const stripProviderPrefix = (s) => String(s || '').trim().replace(PROVIDER_PREFIX, '');
export const stripDateSuffix = (s) => String(s || '').replace(DATE_SUFFIX, '');

/**
 * Canonical key for cross-source matching: strip provider prefix, strip trailing date suffix,
 * then normalize (lowercase, drop everything but letters/digits — so "." "-" "_" " " all
 * collapse to nothing and become equivalent).
 */
export const canonicalKey = (s) => normalize(stripDateSuffix(stripProviderPrefix(s)));

// Feed display names come as "Vendor: Model Name" ("MoonshotAI: Kimi K3", "Z.ai: GLM 5.3",
// "Qwen: Qwen3 Max") — a few of our own catalog names inherited that shape too (whatever a past
// Judge run copied verbatim). Strip that lead segment before comparing, mirroring
// stripProviderPrefix for machine-style ids ("anthropic/claude-x") and the existing
// releaseTitle() vendor/name split, so a vendor-prefixed listing still resolves to the bare name
// it's a re-listing of.
const DISPLAY_VENDOR_PREFIX = /^[A-Za-z][A-Za-z0-9.\- ]{0,29}:\s+/;
export const stripDisplayVendorPrefix = (s) => String(s || '').replace(DISPLAY_VENDOR_PREFIX, '');

/**
 * Normalize a candidate's display name for admission: strip a leading "<Vendor>: " prefix ONLY
 * when that prefix names the same vendor already recorded in the vendor field ("Anthropic: Claude
 * Fable 5.1" + vendor "anthropic" -> "Claude Fable 5.1"). This is what caused "Anthropic: Claude
 * Fable 5.1", "OpenAI: GPT-6 Astra", "OpenAI: GPT-6 Astra Pro" to land in the catalog verbatim
 * (2026-09-06) — OpenRouter's display names carry the "Vendor: Model" shape by convention, and
 * admission copied it straight into `name`, duplicating the vendor field.
 * A prefix that names something OTHER than the vendor field (e.g. "SpaceXAI: Grok 4.6" when
 * vendor is "x-ai") is left alone — only strip what's confirmed to be the vendor itself, never
 * guess. Comparison is via normalize() so casing/punctuation differences ("OpenAI" vs "openai")
 * don't block the match.
 */
export function normalizeDisplayName(name, vendor) {
  const s = String(name || '');
  const m = DISPLAY_VENDOR_PREFIX.exec(s);
  if (!m) return s;
  const prefix = m[0].replace(/:\s*$/, '').trim();
  if (normalize(prefix) !== normalize(vendor)) return s;
  const rest = s.slice(m[0].length).trim();
  return rest || s;
}

/**
 * New-model dedup key: strip the variant tag, the display vendor prefix, then canonicalize.
 * Applied identically to a candidate and to a known model's name/id/aliases so it doesn't matter
 * which side happens to carry the "Vendor: " noise.
 */
const dedupKey = (s) => canonicalKey(stripDisplayVendorPrefix(stripVariantSuffix(s)));

/**
 * Returns the id of the known model `name` matches (by name, id, or alias), or null. EXACT key
 * match only — never substring containment. Containment is what caused the bug this replaced:
 * canonicalKey deletes every separator, so "claude-fable-5" -> "claudefable5" is a plain PREFIX
 * of "claude-fable-5.1" -> "claudefable51", and the old `k.includes(n) || n.includes(k)` check
 * silently treated the point release as the model it supersedes. A prefix/suffix "boundary"
 * exception was tried and rejected: on live data it also merged genuinely different models that
 * share a word stem — "Z.ai: GLM 5.3" vs "Z.ai: GLM 5.3 Flash", "inclusionAI: Ling 3.0 Flash" vs
 * "... Flash Fin" — which is exactly the class of silent-merge bug being fixed here. Exact-match
 * plus prefix-stripping (provider ids, vendor display names, date/variant suffixes) is what
 * verified clean against data/models.json + the live OpenRouter feed (see the fix PR for the
 * before/after diff).
 */
export function findKnownModel(name, models, aliases) {
  const n = dedupKey(name);
  if (!n) return null;
  for (const m of models) {
    const known = [dedupKey(m.name), dedupKey(m.id), ...(aliases[m.id] || []).map(dedupKey)];
    if (known.some((k) => k && k === n)) return m.id;
  }
  return null;
}

/** Same-model match used only for new-model dedup (never for price facts). */
export function isKnownCandidate(name, models, aliases) {
  const n = canonicalKey(stripVariantSuffix(name));
  if (!n) return true; // empty name can't be a real candidate
  return findKnownModel(name, models, aliases) != null;
}

// --- cheap early exit (release watching without a second job) ---------------------------------
// Purpose: catch a launch-day model within ~2h instead of waiting for the Tue/Fri full run,
// without a second workflow/job (automation rule: one workflow, one schedule; no job triggers
// another). The workflow's cron runs every 2h; this decides, using only the already-fetched
// OpenRouter id list (no Epoch download, no price/worklist processing), whether there's anything
// worth a full Collect pass this cycle. See findNewCandidateIds() for why LiteLLM — also fetched
// on every cycle for the full run's price checks — isn't used for this comparison.
export const DAILY_FULL_RUN_HOUR_UTC = 6; // matches the "Tue/Fri 06:00 UTC" full-run cron hour

/**
 * Which OpenRouter candidates are worth a full Collect pass this cycle: not a variant tag, not
 * older than `maxAgeDays` (the same 45-day staleness rule the full run's new-model check uses —
 * this is release watching, so a listing that's been sitting on OpenRouter for months isn't a
 * launch, it's just something the catalog never picked up), not a known model (same
 * alias/canonical matching admission uses), and not already flagged by a previous cheap check
 * (`pending` — ids a prior cycle already surfaced but the full run couldn't yet resolve, e.g.
 * still single-source). Without the `pending` exclusion, a stuck candidate that never gets
 * admitted would force a full run every single 2h cycle forever, instead of the one cycle it
 * actually takes to notice it.
 *
 * LiteLLM is deliberately NOT scanned here even though it's a cheap fetch: it's a ~3,000-entry
 * historical price table spanning every vendor it has ever priced, not a curated "what's
 * available now" list — tried against the live feed, treating its ids as independent candidates
 * found ~3,200 "new" ids on a single run (almost the whole table), which would make the early
 * exit always decide `run` and defeat the point of it. The full Collect run already treats
 * LiteLLM the same way — a secondary source that confirms an OpenRouter candidate's price, never
 * an independent discovery source for new models — this mirrors that.
 *
 * Returns [{ id, key }] — `id` for logging, `key` (canonical) for persisting into `pending` next run.
 */
export function findNewCandidateIds({ orList, models, aliases, pending, today = new Date().toISOString().slice(0, 10), maxAgeDays = 45 }) {
  const pendingSet = new Set(pending || []);
  const seenThisRun = new Set();
  const out = [];
  for (const c of orList || []) {
    if (!c) continue;
    if (/free|preview-\d|:online|extended/i.test(c.id || '')) continue; // variant tag, not a new model
    if (c.created && today && (Date.parse(today) - Date.parse(c.created)) / 864e5 > maxAgeDays) continue; // stale listing, not a launch
    if (findKnownModel(c.name, models, aliases) || findKnownModel(c.id, models, aliases)) continue;
    const key = canonicalKey(stripVariantSuffix(c.name || c.id));
    if (!key || seenThisRun.has(key) || pendingSet.has(key)) continue;
    seenThisRun.add(key);
    out.push({ id: c.id || c.name, key });
  }
  return out;
}

/**
 * The decision itself, isolated as a pure function so it's trivial to test: given the candidate
 * ids a cheap check couldn't already explain, and the current UTC hour, run the full Collect
 * pipeline or skip it. The 06:00 UTC hour always runs — that's the guaranteed daily full pass
 * (automation/jobs/auto-refresh/README.md); every other hour only runs when there's something new.
 */
export function decideRefreshRun(newIds, hourUTC) {
  if (hourUTC === DAILY_FULL_RUN_HOUR_UTC) return 'run';
  return (newIds && newIds.length > 0) ? 'run' : 'skip';
}

/** Match a candidate name/id against our models via the alias map. Returns our model id or null. */
export function matchAlias(name, models, aliases) {
  const n = canonicalKey(name);
  if (!n) return null;
  for (const m of models) {
    if (canonicalKey(m.name) === n || canonicalKey(m.id) === n) return m.id;
    for (const a of aliases[m.id] || []) if (canonicalKey(a) === n) return m.id;
  }
  return null;
}

/** Do two numeric values agree within AGREEMENT_PCT of each other? */
export function withinTolerance(a, b, pct = AGREEMENT_PCT) {
  if (a == null || b == null) return false;
  if (a === 0 && b === 0) return true;
  const base = Math.max(Math.abs(a), Math.abs(b), 1e-9);
  return Math.abs(a - b) / base <= pct;
}

/**
 * Decide whether a candidate fact applies.
 * observations: [{ source: 'openrouter'|'litellm'|'vendor'|'judgment', value: number }]
 * A fact applies when >=2 independent sources agree within tolerance, OR vendor + judgment agree.
 * Returns { applies: boolean, reason: string, sources: string[] }
 */
export function factAgreement(observations) {
  const obs = (observations || []).filter((o) => o && o.value != null && !Number.isNaN(o.value));
  if (obs.length < 2) {
    return { applies: false, reason: 'single-source', sources: obs.map((o) => o.source) };
  }
  for (let i = 0; i < obs.length; i++) {
    for (let j = i + 1; j < obs.length; j++) {
      const a = obs[i], b = obs[j];
      if (a.source === b.source) continue; // not independent
      const vendorJudgment =
        (a.source === 'vendor' && b.source === 'judgment') ||
        (a.source === 'judgment' && b.source === 'vendor');
      const structuredPair = ['openrouter', 'litellm', 'vendor'].includes(a.source) &&
        ['openrouter', 'litellm', 'vendor'].includes(b.source);
      if ((vendorJudgment || structuredPair) && withinTolerance(a.value, b.value)) {
        return { applies: true, reason: 'agreement', sources: [a.source, b.source] };
      }
    }
  }
  return { applies: false, reason: 'no-agreement', sources: obs.map((o) => o.source) };
}

const CONFIRM_TOL = 0.005; // a source within 0.5% of our current value counts as confirming it, not proposing a change

/**
 * Decide what to do with a field's observations against our current value.
 * "held" is reserved for genuine conflict: sources disagree with each other, a single source
 * disagrees with current and there's no second source to break the tie, or a sanity-bound trip.
 * A single source that simply confirms current value is "confirmed", not held.
 * observations: [{ source, value }]
 * Returns { status: 'confirmed'|'applied'|'held'|null, reason?, value?, sources }
 */
export function evaluateFact(current, observations) {
  const obs = (observations || []).filter((o) => o && o.value != null && !Number.isNaN(o.value));
  if (!obs.length) return null;

  if (obs.length === 1) {
    const o = obs[0];
    if (current != null && withinTolerance(current, o.value, CONFIRM_TOL)) {
      return { status: 'confirmed', sources: [o.source] };
    }
    return { status: 'held', reason: 'single-source', sources: [o.source], candidate: o.value };
  }

  // >=2 independent observations — first check they agree with each other.
  const allAgree = obs.every((a, i) => obs.every((b, j) => i === j || withinTolerance(a.value, b.value)));
  if (!allAgree) {
    return { status: 'held', reason: 'source-conflict', sources: obs.map((o) => o.source), observations: obs };
  }
  const value = obs[0].value;
  if (current != null && withinTolerance(current, value, CONFIRM_TOL)) {
    return { status: 'confirmed', sources: obs.map((o) => o.source) };
  }
  if (!withinSanityBounds(current, value)) {
    return { status: 'held', reason: 'sanity-bound', sources: obs.map((o) => o.source), current, candidate: value };
  }
  return { status: 'applied', value, sources: obs.map((o) => o.source) };
}

/** Sanity bound: a change >5x or <0.2x current holds for review regardless of agreement. */
export function withinSanityBounds(current, next) {
  if (current == null || current === 0) return true; // nothing to compare against yet
  if (next == null) return true;
  const ratio = next / current;
  return ratio <= SANITY_HIGH && ratio >= SANITY_LOW;
}

/**
 * A fact newer than our as_of wins over an older one. Returns true if `candidateDate` should
 * be preferred over `asOf` (i.e. candidateDate is newer or as_of is missing).
 */
export function newerWins(asOf, candidateDate) {
  if (!candidateDate) return false;
  if (!asOf) return true;
  return Date.parse(candidateDate) > Date.parse(asOf);
}

/** New-model admission: >=2 sources, has pricing, name maps to a known vendor. */
export function admitNewModel({ sourceCount, hasPricing, vendorKnown }) {
  return sourceCount >= 2 && !!hasPricing && !!vendorKnown;
}

/** Human-readable reasons a new-model candidate failed admission — same predicates as
 *  admitNewModel(), decomposed for the `dropped:` run-log line and the worklist ask so the two
 *  never drift out of sync. */
export function admissionFailReasons({ sourceCount, hasPricing, vendorKnown }) {
  const reasons = [];
  if (sourceCount < 2) reasons.push('single source');
  if (!hasPricing) reasons.push('no pricing data');
  if (!vendorKnown) reasons.push('unknown vendor');
  return reasons;
}

/** Exact wording for a `dropped:` run-log line, kept as one function so the log text and the
 *  tests that check it can never drift apart. */
export function formatDropLine(id, reason) {
  return `dropped: ${id} — ${reason}`;
}

// Display casing for vendors we know about, keyed by normalize(). Falls back to the raw
// vendor string when we don't recognize it (better than guessing at capitalization).
const VENDOR_DISPLAY = {
  anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google', meta: 'Meta',
  mistral: 'Mistral AI', mistralai: 'Mistral AI', xai: 'xAI', deepseek: 'DeepSeek',
  alibaba: 'Alibaba', qwen: 'Qwen', amazon: 'Amazon', cohere: 'Cohere',
  moonshot: 'Moonshot AI', moonshotai: 'Moonshot AI',
};

/**
 * Release-feed title for a newly admitted model. OpenRouter names already come vendor-prefixed
 * ("Qwen: Qwen3.8 Flash", "Google: Gemini 3.8 Flash"), so blindly prepending nm.vendor doubles
 * the vendor and — since nm.vendor is a lowercased id fragment — mangles the casing too
 * ("qwen releases Qwen: Qwen3.8 Flash"). Prefer the name's own vendor prefix (already properly
 * cased); only fall back to a display-cased nm.vendor when the name carries no prefix.
 */
export function releaseTitle(nm) {
  const m = /^([^:]+):\s*(.+)$/.exec(nm.name || '');
  if (m) return `${m[1].trim()} releases ${m[2].trim()}`;
  const display = VENDOR_DISPLAY[normalize(nm.vendor)] || nm.vendor;
  return `${display} releases ${nm.name}`;
}

export function isKnownVendor(vendorName) {
  return KNOWN_VENDORS.has(normalize(vendorName).replace(/inc|corp|ltd|ai$/g, '') || normalize(vendorName)) ||
    KNOWN_VENDORS.has(String(vendorName || '').trim().toLowerCase());
}

/**
 * Track "missing from all sources" across runs. state: { [modelId]: consecutiveMisses }.
 * Returns { state, absentNow: string[] } — ids that just crossed the 2-run threshold. This is a
 * candidate list only — deprecation is never auto-applied; absentNow becomes a "deprecation"
 * worklist item for the Judge to decide with a cited source.
 */
export function trackDeprecation(state, presentIds, allModelIds) {
  const next = { ...state };
  const absentNow = [];
  for (const id of allModelIds) {
    if (presentIds.has(id)) {
      next[id] = 0;
    } else {
      next[id] = (next[id] || 0) + 1;
      if (next[id] === 2) absentNow.push(id);
    }
  }
  return { state: next, absentNow };
}

/**
 * Which models still need usage guidance: empty best_for or empty use_well. Deprecated models
 * and models with no price at all are skipped — nothing to recommend yet.
 */
export function needsGuidance(m) {
  if (m.deprecated) return false;
  if (m.price_input == null && m.price_output == null) return false;
  return !(m.best_for || []).length || !(m.use_well || []).length;
}

/**
 * Rotating pick: sort blank ids, start after the last id attempted (state.guidanceCursor),
 * wrap around, take GUIDANCE_PER_RUN. Same state + same models → same picks (idempotent);
 * a model the Judge held simply comes round again after the others have had their turn.
 */
export function pickGuidance(models, state, perRun = GUIDANCE_PER_RUN) {
  const ids = models.filter(needsGuidance).map((m) => m.id).sort();
  if (!ids.length) return { picked: [], cursor: state.guidanceCursor ?? null };
  const cursor = state.guidanceCursor ?? null;
  let start = cursor ? ids.findIndex((id) => id > cursor) : 0;
  if (start < 0) start = 0;
  const picked = [];
  for (let i = 0; i < Math.min(perRun, ids.length); i++) picked.push(ids[(start + i) % ids.length]);
  return { picked, cursor: picked[picked.length - 1] };
}

export function guidanceItem(m, today) {
  return {
    id: `${m.id}:guidance`, model: m.name, kind: 'guidance', field: 'use_well', current: null,
    observations: [{ source: 'auto-refresh', url: OR_URL, value: null, date: today }],
    ask: `${m.name} has no usage guidance. From the vendor's model card / docs (cite the URL): which of these tags fit — reasoning, agentic, coding, research, long-context, writing, cheap-bulk, speed, vision — and 2–4 plain one-sentence tips on using it well (when its thinking mode earns its cost, when a cheaper tier is enough, cache/batch tactics, pricing traps). Hold if the vendor publishes nothing concrete.`,
  };
}

// --- effort ladders: CursorBench from Epoch AI's CC-BY export (tier A, exact values) ----------
const EPOCH_ZIP_URL = 'https://epoch.ai/data/benchmark_data.zip';
const CURSORBENCH_LADDER_ID = 'cursorbench-agentic-coding';
const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Tiny CSV reader — quoted fields with commas are the only wrinkle in Epoch's file. */
export function parseCsv(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = []; let cur = '', q = false;
    for (const ch of line) {
      if (ch === '"') q = !q;
      else if (ch === ',' && !q) { cells.push(cur); cur = ''; }
      else cur += ch;
    }
    cells.push(cur);
    rows.push(cells);
  }
  const head = rows.shift() || [];
  return rows.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

/**
 * Rebuild the CursorBench ladder's points from Epoch's cursorbench_external.csv. Pure: returns
 * { changed, notes }. Each series carries `source_key` (the CSV's model-version stem, e.g.
 * "gpt-5.6-sol"); rows are "<stem>_<level>". Rules, in the spirit of the price feed:
 *  - the series list is fixed here — this never adds or drops a model, only refreshes rungs;
 *  - a series the file no longer carries (or carries with < 2 usable rungs) keeps yesterday's
 *    points and is noted, never blanked;
 *  - a rung without both cost and score is dropped, never interpolated;
 *  - as_of moves to `today` only when at least one point actually changed.
 */
export function refreshCursorBench(data, rows, today) {
  const L = (data.effort_ladders || []).find((l) => l.id === CURSORBENCH_LADDER_ID);
  const notes = [];
  if (!L) return { changed: false, notes: ['no cursorbench ladder in data'] };
  let changed = false;
  for (const s of L.series) {
    if (!s.source_key) { notes.push(`${s.label}: no source_key — left as is`); continue; }
    const pts = {};
    for (const r of rows) {
      const mv = r['Model version'] || '';
      const i = mv.lastIndexOf('_');
      if (i < 0) continue;
      const stem = mv.slice(0, i), lvl = mv.slice(i + 1).toLowerCase();
      if (stem !== s.source_key || !EFFORT_ORDER.includes(lvl)) continue;
      const cost = Number(r['Cost per task']), score = Number(r['Score']);
      if (!r['Cost per task'] || !r['Score'] || !Number.isFinite(cost) || !Number.isFinite(score) || cost <= 0) continue;
      pts[lvl] = { effort: lvl, cost: Math.round(cost * 100) / 100, score: Math.round(score * 1000) / 10 };
    }
    const next = EFFORT_ORDER.filter((l) => pts[l]).map((l) => pts[l]);
    if (next.length < 2) { notes.push(`${s.label}: ${next.length} usable rung(s) in the file — kept previous ${s.points.length}`); continue; }
    if (JSON.stringify(next) !== JSON.stringify(s.points)) { s.points = next; changed = true; notes.push(`${s.label}: ${next.length} rungs refreshed`); }
  }
  if (changed) L.as_of = today;
  return { changed, notes };
}

/** Download Epoch's bundle and pull the CursorBench CSV out of it. Best effort — [] on any failure. */
async function feedEpochCursorBench() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 60000);
  try {
    const res = await fetch(EPOCH_ZIP_URL, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const zipPath = join(tmpdir(), `epoch-benchmarks-${process.pid}.zip`);
    writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));
    const csv = execFileSync('unzip', ['-p', zipPath, 'cursorbench_external.csv'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    return parseCsv(csv);
  } catch (e) {
    console.log(`feed: Epoch CursorBench export unreachable (${e.message}) — ladder keeps its current points.`);
    return [];
  } finally {
    clearTimeout(t);
  }
}

/**
 * Sort candidate worklist items by kind priority (new-model > conflict > benchmark > ladder >
 * release), then by id for a stable tie-break, and cap at MAX_WORKLIST. Same input always
 * produces the same output (idempotent) — nothing here depends on wall-clock time or Math.random.
 */
export function buildWorklist(items) {
  const byPriority = (a, b) => {
    const pa = WORKLIST_PRIORITY[a.kind] ?? 99;
    const pb = WORKLIST_PRIORITY[b.kind] ?? 99;
    if (pa !== pb) return pa - pb;
    return String(a.id).localeCompare(String(b.id));
  };
  const guidance = items.filter((i) => i.kind === 'guidance').sort(byPriority).slice(0, GUIDANCE_PER_RUN);
  const rest = items.filter((i) => i.kind !== 'guidance').sort(byPriority).slice(0, MAX_WORKLIST - guidance.length);
  return [...rest, ...guidance].sort(byPriority);
}

/**
 * Deterministic "best for" line built from facts only — no prose generation. Ranks the model's
 * price_input among same-vendor models to call out "cheapest"/"priciest" when it's actually true.
 */
export function bestForLine(model, allModels) {
  const parts = [];
  const sameVendor = (allModels || []).filter((m) => m.vendor === model.vendor && m.price_input != null);
  if (model.price_input != null && sameVendor.length > 1) {
    const sorted = [...sameVendor].sort((a, b) => a.price_input - b.price_input);
    if (sorted[0].id === model.id) parts.push(`Cheapest ${model.vendor} model`);
    else if (sorted[sorted.length - 1].id === model.id) parts.push(`Priciest ${model.vendor} model`);
  }
  if (!parts.length) parts.push(model.vendor ? `${model.vendor} model` : 'Model');
  if (model.context_window) {
    const ctx = model.context_window >= 1e6 ? `${Math.round(model.context_window / 1e6)}M ctx` : `${Math.round(model.context_window / 1e3)}K ctx`;
    parts.push(ctx);
  }
  if (model.price_input != null && model.price_output != null) parts.push(`$${model.price_input}/$${model.price_output}`);
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------------------------
// feed
// ---------------------------------------------------------------------------------------------

async function fetchJson(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, ...opts });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function feedOpenRouter() {
  try {
    const json = await fetchJson(OR_URL);
    return (json.data || []).map((o) => ({
      source: 'openrouter',
      id: o.id,
      name: o.name,
      priceInput: o.pricing?.prompt != null ? Number(o.pricing.prompt) * 1e6 : null,
      priceOutput: o.pricing?.completion != null ? Number(o.pricing.completion) * 1e6 : null,
      contextWindow: o.context_length ?? null,
      hfId: o.hugging_face_id ?? null, // used by derive-availability.mjs's open_weights check
      created: o.created ? new Date(o.created * 1000).toISOString().slice(0, 10) : null,
    }));
  } catch (e) {
    console.log(`feed: OpenRouter unreachable (${e.message}) — skipping.`);
    return [];
  }
}

async function feedLiteLLM() {
  try {
    const json = await fetchJson(LITELLM_URL);
    const out = [];
    for (const [key, v] of Object.entries(json)) {
      if (!v || typeof v !== 'object') continue;
      if (v.input_cost_per_token == null && v.output_cost_per_token == null) continue;
      out.push({
        source: 'litellm',
        id: key,
        name: key,
        priceInput: v.input_cost_per_token != null ? v.input_cost_per_token * 1e6 : null,
        priceOutput: v.output_cost_per_token != null ? v.output_cost_per_token * 1e6 : null,
        contextWindow: v.max_input_tokens ?? v.max_tokens ?? null,
        created: null,
      });
    }
    return out;
  } catch (e) {
    console.log(`feed: LiteLLM unreachable (${e.message}) — skipping.`);
    return [];
  }
}


// ---------------------------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------------------------

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const data = JSON.parse(readFileSync(dataUrl));
  const aliases = JSON.parse(readFileSync(aliasUrl));
  const state = existsSync(stateUrl) ? JSON.parse(readFileSync(stateUrl)) : {};
  const changelog = existsSync(changelogUrl) ? JSON.parse(readFileSync(changelogUrl)) : [];
  const today = new Date().toISOString().slice(0, 10);

  console.log('feed: fetching OpenRouter + LiteLLM...');
  const [orList, llmList] = await Promise.all([feedOpenRouter(), feedLiteLLM()]);
  console.log(`feed: openrouter=${orList.length} litellm=${llmList.length} candidates`);

  // --- cheap early exit (release watching without a second job) -------------------------------
  // The workflow now runs every 2h; everything above this line is the only network cost paid on
  // a cycle with nothing new. REFRESH_FORCE_FULL / REFRESH_FORCE_SKIP are local/CI testing
  // overrides only — the real decision is always decideRefreshRun(newIds, hourUTC).
  const hourUTC = new Date().getUTCHours();
  const newCandidates = findNewCandidateIds({ orList, models: data.models, aliases, pending: state.seenCandidateIds, today });
  const forceFull = process.env.REFRESH_FORCE_FULL === '1';
  const forceSkip = process.env.REFRESH_FORCE_SKIP === '1';
  const decision = forceFull ? 'run' : forceSkip ? 'skip' : decideRefreshRun(newCandidates, hourUTC);
  console.log(`early-exit: ${newCandidates.length} new candidate id(s), hour=${hourUTC} UTC -> ${decision}` +
    (forceFull ? ' (forced via REFRESH_FORCE_FULL=1)' : forceSkip ? ' (forced via REFRESH_FORCE_SKIP=1)' : '') +
    (newCandidates.length ? ` [${newCandidates.slice(0, 5).map((c) => c.id).join(', ')}${newCandidates.length > 5 ? ', ...' : ''}]` : ''));
  if (decision === 'skip') {
    console.log('no new models — skipping full run');
    return;
  }

  const epochRows = await feedEpochCursorBench();
  const ladder = epochRows.length ? refreshCursorBench(data, epochRows, today) : { changed: false, notes: ['feed empty — untouched'] };
  console.log(`ladder: cursorbench ${ladder.changed ? 'REFRESHED' : 'unchanged'} — ${ladder.notes.join('; ')}`);

  // --- availability: where each model can actually be reached (direct API, OpenRouter, AWS
  // Bedrock, open weights) — see scripts/derive-availability.mjs for the sourcing rules. Runs
  // every full pass (this early-exit already returned above if this is a cheap skip cycle), so
  // it stays at most a day stale. Computed unconditionally (even under --dry-run) so a dry run
  // exercises the real fetch + derivation path; only the write is gated below.
  console.log('availability: fetching AWS Bedrock price list...');
  const bedrockKeys = await fetchBedrockModelKeys();
  const orFeedOk = orList.length > 0;
  const availabilityUpdates = [];
  for (const m of data.models) {
    const next = deriveAvailabilityForModel(m, { orList, aliases, orFeedOk, bedrockKeys });
    if (!availabilityEquals(m.availability, next)) availabilityUpdates.push({ id: m.id, availability: next });
  }
  const availCounts = data.models.reduce((acc, m) => {
    const a = availabilityUpdates.find((u) => u.id === m.id)?.availability || m.availability || {};
    for (const k of ['direct_api', 'openrouter', 'aws_bedrock', 'open_weights']) if (a[k]) acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});
  console.log(`availability: ${availabilityUpdates.length} of ${data.models.length} model(s) changed — ` +
    `direct_api=${availCounts.direct_api || 0} openrouter=${availCounts.openrouter || 0} ` +
    `aws_bedrock=${availCounts.aws_bedrock || 0} open_weights=${availCounts.open_weights || 0}` +
    (bedrockKeys ? '' : ' (AWS Bedrock check skipped — fetch failed, prior values kept)'));

  const applied = [];
  const held = [];
  const confirmed = [];
  const newModels = [];
  const worklistItems = [];
  const presentIds = new Set();

  // --- check: existing models — price/context facts -------------------------------------------
  for (const m of data.models) {
    presentIds.add(m.id);
    const orMatch = orList.find((c) => matchAlias(c.name, [m], aliases) === m.id || matchAlias(c.id, [m], aliases) === m.id);
    const llmMatch = llmList.find((c) => matchAlias(c.id, [m], aliases) === m.id || matchAlias(c.name, [m], aliases) === m.id);

    for (const field of ['priceInput', 'priceOutput']) {
      const targetField = field === 'priceInput' ? 'price_input' : 'price_output';
      const obs = [];
      if (orMatch?.[field] != null) obs.push({ source: 'openrouter', value: orMatch[field] });
      if (llmMatch?.[field] != null) obs.push({ source: 'litellm', value: llmMatch[field] });
      if (!obs.length) continue;

      const current = m[targetField];
      const verdict = evaluateFact(current, obs);
      if (!verdict) continue;
      if (verdict.status === 'confirmed') {
        confirmed.push({ model: m.name, field: targetField, sources: verdict.sources });
      } else if (verdict.status === 'held') {
        held.push({ model: m.name, field: targetField, reason: verdict.reason, observations: obs, current, candidate: verdict.candidate });
        worklistItems.push({
          id: `${m.id}:${targetField}`, model: m.name, kind: 'conflict', field: targetField, current,
          observations: obs.map((o) => ({ source: o.source, url: o.source === 'openrouter' ? OR_URL : LITELLM_URL, value: o.value, date: today })),
          ask: `${m.name} ${targetField.replace('_', ' ')} is currently ${current ?? 'null'}; sources disagree (${verdict.reason}) — what's the correct current value, with a source URL and date?`,
        });
      } else if (verdict.status === 'applied') {
        applied.push({ model: m.name, id: m.id, field: targetField, old: current, new: Math.round(verdict.value * 100) / 100, sources: verdict.sources });
      }
    }

  }

  // --- check: new models -----------------------------------------------------------------------
  // Every candidate that doesn't become a new model leaves exactly one `dropped:` log line below
  // — no candidate silently disappears between the feed and the report.
  const seen = new Set();
  const dropped = [];
  const logDrop = (id, reason) => { dropped.push({ id, reason }); console.log(formatDropLine(id, reason)); };
  for (const c of orList) {
    if (/free|preview-\d|:online|extended/i.test(c.id || '')) { logDrop(c.id, 'variant suffix, not a new model'); continue; }
    const knownMatch = findKnownModel(c.name, data.models, aliases) || findKnownModel(c.id, data.models, aliases);
    if (knownMatch) { logDrop(c.id, `known as ${knownMatch}`); continue; }
    const n = canonicalKey(stripVariantSuffix(c.name));
    if (!n) { logDrop(c.id, 'empty/unresolvable name'); continue; }
    if (seen.has(n)) { logDrop(c.id, 'duplicate of another candidate this run'); continue; }
    if (c.created && (Date.parse(today) - Date.parse(c.created)) / 864e5 > 45) { logDrop(c.id, 'stale (listed on OpenRouter >45 days ago)'); continue; }
    const llmSame = llmList.find((l) => canonicalKey(l.id).includes(n) || n.includes(canonicalKey(l.id)));
    const sourceCount = 1 + (llmSame ? 1 : 0);
    const vendorGuess = (c.id || '').split('/')[0];
    const vendorKnown = isKnownVendor(vendorGuess);
    const hasPricing = c.priceInput != null || c.priceOutput != null || llmSame?.priceInput != null;
    seen.add(n);
    if (admitNewModel({ sourceCount, hasPricing, vendorKnown })) {
      newModels.push({
        id: c.id.replace(/[^a-z0-9]+/gi, '-').toLowerCase(),
        name: normalizeDisplayName(c.name, vendorGuess),
        vendor: vendorGuess,
        released: c.created || null,
        context_window: c.contextWindow ?? llmSame?.contextWindow ?? null,
        price_input: c.priceInput != null ? Math.round(c.priceInput * 100) / 100 : (llmSame?.priceInput ?? null),
        price_output: c.priceOutput != null ? Math.round(c.priceOutput * 100) / 100 : (llmSame?.priceOutput ?? null),
        speed_tps: null,
        benchmarks: { swe_bench: null, gpqa: null, aime: null, mmlu_pro: null },
        best_for: [],
        strengths: [],
        weaknesses: [],
        verdict: null,
        confidence: 'low',
        sources: ['https://openrouter.ai/' + c.id],
        coding_score: null,
        coding_basis: null,
        coding_confidence: 'low',
        use_well: [],
        task_copy: {},
        auto_added: today,
      });
    } else {
      const reason = admissionFailReasons({ sourceCount, hasPricing, vendorKnown }).join(', ');
      logDrop(c.id, `${reason} — queued for Judge review`);
      held.push({ model: c.name, field: 'new-model', reason });
      worklistItems.push({
        id: `new:${canonicalKey(c.id)}`, model: c.name, kind: 'new-model', current: null,
        observations: [{ source: 'openrouter', url: OR_URL, value: c.priceInput, date: today }],
        ask: `"${c.name}" showed up on OpenRouter but ${reason} — is this a real, released model? If so, find vendor + a second source and add it.`,
      });
    }
  }

  // --- check: deprecation tracking ---------------------------------------------------------------
  // Presence MUST use the exact same matching as the price check above (both name and id, both
  // directions) — a model matched for price can never simultaneously count as absent.
  const stillPresent = new Set();
  for (const m of data.models) {
    const inOr = orList.some((c) => matchAlias(c.name, [m], aliases) === m.id || matchAlias(c.id, [m], aliases) === m.id);
    const inLlm = llmList.some((c) => matchAlias(c.id, [m], aliases) === m.id || matchAlias(c.name, [m], aliases) === m.id);
    if (inOr || inLlm || (!orList.length && !llmList.length)) stillPresent.add(m.id);
  }
  const { state: nextState, absentNow } = trackDeprecation(state, stillPresent, data.models.map((m) => m.id));

  // Deprecation is NEVER auto-applied — 2 consecutive absent runs becomes a worklist item for
  // the Judge to decide with a cited vendor source, not a direct write.
  for (const id of absentNow) {
    const m = data.models.find((x) => x.id === id);
    if (!m || m.deprecated) continue;
    worklistItems.push({
      id: `${id}:deprecation`, model: m.name, kind: 'deprecation', field: 'deprecated', current: false,
      observations: [{ source: 'auto-refresh', url: OR_URL, value: null, date: today }],
      ask: `Is ${m.name} deprecated/retired? Cite the vendor page. (Absent from OpenRouter + LiteLLM for 2 consecutive collect runs.)`,
    });
  }

  // Usage guidance — a rotating handful of blank models for the Judge (lowest priority).
  const guidance = pickGuidance(data.models, nextState);
  for (const id of guidance.picked) {
    const m = data.models.find((x) => x.id === id);
    if (m) worklistItems.push(guidanceItem(m, today));
  }
  nextState.guidanceCursor = guidance.cursor;

  // Remember every candidate this run already looked at (admitted or held) so the cheap early-exit
  // check on the next 2h cycle doesn't force another full run for the same still-unresolved id.
  nextState.seenCandidateIds = Array.from(new Set([...(state.seenCandidateIds || []), ...newCandidates.map((c) => c.key)]));

  // --- worklist (computed regardless of dry-run, so --dry-run can preview it) ------------------
  const worklist = { generated: today, items: buildWorklist(worklistItems) };

  // --- publish -------------------------------------------------------------------------------
  let changed = false;
  if (!dryRun) {
    for (const u of availabilityUpdates) {
      const m = data.models.find((x) => x.id === u.id);
      if (!m) continue;
      m.availability = u.availability;
      changed = true;
    }
    for (const a of applied) {
      const m = data.models.find((x) => x.id === a.id);
      if (!m) continue;
      m[a.field] = a.new;
      changed = true;
      changelog.push({ date: today, model: a.model, field: a.field, old: a.old, new: a.new, sources: a.sources });
      // a price move of 20%+ is timeline news (kind: price); smaller moves stay in the changelog only
      if ((a.field === 'price_input' || a.field === 'price_output') && isNotablePriceChange(a.old, a.new)) {
        addEntry(data, priceEntry(m, a.field === 'price_input' ? 'input' : 'output', a.old, a.new, OR_URL, today));
      }
    }
    for (const nm of newModels) {
      data.models.push(nm);
      changed = true;
      changelog.push({ date: today, model: nm.name, field: 'added', old: null, new: 'new model', sources: nm.sources });
      data.releases = data.releases || [];
      data.releases.push({
        kind: 'model',
        date: nm.released ? String(nm.released).slice(0, 10) : today,
        vendor: nm.vendor,
        title: releaseTitle(nm),
        summary: 'Listed with sourced pricing and context window; benchmark scores are pending publication.',
        source: nm.sources[0],
        why: 'Priced and available now; treat capability as unproven until scores land.',
      });
      // new models are pushed after the availability pass above ran, so derive theirs now.
      nm.availability = deriveAvailabilityForModel(nm, { orList, aliases, orFeedOk, bedrockKeys });
    }
    // best_for_line: deterministic template, added to every model missing it (strengths untouched).
    let bestForChanged = false;
    for (const m of data.models) {
      if (!m.best_for_line) {
        m.best_for_line = bestForLine(m, data.models);
        bestForChanged = true;
      }
    }
    if (bestForChanged) changed = true;
    if (ladder.changed) {
      changed = true;
      changelog.push({ date: today, model: 'CursorBench ladder', field: 'effort_ladders', old: null, new: ladder.notes.join('; '), sources: [EPOCH_ZIP_URL] });
    }

    if (changed) data.as_of = today;
    writeFileSync(stateUrl, JSON.stringify(nextState, null, 2) + '\n');

    mkdirSync(new URL('data/refresh/', ROOT), { recursive: true });
    writeFileSync(worklistUrl, JSON.stringify(worklist, null, 2) + '\n');

    let gateOk = true;
    if (changed) {
      writeFileSync(dataUrl, JSON.stringify(data, null, 2) + '\n');
      writeFileSync(changelogUrl, JSON.stringify(changelog, null, 2) + '\n');

      // honesty gate — must pass or nothing publishes
      const { execFileSync } = await import('node:child_process');
      try {
        execFileSync('node', [fileURLToPath(new URL('scripts/validate-data.mjs', ROOT))], { stdio: 'inherit' });
      } catch (e) {
        console.error('honesty gate failed — reverting write, nothing published.');
        gateOk = false;
        process.exitCode = 1;
      }
    }

    writeFileSync(receiptUrl, JSON.stringify({
      job: 'collect', ran_at: new Date().toISOString(), applied: applied.length, held: held.length,
      confirmed: confirmed.length, new_models: newModels.length, dropped: dropped.length,
      worklist_items: worklist.items.length, availability_changed: availabilityUpdates.length,
      ok: gateOk, ...(gateOk ? {} : { error: 'honesty gate failed' }),
    }, null, 2) + '\n');

    if (!gateOk) return;
  }

  // --- report ----------------------------------------------------------------------------------
  console.log(`\n=== auto-refresh report (${dryRun ? 'DRY RUN' : 'LIVE'}) ===`);
  console.log(`applied: ${applied.length}  held: ${held.length}  confirmed: ${confirmed.length}  new models (would add): ${newModels.length}  dropped: ${dropped.length}  absent 2 runs (would ask Judge): ${absentNow.length}`);
  console.log('\n-- applied (first 12) --');
  applied.slice(0, 12).forEach((a) => console.log(`  ${a.model} / ${a.field}: ${a.old} -> ${a.new} [${a.sources.join('+')}]`));
  console.log('\n-- held (first 8, genuine conflicts only) --');
  held.slice(0, 8).forEach((h) => console.log(`  ${h.model} / ${h.field}: ${h.reason}${h.current != null ? ` (current=${h.current}, candidate=${h.candidate})` : ''}`));
  console.log('\n-- new models (would add — publish-eligible) --');
  newModels.forEach((n) => console.log(`  ${n.name} (${n.vendor})`));
  if (absentNow.length) console.log('\n-- absent 2 consecutive runs (deprecation worklist item, never auto-applied) --\n' + absentNow.join(', '));
  console.log(`\n-- worklist for the Judge (${worklist.items.length} of ${worklistItems.length} candidates, first 10) --`);
  console.log('  by kind: ' + Object.entries(worklist.items.reduce((acc, i) => ((acc[i.kind] = (acc[i.kind] || 0) + 1), acc), {})).map(([k, n]) => `${k}=${n}`).join(' '));
  worklist.items.slice(0, 10).forEach((i) => console.log(`  [${i.kind}] ${i.model}: ${i.ask}`));

  if (!dryRun) await reportIssue(held);
}

/** File/update ONE GitHub issue for held items; close it when the list is empty. Idempotent by title. */
async function reportIssue(held) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY; // "owner/repo", set by Actions
  if (!token || !repo) { console.log('report: no GH_TOKEN/GITHUB_REPOSITORY — skipping issue (local run).'); return; }
  const title = 'Held for review — modelproof data refresh';
  const api = (path, opts = {}) => fetch(`https://api.github.com/repos/${repo}${path}`, {
    ...opts,
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', ...(opts.headers || {}) },
  });
  const list = await api('/issues?state=open&labels=data-refresh').then((r) => r.json());
  const existing = Array.isArray(list) ? list.find((i) => i.title === title) : null;

  if (!held.length) {
    if (existing) await api(`/issues/${existing.number}`, { method: 'PATCH', body: JSON.stringify({ state: 'closed' }) });
    console.log('report: no held items — issue closed/absent.');
    return;
  }
  const body = ['Auto-refresh held these facts for human review — single-source or out-of-bounds, ' +
    'not fabricated, not published.', '',
    ...held.slice(0, 50).map((h) => `- **${h.model}** / \`${h.field}\`: ${h.reason}`)].join('\n');
  if (existing) {
    await api(`/issues/${existing.number}`, { method: 'PATCH', body: JSON.stringify({ body }) });
    console.log(`report: updated issue #${existing.number}`);
  } else {
    const created = await api('/issues', { method: 'POST', body: JSON.stringify({ title, body, labels: ['data-refresh'] }) }).then((r) => r.json());
    console.log(`report: opened issue #${created.number}`);
  }
}

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
