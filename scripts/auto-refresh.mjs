#!/usr/bin/env node
/* Collect v1.1 (automation/PIPELINE_V1.md "Modelproof refresh — v1.1"). Publishes facts, not
   proposals; hands anything it can't settle to worklist.json for the cloud Judge routine.
   Stages: feed -> check -> publish -> worklist -> report. See automation/jobs/auto-refresh/README.md.

   feed:     OpenRouter models API + LiteLLM price table (both Tier-A, public, no key) + Epoch
             (via scripts/collect-epoch.mjs, reused as a module) + LMArena leaderboard (best
             effort — public JSON/CSV; skipped with a note if unreachable, no scraping).
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
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../', import.meta.url);
const dataUrl = new URL('data/models.json', ROOT);
const changelogUrl = new URL('data/changelog.json', ROOT);
const aliasUrl = new URL('scripts/model-aliases.json', ROOT);
const stateUrl = new URL('data/_auto_refresh_state.json', ROOT);
const worklistUrl = new URL('data/refresh/worklist.json', ROOT);
const receiptUrl = new URL('data/refresh/receipt-collect.json', ROOT);

const MAX_WORKLIST = 15;
const WORKLIST_PRIORITY = { 'new-model': 0, conflict: 1, deprecation: 2, benchmark: 3, ladder: 4, release: 5 };
const LMARENA_URL = 'https://storage.googleapis.com/lmsys-arena-external/leaderboard_table.csv';

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

/** Loose containment match used only for new-model dedup (never for price facts). */
export function isKnownCandidate(name, models, aliases) {
  const n = canonicalKey(stripVariantSuffix(name));
  if (!n) return true; // empty name can't be a real candidate
  for (const m of models) {
    const known = [canonicalKey(m.name), canonicalKey(m.id), ...(aliases[m.id] || []).map(canonicalKey)];
    if (known.some((k) => k && (k === n || k.includes(n) || n.includes(k)))) return true;
  }
  return false;
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
 * Sort candidate worklist items by kind priority (new-model > conflict > benchmark > ladder >
 * release), then by id for a stable tie-break, and cap at MAX_WORKLIST. Same input always
 * produces the same output (idempotent) — nothing here depends on wall-clock time or Math.random.
 */
export function buildWorklist(items) {
  const sorted = [...items].sort((a, b) => {
    const pa = WORKLIST_PRIORITY[a.kind] ?? 99;
    const pb = WORKLIST_PRIORITY[b.kind] ?? 99;
    if (pa !== pb) return pa - pb;
    return String(a.id).localeCompare(String(b.id));
  });
  return sorted.slice(0, MAX_WORKLIST);
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

/** LMArena leaderboard — best effort. Public CSV export; no scraping if it moves or 404s. */
async function feedLmArena() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    let res;
    try {
      res = await fetch(LMARENA_URL, { signal: ctrl.signal });
    } finally {
      clearTimeout(t);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const [head, ...rows] = text.trim().split('\n').map((r) => r.split(','));
    const nameIdx = head.findIndex((h) => /model/i.test(h));
    const eloIdx = head.findIndex((h) => /elo|score|rating/i.test(h));
    if (nameIdx < 0 || eloIdx < 0) throw new Error('unexpected CSV shape');
    return rows.filter((r) => r.length > Math.max(nameIdx, eloIdx)).map((r) => ({
      source: 'lmarena', name: r[nameIdx], lmarena_elo: Number(r[eloIdx]) || null,
    }));
  } catch (e) {
    console.log(`feed: LMArena unreachable/unavailable (${e.message}) — skipping, no scraping fallback.`);
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

  console.log('feed: fetching OpenRouter + LiteLLM + LMArena...');
  const [orList, llmList, arenaList] = await Promise.all([feedOpenRouter(), feedLiteLLM(), feedLmArena()]);
  console.log(`feed: openrouter=${orList.length} litellm=${llmList.length} lmarena=${arenaList.length} candidates`);

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

    // LMArena elo — benchmark candidate, not an auto-applied fact (single source).
    if (m.benchmarks?.lmarena_elo == null) {
      const arenaMatch = arenaList.find((a) => matchAlias(a.name, [m], aliases) === m.id);
      if (arenaMatch?.lmarena_elo != null) {
        worklistItems.push({
          id: `${m.id}:lmarena_elo`, model: m.name, kind: 'benchmark', field: 'lmarena_elo', current: null,
          observations: [{ source: 'lmarena', url: LMARENA_URL, value: arenaMatch.lmarena_elo, date: today }],
          ask: `LMArena reports an elo of ${arenaMatch.lmarena_elo} for ${m.name} — corroborate against a second leaderboard or the vendor card before publishing.`,
        });
      }
    }
  }

  // --- check: new models -----------------------------------------------------------------------
  const seen = new Set();
  for (const c of orList) {
    if (/free|preview-\d|:online|extended/i.test(c.id || '')) continue; // variant, not a new model
    if (isKnownCandidate(c.name, data.models, aliases) || isKnownCandidate(c.id, data.models, aliases)) continue;
    const n = canonicalKey(stripVariantSuffix(c.name));
    if (!n || seen.has(n)) continue;
    if (c.created && (Date.parse(today) - Date.parse(c.created)) / 864e5 > 45) continue; // stale, not day-0
    const llmSame = llmList.find((l) => canonicalKey(l.id).includes(n) || n.includes(canonicalKey(l.id)));
    const sourceCount = 1 + (llmSame ? 1 : 0);
    const vendorGuess = (c.id || '').split('/')[0];
    const vendorKnown = isKnownVendor(vendorGuess);
    const hasPricing = c.priceInput != null || c.priceOutput != null || llmSame?.priceInput != null;
    seen.add(n);
    if (admitNewModel({ sourceCount, hasPricing, vendorKnown })) {
      newModels.push({
        id: c.id.replace(/[^a-z0-9]+/gi, '-').toLowerCase(),
        name: c.name,
        vendor: vendorGuess,
        released: c.created || null,
        context_window: c.contextWindow ?? llmSame?.contextWindow ?? null,
        price_input: c.priceInput != null ? Math.round(c.priceInput * 100) / 100 : (llmSame?.priceInput ?? null),
        price_output: c.priceOutput != null ? Math.round(c.priceOutput * 100) / 100 : (llmSame?.priceOutput ?? null),
        speed_tps: null,
        benchmarks: { swe_bench: null, gpqa: null, aime: null, mmlu_pro: null, lmarena_elo: null },
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
      const reason = `admission rules not met (sources=${sourceCount} pricing=${hasPricing} vendor=${vendorKnown})`;
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

  // --- worklist (computed regardless of dry-run, so --dry-run can preview it) ------------------
  const worklist = { generated: today, items: buildWorklist(worklistItems) };

  // --- publish -------------------------------------------------------------------------------
  let changed = false;
  if (!dryRun) {
    for (const a of applied) {
      const m = data.models.find((x) => x.id === a.id);
      if (!m) continue;
      m[a.field] = a.new;
      changed = true;
      changelog.push({ date: today, model: a.model, field: a.field, old: a.old, new: a.new, sources: a.sources });
    }
    for (const nm of newModels) {
      data.models.push(nm);
      changed = true;
      changelog.push({ date: today, model: nm.name, field: 'added', old: null, new: 'new model', sources: nm.sources });
      data.releases = data.releases || [];
      data.releases.push({
        date: nm.released ? String(nm.released).slice(0, 10) : today,
        vendor: nm.vendor,
        title: `${nm.vendor} releases ${nm.name}`,
        summary: `Auto-added from OpenRouter/LiteLLM — pricing and context window sourced, benchmarks not yet verified.`,
        source: nm.sources[0],
        why: 'New listing — check back once benchmarks are sourced.',
      });
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
      confirmed: confirmed.length, new_models: newModels.length, worklist_items: worklist.items.length,
      ok: gateOk, ...(gateOk ? {} : { error: 'honesty gate failed' }),
    }, null, 2) + '\n');

    if (!gateOk) return;
  }

  // --- report ----------------------------------------------------------------------------------
  console.log(`\n=== auto-refresh report (${dryRun ? 'DRY RUN' : 'LIVE'}) ===`);
  console.log(`applied: ${applied.length}  held: ${held.length}  confirmed: ${confirmed.length}  new models (would add): ${newModels.length}  absent 2 runs (would ask Judge): ${absentNow.length}`);
  console.log('\n-- applied (first 12) --');
  applied.slice(0, 12).forEach((a) => console.log(`  ${a.model} / ${a.field}: ${a.old} -> ${a.new} [${a.sources.join('+')}]`));
  console.log('\n-- held (first 8, genuine conflicts only) --');
  held.slice(0, 8).forEach((h) => console.log(`  ${h.model} / ${h.field}: ${h.reason}${h.current != null ? ` (current=${h.current}, candidate=${h.candidate})` : ''}`));
  console.log('\n-- new models (would add — publish-eligible) --');
  newModels.forEach((n) => console.log(`  ${n.name} (${n.vendor})`));
  if (absentNow.length) console.log('\n-- absent 2 consecutive runs (deprecation worklist item, never auto-applied) --\n' + absentNow.join(', '));
  console.log(`\n-- worklist for the Judge (${worklist.items.length} of ${worklistItems.length} candidates, first 10) --`);
  worklist.items.slice(0, 10).forEach((i) => console.log(`  [${i.kind}] ${i.model}: ${i.ask}`));

  if (!dryRun) await reportIssue(held);
}

/** File/update ONE GitHub issue for held items; close it when the list is empty. Idempotent by title. */
async function reportIssue(held) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY; // "owner/repo", set by Actions
  if (!token || !repo) { console.log('report: no GH_TOKEN/GITHUB_REPOSITORY — skipping issue (local run).'); return; }
  const title = 'Needs Lucas — modelproof data refresh';
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
