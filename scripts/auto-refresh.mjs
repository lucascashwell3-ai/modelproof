#!/usr/bin/env node
/* Auto-refresh v1 (automation/PIPELINE_V1.md job 4). Publishes facts, not proposals.
   Stages: feed -> check -> publish -> report. See automation/jobs/auto-refresh/README.md.

   feed:    OpenRouter models API + LiteLLM price table (both Tier-A, public, no key) +
            vendor pages already listed in scripts/sources.json. Optional judgment layer
            (Anthropic API) reads a vendor page and extracts strict JSON, only when
            ANTHROPIC_API_KEY is set.
   check:   deterministic rules decide what counts as a fact (see FACT RULES below).
   publish: writes data/models.json + data/changelog.json, then runs the honesty gate.
   report:  prints applied/held counts; held items go to one GitHub issue (idempotent by title).

   Usage:
     node scripts/auto-refresh.mjs [--dry-run]
   Env:
     ANTHROPIC_API_KEY  optional — enables the judgment layer, capped at 40 calls/run.
     GH_TOKEN           required in CI to file/close the review issue (workflow_dispatch works
                         without it locally; the script just skips the issue step).
*/
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../', import.meta.url);
const dataUrl = new URL('data/models.json', ROOT);
const changelogUrl = new URL('data/changelog.json', ROOT);
const aliasUrl = new URL('scripts/model-aliases.json', ROOT);
const stateUrl = new URL('data/_auto_refresh_state.json', ROOT);

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
 * Returns { state, deprecatedNow: string[] } — ids that just crossed the 2-run threshold.
 */
export function trackDeprecation(state, presentIds, allModelIds) {
  const next = { ...state };
  const deprecatedNow = [];
  for (const id of allModelIds) {
    if (presentIds.has(id)) {
      next[id] = 0;
    } else {
      next[id] = (next[id] || 0) + 1;
      if (next[id] === 2) deprecatedNow.push(id);
    }
  }
  return { state: next, deprecatedNow };
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

/** Optional judgment layer. Only runs when ANTHROPIC_API_KEY is set. Cap 40 calls/run. */
async function judgeModel(model, vendorUrl, apiKey) {
  const prompt = `Extract current facts for the AI model "${model.name}" (vendor: ${model.vendor}) ` +
    `from this vendor page: ${vendorUrl}\n\n` +
    `Return STRICT JSON only, no prose, matching exactly:\n` +
    `{"price_input": number|null, "price_output": number|null, "context_window": number|null, ` +
    `"released": string|null, "deprecated": boolean, "benchmarks": {}, "sources": [string]}\n` +
    `Rules: price_input/price_output are USD per 1M tokens. Return null for anything not stated ` +
    `on the page. Never invent or estimate a number.`;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 1500,
      temperature: 0,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`judgment layer HTTP ${res.status}`);
  const json = await res.json();
  const text = (json.content || []).map((c) => c.text || '').join('');
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('judgment layer returned no JSON');
  return JSON.parse(match[0]);
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

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) console.log('judgment layer skipped: no ANTHROPIC_API_KEY');

  const applied = [];
  const held = [];
  const confirmed = [];
  const newModels = [];
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
      } else if (verdict.status === 'applied') {
        applied.push({ model: m.name, id: m.id, field: targetField, old: current, new: Math.round(verdict.value * 100) / 100, sources: verdict.sources });
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
      held.push({ model: c.name, field: 'new-model', reason: `admission rules not met (sources=${sourceCount} pricing=${hasPricing} vendor=${vendorKnown})` });
    }
  }

  // --- check: deprecation tracking ---------------------------------------------------------------
  const orNames = new Set(orList.map((c) => normalize(c.name)));
  const llmNames = new Set(llmList.map((c) => normalize(c.id)));
  const stillPresent = new Set();
  for (const m of data.models) {
    const inOr = orList.some((c) => matchAlias(c.name, [m], aliases) === m.id);
    const inLlm = llmList.some((c) => matchAlias(c.id, [m], aliases) === m.id);
    if (inOr || inLlm || (!orList.length && !llmList.length)) stillPresent.add(m.id);
  }
  const { state: nextState, deprecatedNow } = trackDeprecation(state, stillPresent, data.models.map((m) => m.id));

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
    for (const id of deprecatedNow) {
      const m = data.models.find((x) => x.id === id);
      if (m && !m.deprecated) { m.deprecated = true; changed = true; changelog.push({ date: today, model: m.name, field: 'deprecated', old: false, new: true, sources: ['auto-refresh: absent from all feeds for 2 consecutive runs'] }); }
    }
    for (const nm of newModels) {
      data.models.push(nm);
      changed = true;
      changelog.push({ date: today, model: nm.name, field: 'added', old: null, new: 'new model', sources: nm.sources });
    }
    if (changed) data.as_of = today;
    writeFileSync(stateUrl, JSON.stringify(nextState, null, 2) + '\n');

    if (changed) {
      writeFileSync(dataUrl, JSON.stringify(data, null, 2) + '\n');
      writeFileSync(changelogUrl, JSON.stringify(changelog, null, 2) + '\n');

      // honesty gate — must pass or nothing publishes
      const { execFileSync } = await import('node:child_process');
      try {
        execFileSync('node', [fileURLToPath(new URL('scripts/validate-data.mjs', ROOT))], { stdio: 'inherit' });
      } catch (e) {
        console.error('honesty gate failed — reverting write, nothing published.');
        process.exitCode = 1;
        return;
      }
    }
  }

  // --- report ----------------------------------------------------------------------------------
  console.log(`\n=== auto-refresh report (${dryRun ? 'DRY RUN' : 'LIVE'}) ===`);
  console.log(`applied: ${applied.length}  held: ${held.length}  confirmed: ${confirmed.length}  new models (would add): ${newModels.length}  deprecated: ${deprecatedNow.length}`);
  console.log('\n-- applied (first 12) --');
  applied.slice(0, 12).forEach((a) => console.log(`  ${a.model} / ${a.field}: ${a.old} -> ${a.new} [${a.sources.join('+')}]`));
  console.log('\n-- held (first 8, genuine conflicts only) --');
  held.slice(0, 8).forEach((h) => console.log(`  ${h.model} / ${h.field}: ${h.reason}${h.current != null ? ` (current=${h.current}, candidate=${h.candidate})` : ''}`));
  console.log('\n-- new models (would add — publish-eligible) --');
  newModels.forEach((n) => console.log(`  ${n.name} (${n.vendor})`));
  if (deprecatedNow.length) console.log('\n-- deprecated --\n' + deprecatedNow.join(', '));

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

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((e) => { console.error(e); process.exitCode = 1; });
}
