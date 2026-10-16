#!/usr/bin/env node
/* Honesty gate for data/models.json. Run in CI on every push to the auto-refresh PR branch:
   a guessed/unsourced value must NOT be able to merge. Exits non-zero on any error.
   Also enforces the naming rule (scripts/naming.mjs): ids derive from names, vendors are canonical.
   Also enforces the data contract (FEEDS below): every data file a page shows carries a file-level
   as_of, and every line it shows carries a source and a date of its own or inherits them.
   Usage: node scripts/validate-data.mjs [--data <dir>]
     --data  validate the data files in <dir> instead of data/ (the release drill and the tests
             run the gate on a temp copy this way). testers.json is a static registry and is
             always read from data/.
   As a module: validate(data, registry) -> { errors, warnings } (unit-tested in test-auto-refresh.mjs);
   FEEDS + validateFeeds(files, {today}) -> { errors, warnings } (unit-tested in test-data-contract.mjs). */
import { readFileSync, realpathSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { namingProblems, canonicalVendor, VENDORS } from './naming.mjs';
import { TASK_IDS, BASIS_TOKENS } from './derive-task-fit.mjs';
import { STATUS_VALUES, ADOPTION_VALUES, deriveStatus, deriveAdoption } from './derive-status-adoption.mjs';
import { RELEASED_RE } from './timeline.mjs';

// data/testers.json's own tester ids — every standings.measured[].tester must name one of these
// (scripts/derive-standings.mjs). Read once at module load, same as every other
// static registry this gate cross-checks against (BENCHES, VENDOR, etc.).
const TESTERS_FILE = JSON.parse(readFileSync(new URL('../data/testers.json', import.meta.url)));
const TESTER_IDS = new Set(TESTERS_FILE.testers.map((t) => t.id));
export const STANDINGS_LICENCE_VALUES = ['display-ok', 'signal-only'];
// scripts/derive-standings.mjs's EPOCH_FILE_CONFIG entries route by this field on their own
// data/testers.json per_benchmark entry — "measured" (default, absent counts as this) or
// "preferred" (a mirrored blind-vote board like webdev_arena_external, brain v2 step 2). Any other
// value is a typo, not a third kind — this file has never defined one.
export const EPOCH_PER_BENCHMARK_KIND_VALUES = ['measured', 'preferred'];

const CONF = ['low', 'medium', 'high'];
const VOCAB = ['reasoning', 'agentic', 'coding', 'research', 'long-context', 'writing', 'cheap-bulk', 'speed', 'vision'];
const BENCHES = ['swe_bench', 'gpqa', 'aime', 'mmlu_pro'];   // lmarena_elo dropped 2026-08-22
const num = (v) => v === null || v === undefined || Number.isNaN(v);

// --- judged task fit (task_fit_judged) — the qualitative-evidence gate ------------------------
// A judged record (v3, 2026-09) is claims[] + reconciliation + as_of — no grade, no number.
// `band`/`confidence` were the old AI-judged fields (archive/engine/assets/decide.mjs never read them for
// ranking even before this — brain v2 step 3, PR #34 — this just removes them from the shape
// entirely, so the old cloud routine's pre-v3 output can't sneak back in). This block checks
// SHAPE ONLY: no band/confidence present, every claim carries the required fields, dates are
// real dates, enums are in-vocab, and no claim/reconciliation sentence uses relative/superlative
// language a newer model would immediately falsify ("best available", "the top model" — see
// BANNED_RELATIVE below). It does NOT confirm a quote is actually on the page; that live check is
// scripts/check-sources.mjs, which fetches every claim's source_url and can't run inside this
// synchronous, offline gate. The two are complementary, not redundant: this catches a malformed
// or dishonestly-worded claim before it's even written; check-sources.mjs catches a well-formed
// claim that quotes something the page doesn't actually say.
export const CLAIM_TIERS = ['lab', 'reported', 'measured', 'usage'];
// v3 (2026-09): a claim may mark itself a sourced practical drawback (rate limits, latency,
// tool-call failures, price traps) rather than a strength — archive/engine/assets/decide.mjs's hasNegativeClaim
// drops a model one tier for a task where any claim carries this. Absent = an ordinary claim.
export const CLAIM_POLARITY_VALUES = ['negative'];
// Absolute, dated facts only — a record must stay true after a newer model supersedes this one.
// Applied to OUR OWN prose (claim.sentence, reconciliation) — never to `quote`, which is verbatim
// text copied from the source and reproduced as a quotation, not asserted as our own claim.
export const BANNED_RELATIVE_PATTERNS = [
  /\bbest available\b/i, /\bthe top model\b/i, /\btop model\b/i, /\bbest[- ]in[- ]class\b/i,
  /\bstate[- ]of[- ]the[- ]art\b/i, /\bmost capable\b/i, /\bmost advanced\b/i,
  /\bindustry[- ]leading\b/i, /\bworld'?s best\b/i, /\bunmatched\b/i, /\bunrivale?d\b/i,
  /\bsuperior to\b/i, /\bbetter than (any|all|every)\b/i, /\bleading model\b/i,
  /\bcutting[- ]edge\b/i, /\bnumber one\b/i, /\b#1\b/, /\btop[- ]tier\b/i, /\bpremier\b/i,
  /\bbest model\b/i, /\bthe best\b/i,
];
export function bannedPhraseIn(text) {
  const hit = BANNED_RELATIVE_PATTERNS.find((re) => re.test(String(text || '')));
  return hit ? hit.source : null;
}
export const wordCount = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;

// A claim citing one of these hosts can never stay verified, for one of two reasons:
//   - live feed: the page is one this codebase now re-derives every day into model.standings
//     (scripts/derive-standings.mjs) — its quoted numbers change daily, and arena.ai no longer
//     even server-renders its table for scripts/check-sources.mjs to read. The SAME evidence is
//     already the dated, linked standings.chosen/standings.preferred record — a claim citing
//     these hosts was only ever restating that, never independent evidence worth its own citation.
//   - display-banned: artificialanalysis.ai's own terms ban DISPLAYING its content outside a paid
//     tier (data/testers.json's "artificial-analysis" entry: verdict "signal-only", notes
//     "Display-BANNED stands" — a claim's `sentence`/`quote` displaying its numbers is exactly
//     the redistribution its terms reserve; added 2026-09, round 3, after check-sources.mjs also
//     kept failing 4 of its claims for content drift, on top of the licence problem).
// 2026-09 migration (scripts/migrate-claims-2026-09.mjs) removed every existing claim citing one
// of these; this is the permanent gate that stops a new one from being added back in (by
// apply-judgment.mjs's pre-flight validator, and here, so any other path that writes
// data/models.json is caught too).
export const LIVE_FEED_URL_PATTERNS = [
  /^https:\/\/openrouter\.ai\/api\/frontend\//,
  /^https:\/\/openrouter\.ai\/rankings/,
  /^https:\/\/arena\.ai\//,
  /^https:\/\/(?:www\.)?artificialanalysis\.ai\//,
];
export function citesLiveFeed(url) {
  return LIVE_FEED_URL_PATTERNS.some((re) => re.test(String(url || '')));
}
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Shape problems for ONE sourced claim — the same rules for a judged task-fit claim in
 * data/models.json and a guidance claim in data/guidance.json. Returns error strings, each
 * prefixed with `label` (empty = valid). `tiers` is the allowed tier list for the file the claim
 * lives in (CLAIM_TIERS for models.json, GUIDANCE_TIERS for guidance.json). */
export function claimProblems(c, label, { tiers = CLAIM_TIERS } = {}) {
  const out = [];
  if (!c || typeof c !== 'object') return [`${label} must be an object`];
  if (!c.sentence || typeof c.sentence !== 'string') out.push(`${label}.sentence is required`);
  else {
    const hit = bannedPhraseIn(c.sentence);
    if (hit) out.push(`${label}.sentence uses a banned relative phrase (/${hit}/) — write an absolute, dated fact instead`);
  }
  if (!c.source_url || !/^https?:\/\//i.test(c.source_url)) out.push(`${label}.source_url "${c.source_url}" must be http(s)`);
  else if (citesLiveFeed(c.source_url)) out.push(`${label}.source_url "${c.source_url}" cites a live feed this codebase already re-derives daily into standings (OpenRouter rankings/arena.ai) — its numbers change every day and can never stay verified by scripts/check-sources.mjs; cite the standings record instead (model.standings[taskId]), or a stable page`);
  if (!tiers.includes(c.tier)) out.push(`${label}.tier "${c.tier}" must be one of ${tiers.join(', ')}`);
  if (!c.date || !DATE_RE.test(c.date)) out.push(`${label}.date "${c.date}" must be a YYYY-MM-DD date`);
  if (!c.quote || typeof c.quote !== 'string') out.push(`${label}.quote is required (verbatim text copied from source_url)`);
  else if (wordCount(c.quote) > 25) out.push(`${label}.quote is ${wordCount(c.quote)} word(s) — must be ≤25 words, copied verbatim from the source`);
  if (c.polarity != null && !CLAIM_POLARITY_VALUES.includes(c.polarity)) out.push(`${label}.polarity "${c.polarity}" must be one of ${CLAIM_POLARITY_VALUES.join(', ')}`);
  return out;
}

// --- data/guidance.json — sourced facts the instruction package is built from ----------------
// Claims come from a coding tool's own docs (tier "tool") or a model maker's own docs about its
// own models (tier "lab"). role_defaults may name a model for a helper job only where one of the
// tool's or lab's own claims names that job; the reviewer always runs on the lead's model.
export const GUIDANCE_TIERS = ['tool', 'lab'];
export const GUIDANCE_TOPICS = ['instruction-files', 'enforced-model', 'effort', 'lead-helper', 'model-per-job', 'context'];
// Tool ids the package targets -> the name its claims use as subject.name.
export const GUIDANCE_TOOLS = {
  'claude-code': 'Claude Code', codex: 'Codex CLI', cursor: 'Cursor', 'agents-md': 'AGENTS.md',
  copilot: 'GitHub Copilot', antigravity: 'Antigravity', openrouter: 'OpenRouter',
};
export const GUIDANCE_ROLES = ['scout', 'builder', 'reviewer'];
// Tools with facts in the file that the package doesn't write for (yet) — still valid subjects.
export const GUIDANCE_EXTRA_TOOL_NAMES = ['Gemini CLI'];
// Our own prose (sentence, _readme) never ranks one model against another. Quotes are exempt —
// they are the source's words, reproduced verbatim.
export const GUIDANCE_BANNED_PATTERNS = [
  /\bbest\b/i, /\bbetter\b/i, /\btop\b/i, /\bwinner\b/i, /\bpick(s|ed|ing)?\b/i, /\brecommend/i,
  /\bsuggest/i, /\bverdict\b/i, /\bconfiden/i, /\bstart here\b/i,
];
export function guidanceBannedIn(text) {
  const s = String(text || '');
  const hit = GUIDANCE_BANNED_PATTERNS.find((re) => re.test(s));
  return hit ? hit.source : bannedPhraseIn(s);
}

/** Validate data/guidance.json against the catalog. `models` is data/models.json (or its
 * models array). Returns { errors, warnings }. */
export function validateGuidance(guidance, models) {
  const errors = [], warnings = [];
  const E = (m) => errors.push(m);
  const list = Array.isArray(models) ? models : (models && Array.isArray(models.models) ? models.models : []);
  const byId = new Map(list.map((m) => [m.id, m]));
  const G = 'data/guidance.json';
  if (!guidance || typeof guidance !== 'object' || Array.isArray(guidance)) return { errors: [`${G}: must be an object`], warnings };
  if (!guidance._readme || typeof guidance._readme !== 'string') E(`${G}: _readme must say what the file is`);
  else if (guidanceBannedIn(guidance._readme)) E(`${G}: _readme uses a ranking word (/${guidanceBannedIn(guidance._readme)}/)`);
  if (!guidance.as_of || !DATE_RE.test(guidance.as_of)) E(`${G}: as_of "${guidance.as_of}" must be a YYYY-MM-DD date`);

  const toolNames = new Set([...Object.values(GUIDANCE_TOOLS), ...GUIDANCE_EXTRA_TOOL_NAMES]);
  const claims = new Map();
  if (!Array.isArray(guidance.claims) || !guidance.claims.length) E(`${G}: claims must be a non-empty array`);
  else guidance.claims.forEach((c, i) => {
    const label = `${G} claims[${i}]${c && c.id ? ` (${c.id})` : ''}`;
    if (!c || typeof c !== 'object') { E(`${label} must be an object`); return; }
    if (!c.id || typeof c.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(c.id)) E(`${label}.id must be a lowercase-hyphen id`);
    else if (claims.has(c.id)) E(`${label}.id "${c.id}" is used twice`);
    else claims.set(c.id, c);
    const s = c.subject;
    if (!s || typeof s !== 'object' || !['tool', 'lab'].includes(s.kind) || !s.name) E(`${label}.subject must be {kind: "tool"|"lab", name}`);
    else {
      if (s.kind === 'lab' && !VENDORS.includes(s.name)) E(`${label}.subject.name "${s.name}" is not a canonical vendor in scripts/naming.mjs VENDORS`);
      if (s.kind === 'tool' && !toolNames.has(s.name)) E(`${label}.subject.name "${s.name}" is not a known tool (${[...toolNames].join(', ')})`);
      if (c.tier && s.kind !== c.tier) E(`${label}.tier "${c.tier}" must match subject.kind "${s.kind}" — a tool claim cites the tool's docs, a lab claim the lab's own docs`);
    }
    if (!GUIDANCE_TOPICS.includes(c.topic)) E(`${label}.topic "${c.topic}" must be one of ${GUIDANCE_TOPICS.join(', ')}`);
    for (const p of claimProblems(c, label, { tiers: GUIDANCE_TIERS })) E(p);
    if (typeof c.sentence === 'string' && !bannedPhraseIn(c.sentence)) {
      const hit = guidanceBannedIn(c.sentence);
      if (hit) E(`${label}.sentence uses a ranking word (/${hit}/) — state what the source says, never a comparison`);
    }
  });

  // superseded_by (written by scripts/defaults-watch.mjs when a page changes): the old claim stays
  // as history and names the claim that replaced it; check-sources skips it; no basis may name it.
  for (const c of claims.values()) {
    if (c.superseded_by == null) continue;
    if (typeof c.superseded_by !== 'string' || !claims.has(c.superseded_by) || c.superseded_by === c.id) E(`${G} claim ${c.id}: superseded_by "${c.superseded_by}" must be the id of another claim in this file`);
  }
  const supersededIn = (node, label) => {
    if (Array.isArray(node)) { node.forEach((x, i) => supersededIn(x, `${label}[${i}]`)); return; }
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (k === 'basis' && Array.isArray(v)) for (const id of v) { if (claims.get(id)?.superseded_by != null) E(`${label}.basis names "${id}", which is superseded by "${claims.get(id).superseded_by}" — name the newer claim`); }
      else if (k !== 'claims' && v && typeof v === 'object') supersededIn(v, `${label}.${k}`);
    }
  };
  supersededIn(guidance, G);

  const basisProblems = (basis, label) => {
    if (!Array.isArray(basis) || !basis.length) return [`${label}.basis must be a non-empty array of claim ids`];
    return basis.filter((id) => !claims.has(id)).map((id) => `${label}.basis names "${id}", which is not a claim id in this file`);
  };
  const modelProblems = (modelId, label, lab) => {
    if (modelId === null) return [];
    if (typeof modelId !== 'string' || !byId.has(modelId)) return [`${label}.model_id "${modelId}" is not a model id in data/models.json (use null when there is none)`];
    if (lab && byId.get(modelId).vendor !== lab) return [`${label}.model_id "${modelId}" is a ${byId.get(modelId).vendor} model — a default from ${lab} may only name ${lab}'s own models`];
    return [];
  };

  const seenRole = new Set();
  if (!Array.isArray(guidance.role_defaults)) E(`${G}: role_defaults must be an array`);
  else guidance.role_defaults.forEach((r, i) => {
    const label = `${G} role_defaults[${i}]`;
    if (!r || typeof r !== 'object') { E(`${label} must be an object`); return; }
    if (!Object.prototype.hasOwnProperty.call(GUIDANCE_TOOLS, r.tool)) E(`${label}.tool "${r.tool}" must be one of ${Object.keys(GUIDANCE_TOOLS).join(', ')}`);
    if (!GUIDANCE_ROLES.includes(r.role)) E(`${label}.role "${r.role}" must be one of ${GUIDANCE_ROLES.join(', ')}`);
    if (r.role === 'reviewer') E(`${label}: no default for the reviewer — it runs on the lead's model (inherit)`);
    const key = `${r.tool}/${r.role}`;
    if (seenRole.has(key)) E(`${label}: a second default for ${key}`);
    seenRole.add(key);
    if (!VENDORS.includes(r.lab)) E(`${label}.lab "${r.lab}" is not a canonical vendor`);
    if (r.model_ref !== null && (typeof r.model_ref !== 'string' || !r.model_ref.trim())) E(`${label}.model_ref must be the string the tool's config accepts, or null`);
    for (const p of modelProblems(r.model_id, label, r.lab)) E(p);
    const bp = basisProblems(r.basis, label);
    bp.forEach(E);
    if (!bp.length) {
      const own = r.basis.map((id) => claims.get(id)).some((c) => c.subject && (
        (c.subject.kind === 'tool' && c.subject.name === GUIDANCE_TOOLS[r.tool]) || (c.subject.kind === 'lab' && c.subject.name === r.lab)));
      if (!own) E(`${label}.basis has no claim from ${GUIDANCE_TOOLS[r.tool] || r.tool} or ${r.lab} itself — a default must come from the tool's or lab's own docs`);
    }
  });

  const seenRef = new Set();
  if (!Array.isArray(guidance.model_refs)) E(`${G}: model_refs must be an array`);
  else guidance.model_refs.forEach((m, i) => {
    const label = `${G} model_refs[${i}]`;
    if (!m || typeof m !== 'object') { E(`${label} must be an object`); return; }
    if (!Object.prototype.hasOwnProperty.call(GUIDANCE_TOOLS, m.tool)) E(`${label}.tool "${m.tool}" must be one of ${Object.keys(GUIDANCE_TOOLS).join(', ')}`);
    if (!m.ref || typeof m.ref !== 'string') E(`${label}.ref must be a non-empty string`);
    const key = `${m.tool}/${m.ref}`;
    if (seenRef.has(key)) E(`${label}: ${key} is mapped twice`);
    seenRef.add(key);
    for (const p of modelProblems(m.model_id, label, null)) E(p);
    basisProblems(m.basis, label).forEach(E);
  });
  // Every role default's model_ref must agree with the tool's own ref map when both exist.
  if (Array.isArray(guidance.role_defaults) && Array.isArray(guidance.model_refs)) {
    for (const r of guidance.role_defaults) {
      const ref = guidance.model_refs.find((m) => m && r && m.tool === r.tool && m.ref === r.model_ref);
      if (ref && ref.model_id !== r.model_id) E(`${G} role_defaults ${r.tool}/${r.role}: model_id "${r.model_id}" disagrees with model_refs ${r.tool}/${r.model_ref} -> "${ref.model_id}"`);
    }
  }

  if (!Array.isArray(guidance.effort_pages)) E(`${G}: effort_pages must be an array`);
  else guidance.effort_pages.forEach((p, i) => {
    const label = `${G} effort_pages[${i}]`;
    if (!p || typeof p !== 'object') { E(`${label} must be an object`); return; }
    if (!VENDORS.includes(p.lab)) E(`${label}.lab "${p.lab}" is not a canonical vendor`);
    if (!p.url || !/^https?:\/\//i.test(p.url)) E(`${label}.url "${p.url}" must be http(s)`);
    const bp = basisProblems(p.basis, label);
    bp.forEach(E);
    if (!bp.length) for (const id of p.basis) {
      const c = claims.get(id);
      if (!c.subject || c.subject.kind !== 'lab' || c.subject.name !== p.lab) E(`${label}.basis "${id}" is not a claim from ${p.lab}`);
    }
  });
  toolPlanProblems(guidance, claims, byId).forEach(E);
  return { errors, warnings };
}

// --- paths into the data for the defaults watch (data/defaults-watch.json maps_to / also) ------
// Shared by scripts/defaults-watch.mjs (reads and writes) and validateWatchList below. A path starts
// with the file — guidance. or plans. — then keys; a bracket step [key=value] picks the one array row
// whose key equals value (several brackets: several keys):
//   guidance.tool_plans[tool=codex].lead.model_id
//   guidance.model_refs[tool=claude-code][ref=opus].model_id
//   plans.plans[vendor=Devin][plan=Teams].base_usd_month
/** "guidance.tool_plans[tool=codex].lead.model_id" -> {file:'guidance', steps:[...]}. A bracket
 * step filters an array by key=value; several brackets filter on several keys. */
export function parsePath(path) {
  const m = /^(guidance|plans)\.(.+)$/.exec(String(path || ''));
  if (!m) throw new Error(`bad path "${path}": must start with guidance. or plans.`);
  const steps = [];
  const re = /([A-Za-z_][A-Za-z0-9_]*)((?:\[[^\]=]+=[^\]]*\])*)\.?/y;
  let rest = m[2];
  let pos = 0;
  while (pos < rest.length) {
    re.lastIndex = pos;
    const s = re.exec(rest);
    if (!s || s[0] === '') throw new Error(`bad path "${path}" near "${rest.slice(pos)}"`);
    steps.push({ key: s[1] });
    if (s[2]) {
      const where = [...s[2].matchAll(/\[([^\]=]+)=([^\]]*)\]/g)].map((x) => [x[1], x[2]]);
      steps.push({ where });
    }
    pos = re.lastIndex;
  }
  return { file: m[1], steps };
}

function walkPath(data, path, { parent = false } = {}) {
  const { file, steps } = parsePath(path);
  let node = data[file];
  const upto = parent ? steps.length - 1 : steps.length;
  for (let i = 0; i < upto; i += 1) {
    const st = steps[i];
    if (node == null) return { found: false };
    if (st.where) {
      if (!Array.isArray(node)) return { found: false };
      const hits = node.filter((el) => el && st.where.every(([k, v]) => String(el[k]) === v));
      if (hits.length !== 1) return { found: false, reason: `${hits.length} rows match [${st.where.map((w) => w.join('=')).join('][')}]` };
      node = hits[0];
    } else {
      if (typeof node !== 'object' || !(st.key in node)) return { found: false };
      node = node[st.key];
    }
  }
  return parent ? { found: true, node, key: steps[steps.length - 1].key } : { found: true, value: node };
}

/** The value at `path` in {guidance, plans}; undefined when the path does not resolve. */
export function getPath(data, path) {
  const r = walkPath(data, path);
  return r.found ? r.value : undefined;
}

/** Set the value at `path` (its parent must exist). */
export function setPath(data, path, value) {
  const r = walkPath(data, path, { parent: true });
  if (!r.found || r.node == null || typeof r.node !== 'object' || r.key == null) throw new Error(`cannot set ${path}`);
  r.node[r.key] = value;
}

/** The plans.json row a plans.plans[...] path points into. */
export function planRow(data, path) {
  const { steps } = parsePath(path);
  const where = steps.find((s) => s.where);
  if (!where) return null;
  const hits = (data.plans.plans || []).filter((el) => el && where.where.every(([k, v]) => String(el[k]) === v));
  return hits.length === 1 ? hits[0] : null;
}

/** `{form:tool.slot}` in a rule's anchor, pattern or sentence: filled from the data at run time.
 * form = name | short | slug | ref | id; slot = lead | push_down | bulk | ref.<r> | role.<role>. */
export const PLACEHOLDER_RE = /\{(name|short|slug|ref|id):([a-z0-9-]+(?:\.[a-z0-9_-]+)+)\}/g;

// --- data/defaults-watch.json — the weekly defaults watch's rules (config, not a site feed) ----
// scripts/defaults-watch.mjs reads each rule's page and compares the captured value with the data.
// No rule stores the value it expects: a "field" rule compares with (and on a change writes) the
// value at `maps_to`; a "flag" rule only lists a change, comparing with `maps_to`, a claim's quote
// or sentence (`baseline.claim`), or a `baseline.sentinel` (a value the data does not hold).
export const WATCH_VALUES = ['model', 'word', 'last-word', 'list', 'price', 'text'];
export const WATCH_WRITES = ['field', 'flag'];
const WATCH_KEYS = new Set(['id', 'tool', 'field', 'url', 'anchor', 'pattern', 'value', 'value_to_id', 'first_match', 'write', 'maps_to', 'also', 'ref_row', 'claim_ids', 'baseline', 'sentence', 'judge']);
const WATCH_SLOT_RE = /^[a-z0-9-]+\.(lead|push_down|bulk|ref\.[a-z0-9._-]+|role\.[a-z]+)$/;

/** Problems in data/defaults-watch.json. errors = the file's own shape (a rule that can never run
 * right); warnings = a path or claim id that does not resolve in today's data ({guidance, plans}).
 * Those are warnings on purpose: the Judge or a person may change guidance.json, and the honesty
 * gate must never block a data write over the watch list — the weekly run reports such a rule as
 * broken (red) instead. Returns {errors, warnings}. */
export function validateWatchList(watch, { guidance = null, plans = null } = {}) {
  const W = 'data/defaults-watch.json';
  const out = [];
  const warn = [];
  if (!watch || typeof watch !== 'object' || Array.isArray(watch)) return { errors: [`${W}: must be an object`], warnings: warn };
  if (!watch._readme || typeof watch._readme !== 'string') out.push(`${W}: _readme must say what the file is`);
  if (!Array.isArray(watch.rules) || !watch.rules.length) return { errors: [...out, `${W}: rules must be a non-empty array`], warnings: warn };
  const data = { guidance: guidance || {}, plans: plans || {} };
  const claimIds = new Set(((guidance && guidance.claims) || []).map((c) => c && c.id));
  const ids = new Set();
  const isStr = (v) => typeof v === 'string' && v.trim() !== '';
  const resolves = (path, label) => {
    try { parsePath(path); } catch (e) { out.push(`${label}: ${e.message}`); return false; }
    if (getPath(data, path) === undefined) { warn.push(`${label} "${path}" does not resolve in the data — the weekly run will report this rule broken`); return false; }
    return true;
  };
  watch.rules.forEach((r, i) => {
    const label = `${W} rules[${i}]${r && r.id ? ` (${r.id})` : ''}`;
    if (!r || typeof r !== 'object' || Array.isArray(r)) { out.push(`${label} must be an object`); return; }
    for (const k of Object.keys(r)) if (!WATCH_KEYS.has(k)) out.push(`${label}: unknown key "${k}"${k === 'expected' ? ' — a rule never stores the value it expects; the data holds it' : ''}`);
    if (!isStr(r.id) || !/^[a-z0-9][a-z0-9._-]*$/.test(r.id)) out.push(`${label}.id must be a lowercase id`);
    else if (ids.has(r.id)) out.push(`${label}.id "${r.id}" is used twice`);
    else ids.add(r.id);
    for (const k of ['tool', 'field', 'anchor', 'pattern']) if (!isStr(r[k])) out.push(`${label}.${k} is required`);
    if (!isStr(r.url) || !/^https?:\/\//.test(r.url)) out.push(`${label}.url must be an http(s) URL`);
    for (const k of ['anchor', 'pattern', 'sentence']) {
      if (!isStr(r[k])) continue;
      for (const m of r[k].matchAll(PLACEHOLDER_RE)) if (!WATCH_SLOT_RE.test(m[2])) out.push(`${label}.${k}: placeholder ${m[0]} names no slot (tool.lead|push_down|bulk|ref.<r>|role.<role>)`);
    }
    if (isStr(r.pattern)) {
      try {
        const re = new RegExp(r.pattern.replace(PLACEHOLDER_RE, 'x'));
        if (!/\((?!\?)/.test(re.source.replace(/\\\\|\\\(/g, ''))) out.push(`${label}.pattern needs a capture group (group 1 is the value)`);
      } catch (e) { out.push(`${label}.pattern does not compile: ${e.message}`); }
    }
    if (!WATCH_VALUES.includes(r.value)) out.push(`${label}.value "${r.value}" must be one of ${WATCH_VALUES.join(', ')}`);
    if (r.value_to_id != null && (r.value !== 'model' || !/^(claude|direct|ref:[a-z0-9-]+)$/.test(r.value_to_id))) out.push(`${label}.value_to_id is for model values only: claude | direct | ref:<tool>`);
    if (r.first_match != null && typeof r.first_match !== 'boolean') out.push(`${label}.first_match must be true or false`);
    if (r.judge != null && !isStr(r.judge)) out.push(`${label}.judge must be a question`);
    if (!WATCH_WRITES.includes(r.write)) { out.push(`${label}.write "${r.write}" must be field or flag`); return; }
    const claimsOk = (list, what) => {
      if (!Array.isArray(list)) { out.push(`${label}.${what} must be a list of claim ids`); return; }
      for (const id of list) if (!claimIds.has(id)) warn.push(`${label}.${what} names "${id}", which is not a claim id in data/guidance.json — the weekly run will list this rule for review`);
    };
    if (r.write === 'field') {
      if (r.baseline !== undefined) out.push(`${label}: a field rule compares with maps_to, never a baseline`);
      if (!r.maps_to && !(Array.isArray(r.claim_ids) && r.claim_ids.length)) out.push(`${label}: a field rule needs maps_to or claim_ids`);
      if (r.maps_to !== undefined) {
        if (!isStr(r.maps_to)) out.push(`${label}.maps_to must be one path`);
        else if (resolves(r.maps_to, `${label}.maps_to`)) {
          if (r.maps_to.startsWith('plans.') && r.value !== 'price') out.push(`${label}: a plans.json path takes a price value`);
          const held = JSON.stringify(getPath(data, r.maps_to));
          for (const [j, p] of (r.also || []).entries()) {
            if (resolves(p, `${label}.also[${j}]`) && JSON.stringify(getPath(data, p)) !== held) warn.push(`${label}.also[${j}] "${p}" holds a different value than maps_to — a change would overwrite it with the maps_to value`);
          }
        }
      }
      if (r.also !== undefined && !Array.isArray(r.also)) out.push(`${label}.also must be a list of paths`);
      if (r.ref_row != null && (r.ref_row !== true || r.value !== 'model')) out.push(`${label}.ref_row is true or absent, and only on a model value`);
      if (r.claim_ids !== undefined) {
        claimsOk(r.claim_ids, 'claim_ids');
        if (r.claim_ids.length) {
          if (!isStr(r.sentence)) out.push(`${label}.sentence is required: the template for each new claim's sentence`);
          else { const hit = guidanceBannedIn(r.sentence.replace(PLACEHOLDER_RE, 'x')); if (hit) out.push(`${label}.sentence uses a ranking word (/${hit}/)`); }
        }
      }
    } else {
      for (const k of ['also', 'ref_row', 'claim_ids', 'sentence']) if (r[k] !== undefined) out.push(`${label}.${k}: a flag rule writes nothing`);
      const b = r.baseline;
      const kinds = [r.maps_to !== undefined, !!(b && b.claim !== undefined), !!(b && b.sentinel !== undefined)].filter(Boolean).length;
      if (kinds !== 1) out.push(`${label}: a flag rule compares with exactly one of maps_to, baseline.claim, baseline.sentinel`);
      if (r.maps_to !== undefined) { if (isStr(r.maps_to)) resolves(r.maps_to, `${label}.maps_to`); else out.push(`${label}.maps_to must be one path`); }
      if (b && b.claim !== undefined) {
        claimsOk([b.claim], 'baseline.claim');
        if (b.in != null && !['quote', 'sentence'].includes(b.in)) out.push(`${label}.baseline.in must be quote or sentence`);
      }
      if (b && b.sentinel !== undefined && !isStr(b.sentinel)) out.push(`${label}.baseline.sentinel must be text`);
    }
  });
  return { errors: out, warnings: warn };
}

// --- guidance.json tool_plans: one Lead / Helpers / Bulk plan per tool -----------------------
// { tool, as_of, instruction_files[{path, basis}], enforced[{what, basis}], effort_levels?{values, basis},
//   lead{model_id | choice, effort, raise_to?, when?, basis}, helpers{model:"inherit", basis, push_down?} | null,
//   bulk{model_id | choice, effort, when, basis, explore?{basis}} }
// A slot names a catalog model only where the tool's own docs give the string its files take;
// every other slot is `choice: "your pick"` (TOOL_PLAN_CHOICE_ONLY: tools whose model strings are
// not documented, so a value would be a guess and must never reach an enforced file).
export const TOOL_PLAN_TOOLS = ['claude-code', 'codex', 'cursor', 'copilot', 'antigravity', 'openrouter'];
export const TOOL_PLAN_CHOICE = 'your pick';
export const TOOL_PLAN_CHOICE_ONLY = ['cursor', 'copilot', 'antigravity', 'openrouter'];
// Tools whose helper files take a model string from a plan slot (the bulk helper; Claude Code's
// optional Explore helper too). Their bulk slot reaches an enforced file.
export const TOOL_PLAN_FILE_SLOT_TOOLS = ['claude-code', 'codex'];
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** True when `text` contains `word` as a whole token (case-insensitive; '-' and '.' count as part
 * of a token, so "gpt-6" is not found inside "gpt-6-luna"). */
export function namesToken(text, word) {
  if (!word) return false;
  return new RegExp(`(^|[^a-z0-9.-])${escRe(String(word).toLowerCase())}(?![a-z0-9-]|\\.[a-z0-9])`).test(String(text || '').toLowerCase());
}
export function toolPlanProblems(guidance, claims, byId) {
  const out = [];
  const G = 'data/guidance.json';
  const plans = guidance && guidance.tool_plans;
  if (plans === undefined) return out;
  if (!Array.isArray(plans)) return [`${G}: tool_plans must be an array`];
  const seen = new Set();
  const isStr = (v) => typeof v === 'string' && v.trim() !== '';
  const quoteOf = (id) => { const c = claims.get(id); return c && typeof c.quote === 'string' ? c.quote : ''; };
  const refsFor = (tool, modelId) => (Array.isArray(guidance.model_refs) ? guidance.model_refs : [])
    .filter((r) => r && r.tool === tool && r.model_id === modelId && isStr(r.ref));
  // A slot that names a model must rest on a claim that names it: by one of the tool's refs for it,
  // its catalog name or its id. Otherwise the line would cite another model's quotes.
  const basisNamesModel = (tool, modelId, basis) => {
    const m = byId.get(modelId);
    const words = [modelId, m && m.name, ...refsFor(tool, modelId).map((r) => r.ref)].filter(Boolean);
    return (Array.isArray(basis) ? basis : []).some((id) => words.some((w) => namesToken(quoteOf(id), w)));
  };
  plans.forEach((tp, i) => {
    const who = `${G} tool_plans[${i}]${tp && tp.tool ? ` (${tp.tool})` : ''}`;
    if (!tp || typeof tp !== 'object' || Array.isArray(tp)) { out.push(`${who} must be an object`); return; }
    if (!TOOL_PLAN_TOOLS.includes(tp.tool)) { out.push(`${who}.tool "${tp.tool}" must be one of ${TOOL_PLAN_TOOLS.join(', ')}`); return; }
    if (seen.has(tp.tool)) out.push(`${who}: a second plan for ${tp.tool}`);
    seen.add(tp.tool);
    if (!isStr(tp.as_of) || !DATE_RE.test(tp.as_of)) out.push(`${who}.as_of "${tp.as_of}" must be a YYYY-MM-DD date`);
    const own = (basis, label, modelId) => basisOwnerProblems(basis, { tool: tp.tool, modelId, label, claims, modelsById: byId });
    const prose = (v, label) => {
      if (v === undefined || v === null) return;
      if (!isStr(v)) { out.push(`${label} must be plain text`); return; }
      const hit = guidanceBannedIn(v);
      if (hit) out.push(`${label} uses a ranking word (/${hit}/) — say what the source says, never a comparison`);
    };
    const levels = tp.effort_levels;
    if (levels !== undefined) {
      if (!levels || !Array.isArray(levels.values) || !levels.values.length || levels.values.some((v) => !isStr(v) || !/^[a-z]+$/.test(v))
        || new Set(levels.values).size !== levels.values.length) out.push(`${who}.effort_levels.values must be a list of distinct lowercase level names`);
      out.push(...own(levels && levels.basis, `${who}.effort_levels`, null));
    }
    const levelOk = (v) => (levels && Array.isArray(levels.values) ? levels.values.includes(v) : false);
    for (const key of ['instruction_files', 'enforced']) {
      const list = tp[key];
      if (!Array.isArray(list) || !list.length) { out.push(`${who}.${key} must be a non-empty array`); continue; }
      list.forEach((x, j) => {
        const label = `${who}.${key}[${j}]`;
        const field = key === 'enforced' ? 'what' : 'path';
        if (!x || !isStr(x[field])) out.push(`${label}.${field} is required`);
        else prose(x[field], `${label}.${field}`);
        out.push(...own(x && x.basis, label, null));
      });
    }
    // One model slot: a catalog model id (that tool's own lab for a one-lab tool), or the choice marker.
    const slot = (x, label, { effort = true } = {}) => {
      if (!x || typeof x !== 'object' || Array.isArray(x)) { out.push(`${label} must be an object`); return; }
      const hasId = x.model_id !== undefined && x.model_id !== null;
      if (hasId === (x.choice !== undefined && x.choice !== null)) out.push(`${label} needs exactly one of model_id or choice "${TOOL_PLAN_CHOICE}"`);
      if (hasId) {
        if (!isStr(x.model_id) || !byId.has(x.model_id)) out.push(`${label}.model_id "${x.model_id}" is not a model id in data/models.json`);
        else {
          const lab = TOOL_OWN_LAB[tp.tool];
          if (lab && byId.get(x.model_id).vendor !== lab) out.push(`${label}.model_id "${x.model_id}" is a ${byId.get(x.model_id).vendor} model — ${tp.tool} runs ${lab} models only`);
        }
        if (TOOL_PLAN_CHOICE_ONLY.includes(tp.tool)) out.push(`${label}.model_id: ${tp.tool}'s docs give no model string for its files, so this slot is choice "${TOOL_PLAN_CHOICE}" — a derived value never reaches an enforced file`);
      } else if (x.choice !== undefined && x.choice !== null && x.choice !== TOOL_PLAN_CHOICE) out.push(`${label}.choice must be "${TOOL_PLAN_CHOICE}"`);
      if (effort) for (const k of ['effort', 'raise_to']) {
        const v = x[k];
        if (v === undefined || v === null) continue;
        if (!levelOk(v)) out.push(`${label}.${k} "${v}" is not one of ${tp.tool}'s effort levels (effort_levels.values)`);
      }
      if (x.raise_to != null && !isStr(x.when)) out.push(`${label}.when must say when to raise effort to ${x.raise_to}`);
      prose(x.when, `${label}.when`);
      out.push(...own(x.basis, label, hasId && isStr(x.model_id) ? x.model_id : null));
      if (hasId && isStr(x.model_id) && byId.has(x.model_id) && Array.isArray(x.basis) && x.basis.length && !basisNamesModel(tp.tool, x.model_id, x.basis)) {
        out.push(`${label}.basis: no quote names ${x.model_id} (by its name, its id or a ${tp.tool} model_refs string) — a slot rests on a source that names its model`);
      }
    };
    slot(tp.lead, `${who}.lead`);
    if (tp.helpers !== null) {
      const h = tp.helpers;
      if (!h || typeof h !== 'object' || h.model !== 'inherit') out.push(`${who}.helpers must be {model: "inherit", basis, push_down?} (helpers run on the lead's model), or null for a tool with no helpers`);
      else {
        out.push(...own(h.basis, `${who}.helpers`, null));
        if (h.push_down !== undefined && h.push_down !== null) {
          slot(h.push_down, `${who}.helpers.push_down`, { effort: false });
          if (!isStr(h.push_down.when)) out.push(`${who}.helpers.push_down.when is required`);
        }
      }
    }
    slot(tp.bulk, `${who}.bulk`);
    // The bulk slot's model is written into a helper file: the tool's own string for it must be on
    // file in model_refs, with a basis that quotes that string. Never the catalog id by default.
    const bulkId = tp.bulk && isStr(tp.bulk.model_id) ? tp.bulk.model_id : null;
    if (bulkId && TOOL_PLAN_FILE_SLOT_TOOLS.includes(tp.tool)) {
      const rows = refsFor(tp.tool, bulkId);
      if (!rows.length) out.push(`${who}.bulk.model_id "${bulkId}" goes into ${tp.tool}'s bulk helper file, so it needs a model_refs row (tool ${tp.tool}, model_id ${bulkId}) whose basis quotes the string the file takes`);
      else if (!rows.some((r) => (Array.isArray(r.basis) ? r.basis : []).some((id) => namesToken(quoteOf(id), r.ref)))) {
        out.push(`${who}.bulk.model_id "${bulkId}": no model_refs row for it has a basis quote containing its string (${rows.map((r) => r.ref).join(', ')})`);
      }
    }
    if (tp.bulk && !isStr(tp.bulk.when)) out.push(`${who}.bulk.when is required (the kind of work it is for)`);
    if (tp.bulk && tp.bulk.explore !== undefined) {
      if (tp.tool !== 'claude-code') out.push(`${who}.bulk.explore is a Claude Code helper only`);
      out.push(...own(tp.bulk.explore && tp.bulk.explore.basis, `${who}.bulk.explore`, null));
    }
  });
  return out;
}

export function validate(data, registry) {
  const errors = [], warnings = [];
  const E = (m) => errors.push(m);
  const W = (m) => warnings.push(m);

  // Host → registry entry, so a URL anywhere in the data can be traced back to a licence and a tier.
  const byHost = new Map();
  for (const s of registry.sources) for (const h of s.hosts || []) byHost.set(h, s);
  // Subdomains resolve to their parent entry, so www.anthropic.com and docs.anthropic.com both land
  // on the vendor-primary tier without every host needing its own line.
  const sourceFor = (url) => {
    let host;
    try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
    for (let h = host; h.includes('.'); h = h.slice(h.indexOf('.') + 1)) if (byHost.has(h)) return byHost.get(h);
    return null;
  };

  for (const m of data.models) {
    const id = m.name || m.id || '(unnamed)';
    const hasSrc = Array.isArray(m.sources) && m.sources.length > 0;
    // 1. any non-null price MUST trace to a source
    if ((!num(m.price_input) || !num(m.price_output)) && !hasSrc) E(`${id}: has a price but no sources[]`);
    // 2. any non-null benchmark MUST trace to a source
    for (const b of BENCHES) if (!num(m.benchmarks?.[b]) && !hasSrc) E(`${id}: benchmark ${b} present but no sources[]`);
    // 3. confidence enums
    if (m.confidence && !CONF.includes(m.confidence)) E(`${id}: bad confidence "${m.confidence}"`);
    if (m.coding_confidence && !CONF.includes(m.coding_confidence)) E(`${id}: bad coding_confidence "${m.coding_confidence}"`);
    // 4. controlled tag vocabulary
    for (const t of m.best_for || []) if (!VOCAB.includes(t)) E(`${id}: best_for tag "${t}" not in vocab`);
    // 5. coding_score range
    if (!num(m.coding_score) && (m.coding_score < 0 || m.coding_score > 100)) E(`${id}: coding_score ${m.coding_score} out of 0–100`);
    // 6. cross-field (target/warning): a real SWE-bench number should read as high-confidence + cited
    if (!num(m.benchmarks?.swe_bench)) {
      if (m.coding_confidence !== 'high') W(`${id}: has SWE-bench but coding_confidence is "${m.coding_confidence}" (expected high)`);
      if (!/swe.?bench/i.test(m.coding_basis || '')) W(`${id}: has SWE-bench but coding_basis doesn't cite it`);
    }
  }
  for (const r of data.releases || []) {
    if (!r.source) W(`release "${r.title}": no source URL`);
    if (r.kind != null && !['model', 'price', 'retired'].includes(r.kind)) E(`release "${r.title}": kind "${r.kind}" must be model | price | retired`);
    if (r.kind == null) W(`release "${r.title}": no kind — the site shows it under new models`);
  }

  // 7. effort ladders: a published cost/performance curve must carry its provenance, and
  //    every plotted point must be a real number against a model we actually list.
  const modelIds = new Set(data.models.map((m) => m.id));
  for (const L of data.effort_ladders || []) {
    const id = L.id || L.suite || '(unnamed ladder)';
    for (const field of ['suite', 'source', 'publisher', 'method', 'confidence']) {
      if (!L[field]) E(`ladder ${id}: missing ${field} — a ladder without provenance can't ship`);
    }
    if (L.confidence && !CONF.includes(L.confidence)) E(`ladder ${id}: bad confidence "${L.confidence}"`);
    if (!Array.isArray(L.series) || !L.series.length) E(`ladder ${id}: no series[]`);
    for (const s of L.series || []) {
      if (!modelIds.has(s.model_id)) E(`ladder ${id}: series "${s.label || s.model_id}" points at unknown model_id "${s.model_id}"`);
      if (!Array.isArray(s.points) || s.points.length < 2) { E(`ladder ${id}/${s.model_id}: needs at least 2 points to be a curve`); continue; }
      for (const p of s.points) {
        if (num(p.cost) || num(p.score)) E(`ladder ${id}/${s.model_id}: point "${p.effort}" has a blank cost or score — drop the point, don't guess it`);
        if (p.cost <= 0) E(`ladder ${id}/${s.model_id}: point "${p.effort}" cost ${p.cost} must be > 0 (log axis)`);
        if (Array.isArray(L.levels) && !L.levels.includes(p.effort)) W(`ladder ${id}/${s.model_id}: effort "${p.effort}" not in declared levels[]`);
      }
      // Each rung may appear once. A repeated effort means the rungs were keyed on the wrong
      // column upstream and collapsed together — Epoch's CursorBench export ships exactly this
      // bug (all three Opus 5 rows carry the model version "claude-opus-5_max"), so a future
      // refresh that trusts that field would silently plot three "max" dots and hand the
      // takeaway generator a curve that peaks and still climbs at the same time.
      const seen = new Set();
      for (const p of s.points) {
        if (seen.has(p.effort)) E(`ladder ${id}/${s.model_id}: effort "${p.effort}" appears more than once — the rungs were keyed on the wrong field; one point per effort level`);
        seen.add(p.effort);
      }

      // Points must run low → max in the order levels[] declares. The chart and the takeaways
      // both read the last point as "the top rung", so out-of-order points misreport what the
      // most expensive setting actually buys.
      if (Array.isArray(L.levels)) {
        const rank = (e) => L.levels.indexOf(e);
        const ranks = s.points.map((p) => rank(p.effort));
        if (ranks.every((r) => r >= 0) && ranks.some((r, i) => i && r < ranks[i - 1])) {
          E(`ladder ${id}/${s.model_id}: points are out of effort order — sort them to match levels[], the last point is read as the top rung`);
        }
      }

      const costs = s.points.map((p) => p.cost);
      if (costs.some((c, i) => i && c < costs[i - 1])) W(`ladder ${id}/${s.model_id}: cost isn't rising with effort — check the reading`);
    }
  }

  // 8. source-registry gates (scripts/sources.json). The tier system only means something if the
  //    build enforces it: Tier B is licensed to be CITED, not ingested, so it must never be what a
  //    ladder rests on. Getting this wrong is a licensing problem, not a style problem.
  for (const L of data.effort_ladders || []) {
    const id = L.id || L.suite || '(unnamed ladder)';
    const reg = sourceFor(L.source);
    if (!reg) {
      W(`ladder ${id}: source host isn't in scripts/sources.json — add it to the registry with its tier and licence, or the page can't say what we're allowed to republish`);
    } else if (reg.tier === 'B' || !reg.redistributable) {
      // Tier B is licensed to be quoted, not reproduced. This is the licensing gate.
      E(`ladder ${id}: backed by "${reg.name}" (tier ${reg.tier}, redistributable=${reg.redistributable}) — tier B may be cited in sources[], never used as a ladder feed. See scripts/data-sources.md.`);
    } else if (reg.tier === 'C' && L.source_kind !== 'vendor-reported') {
      // Tier C (a lab publishing about its own models) is allowed — it is often the only thing that
      // exists at launch — but it has to be labelled as such, because the panel renders source_kind
      // and a vendor curve reading as third-party is the exact failure this site exists to avoid.
      E(`ladder ${id}: backed by vendor-primary source "${reg.name}" but source_kind is "${L.source_kind}" — a lab publishing about its own models must be labelled "vendor-reported"`);
    }
  }

  // A stub is how a model appears on day 0 without anyone guessing: present, with visible blanks.
  // A stub carrying a score is a contradiction — it means a figure got in without verification.
  for (const m of data.models) {
    if (m.confidence !== 'low') continue;
    const scored = BENCHES.filter((b) => m.benchmarks?.[b] != null);
    if (scored.length && !(Array.isArray(m.sources) && m.sources.length))
      E(`${m.name}: confidence "low" with unsourced benchmark(s) [${scored.join(', ')}] — a day-0 stub must keep every benchmark null until a source publishes one`);
  }

  // 9. naming rule (scripts/naming.mjs): the id is the name's slug with no vendor glued on, the
  //    vendor is one canonical spelling, the name carries no "Vendor: " label. Every id is unique.
  //    This is what stops "google-gemini-3-8-flash" / vendor "google" from ever landing again.
  const seenIds = new Set();
  for (const m of data.models) {
    const who = m.name || m.id || '(unnamed)';
    for (const p of namingProblems(m)) E(`${who}: ${p}`);
    if (seenIds.has(m.id)) E(`${who}: duplicate id "${m.id}"`);
    seenIds.add(m.id);
  }
  for (const r of data.releases || []) {
    const fix = canonicalVendor(r.vendor);
    if (r.vendor && fix && fix !== r.vendor) E(`release "${r.title}": vendor "${r.vendor}" must be written "${fix}"`);
  }

  // 10. task_fit (scripts/derive-task-fit.mjs): every model must carry a score-or-null-plus-
  //     reason for EXACTLY the ten known tasks, citing only the shared basis vocabulary. A
  //     score with no basis, or a basis token outside BASIS_TOKENS, means a fitter drifted from
  //     the registry archive/engine/assets/decide.mjs's `why` builder also reads from — same class of bug the
  //     naming-rule gate exists to catch, just for the decision layer instead of the catalog.
  for (const m of data.models) {
    const id = m.name || m.id || '(unnamed)';
    const tf = m.task_fit;
    if (tf == null || typeof tf !== 'object' || Array.isArray(tf)) { E(`${id}: missing task_fit{} (scripts/derive-task-fit.mjs) — every model needs one`); continue; }
    const keys = Object.keys(tf);
    for (const t of TASK_IDS) if (!keys.includes(t)) E(`${id}: task_fit missing "${t}"`);
    for (const t of keys) if (!TASK_IDS.includes(t)) E(`${id}: task_fit has unknown task "${t}" — not one of ${TASK_IDS.join(', ')}`);
    for (const t of TASK_IDS) {
      const entry = tf[t];
      if (entry == null || typeof entry !== 'object') { E(`${id}: task_fit.${t} must be an object`); continue; }
      if (entry.score !== null && (typeof entry.score !== 'number' || entry.score < 0 || entry.score > 100)) {
        E(`${id}: task_fit.${t}.score "${entry.score}" must be null or 0-100`);
      }
      if (!Array.isArray(entry.basis)) E(`${id}: task_fit.${t}.basis must be an array`);
      else for (const token of entry.basis) if (!BASIS_TOKENS.includes(token)) E(`${id}: task_fit.${t}.basis cites unknown token "${token}"`);
      if (entry.score == null) {
        if (Array.isArray(entry.basis) && entry.basis.length) E(`${id}: task_fit.${t} has score:null but a non-empty basis[] — a null score should cite nothing`);
        if (!entry.reason || typeof entry.reason !== 'string') E(`${id}: task_fit.${t} has score:null but no plain-English reason — never a silent exclusion`);
      } else if (Array.isArray(entry.basis) && !entry.basis.length) {
        E(`${id}: task_fit.${t} has a score but an empty basis[] — every score must trace to at least one field`);
      }
    }
  }

  // 10b. task_fit_judged (sourced qualitative fit, scripts/refresh-judge.md): null (no judged
  // records yet) or an object keyed by a SUBSET of TASK_IDS — unlike task_fit, judged fit is
  // sparse by design; most models will only ever have a judged record for the handful of tasks
  // someone actually researched. v3 (2026-09): a record is claims[] + reconciliation + as_of —
  // NO band, NO confidence (see scripts/migrate-judged-v3.mjs); either key present is rejected
  // outright so the pre-v3 shape can't sneak back in through a stale routine or a hand edit.
  // Every record needs a non-empty claims[], each claim carrying source_url + tier + date + a
  // verbatim quote of at most 25 words, and an optional `polarity: "negative"` marker for a sourced
  // practical drawback. See the BANNED_RELATIVE comment above for why sentence/reconciliation get
  // a phrase gate here — the "is this quote real" gate is scripts/check-sources.mjs's job.
  for (const m of data.models) {
    const id = m.name || m.id || '(unnamed)';
    const tfj = m.task_fit_judged;
    if (tfj == null) continue; // valid: no judged records for this model yet
    if (typeof tfj !== 'object' || Array.isArray(tfj)) { E(`${id}: task_fit_judged must be null or an object keyed by task id`); continue; }
    for (const taskId of Object.keys(tfj)) {
      const rec = tfj[taskId];
      const label = `${id}: task_fit_judged.${taskId}`;
      if (!TASK_IDS.includes(taskId)) { E(`${label} — "${taskId}" is not one of ${TASK_IDS.join(', ')}`); continue; }
      if (rec == null) continue; // valid: no judged record for this task (see migrate-judged-v3)
      if (typeof rec !== 'object') { E(`${label} must be null or an object`); continue; }
      if (Object.prototype.hasOwnProperty.call(rec, 'band')) E(`${label}.band is present — v3 removed band from the schema (see scripts/migrate-judged-v3.mjs); a record is claims[] + reconciliation + as_of only`);
      if (Object.prototype.hasOwnProperty.call(rec, 'confidence')) E(`${label}.confidence is present — v3 removed confidence from the schema (see scripts/migrate-judged-v3.mjs); a record is claims[] + reconciliation + as_of only`);
      if (!rec.as_of || !DATE_RE.test(rec.as_of)) E(`${label}.as_of "${rec.as_of}" must be a YYYY-MM-DD date`);
      if (rec.reconciliation != null) {
        if (typeof rec.reconciliation !== 'string') E(`${label}.reconciliation must be a string or null`);
        else {
          const hit = bannedPhraseIn(rec.reconciliation);
          if (hit) E(`${label}.reconciliation uses a banned relative phrase (/${hit}/) — statements must be absolute and dated, never relative`);
        }
      }
      if (!Array.isArray(rec.claims) || !rec.claims.length) { E(`${label}.claims must be a non-empty array`); continue; }
      rec.claims.forEach((c, i) => {
        for (const p of claimProblems(c, `${label}.claims[${i}]`)) E(p);
      });
    }
  }

  // 10c. usage.openrouter (added with judged task fit, 2026-09-06) — same honesty rule as
  // everything else: sourced or null, never guessed. Every model needs the field (even
  // all-null), mirroring availability{}'s always-present-but-sourced-or-null shape. "category"
  // is free text in v1 (e.g. "overall") rather than a fixed vocab, because the only feed found
  // so far (scripts/data-sources.md, added 2026-09-06) reports total token volume, not a
  // per-task breakdown — never invent a task split the source doesn't give.
  for (const m of data.models) {
    const id = m.name || m.id || '(unnamed)';
    const u = m.usage;
    if (u == null || typeof u !== 'object' || Array.isArray(u)) { E(`${id}: usage{} is required (openrouter: null | {...}) — every model needs the field, even all-null`); continue; }
    if (!('openrouter' in u)) { E(`${id}: usage.openrouter is required (null when not sourced)`); continue; }
    const or = u.openrouter;
    if (or == null) continue;
    if (typeof or !== 'object' || Array.isArray(or)) { E(`${id}: usage.openrouter must be null or an object`); continue; }
    if (!or.category || typeof or.category !== 'string') E(`${id}: usage.openrouter.category is required`);
    if (typeof or.share !== 'number' || Number.isNaN(or.share) || or.share < 0 || or.share > 100) E(`${id}: usage.openrouter.share "${or.share}" must be 0-100`);
    if (!Number.isInteger(or.rank) || or.rank < 1) E(`${id}: usage.openrouter.rank "${or.rank}" must be a positive integer`);
    if (!or.as_of || !DATE_RE.test(or.as_of)) E(`${id}: usage.openrouter.as_of "${or.as_of}" must be a YYYY-MM-DD date`);
    if (!or.source_url || !/^https?:\/\//i.test(or.source_url)) E(`${id}: usage.openrouter.source_url must be http(s)`);
  }

  // 10d. status / adoption (scripts/derive-status-adoption.mjs, added with the judged-ranking
  // rewrite, 2026-09-07) — model-level, not per-task, because archive/engine/assets/decide.mjs's "a preview SKU
  // or a low-adoption model can never be start_here" gate has to fire even on a task with no
  // judged record at all (the exact gap a 0.16%-share preview model exploited to top "research"
  // on a benchmark number alone). Both are pure derivations of fields the catalog already
  // sources — model.deprecated / model.name for status, usage.openrouter.share for adoption — so
  // this gate re-derives them and requires an exact match, the same cross-check pattern rule 6
  // above uses for SWE-bench: a hand-edited or stale value drifting from its own source is a bug,
  // not a matter of opinion.
  for (const m of data.models) {
    const id = m.name || m.id || '(unnamed)';
    if (!STATUS_VALUES.includes(m.status)) { E(`${id}: status "${m.status}" must be one of ${STATUS_VALUES.join(', ')}`); continue; }
    if (!ADOPTION_VALUES.includes(m.adoption)) { E(`${id}: adoption "${m.adoption}" must be one of ${ADOPTION_VALUES.join(', ')}`); continue; }
    const wantStatus = deriveStatus(m).status;
    if (m.status !== wantStatus) E(`${id}: status "${m.status}" doesn't match what deriveStatus() computes from this model's own name/deprecated flag ("${wantStatus}") — re-run scripts/derive-status-adoption.mjs`);
    const wantAdoption = deriveAdoption(m, data.as_of).adoption;
    if (m.adoption !== wantAdoption) E(`${id}: adoption "${m.adoption}" doesn't match what deriveAdoption() computes from usage.openrouter.share ("${wantAdoption}") — re-run scripts/derive-status-adoption.mjs`);
  }

  // 10e. signals (scripts/derive-signals.mjs, added with the calibration fix, 2026-09-07) —
  // per-task real-world-signal counts archive/engine/assets/decide.mjs's rule 3b reads to downgrade a
  // thinly-evidenced judged "strong" to "capable". Same honesty rule as everywhere else:
  // usage_rank/arena_rank are a positive integer or null (never 0 or negative — "rank 0" isn't a
  // real rank), usage_share is 0-100 or null, expert_default is `true` or null (never `false` —
  // the same "not confirmed, never confirmed absent" convention availability{}'s
  // AVAIL_BOOL_OR_NULL_ONLY_TRUE uses, since a model absent from Cursor/Claude Code/Anthropic's
  // published shortlists was simply never on any of them, not affirmatively rejected), and
  // `families` must be an exact cross-check of the other three fields (same pattern rule 10d uses
  // for status/adoption) — never a hand-typed number that could drift from what the three actual
  // fields say.
  for (const m of data.models) {
    const id = m.name || m.id || '(unnamed)';
    const sig = m.signals;
    if (sig == null || typeof sig !== 'object' || Array.isArray(sig)) { E(`${id}: missing signals{} (scripts/derive-signals.mjs) — every model needs one, keyed by every task id`); continue; }
    const keys = Object.keys(sig);
    for (const t of TASK_IDS) if (!keys.includes(t)) E(`${id}: signals missing "${t}"`);
    for (const t of keys) if (!TASK_IDS.includes(t)) E(`${id}: signals has unknown task "${t}" — not one of ${TASK_IDS.join(', ')}`);
    for (const t of TASK_IDS) {
      const rec = sig[t];
      const label = `${id}: signals.${t}`;
      if (rec == null || typeof rec !== 'object') { E(`${label} must be an object`); continue; }
      if (rec.usage_rank !== null && (!Number.isInteger(rec.usage_rank) || rec.usage_rank < 1)) E(`${label}.usage_rank "${rec.usage_rank}" must be null or a positive integer`);
      if (rec.usage_share !== null && (typeof rec.usage_share !== 'number' || Number.isNaN(rec.usage_share) || rec.usage_share < 0 || rec.usage_share > 100)) E(`${label}.usage_share "${rec.usage_share}" must be null or 0-100`);
      if (rec.arena_rank !== null && (!Number.isInteger(rec.arena_rank) || rec.arena_rank < 1)) E(`${label}.arena_rank "${rec.arena_rank}" must be null or a positive integer`);
      if (rec.expert_default !== null && rec.expert_default !== true) E(`${label}.expert_default is "${rec.expert_default}" — must be true or null (never false — absence isn't confirmed rejection)`);
      const wantFamilies = (rec.usage_rank !== null ? 1 : 0) + (rec.arena_rank !== null ? 1 : 0) + (rec.expert_default === true ? 1 : 0);
      if (rec.families !== wantFamilies) E(`${label}.families "${rec.families}" doesn't match the count of its own usage_rank/arena_rank/expert_default fields (${wantFamilies}) — re-run scripts/derive-signals.mjs`);
    }
  }

  // 10f. standings (scripts/derive-standings.mjs, 2026-09-07) — the three kinds
  // of evidence (measured / chosen / preferred), kept separate, that later feed a ranking this
  // gate does not itself compute. Same honesty rule as everywhere else: a task with no evidence
  // gets measured: [] (never a missing key) and chosen/preferred: null (never a guessed object);
  // every measured row must name a real tester (data/testers.json), a real rank inside its own
  // n_models, a real date, a real URL, and a licence class that is display-ok or signal-only —
  // "banned" must never appear here (a banned tester is excluded from standings entirely, not
  // downgraded); a signal-only row may never carry a score (that's the whole point of
  // signal-only — cite the tester, never republish its number).
  for (const m of data.models) {
    const id = m.name || m.id || '(unnamed)';
    const st = m.standings;
    if (st == null || typeof st !== 'object' || Array.isArray(st)) { E(`${id}: missing standings{} (scripts/derive-standings.mjs) — every model needs one, keyed by every task id`); continue; }
    if (!st.as_of || !DATE_RE.test(st.as_of)) E(`${id}: standings.as_of "${st.as_of}" must be a YYYY-MM-DD date`);
    for (const t of TASK_IDS) if (!(t in st)) E(`${id}: standings missing "${t}"`);
    for (const t of Object.keys(st)) if (t !== 'as_of' && !TASK_IDS.includes(t)) E(`${id}: standings has unknown task "${t}" — not one of ${TASK_IDS.join(', ')}`);
    for (const taskId of TASK_IDS) {
      const rec = st[taskId];
      const label = `${id}: standings.${taskId}`;
      if (rec == null || typeof rec !== 'object') { E(`${label} must be an object`); continue; }
      if (!Array.isArray(rec.measured)) { E(`${label}.measured must be an array (empty when nothing was found — never a missing key)`); }
      else rec.measured.forEach((row, i) => {
        const rl = `${label}.measured[${i}]`;
        if (!row || typeof row !== 'object') { E(`${rl} must be an object`); return; }
        if (!TESTER_IDS.has(row.tester)) E(`${rl}.tester "${row.tester}" does not name a tester id in data/testers.json`);
        if (!row.benchmark || typeof row.benchmark !== 'string') E(`${rl}.benchmark is required`);
        if (!Number.isInteger(row.n_models) || row.n_models < 1) E(`${rl}.n_models "${row.n_models}" must be a positive integer`);
        else if (!Number.isInteger(row.rank) || row.rank < 1 || row.rank > row.n_models) E(`${rl}.rank "${row.rank}" must be an integer between 1 and n_models (${row.n_models})`);
        if (!row.as_of || !DATE_RE.test(row.as_of)) E(`${rl}.as_of "${row.as_of}" must be a YYYY-MM-DD date`);
        if (!row.url || !/^https?:\/\//i.test(row.url)) E(`${rl}.url "${row.url}" must be http(s)`);
        if (!STANDINGS_LICENCE_VALUES.includes(row.licence)) E(`${rl}.licence "${row.licence}" must be one of ${STANDINGS_LICENCE_VALUES.join(', ')} — a banned tester must never appear in standings at all`);
        if (row.licence === 'signal-only' && row.score !== null) E(`${rl}.score must be null for a signal-only tester — cite it, never republish its number`);
        if (row.score !== null && typeof row.score !== 'number') E(`${rl}.score "${row.score}" must be a number or null`);
      });
      if (rec.chosen != null) {
        const c = rec.chosen;
        const cl = `${label}.chosen`;
        if (typeof c !== 'object') E(`${cl} must be null or an object`);
        else {
          if (!Number.isInteger(c.n_models) || c.n_models < 1) E(`${cl}.n_models "${c.n_models}" must be a positive integer`);
          else if (!Number.isInteger(c.rank) || c.rank < 1 || c.rank > c.n_models) E(`${cl}.rank "${c.rank}" must be an integer between 1 and n_models (${c.n_models})`);
          if (typeof c.share !== 'number' || Number.isNaN(c.share) || c.share < 0 || c.share > 100) E(`${cl}.share "${c.share}" must be 0-100`);
          if (!Array.isArray(c.tags)) E(`${cl}.tags must be an array (may be empty for bulk's token-volume rule)`);
          if (!c.as_of || !DATE_RE.test(c.as_of)) E(`${cl}.as_of "${c.as_of}" must be a YYYY-MM-DD date`);
          if (!c.url || !/^https?:\/\//i.test(c.url)) E(`${cl}.url "${c.url}" must be http(s)`);
        }
      }
      if (rec.preferred != null) {
        const p = rec.preferred;
        const pl = `${label}.preferred`;
        if (typeof p !== 'object') E(`${pl} must be null or an object`);
        else {
          if (!p.board || typeof p.board !== 'string') E(`${pl}.board is required`);
          if (!Number.isInteger(p.n_models) || p.n_models < 1) E(`${pl}.n_models "${p.n_models}" must be a positive integer`);
          else if (!Number.isInteger(p.rank) || p.rank < 1 || p.rank > p.n_models) E(`${pl}.rank "${p.rank}" must be an integer between 1 and n_models (${p.n_models})`);
          if (!p.as_of || !DATE_RE.test(p.as_of)) E(`${pl}.as_of "${p.as_of}" must be a YYYY-MM-DD date`);
          if (!p.url || !/^https?:\/\//i.test(p.url)) E(`${pl}.url "${p.url}" must be http(s)`);
          // licence/score are OPTIONAL on preferred (a plain arena.ai capture carries neither) —
          // only present when the evidence actually came from a licensed/scored feed reused as
          // preferred (e.g. an Epoch mirror, brain v2 step 2). Same honesty rule as measured's
          // signal-only row above: a signal-only preferred entry may never carry a real score.
          if (p.licence !== undefined && !STANDINGS_LICENCE_VALUES.includes(p.licence)) E(`${pl}.licence "${p.licence}" must be one of ${STANDINGS_LICENCE_VALUES.join(', ')}`);
          if (p.score !== undefined && p.score !== null && typeof p.score !== 'number') E(`${pl}.score "${p.score}" must be null or a number`);
          if (p.licence === 'signal-only' && p.score !== null && p.score !== undefined) E(`${pl}.score must be null for a signal-only preferred entry — cite it, never republish its number`);
        }
      }
    }
  }

  // 10g. data/testers.json's own per_benchmark `kind` field (scripts/derive-standings.mjs's
  // EPOCH_FILE_CONFIG reads this to route a set into measured vs. preferred — see 10f above).
  // Absent means "measured"; anything present that isn't one of the two known values is a typo.
  for (const tester of TESTERS_FILE.testers) {
    for (const [file, meta] of Object.entries(tester.mapping?.per_benchmark || {})) {
      if (meta.kind !== undefined && !EPOCH_PER_BENCHMARK_KIND_VALUES.includes(meta.kind)) {
        E(`data/testers.json: ${tester.id}.mapping.per_benchmark["${file}"].kind "${meta.kind}" must be one of ${EPOCH_PER_BENCHMARK_KIND_VALUES.join(', ')} (or absent, meaning "measured")`);
      }
    }
  }

  return { errors, warnings };
}

// --- the data contract (2026-10-03) -----------------------------------------------------------
// One table of every data file a page shows (FEEDS) and one check per feed (validateFeeds). The
// rule for every feed: the file says when it was true (a file-level `as_of`), and every line it
// shows carries a source and a date of its own, or inherits them from something that does (a
// guidance default inherits from the claims in its `basis`; a ladder point from its ladder). The
// writers (scripts/auto-refresh.mjs, scripts/apply-judgment.mjs via scripts/timeline.mjs) stamp
// dates in these same forms, so a scheduled run never writes what this gate rejects.

/** Today's date in UTC. The writers stamp UTC dates (the scheduled jobs run on UTC runners), so the
 * "not in the future" rule compares in UTC and allows one day of slack — a check run on a machine
 * whose local date is behind UTC must never read today's run as "tomorrow". */
export const utcToday = () => new Date().toISOString().slice(0, 10);
const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const isRealDate = (s) => typeof s === 'string' && DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const isUrl = (u) => typeof u === 'string' && /^https?:\/\//i.test(u);

/** Problems with a date that says "as of": a real YYYY-MM-DD date, no later than today + 1 (UTC). */
export function asOfProblems(asOf, label, { today = utcToday() } = {}) {
  if (asOf == null || asOf === '') return [`${label} as_of is missing — every shown file says when it was true (YYYY-MM-DD)`];
  if (!isRealDate(asOf)) return [`${label} as_of "${asOf}" must be a real YYYY-MM-DD date`];
  if (asOf > addDays(today, 1)) return [`${label} as_of "${asOf}" is in the future (today is ${today} UTC)`];
  return [];
}

// `released` on a model: as much of a date as the source gives, or null. Never "unknown".
export const RELEASED_FORMS = 'YYYY-MM-DD | YYYY-MM | YYYY-Qn | YYYY | null';
export const DATE_PRECISION_VALUES = ['month', 'quarter', 'year'];
export const RELEASE_KINDS = ['model', 'price', 'retired'];
// Plan rows checked on or after this date carry a verbatim `quote` (scripts/check-sources.mjs
// checks it) whenever they print a price. A null price (contact sales, or a JS-only page —
// scripts/refresh-plans.md) has nothing to quote.
export const PLAN_QUOTE_FROM = '2026-10-03';
// The seller's name as a buyer sees it on the invoice, which is not always a model vendor from
// naming.mjs: "Microsoft 365 Copilot" and the three marketplaces (Bedrock, Vertex AI, Azure AI
// Foundry) sell other people's models, and they are here because that is how enterprises buy.
export const PLAN_VENDORS = [
  'Anthropic', 'OpenAI', 'Google', 'xAI', 'Cursor', 'GitHub Copilot', 'Mistral AI',
  'Microsoft 365 Copilot', 'Devin', 'Perplexity', 'OpenRouter',
  'Amazon Bedrock', 'Google Vertex AI', 'Microsoft Azure AI Foundry',
];
/** The label a board shows for a plan row (same rule as board.html planLabel / test-board.mjs). */
export function planLabel(p) {
  if (p.plan.indexOf(p.vendor) === 0) return p.plan;
  const lead = String(p.vendor || '').split(' ')[0];
  if (lead && p.plan.indexOf(`${lead} `) === 0) return p.plan;
  return `${p.vendor} ${p.plan}`;
}

// Tool id -> the subject names its own claims use, and the lab it runs (when it runs one lab's
// models only). A default for a tool may rest on the tool's own docs, its own lab's docs, or —
// for a tool that runs several labs' models (Cursor, Copilot, OpenRouter, AGENTS.md) — the docs
// of the lab whose model that line names.
export const TOOL_SUBJECTS = {
  'claude-code': ['Claude Code'], codex: ['Codex CLI'], cursor: ['Cursor'], 'agents-md': ['AGENTS.md'],
  copilot: ['GitHub Copilot'], antigravity: ['Antigravity', 'Gemini CLI'], gemini: ['Gemini CLI', 'Antigravity'],
  openrouter: ['OpenRouter'],
};
export const TOOL_OWN_LAB = { 'claude-code': 'Anthropic', codex: 'OpenAI', antigravity: 'Google', gemini: 'Google' };

/** Basis rule for one guidance line (a role default, a model ref, a tool plan slot): every id is a
 * claim in the file, and every claim is the tool's own or its lab's own (see TOOL_SUBJECTS). */
export function basisOwnerProblems(basis, { tool, modelId = null, label, claims, modelsById }) {
  if (!Array.isArray(basis) || !basis.length) return [`${label}.basis must name at least one claim id (the line's source)`];
  const out = [];
  const subjects = new Set(TOOL_SUBJECTS[tool] || []);
  const labs = new Set([TOOL_OWN_LAB[tool]].filter(Boolean));
  if (modelId && modelsById.has(modelId)) labs.add(modelsById.get(modelId).vendor);
  for (const id of basis) {
    const c = claims.get(id);
    if (!c) { out.push(`${label}.basis names "${id}", which is not a claim id in guidance.json`); continue; }
    const s = c.subject || {};
    const own = (s.kind === 'tool' && subjects.has(s.name)) || (s.kind === 'lab' && labs.has(s.name));
    if (!own) out.push(`${label}.basis "${id}" is a claim about ${s.name || '?'} — a line for ${tool} rests only on ${[...subjects, ...labs].join(' / ') || tool}'s own docs`);
  }
  return out;
}

/** Every value under a model-naming key (model, model_id, models, have) anywhere in `obj`. */
function modelIdsNamedIn(obj, out = []) {
  if (Array.isArray(obj)) { obj.forEach((x) => modelIdsNamedIn(x, out)); return out; }
  if (!obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) {
    if (['model', 'model_id'].includes(k) && typeof v === 'string') out.push(v);
    else if (['models', 'have'].includes(k) && Array.isArray(v)) v.forEach((x) => typeof x === 'string' && out.push(x));
    else if (v && typeof v === 'object') modelIdsNamedIn(v, out);
  }
  return out;
}

const fileAsOf = (feed) => (files, ctx) => asOfProblems(files[feed.file]?.as_of, `data/${feed.file}:`, ctx);

function checkModels(f, { models }, ctx) {
  const E = [];
  E.push(...asOfProblems(models.as_of, 'data/models.json:', ctx));
  if (!Array.isArray(models.models)) return [...E, 'data/models.json: models must be an array'];
  for (const m of models.models) {
    const who = `data/models.json ${m.id || m.name || '(unnamed)'}`;
    if (!Array.isArray(m.sources) || !m.sources.length) E.push(`${who}: sources[] is empty — every listed model traces to at least one page`);
    else if (m.sources.some((u) => !isUrl(u))) E.push(`${who}: sources[] has a non-URL entry`);
    if (m.released !== null && m.released !== undefined && !(typeof m.released === 'string' && RELEASED_RE.test(m.released))) {
      E.push(`${who}: released "${m.released}" must be ${RELEASED_FORMS} — an unknown date is null`);
    }
  }
  return E;
}

function checkReleases(f, { models }, ctx) {
  const E = [];
  (models.releases || []).forEach((r, i) => {
    const who = `data/models.json releases[${i}] "${r && r.title}"`;
    if (!r || typeof r !== 'object') { E.push(`${who} must be an object`); return; }
    if (!RELEASE_KINDS.includes(r.kind)) E.push(`${who}: kind "${r.kind}" must be one of ${RELEASE_KINDS.join(', ')}`);
    if (!isRealDate(r.date)) E.push(`${who}: date "${r.date}" must be a real YYYY-MM-DD date (a month-only date is the 1st with date_precision "month")`);
    else if (r.date > addDays(ctx.today, 1)) E.push(`${who}: date "${r.date}" is in the future`);
    if (r.date_precision != null && !DATE_PRECISION_VALUES.includes(r.date_precision)) E.push(`${who}: date_precision "${r.date_precision}" must be one of ${DATE_PRECISION_VALUES.join(', ')}`);
    for (const k of ['vendor', 'title', 'summary']) if (!r[k] || typeof r[k] !== 'string') E.push(`${who}: ${k} is required`);
    if (!isUrl(r.source)) E.push(`${who}: source "${r.source}" must be an http(s) URL — every timeline line links its source`);
  });
  return E;
}

function checkLadders(f, { models }, ctx) {
  const E = [];
  (models.effort_ladders || []).forEach((L, i) => {
    const who = `data/models.json effort_ladders[${i}] (${L && (L.id || L.suite)})`;
    E.push(...asOfProblems(L && L.as_of, `${who}:`, ctx));
    if (!isUrl(L && L.source)) E.push(`${who}: source must be an http(s) URL — its points inherit it`);
    for (const s of (L && L.series) || []) {
      if (s.source != null && !isUrl(s.source)) E.push(`${who}/${s.model_id}: series source must be an http(s) URL when present`);
      for (const p of s.points || []) if (p.source != null && !isUrl(p.source)) E.push(`${who}/${s.model_id}: point "${p.effort}" source must be an http(s) URL when present`);
    }
  });
  return E;
}

function checkGuidanceFeed(f, { guidance, models }, ctx) {
  const E = [];
  E.push(...asOfProblems(guidance.as_of, 'data/guidance.json:', ctx));
  const claims = new Map((guidance.claims || []).filter((c) => c && c.id).map((c) => [c.id, c]));
  for (const c of claims.values()) {
    const who = `data/guidance.json claim ${c.id}`;
    if (!isUrl(c.source_url)) E.push(`${who}: source_url is required`);
    if (!c.quote) E.push(`${who}: quote is required`);
    if (!isRealDate(c.date)) E.push(`${who}: date "${c.date}" must be a real YYYY-MM-DD date`);
    else if (c.date > addDays(ctx.today, 1)) E.push(`${who}: date "${c.date}" is in the future`);
  }
  const modelsById = new Map((models.models || []).map((m) => [m.id, m]));
  (guidance.role_defaults || []).forEach((r, i) => E.push(...basisOwnerProblems(r.basis, { tool: r.tool, modelId: r.model_id, label: `data/guidance.json role_defaults[${i}] (${r.tool}/${r.role})`, claims, modelsById })));
  (guidance.model_refs || []).forEach((r, i) => E.push(...basisOwnerProblems(r.basis, { tool: r.tool, modelId: r.model_id, label: `data/guidance.json model_refs[${i}] (${r.tool}/${r.ref})`, claims, modelsById })));
  // tool_plans (one per tool): every slot that carries a basis follows the same rule. The slot
  // shape is the tool_plans schema's own business; this only walks it for basis lists.
  const walk = (node, label, tool) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach((x, i) => walk(x, `${label}[${i}]`, tool)); return; }
    if ('basis' in node) E.push(...basisOwnerProblems(node.basis, { tool, modelId: typeof node.model_id === 'string' ? node.model_id : null, label, claims, modelsById }));
    for (const [k, v] of Object.entries(node)) if (k !== 'basis' && v && typeof v === 'object') walk(v, `${label}.${k}`, tool);
  };
  (guidance.tool_plans || []).forEach((tp, i) => {
    const who = `data/guidance.json tool_plans[${i}] (${tp && tp.tool})`;
    if (!tp || typeof tp !== 'object') { E.push(`${who} must be an object`); return; }
    if (tp.as_of != null) E.push(...asOfProblems(tp.as_of, `${who}:`, ctx));
    walk(tp, who, tp.tool);
  });
  return E;
}

function checkPlans(f, { plans }, ctx) {
  const E = [];
  E.push(...asOfProblems(plans.as_of, 'data/plans.json:', ctx));
  if (!Array.isArray(plans.plans)) return [...E, 'data/plans.json: plans must be an array'];
  const labels = new Set(plans.plans.filter((p) => p && p.vendor && p.plan).map(planLabel));
  for (const p of plans.plans) {
    const who = `data/plans.json ${p.vendor || '?'} / ${p.plan || '?'}`;
    if (!isUrl(p.source_url)) E.push(`${who}: source_url is required`);
    E.push(...asOfProblems(p.as_of, `${who}:`, ctx));
    if (typeof p.price_usd_month === 'number' && isRealDate(p.as_of) && p.as_of >= PLAN_QUOTE_FROM && !(typeof p.quote === 'string' && p.quote.trim())) {
      E.push(`${who}: a price checked on or after ${PLAN_QUOTE_FROM} needs a verbatim quote (≤25 words) from its page — scripts/check-sources.mjs confirms it`);
    }
    if (p.quote != null) {
      if (typeof p.quote !== 'string' || !p.quote.trim()) E.push(`${who}: quote must be a non-empty string`);
      else if (wordCount(p.quote) > 25) E.push(`${who}: quote is ${wordCount(p.quote)} words — ≤25, verbatim`);
    }
    if (p.quote_url != null && !isUrl(p.quote_url)) E.push(`${who}: quote_url must be an http(s) URL`);
    for (const k of ['base_usd_month', 'price_usd_month_billed_monthly']) {
      if (p[k] != null && (typeof p[k] !== 'number' || Number.isNaN(p[k]) || p[k] < 0)) E.push(`${who}: ${k} must be a non-negative number when present`);
    }
    if ((p.reaches === undefined) !== (p.covers_tokens === undefined)) E.push(`${who}: reaches and covers_tokens go together — set both or neither`);
    if (p.reaches !== undefined && p.reaches !== 'all' && !(Array.isArray(p.reaches) && p.reaches.length && p.reaches.every((v) => VENDORS.includes(v)))) {
      E.push(`${who}: reaches must be "all" or a non-empty list of canonical model vendors (scripts/naming.mjs VENDORS)`);
    }
    if (p.covers_tokens !== undefined && typeof p.covers_tokens !== 'boolean') E.push(`${who}: covers_tokens must be true or false`);
    if (p.renamed_from !== undefined) {
      if (!Array.isArray(p.renamed_from) || !p.renamed_from.length || p.renamed_from.some((n) => typeof n !== 'string' || !n.trim())) E.push(`${who}: renamed_from must be a non-empty list of earlier board labels`);
      else for (const n of p.renamed_from) if (labels.has(n)) E.push(`${who}: renamed_from "${n}" is still the label of a current row — a saved board could not tell them apart`);
    }
  }
  return E;
}

function checkVendors(f, { vendors }, ctx) {
  const E = [...asOfProblems(vendors.as_of, 'data/vendors.json:', ctx)];
  for (const v of vendors.vendors || []) if (!isUrl(v.source)) E.push(`data/vendors.json "${v.vendor}": source is required (http(s) URL)`);
  return E;
}

/** tasks.json / usage-presets.json / board-samples.json: file as_of, and every model id they name
 * is a real catalog id (and, for board-samples, every plan label a real plan row). */
function checkNamesModels(feed) {
  return (f, files, ctx) => {
    const obj = files[feed.file];
    const E = [...asOfProblems(obj.as_of, `data/${feed.file}:`, ctx)];
    const ids = new Set((files.models.models || []).map((m) => m.id));
    for (const id of modelIdsNamedIn(obj)) if (!ids.has(id)) E.push(`data/${feed.file}: names model "${id}", which is not an id in data/models.json`);
    if (feed.file === 'board-samples.json') {
      const labels = new Set(((files.plans && files.plans.plans) || []).map(planLabel));
      const pd = obj.personal_default;
      if (pd !== undefined) {
        if (!pd || typeof pd !== 'object' || !Array.isArray(pd.plans) || !Array.isArray(pd.models)) E.push('data/board-samples.json: personal_default must be {plans: [plan labels], models: [model ids]}');
      }
      const named = [...((pd && pd.plans) || [])];
      for (const d of (obj.org && obj.org.divisions) || []) for (const person of d.people || []) if (person.plan) named.push(person.plan);
      for (const n of named) if (!labels.has(n)) E.push(`data/board-samples.json: names plan "${n}", which is not a plan label in data/plans.json`);
    }
    return E;
  };
}

function checkPerRequest(f, { 'per-request.json': pr, models }, ctx) {
  const E = [...asOfProblems(pr.as_of, 'data/per-request.json:', ctx)];
  if (!isUrl(pr.source_url)) E.push('data/per-request.json: source_url is required (http(s) URL)');
  const ids = new Set((models.models || []).map((m) => m.id));
  if (!Array.isArray(pr.rows) || !pr.rows.length) E.push('data/per-request.json: rows must be a non-empty array of {model_id, in, out}');
  else pr.rows.forEach((r, i) => {
    const who = `data/per-request.json rows[${i}] (${r && r.model_id})`;
    if (!r || typeof r !== 'object') { E.push(`${who} must be an object`); return; }
    if (!ids.has(r.model_id)) E.push(`${who}: model_id is not an id in data/models.json`);
    for (const k of ['in', 'out']) if (typeof r[k] !== 'number' || Number.isNaN(r[k]) || r[k] < 0) E.push(`${who}: ${k} must be a non-negative number (tokens per request)`);
  });
  return E;
}

/** Every data file a page shows, what it feeds, and the check that holds it to the contract.
 * `file` is relative to the data dir; `optional` files are checked only when present. */
export const FEEDS = [
  { id: 'models', file: 'models.json', shows: 'model rows: name, prices, context, released, sources (index, table, board, install package)', check: checkModels },
  { id: 'releases', file: 'models.json', shows: 'releases[]: the timeline', check: checkReleases },
  { id: 'effort-ladders', file: 'models.json', shows: 'effort_ladders[]: the effort panel (points inherit the ladder source)', check: checkLadders },
  // guidance.json stays optional-if-missing, as gate 13 above has always had it (a throwaway copy
  // of scripts+data, like test-apply-judgment's sandbox, carries none); when present it is held to
  // the contract in full.
  { id: 'tool-defaults', file: 'guidance.json', optional: true, shows: 'claims, role_defaults, model_refs, effort_pages, tool_plans: the install package', check: checkGuidanceFeed },
  { id: 'plans', file: 'plans.json', shows: 'plan rows: seat prices on the board', check: checkPlans },
  { id: 'vendors', file: 'vendors.json', shows: 'vendor country rows (how-we-pick, board)', check: checkVendors },
  { id: 'tasks', file: 'tasks.json', shows: 'task labels (board)', check: null },
  { id: 'usage-presets', file: 'usage-presets.json', shows: 'usage levels (board)', check: null },
  { id: 'board-samples', file: 'board-samples.json', shows: 'example boards and the default personal setup', check: null },
  { id: 'per-request', file: 'per-request.json', optional: true, shows: 'tokens per request by model (board cost maths)', check: checkPerRequest },
];
for (const f of FEEDS) if (!f.check) f.check = checkNamesModels(f);

/** Run every feed's check. `files` maps a FEEDS file name to its parsed JSON (missing = absent).
 * models.json is always needed (the other feeds resolve model ids against it). */
export function validateFeeds(files, { today = utcToday() } = {}) {
  const errors = [], warnings = [];
  const ctx = { today };
  const byName = {
    ...files,
    models: files['models.json'], guidance: files['guidance.json'], plans: files['plans.json'], vendors: files['vendors.json'],
  };
  if (!byName.models) return { errors: ['data/models.json: missing — every other feed resolves model ids against it'], warnings };
  for (const feed of FEEDS) {
    if (files[feed.file] === undefined || files[feed.file] === null) {
      if (!feed.optional) errors.push(`data/${feed.file}: missing — the ${feed.id} feed is shown on the site`);
      continue;
    }
    for (const e of feed.check(feed, byName, ctx)) errors.push(`[${feed.id}] ${e}`);
  }
  return { errors, warnings };
}

/** Read every FEEDS file that exists in `dirUrl` (a file: URL ending in /). Unparseable = error. */
export function loadFeeds(dirUrl) {
  const files = {}, errors = [];
  for (const name of new Set(FEEDS.map((f) => f.file))) {
    const u = new URL(name, dirUrl);
    if (!existsSync(u)) continue;
    try { files[name] = JSON.parse(readFileSync(u, 'utf8')); }
    catch (e) { errors.push(`data/${name}: couldn't read/parse (${e.message})`); }
  }
  return { files, errors };
}

function dataDirFromArgs(argv) {
  const i = argv.indexOf('--data');
  const v = i !== -1 ? argv[i + 1] : (argv.find((a) => a.startsWith('--data=')) || '').slice(7);
  if (i !== -1 && !v) throw new Error('--data needs a directory');
  return v ? pathToFileURL(resolve(v) + '/') : new URL('../data/', import.meta.url);
}

function main() {
  const DIR = dataDirFromArgs(process.argv.slice(2));
  const data = JSON.parse(readFileSync(new URL('models.json', DIR)));
  const registry = JSON.parse(readFileSync(new URL('./sources.json', import.meta.url)));
  const { errors, warnings } = validate(data, registry);
  const E = (m) => errors.push(m);
  const W = (m) => warnings.push(m);

  // 9. availability (scripts/derive-availability.mjs): where a model can actually be reached.
  // Two shapes of field, both enforced here:
  //   - openrouter is a definite, live-checked fact — true, false, or null (feed unreachable) are
  //     all legitimate.
  //   - every other flag (direct_api, aws_bedrock, google_vertex, azure, open_weights) is sourced
  //     by a fuzzy name/URL match, so a "false" there would be a guess, not a fact — true or null
  //     only. Getting this wrong here is exactly the kind of silent regression a gate exists to
  //     catch: it's cheap to accidentally flip a `?? false` into a `?? null` fallback and start
  //     asserting negatives no source actually backs.
  const AVAIL_BOOL_OR_NULL_ONLY_TRUE = ['direct_api', 'aws_bedrock', 'google_vertex', 'azure', 'open_weights'];
  const AVAIL_KEYS = [...AVAIL_BOOL_OR_NULL_ONLY_TRUE, 'openrouter', 'eu_hosting'];
  for (const m of data.models) {
    const id = m.name || m.id || '(unnamed)';
    const a = m.availability;
    if (a == null) { E(`${id}: missing availability{} — every model needs the field (scripts/derive-availability.mjs), even all-null`); continue; }
    if (typeof a !== 'object' || Array.isArray(a)) { E(`${id}: availability must be an object`); continue; }
    for (const k of AVAIL_KEYS) {
      const v = a[k];
      if (v !== null && v !== undefined && typeof v !== 'boolean') E(`${id}: availability.${k} is "${v}" — must be true, false, or null`);
    }
    for (const k of AVAIL_BOOL_OR_NULL_ONLY_TRUE) {
      if (a[k] === false) E(`${id}: availability.${k} is false — this field is sourced by a fuzzy match, so only true or null are honest; a miss is "not confirmed", never "confirmed absent"`);
    }
    if (!Array.isArray(a.sources)) E(`${id}: availability.sources must be an array`);
    else {
      for (const u of a.sources) if (typeof u !== 'string' || !/^https?:\/\//.test(u)) E(`${id}: availability.sources has a non-URL entry "${u}"`);
      // any asserted flag (true, or a definite false on openrouter) must trace to a source
      const anyAsserted = AVAIL_KEYS.some((k) => a[k] === true) || a.openrouter === false;
      if (anyAsserted && !a.sources.length) E(`${id}: availability has an asserted fact but sources[] is empty`);
    }
  }

  // 10. data/plans.json (scripts/refresh-plans.md): seat pricing, refreshed manually. Same honesty
  // rule as everything else — a price with no source_url can't ship, and "contact sales" is null,
  // never a guess at what a sales call would quote.
  // PLAN_VENDORS lives at module level (exported for the contract tests and the board).
  let plans = null;
  try {
    plans = JSON.parse(readFileSync(new URL('plans.json', DIR)));
  } catch (e) {
    E(`data/plans.json: couldn't read/parse (${e.message})`);
  }
  if (plans) {
    if (!Array.isArray(plans.plans)) E('data/plans.json: top-level "plans" must be an array');
    else {
      for (const p of plans.plans) {
        const pid = `${p.vendor || '?'} / ${p.plan || '?'}`;
        if (!p.vendor || !PLAN_VENDORS.includes(p.vendor)) E(`plan ${pid}: vendor must be one of ${PLAN_VENDORS.join(', ')}`);
        if (!p.plan) E(`plan ${pid}: missing plan name`);
        if (p.price_usd_month !== null && (typeof p.price_usd_month !== 'number' || p.price_usd_month < 0)) {
          E(`plan ${pid}: price_usd_month must be a non-negative number or null (contact-sales/JS-only price)`);
        }
        if (!p.billing) W(`plan ${pid}: no billing note`);
        if (!p.source_url) E(`plan ${pid}: missing source_url — every price traces to the vendor's own pricing page, or it's null`);
        else if (typeof p.source_url !== 'string' || !/^https?:\/\//.test(p.source_url)) E(`plan ${pid}: source_url "${p.source_url}" isn't a URL`);
        if (!p.as_of) E(`plan ${pid}: missing as_of date`);
        else if (!/^\d{4}-\d{2}-\d{2}$/.test(p.as_of)) E(`plan ${pid}: as_of "${p.as_of}" must be YYYY-MM-DD`);
        // The one guess this schema can't allow: a real number with no page behind it.
        if (typeof p.price_usd_month === 'number' && !p.source_url) E(`plan ${pid}: has a price but no source_url — never invent a price`);
      }
    }
  }

  // 11. data/vendors.json (archive/engine/assets/decide.mjs's noChinaHosted data rule): every vendor in
  // scripts/naming.mjs's VENDORS needs exactly one row here, or a new vendor would silently
  // read as "unknown country" (kept, not excluded) instead of a deliberate call. country is a
  // plain string or null (never a guessed default); source, when present, must be a real URL —
  // see data/vendors.json's own _readme for how these were sourced (a one-time editorial pass,
  // not the automated Collect pipeline).
  let vendorsFile = null;
  try {
    vendorsFile = JSON.parse(readFileSync(new URL('vendors.json', DIR)));
  } catch (e) {
    E(`data/vendors.json: couldn't read/parse (${e.message})`);
  }
  if (vendorsFile) {
    if (!Array.isArray(vendorsFile.vendors)) E('data/vendors.json: top-level "vendors" must be an array');
    else {
      const seenVendors = new Set();
      for (const v of vendorsFile.vendors) {
        const vid = v.vendor || '(unnamed)';
        if (!VENDORS.includes(v.vendor)) E(`data/vendors.json: "${vid}" is not a canonical vendor in scripts/naming.mjs VENDORS`);
        if (seenVendors.has(v.vendor)) E(`data/vendors.json: duplicate row for "${vid}"`);
        seenVendors.add(v.vendor);
        if (v.country !== null && typeof v.country !== 'string') E(`data/vendors.json: "${vid}" country must be a string or null`);
        if (v.source != null && (typeof v.source !== 'string' || !/^https?:\/\//.test(v.source))) E(`data/vendors.json: "${vid}" source "${v.source}" isn't a URL`);
      }
      for (const canon of VENDORS) if (!seenVendors.has(canon)) W(`data/vendors.json: no row for canonical vendor "${canon}" — the noChinaHosted rule will treat it as unknown-country (kept)`);
    }
  }

  // 12. data/usage-presets.json (archive/engine/assets/decide.mjs's volume input): the three named bands must
  // each carry non-negative monthly token counts and a plain-English rationale — these are
  // stated assumptions, not sourced facts, but an assumption with no rationale is just a guess
  // wearing a label.
  let presetsFile = null;
  try {
    presetsFile = JSON.parse(readFileSync(new URL('usage-presets.json', DIR)));
  } catch (e) {
    E(`data/usage-presets.json: couldn't read/parse (${e.message})`);
  }
  if (presetsFile) {
    const PRESET_KEYS = ['light', 'typical', 'heavy'];
    if (typeof presetsFile.presets !== 'object' || presetsFile.presets == null) E('data/usage-presets.json: top-level "presets" must be an object');
    else {
      for (const key of PRESET_KEYS) {
        const p = presetsFile.presets[key];
        if (!p) { E(`data/usage-presets.json: missing preset "${key}"`); continue; }
        for (const field of ['tokens_in_month', 'tokens_out_month']) {
          if (typeof p[field] !== 'number' || p[field] < 0) E(`data/usage-presets.json: preset "${key}".${field} must be a non-negative number`);
        }
        if (!p.rationale || typeof p.rationale !== 'string') E(`data/usage-presets.json: preset "${key}" is missing a plain-English rationale`);
      }
    }
  }

  // 13. data/guidance.json (the instruction package's sourced facts). Optional-if-missing so a
  // throwaway copy of scripts+data (test-apply-judgment's sandbox) still passes; when present it
  // must pass validateGuidance against this same catalog.
  let guidance = null;
  const guidanceUrl = new URL('guidance.json', DIR);
  if (existsSync(guidanceUrl)) {
    try {
      guidance = JSON.parse(readFileSync(guidanceUrl));
    } catch (e) {
      E(`data/guidance.json: couldn't read/parse (${e.message})`);
    }
    if (guidance) {
      const g = validateGuidance(guidance, data);
      g.errors.forEach(E);
      g.warnings.forEach(W);
    }
  } else {
    W('data/guidance.json: not found — skipped the guidance checks');
  }

  // 13b. data/defaults-watch.json (the weekly defaults watch's rules): config, not a site feed —
  // shape only, plus every path and claim id it names must exist in the data.
  const watchUrl = new URL('defaults-watch.json', DIR);
  if (existsSync(watchUrl)) {
    try {
      const watch = JSON.parse(readFileSync(watchUrl));
      const w = validateWatchList(watch, { guidance, plans });
      w.errors.forEach(E);
      w.warnings.forEach(W);
    } catch (e) {
      E(`data/defaults-watch.json: couldn't read/parse (${e.message})`);
    }
  }

  // 14. the data contract (FEEDS): file as_of + a source and a date for every shown line.
  {
    const { files, errors: readErrors } = loadFeeds(DIR);
    readErrors.forEach(E);
    const f = validateFeeds(files);
    f.errors.forEach(E);
    f.warnings.forEach(W);
  }

  if (warnings.length) { console.log('⚠ warnings (non-blocking):'); warnings.forEach((w) => console.log('  - ' + w)); }
  if (errors.length) {
    console.error(`\n✗ ${errors.length} honesty-gate error(s) — blocking:`);
    errors.forEach((e) => console.error('  - ' + e));
    process.exit(1);
  }
  const ladderPts = (data.effort_ladders || []).reduce((n, L) => n + (L.series || []).reduce((k, s) => k + (s.points || []).length, 0), 0);
  const planCount = plans?.plans?.length || 0;
  const vendorCount = vendorsFile?.vendors?.length || 0;
  const feedCount = FEEDS.filter((f) => f.optional ? existsSync(new URL(f.file, DIR)) : true).length;
  console.log(`\n✓ honesty gate passed: ${feedCount} feed(s) under the data contract, ${data.models.length} models, ${(data.releases || []).length} releases, ${(data.effort_ladders || []).length} effort ladder(s) / ${ladderPts} points, ${planCount} plan(s), ${vendorCount} vendor(s), ${guidance?.claims?.length || 0} guidance claim(s), 0 errors.`);
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try { return fileURLToPath(import.meta.url) === realpathSync(resolve(process.argv[1])); }
  catch { return fileURLToPath(import.meta.url) === process.argv[1]; }
})();
if (isMain) main();
