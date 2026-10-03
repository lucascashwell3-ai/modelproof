// Modelproof instruction package generator — the ONE generator.
//
// Pure ES module: no imports, no clock, no network, no randomness. The board (browser), the
// installer (Node) and the skill all call it, so the same answers always give the same bytes.
//
// A package is a list of parts: helper-agent files that set a model the tool obeys (the backbone),
// plus one short text part per tool (never the only lever). The plan per tool comes from
// data/guidance.json tool_plans (each slot quoted with url + date):
// - Lead: the user's own choice, else the model the tool's docs name as its default, else the
//   model they choose in the tool. Effort is shown as information with its source, never set.
// - Helpers (scout, builder, reviewer): inherit the lead's model unless the user chose one. When
//   the user hits limits often or sometimes, a sourced text line names the tool's own push-down
//   for a well-scoped thread (a habit, not a setting).
// - Bulk: the only helper pushed down by default, to the model the tool's docs name for
//   mechanical, checkable work, written only when the docs give the string its file takes.
// A tool with no instruction file of its own (OpenRouter / a raw API) gets copy-only text: the
// installer writes nothing for it. Nothing here ranks models.
//
// It also holds the one definition of the marker lines the installer writes around a block and
// the owned-file stamp (end of file), so the board's Copy text prints the same bytes.

export const GENERATOR_VERSION = '1.1.0';
export const TOOLS = ['claude-code', 'codex', 'cursor', 'copilot', 'antigravity', 'openrouter', 'agents-md'];
export const ROLES = ['scout', 'builder', 'reviewer', 'bulk'];

/* ------------------------------------------------------------------ constants */

const PROFILE_SCHEMA = 'modelproof.profile/1';
const PACKAGE_SCHEMA = 'modelproof.package/1';
const SITE_EFFORT_URL = 'https://lucascashwell3-ai.github.io/modelproof/#effort';
const OWNED_TAG = '<!-- modelproof:owned v1 -->';
const OWNED_TAG_TOML = '# modelproof:owned v1';
const LIMITS = ['often', 'sometimes', 'rarely', 'api-budget'];
const WORK_IDS = ['coding', 'agents', 'bulk', 'writing', 'research', 'extraction', 'chat', 'vision', 'frontend', 'exec-summaries'];
const ALL_ROLE_KEYS = ['lead', ...ROLES];
// The helpers that run on the lead's model unless the user chose one; bulk is the one pushed down.
const HELPER_ROLES = ['scout', 'builder', 'reviewer'];
const PUSH_DOWN_LIMITS = ['often', 'sometimes'];
const TEXT_CAP = { person: 40, org: 60 };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const URL_RE = /^https:\/\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+$/;
// Built from escapes so the source file holds no raw U+2028 / U+2029 characters.
const LINE_BREAK = new RegExp('\\r\\n|\\r|\\n|\\u2028|\\u2029|\\u0085');
const DEAD_STATUS =['deprecated', 'retired', 'shutdown', 'removed'];

const TOOL_LABEL = {
  'claude-code': 'Claude Code', codex: 'Codex', cursor: 'Cursor', copilot: 'GitHub Copilot', antigravity: 'Antigravity',
  openrouter: 'OpenRouter / API', 'agents-md': 'AGENTS.md',
};
// The tools a package covers and their display names (the board's install pane lists these).
export const TOOL_LABELS = Object.freeze({ ...TOOL_LABEL });
const TOOL_SUBJECTS = {
  'claude-code': ['claude code'], codex: ['codex cli', 'codex'], cursor: ['cursor'], copilot: ['github copilot'],
  antigravity: ['antigravity', 'gemini cli'], openrouter: ['openrouter'], 'agents-md': ['agents.md'],
};
const TOOL_ALIASES = {
  'claude-code': 'claude-code', 'claude code': 'claude-code', claude: 'claude-code', cc: 'claude-code',
  codex: 'codex', 'codex cli': 'codex', 'openai codex': 'codex', 'codex-cli': 'codex',
  cursor: 'cursor',
  copilot: 'copilot', 'github copilot': 'copilot', 'github-copilot': 'copilot', 'gh copilot': 'copilot',
  antigravity: 'antigravity', 'google antigravity': 'antigravity', gemini: 'antigravity', 'gemini cli': 'antigravity', 'gemini-cli': 'antigravity',
  openrouter: 'openrouter', 'open router': 'openrouter', api: 'openrouter', 'raw api': 'openrouter', 'openrouter api': 'openrouter',
  'agents-md': 'agents-md', 'agents.md': 'agents-md', agentsmd: 'agents-md', 'agents md': 'agents-md',
};
// The lab whose models a tool runs, when it runs only one lab's models.
const TOOL_LAB = { 'claude-code': 'anthropic', codex: 'openai' };
// What a tool reaches without a plan saying more: its own lab, or every lab for a tool that runs
// several labs' models.
const TOOL_REACH = { 'claude-code': ['anthropic'], codex: ['openai'], antigravity: ['google'], cursor: 'all', copilot: 'all', openrouter: 'all' };
// Tools that get helper files. OpenRouter / a raw API has no helper file and no instruction file.
const HELPER_TOOLS = ['claude-code', 'codex', 'cursor', 'copilot', 'antigravity'];
const COPY_ONLY_TOOLS = ['openrouter'];

// Words a displayed quote or sentence must not carry: the package shows facts, never a ranking.
// Two terms are split so the shipped-wording scan stays clean on this file.
const RANKING_WORDS = new RegExp('\\b(best|better|top|winner|pick\\w*|recommend\\w*|suggest\\w*|'
  + 'ver' + 'dict|confi' + 'dence|start(s|ing)? (here|with))\\b', 'i');

// Lab self-praise a preview fact line must not carry (the preview shows facts, never promotion):
// "our most ...", "...est" superlatives, "yet", frontier-class, state-of-the-art, leading, world's.
// Plain time words (latest, newest), ordinary -est words (test, request), "most" as a count
// ("most coding tasks") and "not yet" are not praise.
const SUPERLATIVE_WORDS = /\b(our|its|their|the) most\b|(?<!\bnot )\byet\b|\b(frontier(-class)?|state[- ]of[- ]the[- ]art|leading|world[\u2019']s)\b/i;
const NOT_SUPERLATIVE = new Set(['latest', 'newest', 'test', 'request', 'interest', 'suggest', 'digest', 'manifest', 'honest', 'modest',
  'invest', 'contest', 'protest', 'rest', 'west', 'guest', 'nest', 'quest', 'chest', 'forest', 'earnest', 'harvest', 'arrest',
  'attest', 'ingest', 'unrest', 'backtest', 'pretest', 'retest', 'fest', 'zest', 'vest', 'crest', 'jest', 'pest', 'lest']);
function hasSuperlative(text) {
  const s = String(text || '');
  if (SUPERLATIVE_WORDS.test(s)) return true;
  return (s.toLowerCase().match(/\b[a-z]+est\b/g) || []).some((w) => !NOT_SUPERLATIVE.has(w));
}

const JOB = {
  scout: 'reads and searches',
  builder: 'makes the planned change',
  reviewer: 'reviews the diff cold',
  bulk: 'does mechanical work a check can verify',
};
const AGENT_DESCRIPTION = {
  scout: 'Reads, searches and sums up code or docs for the lead. Use it for long reading and lookups. It does not edit files.',
  builder: 'Makes one planned change from a brief (exact files, goal, done check) and reports the check result.',
  reviewer: 'Reviews a change cold from the diff, runs the checks itself, and reports problems with file:line.',
  bulk: 'Does mechanical, repetitive work (renames, boilerplate, many small edits) whose result a script or test can check.',
};
const AGENT_BODY = {
  scout: [
    'You are the scout. You find and read; you do not edit files.',
    '- Search first (grep or glob), then open only the line ranges you need.',
    '- Never read a large file whole.',
    '- Answer in a few lines: what you found, with file:line for each fact.',
    '- Say what you could not find.',
    '- Put long findings in a file on disk and return its path.',
  ],
  builder: [
    'You are the builder. You make the change the lead planned.',
    '- Touch only the files the brief names; ask before touching others.',
    '- Run the done check from the brief and report its exact result.',
    '- Return in a few lines: files changed, the last lines of the check, anything left undone.',
    '- Put long logs in a file on disk and return its path.',
  ],
  reviewer: [
    'You are the reviewer. You review cold: the diff, not the author\'s summary.',
    '- Read the diff (git diff) and the files it touches.',
    '- Run the project\'s checks yourself; scripts decide pass or fail.',
    '- Report problems worst first, each with file:line and a one-line fix.',
    '- Say plainly when you found nothing wrong. Do not edit files.',
  ],
  bulk: [
    'You are the bulk helper. You do mechanical work the lead has already planned.',
    '- Follow the brief exactly: the files, the change, and the check that proves it.',
    '- Run the check after the change and report its exact result.',
    '- Stop and report back when a step needs judgment the brief does not give.',
    '- Return in a few lines: what changed, the last lines of the check.',
  ],
};
// Antigravity helper files list the tools a helper may use (names from Antigravity's own docs).
const ANTIGRAVITY_TOOLS = {
  scout: ['view_file', 'grep_search'],
  builder: ['view_file', 'grep_search', 'replace_file_content', 'run_command'],
  reviewer: ['view_file', 'grep_search', 'run_command'],
  bulk: ['view_file', 'grep_search', 'replace_file_content', 'run_command'],
};
const EXPLORE_BODY = [
  'You explore the codebase and report back; you do not edit files.',
  '- Search first, then read only the line ranges you need.',
  '- Answer briefly, with file:line for each fact.',
];

/* ------------------------------------------------------------------ small helpers */

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v : []);
const num = (v) => typeof v === 'number' && Number.isFinite(v);
const uniq = (list) => list.filter((v, i) => list.indexOf(v) === i);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Free text from a profile: one line, [A-Za-z0-9 ._+-] only, ≤ max chars.
function cleanText(v, max = 40) {
  if (v === null || v === undefined || typeof v === 'object') return '';
  const first = String(v).split(LINE_BREAK)[0];
  return first.replace(/[^A-Za-z0-9 ._+-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();
}
// Text that came from a data file (model names, claim sentences and quotes): one line, no
// comment or marker syntax, no leading @ or #, bounded length. Data is data, never markup.
function safeLine(v, max = 400) {
  if (v === null || v === undefined || typeof v === 'object') return '';
  let s = String(v).split(LINE_BREAK)[0];
  s = s.replace(/<!--|-->|[<>`]/g, ' ').replace(/modelproof:/gi, 'modelproof ');
  s = s.replace(/\s+/g, ' ').trim().replace(/^[@#]+/, '').trim();
  return s.slice(0, max).trim();
}
function safeUrl(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  return URL_RE.test(s) && s.length <= 300 && !/<!--|-->|modelproof:/i.test(s) ? s : null;
}
function safeDate(v) { return typeof v === 'string' && DATE_RE.test(v) ? v : null; }
function labKey(v) {
  return String(v === null || v === undefined ? '' : v).toLowerCase()
    .replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9.]+/g, ' ').trim().replace(/\s+ai$/, '').trim();
}
function fmtUsd(n) {
  if (!num(n)) return '?';
  return '$' + (Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3))));
}
function priceText(price) {
  return price ? `list price ${fmtUsd(price.input)} in / ${fmtUsd(price.output)} out per 1M tokens` : 'no list price on file';
}
function stripParen(name) { return String(name).replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s+/g, ' ').trim(); }
function countLines(text) { return text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0; }

/* ------------------------------------------------------------------ facts */

function indexFacts(facts) {
  const f = isObj(facts) ? facts : {};
  const mfile = f.models;
  const rawModels = Array.isArray(mfile) ? mfile : arr(isObj(mfile) ? mfile.models : null);
  const models = [];
  const byId = new Map();
  for (const m of rawModels) {
    if (!isObj(m) || typeof m.id !== 'string' || !ID_RE.test(m.id) || byId.has(m.id)) continue;
    const name = safeLine(m.name, 60) || m.id;
    const vendor = safeLine(m.vendor, 60);
    const or = isObj(m.usage) && isObj(m.usage.openrouter) ? m.usage.openrouter : null;
    const rec = {
      id: m.id, name, vendor, lab: labKey(vendor),
      status: typeof m.status === 'string' ? m.status : '',
      released: typeof m.released === 'string' ? m.released : null,
      price: num(m.price_input) && num(m.price_output) ? { input: m.price_input, output: m.price_output } : null,
      usage: or && num(or.share) ? { openrouter_share: or.share, as_of: safeDate(or.as_of), source_url: safeUrl(or.source_url) } : null,
    };
    models.push(rec);
    byId.set(rec.id, rec);
  }
  // Longest terms first, so "GPT-6 Luna Pro" is claimed before "GPT-6 Luna" can match inside it.
  const terms = [];
  for (const m of models) {
    for (const t of uniq([m.id, stripParen(m.name)])) if (t.length >= 3) terms.push({ t: t.toLowerCase(), id: m.id });
  }
  terms.sort((a, b) => b.t.length - a.t.length || (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  for (const x of terms) x.re = new RegExp('(^|[^a-z0-9.-])' + esc(x.t) + '(?![a-z0-9-]|\\.[0-9])', 'g');

  const g = isObj(f.guidance) ? f.guidance : {};
  const claims = [];
  const claimById = new Map();
  for (const c of arr(g.claims)) {
    if (!isObj(c) || typeof c.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(c.id) || claimById.has(c.id)) continue;
    if (!isObj(c.subject) || !['tool', 'lab'].includes(c.subject.kind)) continue;
    const url = safeUrl(c.source_url);
    const date = safeDate(c.date);
    const sentence = safeLine(c.sentence);
    const quote = safeLine(c.quote);
    const subject = safeLine(c.subject.name, 40);
    if (!url || !date || !sentence || !quote || !subject) continue;
    const rec = { id: c.id, kind: c.subject.kind, subject, subjectKey: labKey(subject), topic: String(c.topic || ''), tier: String(c.tier || ''), sentence, quote, source_url: url, date };
    claims.push(rec);
    claimById.set(rec.id, rec);
  }
  const refs = [];
  for (const r of arr(g.model_refs)) {
    if (!isObj(r) || !TOOLS.includes(r.tool) || typeof r.ref !== 'string' || !REF_RE.test(r.ref)) continue;
    if (typeof r.model_id !== 'string' || !byId.has(r.model_id)) continue;
    refs.push({ tool: r.tool, ref: r.ref, model_id: r.model_id, basis: arr(r.basis).filter((id) => claimById.has(id)) });
  }
  // tool_plans: one Lead / Helpers / Bulk plan per tool. Only ids that are claims in this file
  // are kept as a basis; a slot names a catalog model only where the data gives one.
  const toolPlans = new Map();
  const effortValues = [];
  const word = (v) => (typeof v === 'string' && /^[a-z]{1,12}$/.test(v) ? v : null);
  const ids = (v) => arr(v).filter((id) => claimById.has(id));
  const slotOf = (x) => {
    if (!isObj(x)) return null;
    const modelId = typeof x.model_id === 'string' && byId.has(x.model_id) ? x.model_id : null;
    return { model_id: modelId, effort: word(x.effort), raise_to: word(x.raise_to), when: safeLine(x.when, 120) || null, basis: ids(x.basis) };
  };
  for (const t of arr(g.tool_plans)) {
    if (!isObj(t) || !TOOLS.includes(t.tool) || toolPlans.has(t.tool)) continue;
    const levels = isObj(t.effort_levels) ? arr(t.effort_levels.values).map(word).filter(Boolean) : [];
    for (const v of levels) if (!effortValues.includes(v)) effortValues.push(v);
    const h = isObj(t.helpers) ? t.helpers : null;
    const bulk = slotOf(t.bulk);
    if (bulk) bulk.explore = isObj(t.bulk.explore) ? ids(t.bulk.explore.basis) : [];
    toolPlans.set(t.tool, {
      levels,
      lead: slotOf(t.lead),
      helpers: h ? { basis: ids(h.basis), push_down: slotOf(h.push_down) } : null,
      bulk,
    });
  }
  const plans = [];
  const prow = Array.isArray(f.plans) ? f.plans : arr(isObj(f.plans) ? f.plans.plans : null);
  for (const p of prow) {
    if (!isObj(p) || typeof p.vendor !== 'string' || typeof p.plan !== 'string') continue;
    const reaches = p.reaches === 'all' ? 'all' : Array.isArray(p.reaches) ? p.reaches.map(labKey).filter(Boolean) : null;
    plans.push({
      vendor: safeLine(p.vendor, 60), plan: safeLine(p.plan, 80), price: num(p.price_usd_month) ? p.price_usd_month : null,
      reaches, covers_tokens: typeof p.covers_tokens === 'boolean' ? p.covers_tokens : null,
    });
  }
  const asOf = safeDate(g.as_of) || safeDate(isObj(mfile) ? mfile.as_of : null) || null;
  const labNames = new Map();
  for (const m of models) if (m.lab && !labNames.has(m.lab)) labNames.set(m.lab, m.vendor);
  const modelsAsOf = safeDate(isObj(mfile) ? mfile.as_of : null);
  return { models, byId, terms, claims, claimById, refs, toolPlans, effortValues, plans, asOf, modelsAsOf, labNames, namedCache: new Map() };
}

// Model ids a piece of text names (ids or display names), longest match first.
function namedModels(F, text) {
  let s = String(text || '').toLowerCase();
  const found = new Set();
  for (const x of F.terms) {
    x.re.lastIndex = 0;
    if (!x.re.test(s)) continue;
    found.add(x.id);
    x.re.lastIndex = 0;
    s = s.replace(x.re, (all, pre) => pre + ' '.repeat(all.length - pre.length));
  }
  return found;
}
function claimModels(F, c) {
  if (!F.namedCache.has(c.id)) F.namedCache.set(c.id, [...namedModels(F, c.sentence + ' ' + c.quote)]);
  return F.namedCache.get(c.id);
}
function refsNamed(F, tool, text) {
  const out = new Set();
  const s = String(text || '').toLowerCase();
  for (const r of F.refs) {
    if (r.tool !== tool) continue;
    if (new RegExp('(^|[^a-z0-9-])' + esc(r.ref.toLowerCase()) + '(?![a-z0-9-])').test(s)) out.add(r.model_id);
  }
  return out;
}
function labName(F, key) { return F.labNames.get(key) || key; }

/* ------------------------------------------------------------------ reach */

// Which labs a plan reaches: the plan rows' own `reaches` (data/plans.json) for that vendor; else a
// plan from a model vendor reaches that lab; an unknown vendor reaches every lab (never hide models
// behind a plan the data doesn't carry).
function planReach(F, vendor) {
  const key = labKey(vendor);
  if (!key) return 'all';
  const rows = F.plans.filter((r) => labKey(r.vendor) === key && r.reaches);
  if (rows.length) {
    if (rows.some((r) => r.reaches === 'all')) return 'all';
    return uniq(rows.flatMap((r) => r.reaches));
  }
  for (const lab of F.labNames.keys()) {
    if (lab === key || key.startsWith(lab + ' ') || lab.startsWith(key + ' ')) return [lab];
  }
  return 'all';
}
function reachOf(F, plans, api, tools) {
  const r = { all: api === true, labs: new Set(), planLabs: new Set() };
  for (const p of plans) {
    const reach = planReach(F, p.vendor);
    if (reach === 'all') r.all = true;
    else for (const l of reach) { r.labs.add(l); r.planLabs.add(l); }
  }
  for (const t of tools) {
    const tr = TOOL_REACH[t];
    if (tr === 'all') r.all = true;
    else for (const l of arr(tr)) r.labs.add(l);
  }
  return r;
}
function mergeReach(a, b) {
  return { all: a.all || b.all, labs: new Set([...a.labs, ...b.labs]), planLabs: new Set([...a.planLabs, ...b.planLabs]) };
}
function isLive(m) { return !!m && !DEAD_STATUS.includes(String(m.status).toLowerCase()); }
function neverSets(F, never) {
  const ids = new Set();
  const labs = new Set();
  for (const n of never) {
    if (F.byId.has(n)) ids.add(n);
    else labs.add(labKey(n));
  }
  return { ids, labs };
}
function reachable(m, reach, nv) {
  return isLive(m) && (reach.all || reach.labs.has(m.lab)) && !nv.ids.has(m.id) && !nv.labs.has(m.lab);
}
function toolRuns(tool, m) { return !TOOL_LAB[tool] || (m && m.lab === TOOL_LAB[tool]); }

/* ------------------------------------------------------------------ profile */

function resolveModel(F, value) {
  const raw = cleanText(value, 60);
  if (!raw) return { id: null, raw };
  const low = raw.toLowerCase();
  if (!F) return { id: ID_RE.test(low) ? low : null, raw };
  if (F.byId.has(low)) return { id: low, raw };
  const ref = F.refs.find((r) => r.ref.toLowerCase() === low);
  if (ref) return { id: ref.model_id, raw };
  const byName = F.models.find((m) => cleanText(m.name, 60).toLowerCase() === low || stripParen(m.name).toLowerCase() === low);
  return { id: byName ? byName.id : null, raw };
}
function normTools(list, problems, label) {
  const out = [];
  for (const t of arr(list)) {
    const key = cleanText(t, 30).toLowerCase();
    const id = TOOL_ALIASES[key];
    if (id) out.push(id);
    else problems.push(`${label}: "${cleanText(t, 30)}" is not a tool this package covers (${TOOLS.map((x) => TOOL_LABEL[x]).join(', ')})`);
  }
  return TOOLS.filter((t) => out.includes(t));
}
function normPlans(list, problems, label) {
  const out = [];
  arr(list).slice(0, 12).forEach((p, i) => {
    const src = isObj(p) ? p : { vendor: '', plan: p };
    const vendor = cleanText(src.vendor);
    const plan = cleanText(src.plan);
    // Brackets and commas in a real plan name ("Team (Premium seat)") are dropped quietly.
    const benign = (v) => cleanText(String(v).replace(/[(),]/g, ' '), 200);
    if (isObj(p) && ((src.vendor && vendor !== benign(src.vendor)) || (src.plan && plan !== benign(src.plan)))) {
      problems.push(`${label}[${i}]: cleaned to "${[vendor, plan].filter(Boolean).join(' ')}" (letters, digits, space . _ + - only)`);
    }
    if (!vendor && !plan) { problems.push(`${label}[${i}]: empty; left out`); return; }
    const key = (vendor + '|' + plan).toLowerCase();
    if (!out.some((q) => (q.vendor + '|' + q.plan).toLowerCase() === key)) out.push({ vendor, plan });
  });
  return out;
}

export function normalizeProfile(input, facts) {
  const problems = [];
  const src = isObj(input) ? input : {};
  if (!isObj(input)) problems.push('profile: not an object; starting from empty answers');
  const F = facts ? indexFacts(facts) : null;

  const pickEnum = (key, allowed) => {
    const v = src[key];
    if (v === undefined || v === null) return null;
    const c = cleanText(v, 20).toLowerCase();
    if (allowed.includes(c)) { if (c !== v) problems.push(`${key}: cleaned to "${c}"`); return c; }
    problems.push(`${key}: "${cleanText(v, 20)}" is not one of ${allowed.join(', ')}; left out`);
    return null;
  };
  const who = pickEnum('who', ['person', 'org']) || 'person';
  const tools = normTools(src.tools, problems, 'tools');
  if (!tools.length) problems.push('tools: none given; the package has no files until a tool is named');
  const scope = pickEnum('scope', ['user', 'project']) || (who === 'org' ? 'project' : 'user');
  const plans = normPlans(src.plans, problems, 'plans');
  const api = src.api === true;
  const limits = pickEnum('limits', LIMITS);
  const work = [];
  for (const w of arr(src.work)) {
    const id = cleanText(w, 30).toLowerCase();
    if (WORK_IDS.includes(id)) { if (!work.includes(id)) work.push(id); } else problems.push(`work: "${cleanText(w, 30)}" is not a known kind of work; left out`);
  }
  work.sort((a, b) => WORK_IDS.indexOf(a) - WORK_IDS.indexOf(b));

  // never[]: model ids or lab names.
  const never = [];
  for (const n of arr(src.never).slice(0, 40)) {
    const r = resolveModel(F, n);
    if (r.id && (!F || F.byId.has(r.id))) { if (!never.includes(r.id)) never.push(r.id); continue; }
    const lk = labKey(cleanText(n, 40));
    if (F && lk && F.labNames.has(lk)) { const nm = labName(F, lk); if (!never.includes(nm)) never.push(nm); continue; }
    if (!F && r.raw) { if (!never.includes(r.raw)) never.push(r.raw); continue; }
    if (r.raw) problems.push(`never: "${r.raw}" is not a model or lab in the data; left out`);
  }

  // org (normalized before reach, since divisions widen what the org reaches).
  let org = null;
  if (who === 'org') {
    const o = isObj(src.org) ? src.org : {};
    const divisions = [];
    if (arr(o.divisions).length > 20) problems.push(`org.divisions: ${arr(o.divisions).length - 20} past the first 20 left out`);
    arr(o.divisions).slice(0, 20).forEach((d, i) => {
      if (!isObj(d)) { problems.push(`org.divisions[${i}]: not an object; left out`); return; }
      const name = cleanText(d.name) || `Division ${i + 1}`;
      if (d.name && cleanText(d.name) !== String(d.name).trim()) problems.push(`org.divisions[${i}].name: cleaned to "${name}"`);
      const people = num(d.people) && d.people >= 0 ? Math.min(Math.floor(d.people), 1000000) : null;
      divisions.push({
        name, people,
        plans: normPlans(d.plans, problems, `org.divisions[${i}].plans`),
        api: d.api === true,
        tools: normTools(d.tools, problems, `org.divisions[${i}].tools`),
        lead: d.lead === undefined || d.lead === null ? null : d.lead,
      });
    });
    org = { name: cleanText(o.name), divisions };
    if (o.name && cleanText(o.name) !== String(o.name).trim()) problems.push(`org.name: cleaned to "${org.name}"`);
  } else if (src.org !== undefined && src.org !== null) {
    problems.push('org: answers given for a person; left out');
  }

  let reach = null;
  let nv = null;
  if (F) {
    reach = reachOf(F, plans, api, tools);
    if (org) for (const d of org.divisions) reach = mergeReach(reach, reachOf(F, d.plans, d.api, d.tools));
    nv = neverSets(F, never);
  }
  const checkModel = (value, label) => {
    if (value === undefined || value === null || value === '') return null;
    const low = cleanText(value, 60).toLowerCase();
    if (low === 'inherit' || low === 'same' || low === 'same as lead') return null;
    const r = resolveModel(F, value);
    if (!r.id) { problems.push(`${label}: "${r.raw}" is not a model in the data; left out`); return null; }
    if (!F) return r.id;
    const m = F.byId.get(r.id);
    if (nv.ids.has(m.id) || nv.labs.has(m.lab)) { problems.push(`${label}: ${m.name} is on your never list; left out`); return null; }
    if (!reachable(m, reach, nv)) { problems.push(`${label}: ${m.name} is not reachable with your plans and tools; left out`); return null; }
    return m.id;
  };
  if (org) org.divisions.forEach((d, i) => { d.lead = checkModel(d.lead, `org.divisions[${i}].lead`); });

  const like = [];
  arr(src.like).slice(0, 12).forEach((v, i) => { const id = checkModel(v, `like[${i}]`); if (id && !like.includes(id)) like.push(id); });
  const roles = {};
  const srcRoles = isObj(src.roles) ? src.roles : {};
  for (const k of Object.keys(srcRoles)) if (!ALL_ROLE_KEYS.includes(k)) problems.push(`roles.${cleanText(k, 20)}: not a role (${ALL_ROLE_KEYS.join(', ')}); left out`);
  for (const k of ALL_ROLE_KEYS) { const id = checkModel(srcRoles[k], `roles.${k}`); if (id) roles[k] = id; }
  // Effort levels come from the tools' own docs (tool_plans effort_levels); with no data, any
  // plain level word is kept and each tool checks it against its own list.
  const effortCap = F && F.effortValues.length ? pickEnum('effort_cap', F.effortValues)
    : (src.effort_cap === undefined || src.effort_cap === null ? null : (/^[a-z]{1,12}$/.test(cleanText(src.effort_cap, 12).toLowerCase()) ? cleanText(src.effort_cap, 12).toLowerCase() : pickEnum('effort_cap', [])));

  const profile = {
    schema: PROFILE_SCHEMA, who, tools, scope, plans, api, limits, work, like, never, roles,
    effort_cap: effortCap, set_default_model: src.set_default_model === true,
    explore_override: src.explore_override === true, org,
  };
  return { profile, problems };
}

/* ------------------------------------------------------------------ roles */

function makeContext(p, F) {
  let reach = reachOf(F, p.plans, p.api, p.tools);
  if (p.org) for (const d of p.org.divisions) reach = mergeReach(reach, reachOf(F, d.plans, d.api, d.tools));
  const nv = neverSets(F, p.never);
  const inUse = new Set(reach.planLabs);
  for (const t of p.tools) for (const l of arr(TOOL_REACH[t])) inUse.add(l);
  const chosen = [...p.like, ...Object.values(p.roles)];
  if (p.org) for (const d of p.org.divisions) { if (d.lead) chosen.push(d.lead); for (const t of d.tools) for (const l of arr(TOOL_REACH[t])) inUse.add(l); }
  for (const id of chosen) { const m = F.byId.get(id); if (m) inUse.add(m.lab); }
  for (const l of [...inUse]) if (nv.labs.has(l)) inUse.delete(l);
  const labs = [...inUse].sort((a, b) => (labName(F, a) < labName(F, b) ? -1 : 1));
  return { reach, nv, labs, multiLab: labs.length >= 2, notes: [], used: new Set() };
}
function canUse(ctx, m) { return reachable(m, ctx.reach, ctx.nv); }
// A claim may be shown only if it carries no ranking words and every model it names is one the
// user can reach and has not ruled out.
function claimShowable(F, ctx, c, field, tool) {
  if (!c) return false;
  if (field && RANKING_WORDS.test(field === 'both' ? c.sentence + ' ' + c.quote : c[field])) return false;
  const named = new Set(claimModels(F, c));
  if (tool) for (const id of refsNamed(F, tool, c.sentence + ' ' + c.quote)) named.add(id);
  for (const id of named) if (!canUse(ctx, F.byId.get(id))) return false;
  return true;
}
function basisRec(c) { return { id: c.id, sentence: c.sentence, quote: c.quote, source_url: c.source_url, date: c.date }; }
function refFor(F, tool, m) {
  if (!m) return null;
  const r = F.refs.find((x) => x.tool === tool && x.model_id === m.id);
  if (r) return r.ref;
  // Claude Code accepts a full model id; Codex takes the id form its own config docs show.
  if ((tool === 'claude-code' || tool === 'codex') && toolRuns(tool, m) && REF_RE.test(m.id)) return m.id;
  return null;
}
// The claims of a plan slot a line may show (no ranking words in the field shown, every model
// named reachable), as basis records.
function showable(F, ctx, ids, tool, field) {
  return ids.map((id) => F.claimById.get(id)).filter((c) => claimShowable(F, ctx, c, field, tool)).map(basisRec);
}
// A slot's sentence claim: the first basis claim whose own sentence can be shown.
function slotSentence(F, ctx, ids, tool) {
  const c = ids.map((id) => F.claimById.get(id)).find((x) => claimShowable(F, ctx, x, 'sentence', tool));
  return c || null;
}
const emptyRole = (basis = []) => ({ model_ref: null, model_id: null, model_name: null, from: 'inherit', basis, price: null, usage: null });

function roleFor(F, p, ctx, tool, role) {
  const plan = F.toolPlans.get(tool) || null;
  const modelRec = (m, from, basis) => ({
    model_ref: refFor(F, tool, m), model_id: m.id, model_name: m.name, from,
    basis: basis.map(basisRec), price: m.price, usage: m.usage,
  });
  // Effort for the lead, as information: the tool's documented default and when to raise it,
  // shown only for the model the tool's plan names.
  const effortInfo = (m) => {
    const L = plan && plan.lead;
    if (!L || !m || L.model_id !== m.id || !L.effort) return null;
    const basis = showable(F, ctx, L.basis, tool, 'quote');
    return basis.length ? { effort: L.effort, raise_to: L.raise_to, when: L.when, basis } : null;
  };
  const chosenId = p.roles[role];
  if (chosenId) {
    const m = F.byId.get(chosenId);
    if (m && canUse(ctx, m) && toolRuns(tool, m)) {
      const rec = modelRec(m, 'you', []);
      // A helper the user put on one model stays on that model: Claude Code's helper files take a
      // full model id (cc-subagent-model-values), so a floating alias never moves it to a later
      // release. Aliases stay only for the tool's own documented defaults (from: 'tool').
      if (role !== 'lead' && tool === 'claude-code' && REF_RE.test(m.id)) rec.model_ref = m.id;
      if (role === 'lead') { const e = effortInfo(m); if (e) rec.effort_info = e; }
      return rec;
    }
    if (m && !toolRuns(tool, m)) ctx.notes.push(`${TOOL_LABEL[tool]} runs only ${labName(F, TOOL_LAB[tool])} models, so your ${role} choice (${m.name}) applies to your other tools; in ${TOOL_LABEL[tool]} the ${role} follows the lead.`);
  }
  // A slot of the tool's plan that names a model the user can run: from the tool's (or its lab's)
  // own docs. `needRef`: the model is written into a file, so the tool's own string for it must be
  // on file in model_refs (scripts/validate-data.mjs checks its basis quotes that string) — never
  // the catalog id by default, which no source gives.
  const fromPlan = (slot, needRef) => {
    if (!slot || !slot.model_id) return null;
    const m = F.byId.get(slot.model_id);
    if (!m || !toolRuns(tool, m)) return null;
    if (!canUse(ctx, m)) {
      // Said without naming the model: a model on the never list is never named back.
      if (ctx.nv.ids.has(m.id) || ctx.nv.labs.has(m.lab)) ctx.notes.push(`${TOOL_LABEL[tool]}: the model its docs name for ${role === 'lead' ? 'the lead' : `modelproof-${role}`} is on your never list, so ${role === 'lead' ? 'the lead is the model you choose' : 'it runs on the lead\'s model'}.`);
      return null;
    }
    const basis = slot.basis.map((id) => F.claimById.get(id)).filter((c) => claimShowable(F, ctx, c, 'quote', tool));
    if (!basis.length) return null;
    const rec = modelRec(m, basis.some((c) => c.tier === 'tool') ? 'tool' : 'lab', basis);
    const ref = F.refs.find((x) => x.tool === tool && x.model_id === m.id);
    if (needRef && !ref) return null;
    rec.model_ref = ref ? ref.ref : rec.model_ref;
    return rec;
  };
  if (role === 'lead') {
    const rec = plan ? fromPlan(plan.lead, false) : null;
    if (rec) { const e = effortInfo(F.byId.get(rec.model_id)); if (e) rec.effort_info = e; return rec; }
    // No default the user can run: the model they choose in the tool, with the tool's own words.
    return emptyRole(plan && plan.lead ? showable(F, ctx, plan.lead.basis, tool, 'sentence') : []);
  }
  if (role === 'bulk') {
    const rec = plan ? fromPlan(plan.bulk, HELPER_TOOLS.includes(tool)) : null;
    if (rec) return rec;
    const out = emptyRole(plan && plan.bulk ? showable(F, ctx, plan.bulk.basis, tool, 'sentence') : []);
    out.choice = true;
    return out;
  }
  return emptyRole(plan && plan.helpers ? showable(F, ctx, plan.helpers.basis, tool, 'quote') : []);
}
// The near-a-full-limit line: a TEXT line, never a model setting. Only for someone who hits their
// limits often or sometimes, and only where the tool's plan has a sourced push-down.
function nearLimitFor(F, p, ctx, tool) {
  const plan = F.toolPlans.get(tool);
  const pd = plan && plan.helpers && plan.helpers.push_down;
  if (!pd || !PUSH_DOWN_LIMITS.includes(p.limits)) return null;
  if (pd.model_id) {
    const m = F.byId.get(pd.model_id);
    const basis = showable(F, ctx, pd.basis, tool, 'quote');
    if (!m || !canUse(ctx, m) || !toolRuns(tool, m) || !basis.length) return null;
    return { model_ref: refFor(F, tool, m), model_id: m.id, model_name: m.name, when: pd.when, basis, price: m.price, usage: m.usage };
  }
  const c = slotSentence(F, ctx, pd.basis, tool);
  return c ? { model_ref: null, model_id: null, model_name: null, when: pd.when, basis: [basisRec(c)], choice: true } : null;
}
function rolesFor(F, p, ctx) {
  const out = {};
  for (const tool of p.tools) {
    const t = {};
    for (const role of ALL_ROLE_KEYS) {
      t[role] = roleFor(F, p, ctx, tool, role);
      for (const b of t[role].basis) ctx.used.add(b.id);
      if (t[role].effort_info) for (const b of t[role].effort_info.basis) ctx.used.add(b.id);
    }
    const nl = nearLimitFor(F, p, ctx, tool);
    if (nl) { t.near_limit = nl; for (const b of nl.basis) ctx.used.add(b.id); }
    out[tool] = t;
  }
  return out;
}

export function roleDefaults(profile, facts) {
  const F = indexFacts(facts);
  const { profile: p } = normalizeProfile(profile, facts);
  return rolesFor(F, p, makeContext(p, F));
}

/* ------------------------------------------------------------------ setup */

function safePath(v, fallback) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s || s.length > 200 || !/^(~|\/)[A-Za-z0-9._/ +-]*$/.test(s) || /(^|\/)\.\.(\/|$)/.test(s)) return fallback;
  return s.replace(/\/+$/, '') || fallback;
}
function normalizeSetup(setup) {
  const s = isObj(setup) ? setup : null;
  const dirs = s && isObj(s.dirs) ? s.dirs : {};
  const reads = s ? s.claude_reads_project_agents_md : true;
  const ov = s && isObj(s.agents_override) ? s.agents_override : {};
  const agents = [];
  for (const a of arr(s && s.agents)) {
    if (!isObj(a) || typeof a.name !== 'string') continue;
    agents.push({
      tool: TOOLS.includes(a.tool) ? a.tool : null, scope: a.scope === 'project' ? 'project' : 'user', name: a.name, modelproof: a.modelproof === true,
      path: safeLine(a.path, 200) || null, description: safeLine(a.description, 200) || null,
    });
  }
  // Lines of their own instructions that talk about models or helpers, and who reads each file.
  const headsUp = [];
  for (const h of arr(s && s.heads_up).slice(0, 30)) {
    if (!isObj(h) || !Number.isInteger(h.line) || h.line < 1) continue;
    const file = safeLine(h.file, 200);
    const text = safeLine(h.text, 80);
    if (file && text && text !== '(line not shown)') headsUp.push({ file, line: h.line, text });
  }
  const readersOf = new Map();
  for (const f of arr(s && s.files)) if (isObj(f) && typeof f.path === 'string') readersOf.set(safeLine(f.path, 200), arr(f.readers).filter((t) => TOOLS.includes(t)));
  const settings = [];
  for (const x of arr(s && s.settings)) {
    if (!isObj(x)) continue;
    settings.push({ scope: x.scope === 'project' ? 'project' : 'user', keys: arr(x.keys).filter((k) => typeof k === 'string') });
  }
  const present = s && isObj(s.tools) ? s.tools : null;
  // Where the installer keeps its record: the folder it will really use, when it says so.
  const stateDir = !s || s.state_dir === undefined ? '~/.modelproof' : safePath(s.state_dir, null);
  return {
    given: !!s, stateDir,
    dirs: { claude: safePath(dirs.claude, '~/.claude'), codex: safePath(dirs.codex, '~/.codex'), cursor: '~/.cursor', copilot: '~/.copilot', gemini: '~/.gemini' },
    claudeReadsAgents: reads === true ? true : reads === false ? false : 'unsure',
    override: { user: ov.user === true, project: ov.project === true },
    force: !!(s && isObj(s.env) && s.env.subagent_model_force === true),
    agents, settings, present, headsUp, readersOf,
  };
}

/* ------------------------------------------------------------------ text parts */

function sourceOf(c) { return `Source: ${c.subject} docs, ${c.source_url} (${c.date})`; }
// Who reads the project AGENTS.md block. 'agents-md' is the file, not a reader: it stands for the
// tools the guidance names as AGENTS.md readers (its "<tool>-reads-agents-md" claims) and any other.
function agentsReadBy(F, readers) {
  const tools = readers.filter((t) => t !== 'agents-md');
  if (!readers.includes('agents-md')) return tools.map((t) => TOOL_LABEL[t]).join(', ');
  const others = [];
  for (const c of F.claims) {
    if (c.kind !== 'tool' || !/-reads-agents-md$/.test(c.id)) continue;
    const t = HELPER_TOOLS.find((k) => TOOL_SUBJECTS[k].includes(c.subjectKey));
    if (t) tools.push(t);
    else others.push(c.subject);
  }
  const list = uniq([...HELPER_TOOLS.filter((t) => tools.includes(t)).map((t) => TOOL_LABEL[t]), ...others]);
  return list.length ? `${list.join(', ')} and other tools that read AGENTS.md` : 'any tool that reads AGENTS.md';
}
function youSource(m, asOf) { return `Source: your choice (${priceText(m.price)}${asOf ? ', as of ' + asOf : ''})`; }

// Source lines for a slot: one per distinct page, at most `max`.
function srcLines(F, basis, max) {
  const out = [];
  const urls = new Set();
  for (const b of arr(basis)) {
    if (out.length >= max) break;
    const c = F.claimById.get(b.id);
    if (!c || urls.has(c.source_url)) continue;
    urls.add(c.source_url);
    out.push(sourceOf(c));
  }
  return out;
}
// One line of the plan with its sources: on their own lines for one tool, inline (the first one)
// when several tools share the text. Every model line keeps a Source.
function planItem(main, sources, multi) {
  const srcs = sources.filter(Boolean);
  if (multi || !srcs.length) return { t: srcs.length ? `${main} ${srcs[0]}` : main };
  return { t: [main, ...srcs.map((x) => `  ${x}`)].join('\n') };
}
function shownModel(F, x) {
  const m = F.byId.get(x.model_id);
  return x.model_ref && x.model_ref !== m.id ? `${x.model_ref} (${m.name})` : m.name;
}
// The Lead / Helpers / Bulk lines for one tool.
function planLines(F, p, ctx, roles, tool, multi) {
  const r = roles[tool];
  const L = TOOL_LABEL[tool];
  const plan = F.toolPlans.get(tool) || null;
  const pre = (slot) => (multi ? `- ${L} ${slot}: ` : `- ${slot[0].toUpperCase()}${slot.slice(1)}: `);
  const sentenceOf = (basis) => { const c = basis[0] ? F.claimById.get(basis[0].id) : null; return c ? c.sentence : ''; };
  const lines = [];

  // Lead.
  const lead = r.lead;
  if (lead.from !== 'inherit') {
    const m = F.byId.get(lead.model_id);
    const e = lead.effort_info;
    let main = `${pre('lead')}${m.name}${lead.from === 'you' ? ' (your choice)' : `, ${L}'s default model`}`;
    if (e) main += `; effort ${e.effort} by default${e.raise_to && e.when ? `, ${e.raise_to} for ${e.when}` : ''}`;
    const srcs = lead.from === 'you' ? [youSource(m, F.modelsAsOf), ...srcLines(F, e ? e.basis : [], 1)] : srcLines(F, e ? e.basis : lead.basis, 2);
    lines.push(planItem(main + '.', srcs, multi));
  } else {
    const where = COPY_ONLY_TOOLS.includes(tool) ? 'the model you name in each request' : `the model you choose in ${L}`;
    const said = multi ? '' : sentenceOf(lead.basis);
    lines.push(planItem(`${pre('lead')}${where}.${said ? ' ' + said : ''}`, srcLines(F, lead.basis, 1), multi));
  }

  // Helpers: inherit unless the user chose a model for one.
  if (HELPER_TOOLS.includes(tool)) {
    const inherit = HELPER_ROLES.filter((role) => r[role].from === 'inherit');
    for (const role of HELPER_ROLES) {
      const x = r[role];
      if (x.from === 'inherit') continue;
      lines.push(planItem(`${pre(role)}modelproof-${role} (${JOB[role]}) runs ${shownModel(F, x)} (your choice).`, [youSource(F.byId.get(x.model_id), F.modelsAsOf)], multi));
    }
    if (inherit.length) {
      const names = inherit.map((role) => `modelproof-${role}`);
      const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
      const call = tool === 'claude-code' ? ' Call them by name and pass no model.' : '';
      lines.push(planItem(`${pre('helpers')}${list} ${names.length > 1 ? 'run' : 'runs'} on the lead's model (inherit).${call}`, srcLines(F, r[inherit[0]].basis, 2), multi));
    }
  }

  // Near a full usage limit: a habit, not a setting.
  const nl = r.near_limit;
  if (nl) {
    const main = nl.model_id
      ? `${pre('near a full usage limit')}${nl.when} can run on ${shownModel(F, nl)}; name that model in the call (no file sets it).`
      : `${pre('near a full usage limit')}${sentenceOf(nl.basis)}`;
    lines.push(planItem(main, srcLines(F, nl.basis, 2), multi));
  }

  // Bulk: the one helper pushed down by default.
  const b = r.bulk;
  const slot = plan && plan.bulk;
  const forWhat = slot && slot.when ? `, for ${slot.when}` : '';
  if (b.from !== 'inherit') {
    const m = F.byId.get(b.model_id);
    const where = HELPER_TOOLS.includes(tool) ? 'modelproof-bulk runs ' : '';
    const main = `${pre('bulk')}${where}${shownModel(F, b)}${b.from === 'you' ? ' (your choice)' : forWhat}.`;
    lines.push(planItem(main, b.from === 'you' ? [youSource(m, F.modelsAsOf)] : srcLines(F, b.basis, 2), multi));
  } else if (plan && plan.bulk) {
    const said = multi ? '' : sentenceOf(b.basis);
    const main = HELPER_TOOLS.includes(tool)
      ? `${pre('bulk')}modelproof-bulk runs on the lead's model until you set its model${forWhat}.`
      : `${pre('bulk')}the model you name per request${forWhat}.`;
    lines.push(planItem(`${main}${said ? ' ' + said : ''}`, srcLines(F, b.basis, 1), multi));
  }
  return lines;
}

function claimLine(F, ctx, id, tool, prio, text) {
  const c = F.claimById.get(id);
  if (!c) return null;
  if (!text && !claimShowable(F, ctx, c, 'sentence', tool)) return null;
  if (text && !claimShowable(F, ctx, c, null, tool)) return null;
  return { t: `- ${text || c.sentence} ${sourceOf(c)}`, prio, claim: id };
}

function effortClaimFor(F, ctx, labKeyWanted) {
  for (const c of F.claims) {
    if (c.kind !== 'lab' || c.topic !== 'effort' || c.subjectKey !== labKeyWanted) continue;
    if (claimShowable(F, ctx, c, 'sentence')) return c;
  }
  return null;
}

function renderText(F, p, ctx, roles, readers, opts) {
  const block = opts.kind === 'block';
  const h1 = block ? '##' : '#';
  const h2 = block ? '###' : '##';
  const has = (t) => readers.includes(t);
  const helperReaders = readers.filter((t) => HELPER_TOOLS.includes(t) && roles[t]);
  const work = p.work;
  const rows = (l) => l.t.split('\n').length;
  const wants = (...ids) => !work.length || ids.some((w) => work.includes(w));

  const head = [{ t: `${h1} Modelproof lead, helpers and bulk (facts as of ${F.asOf || 'the data date'})` }];
  if (p.who === 'org') head.push({ t: `Shared by ${p.org && p.org.name ? p.org.name : 'the team'}; each person keeps their own rules in their own files.` });

  const sections = [];
  // Lead, helpers, bulk: one set of lines per tool that reads this text.
  const helpers = [];
  const planReaders = readers.filter((t) => t !== 'agents-md' && roles[t]);
  for (const t of planReaders) helpers.push(...planLines(F, p, ctx, roles, t, planReaders.length > 1));
  if (has('agents-md') && !planReaders.length) {
    const r = roles['agents-md'];
    if (r && r.lead.from === 'you') {
      const m = F.byId.get(r.lead.model_id);
      helpers.push(planItem(`- Lead: ${m.name} (your choice).`, [youSource(m, F.modelsAsOf)], false));
    } else helpers.push({ t: '- Lead: the model you choose in your tool. Helpers run on it unless a line below names another.' });
    for (const role of ROLES) {
      if (!r || r[role].from !== 'you') continue;
      const m = F.byId.get(r[role].model_id);
      helpers.push(planItem(`- If your tool has helpers, the ${role} (${JOB[role]}) runs ${m.name}.`, [youSource(m, F.modelsAsOf)], false));
    }
  }
  if (helpers.length) sections.push({ title: 'Lead, helpers and bulk', lines: helpers });

  // When to hand off: the sourced cost facts, framed as when a helper is worth it (Claude Code).
  if (has('claude-code')) {
    const wh = [];
    const v = claimLine(F, ctx, 'cc-delegate-verbose', 'claude-code', 3, 'Hand helpers verbose work (test runs, logs): only a summary comes back.');
    if (v) wh.push(v);
    const b = claimLine(F, ctx, 'anthropic-multi-agent-token-use', null, wants('agents') ? 3 : 5, 'Hand helpers parallel or separable work; each one adds tokens.');
    if (b) wh.push(b);
    const c = claimLine(F, ctx, 'anthropic-orchestrator-vs-lower-effort', null, 3, 'For a job one model can do alone, lower effort on that model cost less than an orchestrator.');
    if (c) wh.push(c);
    const a = claimLine(F, ctx, 'cc-subagent-usage-limits', 'claude-code', 2, 'Helpers share your usage limits.');
    if (a) wh.push(a);
    if (wh.length) sections.push({ title: 'When to hand off', lines: wh });
  }

  // Hand-off.
  const hand = [
    { t: '- Brief each helper with the exact files, the goal, and a check that proves it is done.' },
    { t: '- Ask for a short return; details go in a file on disk.' },
  ];
  if (wants('coding', 'frontend', 'agents', 'extraction')) hand.push({ t: '- Let scripts and tests decide pass or fail, not a summary.' });
  hand.push({ t: '- A cold review gets the diff, not the author\'s summary.' });
  sections.push({ title: 'How to hand off', lines: hand });

  // Context.
  const cx = [{ t: '- Search before reading; read line ranges, not whole big files.' }];
  if (wants('research', 'writing', 'exec-summaries', 'extraction', 'agents', 'bulk')) {
    cx.push({ t: helperReaders.length ? '- Hand long reading to modelproof-scout and take back a short summary.' : '- Hand long reading to a helper and take back a short summary.' });
  }
  if (has('claude-code')) { const l = claimLine(F, ctx, 'cc-subagent-own-context', 'claude-code', 4); if (l) cx.push(l); }
  if (has('codex')) { const l = claimLine(F, ctx, 'codex-agents-md-size-cap', 'codex', 4); if (l) cx.push(l); }
  sections.push({ title: 'Context', lines: cx });

  // Effort.
  const ef = [{ t: '- Raise effort for a hard step and lower it for routine ones; don\'t leave it at max.' }];
  if (has('claude-code')) { const l = claimLine(F, ctx, 'cc-subagent-effort', 'claude-code', 4); if (l) ef.push(l); }
  if (has('cursor')) { const l = claimLine(F, ctx, 'cursor-subagent-effort', 'cursor', 5); if (l) ef.push(l); }
  if (has('openrouter')) { const l = claimLine(F, ctx, 'openrouter-reasoning-parameter', 'openrouter', 5); if (l) ef.push(l); }
  const effortLabs = [];
  if (has('claude-code')) effortLabs.push('anthropic');
  if (has('codex')) effortLabs.push('openai');
  if (has('antigravity')) effortLabs.push('google');
  if (['cursor', 'copilot', 'openrouter', 'agents-md'].some(has)) for (const l of ctx.labs) if (!effortLabs.includes(l)) effortLabs.push(l);
  effortLabs.forEach((lk, i) => {
    if (!ctx.labs.includes(lk)) return;
    const c = effortClaimFor(F, ctx, lk);
    if (c) ef.push({ t: `- ${c.sentence} ${sourceOf(c)}`, prio: i < 2 ? 4 : 6, claim: c.id });
  });
  ef.push({ t: `- Effort levels per model, for you: ${SITE_EFFORT_URL}` });
  if (p.effort_cap) ef.push({ t: `- Your effort cap: ${p.effort_cap}. Stay at or below it.${opts.capKey && has('claude-code') ? ' maxEffortLevel in settings.json holds it in Claude Code.' : ''}` });
  sections.push({ title: 'Effort', lines: ef });

  // Org: who uses what (facts only, no totals).
  let who = null;
  if (p.who === 'org' && p.org && p.org.divisions.length) {
    const wu = [];
    for (const d of p.org.divisions) {
      const plans = d.plans.map((pl) => planFact(F, pl));
      if (d.api) plans.push('API (billed per token)');
      const about = [d.people !== null ? `${d.people} ${d.people === 1 ? 'person' : 'people'}` : null, ...d.tools.map((t) => TOOL_LABEL[t])].filter(Boolean);
      const m = d.lead ? F.byId.get(d.lead) : null;
      wu.push({ t: `- ${d.name}${about.length ? ' (' + about.join(', ') + ')' : ''}: ${plans.length ? plans.join('; ') : 'no plan given'}. Lead: ${m ? m.name : 'their own choice'}.` });
      if (m) wu.push({ t: `  ${youSource(m, F.modelsAsOf)}` });
    }
    who = { title: 'Who uses what', lines: wu };
    sections.push(who);
  }

  // Fit the cap: drop the highest-priority-number optional lines first.
  const cap = TEXT_CAP[p.who] || 40;
  const total = () => head.length + sections.reduce((n, s) => n + (s.lines.length ? s.lines.reduce((k, l) => k + rows(l), 0) + 2 : 0), 0) + (opts.owned ? 1 : 0) + (opts.extra || 0);
  const trim = () => {
    while (total() > cap) {
      let best = null;
      for (const s of sections) for (const l of s.lines) if (l.prio && (!best || l.prio > best.l.prio)) best = { s, l };
      if (!best) break;
      best.s.lines.splice(best.s.lines.indexOf(best.l), 1);
    }
  };
  const kept = sections.map((s) => s.lines.slice());
  trim();
  // Still over: put the optional lines back, sum up "Who uses what" by lead model in the room
  // the fixed lines leave, then trim optional lines again.
  if (who && total() > cap) {
    sections.forEach((s, i) => { s.lines = kept[i]; });
    const fixed = total() - who.lines.length - sections.reduce((n, s) => n + (s === who ? 0 : s.lines.filter((l) => l.prio).reduce((k, l) => k + rows(l), 0)), 0);
    who.lines = whoSummary(F, p.org.divisions, cap - fixed);
    trim();
  }
  if (total() > cap) throw new Error(`instruction text is ${total()} lines, over the ${cap}-line cap`);
  const out = [];
  if (opts.owned) out.push(OWNED_TAG);
  out.push(...head.map((l) => l.t));
  for (const s of sections) {
    if (!s.lines.length) continue;
    out.push('', `${h2} ${s.title}`, ...s.lines.map((l) => l.t));
    for (const l of s.lines) if (l.claim) ctx.used.add(l.claim);
  }
  return out.join('\n') + '\n';
}

// "Who uses what" in at most `room` lines: one line per lead model (its source on the next line, or
// on the same line when space is short), teams listed up to a few names, then "and K more".
// Every model named keeps its source; leads that don't fit are counted, not named.
function whoSummary(F, divisions, room) {
  const groups = new Map();
  for (const d of divisions) {
    const key = d.lead && F.byId.get(d.lead) ? d.lead : '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(d.name);
  }
  const teams = (names, n) => names.slice(0, n).join(', ') + (names.length > n ? ` and ${names.length - n} more` : '');
  const head = { t: `- ${divisions.length} divisions; their plans and seats stay in your Modelproof answers.` };
  const build = (shown, inline) => {
    const out = [head];
    let models = 0;
    for (const [id, names] of groups) {
      if (!id) { out.push({ t: `- Lead their own choice: ${teams(names, shown)}.` }); continue; }
      models += 1;
      const m = F.byId.get(id);
      const src = youSource(m, F.modelsAsOf);
      if (inline) out.push({ t: `- Lead ${m.name}: ${teams(names, shown)}. ${src}` });
      else out.push({ t: `- Lead ${m.name}: ${teams(names, shown)}.` }, { t: `  ${src}` });
    }
    return { out, models };
  };
  for (const inline of [false, true]) {
    for (const shown of [4, 2]) {
      const { out } = build(shown, inline);
      if (out.length <= room) return out;
    }
  }
  // Too many lead models for the room: name as many as fit, count the rest.
  const { out } = build(2, true);
  const keep = Math.max(0, room - 1);
  if (out.length <= room) return out;
  const cut = out.slice(0, keep);
  const left = out.length - keep;
  cut.push({ t: `- ${left} more lead ${left === 1 ? 'line' : 'lines'} left out to fit; see your Modelproof answers.` });
  return cut.slice(0, Math.max(0, room));
}

function planFact(F, pl) {
  const want = (pl.vendor + ' ' + pl.plan).toLowerCase().replace(/[^a-z0-9]+/g, '');
  const row = F.plans.find((r) => {
    const a = (r.vendor + ' ' + r.plan).toLowerCase().replace(/[^a-z0-9]+/g, '');
    const b = r.plan.toLowerCase().replace(/[^a-z0-9]+/g, '');
    return a === want || (labKey(r.vendor) === labKey(pl.vendor) && b === pl.plan.toLowerCase().replace(/[^a-z0-9]+/g, ''));
  });
  if (!row) return `${[pl.vendor, pl.plan].filter(Boolean).join(' ')} (no list price on file)`;
  const label = row.plan.toLowerCase().startsWith(row.vendor.toLowerCase()) ? row.plan : `${row.vendor} ${row.plan}`;
  return row.price === null ? `${label} (no public list price)` : `${label} ${fmtUsd(row.price)}/seat/month list`;
}

/* ------------------------------------------------------------------ agent files */

// A helper file carries an effort only when the user chose one (their effort cap); nothing is
// inferred from how often they hit limits. The preview shows each one as their choice.
// It is written only where that tool's own docs list the level (tool_plans effort_levels).
function helperEffort(F, p, tool, x) {
  const e = p.effort_cap || null;
  const plan = F.toolPlans.get(tool);
  if (!e || !plan || !plan.levels.includes(e)) return null;
  x.effort = e;
  return e;
}
function ccAgent(name, description, modelRef, effort, body, extra) {
  const fm = ['---', `name: ${name}`, `description: ${description}`, `model: ${modelRef}`];
  if (extra) fm.push(...extra);
  if (effort) fm.push(`effort: ${effort}`);
  fm.push('---', OWNED_TAG, ...body);
  return fm.join('\n') + '\n';
}
function tomlString(s) { return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'; }
function codexAgent(role, modelRef, effort) {
  const out = [OWNED_TAG_TOML, `name = ${tomlString('modelproof-' + role)}`, `description = ${tomlString(AGENT_DESCRIPTION[role])}`];
  if (modelRef) out.push(`model = ${tomlString(modelRef)}`);
  if (effort) out.push(`model_reasoning_effort = ${tomlString(effort)}`);
  out.push('developer_instructions = """', ...AGENT_BODY[role], '"""');
  return out.join('\n') + '\n';
}

// A GitHub Copilot custom agent: no model line, so it runs the default model (the model property
// unset); Copilot's docs show the name format only for hand-offs, so none is written here.
function copilotAgent(role) {
  return ['---', `name: modelproof-${role}`, `description: ${AGENT_DESCRIPTION[role]}`, '---', OWNED_TAG, ...AGENT_BODY[role]].join('\n') + '\n';
}
// An Antigravity subagent: name and description are required; the model tier is inherit (its default).
function antigravityAgent(role) {
  return ['---', `name: modelproof-${role}`, `description: ${AGENT_DESCRIPTION[role]}`, 'tools:', ...ANTIGRAVITY_TOOLS[role].map((t) => `  - ${t}`),
    'model: inherit', '---', OWNED_TAG, ...AGENT_BODY[role]].join('\n') + '\n';
}

/* ------------------------------------------------------------------ preview facts */

function workTags(text) {
  const s = text.toLowerCase();
  const tags = [];
  if (/\bcod(e|ing)\b/.test(s)) tags.push('coding', 'frontend');
  if (/\bagent/.test(s)) tags.push('agents');
  if (/reason|research|analy|complex|capabilit/.test(s)) tags.push('research', 'writing', 'exec-summaries');
  if (/scale|repeatable|lightweight|efficient|simple|fast|speed|cost/.test(s)) tags.push('bulk', 'chat', 'extraction');
  if (/multimodal|image|vision/.test(s)) tags.push('vision');
  return tags;
}
function previewFacts(F, p, ctx) {
  const models = [];
  for (const id of p.like) {
    if (models.length >= 3) break;
    const m = F.byId.get(id);
    if (!m || !canUse(ctx, m)) continue;
    const c = F.claims.find((x) => x.topic === 'model-per-job' && claimModels(F, x).includes(id) && claimShowable(F, ctx, x, 'quote') && !hasSuperlative(x.quote));
    if (c) ctx.used.add(c.id);
    models.push({ id, name: m.name, price: m.price, usage: m.usage, claim: c ? basisRec(c) : null });
  }
  const subjects = [];
  for (const t of p.tools) {
    const keys = TOOL_SUBJECTS[t];
    const list = F.claims.filter((c) => c.kind === 'tool' && keys.includes(c.subjectKey) && c.topic === 'model-per-job'
      && refsNamed(F, t, c.sentence + ' ' + c.quote).size > 0);
    subjects.push({ subject: TOOL_LABEL[t], tool: t, list });
  }
  for (const lk of ctx.labs) {
    subjects.push({ subject: labName(F, lk), tool: null, list: F.claims.filter((c) => c.kind === 'lab' && c.subjectKey === lk && c.topic === 'model-per-job') });
  }
  // work[] selects: claims about the user's kinds of work come first, then the rest, 3 per subject.
  const fits = (c) => { const tags = workTags(c.sentence + ' ' + c.quote); return !p.work.length || !tags.length || tags.some((t) => p.work.includes(t)); };
  const said = [];
  for (const s of subjects) {
    const ok = s.list.filter((c) => claimShowable(F, ctx, c, 'quote', s.tool) && !hasSuperlative(c.quote));
    const shown = [...ok.filter(fits), ...ok.filter((c) => !fits(c))].slice(0, 3).map(basisRec);
    for (const c of shown) ctx.used.add(c.id);
    if (shown.length) said.push({ subject: s.subject, claims: shown });
  }
  return { models_you_use: models, tools_and_labs_say: said };
}

/* ------------------------------------------------------------------ checks against their setup */

// Which package helper a line of their instructions, or one of their own helpers, is about.
const LINE_JOB = {
  scout: /\b(scout\w*|search\w*|explor\w*|research\w*|look-?ups?)\b/i,
  builder: /\b(build|builds|builder|building|implement\w*)\b/i,
  reviewer: /\b(review\w*|verif\w*|audit\w*)\b/i,
  bulk: /\b(bulk|batch\w*|mechanical|boilerplate|renames?)\b/i,
};
const HELPER_JOB = {
  scout: /\b(scout\w*|explor\w*|research\w*)\b/i,
  reviewer: /\b(review\w*|verif\w*|test-?runner\w*|runs? (the )?tests?)\b/i,
};
const NEGATION = /\b(never|avoid|don'?t|do not|not)\b/i;
const MAX_CHECKS = 12;

// Real conflicts between their setup and this package, each tied to the numbered file it touches:
// (a) a line of theirs that names a different model for a job a helper here does, and (b) a helper
// of theirs (not Modelproof's) that already does that job. Their files always stay as they are.
function setupChecks(F, p, S, parts, roles) {
  const checks = [];
  const itemOf = (id) => parts.findIndex((x) => x.id === id) + 1;
  const helperTools = p.tools.filter((t) => HELPER_TOOLS.includes(t) && roles[t]);
  const seen = new Set();
  for (const h of S.headsUp) {
    const fileReaders = S.readersOf.get(h.file);
    const tools = helperTools.filter((t) => !fileReaders || fileReaders.includes(t));
    const negated = NEGATION.test(h.text);
    for (const role of ROLES) {
      if (!LINE_JOB[role].test(h.text) || seen.has(`${h.file}:${h.line}:${role}`)) continue;
      for (const tool of tools) {
        const item = itemOf(`${tool}:agent:${role}`);
        if (!item) continue;
        const named = [...new Set([...namedModels(F, h.text), ...refsNamed(F, tool, h.text)])].filter((id) => toolRuns(tool, F.byId.get(id)));
        if (!named.length) continue;
        const x = roles[tool][role];
        const own = x.from !== 'inherit' && x.model_id ? x.model_id : null;
        if (negated ? !(own && named.includes(own)) : (own && named.includes(own))) continue;
        seen.add(`${h.file}:${h.line}:${role}`);
        checks.push({ kind: 'rule', file: h.file, line: h.line, text: h.text, tool, role, item, runs: own ? F.byId.get(own).name : null });
        break;
      }
    }
  }
  for (const a of S.agents) {
    if (a.modelproof || !a.tool || !helperTools.includes(a.tool)) continue;
    const name = safeLine(a.name, 60);
    for (const role of ['scout', 'reviewer']) {
      if (!name || !(HELPER_JOB[role].test(name) || (a.description && HELPER_JOB[role].test(a.description)))) continue;
      const item = itemOf(`${a.tool}:agent:${role}`);
      if (item) checks.push({ kind: 'helper', name, path: a.path, tool: a.tool, role, item });
    }
  }
  return checks.slice(0, MAX_CHECKS);
}

/* ------------------------------------------------------------------ package */

export function buildPackage(profile, facts, setup) {
  const F = indexFacts(facts);
  const { profile: p, problems } = normalizeProfile(profile, facts);
  const ctx = makeContext(p, F);
  const S = normalizeSetup(setup);
  const roles = rolesFor(F, p, ctx);
  const parts = [];
  const textParts = [];
  const copy = [];
  const notes = [];
  const available = [];
  const scope = p.scope;
  const user = scope === 'user';
  const has = (t) => p.tools.includes(t);

  // Where the project AGENTS.md block goes, and who reads it.
  const codexOverride = has('codex') && (user ? S.override.user : S.override.project);
  const projectAgentsBlock = !user && ((has('codex') && !codexOverride) || has('agents-md') || has('copilot') || has('antigravity'));
  const agentsReaders = [];

  const setupHasAgent = (tool, name) => S.agents.some((a) => !a.modelproof && a.name.toLowerCase() === name.toLowerCase() && (!a.tool || a.tool === tool));
  const setupHasKey = (key) => S.settings.some((x) => x.scope === scope && x.keys.includes(key));
  const ownedPart = (tool, role, path, content, why) => ({
    id: `${tool}:agent:${role}`, tool, kind: 'owned-file', enforced: true, target: { scope, path }, content, why,
  });
  const ccWhy = (ref) => (ref === 'inherit' ? 'Claude Code runs this helper on the lead\'s model (model: inherit).' : `Claude Code runs this helper on ${ref}, the model named in the file.`);

  for (const tool of p.tools) {
    const r = roles[tool];
    if (tool === 'claude-code') {
      const dir = user ? S.dirs.claude : '.claude';
      for (const role of ROLES) {
        const ref = r[role].model_ref || 'inherit';
        parts.push(ownedPart(tool, role, `${dir}/agents/modelproof-${role}.md`,
          ccAgent(`modelproof-${role}`, AGENT_DESCRIPTION[role], ref, helperEffort(F, p, tool, r[role]), AGENT_BODY[role]), ccWhy(ref)));
      }
      // The Explore override is opt-in: it is in the package only when the profile says
      // explore_override: true. It runs Claude Code's built-in Explore helper on the bulk model the
      // tool's own docs name. Otherwise, for someone who hits limits often, the preview lists it
      // under "Also available, not included".
      const plan = F.toolPlans.get(tool);
      const bulkRef = r.bulk.from !== 'inherit' && r.bulk.from !== 'you' ? r.bulk.model_ref : null;
      const exploreClaim = plan && plan.bulk ? plan.bulk.explore.map((id) => F.claimById.get(id)).find((c) => claimShowable(F, ctx, c, 'quote', tool)) : null;
      const exploreFits = !!bulkRef && !!exploreClaim;
      const explorePath = `${dir}/agents/modelproof-explore.md`;
      if (exploreFits && setupHasAgent('claude-code', 'Explore')) {
        if (p.explore_override) notes.push(`You already have your own Explore helper, so the ${bulkRef} Explore is left out.`);
      } else if (exploreFits && p.explore_override) {
        ctx.used.add(exploreClaim.id);
        parts.push({
          id: 'claude-code:agent:explore', tool, kind: 'owned-file', enforced: true, optional: true,
          target: { scope, path: explorePath },
          content: ccAgent('Explore', 'Fast read-only search of the codebase for files, symbols and answers.', bulkRef, null, EXPLORE_BODY, ['disallowedTools: Write, Edit, NotebookEdit']),
          why: `Optional, added because you asked: an Explore helper of your own replaces the built-in one, here on ${bulkRef}; the built-in runs on the lead's model.`,
          basis: [basisRec(exploreClaim)],
        });
      } else if (exploreFits && p.limits === 'often') {
        available.push({ id: 'claude-code:agent:explore', path: explorePath, what: `Claude Code's built-in Explore helper on ${bulkRef}`, add: '"explore_override": true' });
      } else if (p.explore_override) {
        notes.push('The Explore helper you asked for is left out: it needs the bulk model Claude Code\'s docs name, within your reach.');
      }
      // Settings keys: only on explicit opt-in, only keys that are absent.
      const keys = {};
      if (p.set_default_model && r.lead.from === 'you' && r.lead.model_ref) {
        if (setupHasKey('model')) notes.push('settings.json already sets model; it is left as is.');
        else {
          keys.model = r.lead.model_ref;
          notes.push(user ? 'The model key sets where new sessions start; choosing with /model later replaces it.' : 'The project model key wins over your /model choice in this repo.');
        }
      }
      if (p.effort_cap) {
        if (setupHasKey('maxEffortLevel')) notes.push('settings.json already sets maxEffortLevel; it is left as is.');
        else if (!plan || !plan.levels.includes(p.effort_cap)) notes.push(`Claude Code's docs do not list ${p.effort_cap} as an effort level, so your cap stays in the text only.`);
        else keys.maxEffortLevel = p.effort_cap;
      }
      if (Object.keys(keys).length) {
        parts.push({
          id: 'claude-code:settings', tool, kind: 'json-keys', enforced: true,
          target: { scope, path: `${dir}/settings.json` }, keys,
          why: 'Adds only the keys you asked for, and only where they are absent.',
        });
      }
      if (!user && projectAgentsBlock && S.claudeReadsAgents === true) {
        agentsReaders.push('claude-code');
        notes.push('Claude Code reads the project AGENTS.md here, so its lines go in that block and no .claude/rules file is added.');
      } else {
        if (!user && projectAgentsBlock && S.claudeReadsAgents === 'unsure') notes.push('Claude Code may also read the project AGENTS.md here, so some lines may load twice.');
        textParts.push({ id: 'claude-code:rules', tool, readers: ['claude-code'], kind: 'owned-file', path: `${dir}/rules/modelproof.md`, why: 'Claude Code loads every file in rules/ each session; your CLAUDE.md is not touched.', capKey: !!keys.maxEffortLevel });
      }
      if (S.force) notes.push('CLAUDE_CODE_SUBAGENT_MODEL_FORCE is set: while it stays set, Claude Code ignores the model line in every helper file.');
    } else if (tool === 'codex') {
      const dir = user ? S.dirs.codex : '.codex';
      for (const role of ROLES) {
        const x = r[role];
        const effort = helperEffort(F, p, tool, x);
        parts.push(ownedPart(tool, role, `${dir}/agents/modelproof-${role}.toml`, codexAgent(role, x.model_ref, effort),
          x.model_ref ? `Codex runs this helper on ${x.model_ref}; a model in a custom agent file wins for that agent.` : `No model set, so Codex runs this helper on the lead's model${effort ? '' : ' and effort'}.`));
      }
      if (p.effort_cap && !(F.toolPlans.get(tool) || { levels: [] }).levels.includes(p.effort_cap)) notes.push(`Codex's docs do not list ${p.effort_cap} as an effort level, so its helper files carry none.`);
      if (user) {
        textParts.push({ id: 'codex:text', tool, readers: ['codex'], kind: 'block', path: `${S.dirs.codex}/${S.override.user ? 'AGENTS.override.md' : 'AGENTS.md'}`, why: S.override.user ? 'Codex reads AGENTS.override.md instead of AGENTS.md at this level, so the block goes there.' : 'Codex reads this AGENTS.md before any task.' });
      } else if (codexOverride) {
        textParts.push({ id: 'codex:text', tool, readers: ['codex'], kind: 'block', path: 'AGENTS.override.md', why: 'Codex reads AGENTS.override.md instead of AGENTS.md here, so the Codex lines go there.' });
      } else {
        agentsReaders.push('codex');
      }
    } else if (tool === 'cursor') {
      const dir = user ? S.dirs.cursor : '.cursor';
      for (const role of ROLES) {
        const x = r[role];
        parts.push(ownedPart(tool, role, `${dir}/agents/modelproof-${role}.md`, ccAgent(`modelproof-${role}`, AGENT_DESCRIPTION[role], x.model_ref || 'inherit', null, AGENT_BODY[role]),
          'Cursor loads helpers from .cursor/agents; this copy wins over same-named .claude or .codex ones.'));
        if (x.from === 'you' && !x.model_ref) notes.push(`Cursor has no documented model string for ${x.model_name}; its ${role} file says inherit, so choose ${x.model_name} in Cursor's model menu.`);
      }
      if (user) notes.push('Cursor keeps user rules in its app (Customize → Rules), not in a file; paste the Cursor lines there to use them everywhere.');
      else if (projectAgentsBlock) {
        agentsReaders.push('cursor');
        notes.push('Cursor reads the project AGENTS.md, so no .cursor/rules file is added.');
      } else {
        textParts.push({ id: 'cursor:rules', tool, readers: ['cursor'], kind: 'owned-file', path: '.cursor/rules/modelproof.mdc', why: 'Cursor applies a rule with alwaysApply: true in every chat.', mdc: true });
      }
    } else if (tool === 'copilot') {
      // Copilot also loads helpers from .claude/agents (and ~/.claude/agents), so with Claude Code
      // at the same scope, or Modelproof's Claude Code helpers already there, those files serve
      // both: no second, same-named copy.
      const shared = has('claude-code') || S.agents.some((a) => a.tool === 'claude-code' && a.modelproof && a.scope === scope && /^modelproof-/.test(a.name));
      if (shared) {
        const c = F.claimById.get('copilot-custom-agent-locations');
        const ref = roles['claude-code'] && roles['claude-code'].bulk.model_ref;
        notes.push(`GitHub Copilot also loads the Claude Code helper files (${user ? '~/.claude/agents' : '.claude/agents'})${c ? ` (${c.source_url})` : ''}, so no second copy is added. Its docs do not say how it reads their model lines${ref ? ` (such as ${ref})` : ''}; check modelproof-bulk in Copilot's agent list.`);
      } else {
        const dir = user ? S.dirs.copilot : '.github';
        for (const role of ROLES) {
          parts.push(ownedPart(tool, role, `${dir}/agents/modelproof-${role}.agent.md`, copilotAgent(role),
            'No model line, so GitHub Copilot runs this helper on the default model; set one in the file\'s model field to change it.'));
        }
      }
      for (const role of ROLES) if (r[role].from === 'you') notes.push(`GitHub Copilot's docs give the model name format only for hand-offs, so your ${role} choice (${r[role].model_name}) is not written into its file; choose it in Copilot's model picker.`);
      if (user) notes.push('GitHub Copilot reads AGENTS.md in a repository; answer "this project" to add its lines there.');
      else agentsReaders.push('copilot');
    } else if (tool === 'antigravity') {
      const dir = user ? `${S.dirs.gemini}/config` : '.agents';
      for (const role of ROLES) {
        parts.push(ownedPart(tool, role, `${dir}/agents/modelproof-${role}.md`, antigravityAgent(role),
          'Antigravity runs this helper on the lead\'s model (model: inherit, its default tier).'));
      }
      for (const role of ROLES) if (r[role].from === 'you') notes.push(`Antigravity helper files take a tier (inherit, flash or pro), not a model, so your ${role} choice (${r[role].model_name}) is not written there.`);
      if (user) textParts.push({ id: 'antigravity:text', tool, readers: ['antigravity'], kind: 'block', path: `${S.dirs.gemini}/AGENTS.md`, why: 'Antigravity reads ~/.gemini/AGENTS.md as global rules for every project.' });
      else agentsReaders.push('antigravity');
    } else if (tool === 'openrouter') {
      copy.push({ id: 'openrouter:copy', tool, readers: ['openrouter'] });
      notes.push('OpenRouter / API is copy only: Modelproof writes no file for it. Paste its lines into your system prompt or an OpenRouter preset.');
    } else if (tool === 'agents-md') {
      if (user) notes.push('AGENTS.md is a project file; answer "this project" to add it.');
      else agentsReaders.push('agents-md');
    }
  }
  if (projectAgentsBlock && agentsReaders.length) {
    const readers = TOOLS.filter((t) => agentsReaders.includes(t));
    textParts.push({ id: 'agents-md:text', tool: readers.includes('agents-md') ? 'agents-md' : readers[0], readers, kind: 'block', path: 'AGENTS.md', why: `One block at the end of AGENTS.md, read by ${agentsReadBy(F, readers)}; your own text is untouched.` });
  }
  for (const tp of textParts) {
    let content = renderText(F, p, ctx, roles, tp.readers, { kind: tp.kind, owned: tp.kind === 'owned-file', capKey: tp.capKey, extra: tp.mdc ? 4 : 0 });
    if (tp.mdc) content = ['---', 'description: Modelproof lead, helpers and bulk', 'alwaysApply: true', '---', content].join('\n');
    const part = { id: tp.id, tool: tp.tool, readers: tp.readers, kind: tp.kind, enforced: false, target: { scope, path: tp.path }, content, why: tp.why };
    parts.push(part);
  }
  for (const part of parts) part.lines = part.kind === 'json-keys' ? Object.keys(part.keys).length : countLines(part.content);
  const copies = copy.map((c) => {
    const content = renderText(F, p, ctx, roles, c.readers, { kind: 'copy', owned: false });
    return { id: c.id, tool: c.tool, content, lines: countLines(content), where: 'your system prompt or an OpenRouter preset' };
  });

  if (S.present) for (const t of p.tools) if (S.present[t] === false) notes.push(`${TOOL_LABEL[t]} was not found on this machine; its files are still listed.`);
  if (parts.some((x) => x.kind === 'owned-file')) notes.push('Start a new session so each tool loads the new helper and rule files.');
  notes.push(`Undo removes every file, block and key this adds; ${S.stateDir ? S.stateDir + '/' : 'the Modelproof state folder'} keeps the install history.`);
  const allNotes = uniq([...problems.map((x) => `Left out of your answers: ${x}`), ...ctx.notes, ...notes]);

  const checks = setupChecks(F, p, S, parts, roles);
  const preview = previewFacts(F, p, ctx);
  for (const part of parts) for (const b of arr(part.basis)) ctx.used.add(b.id);
  const model_names = {};
  const namedIds = [...p.like, ...Object.values(p.roles), ...p.never.filter((n) => F.byId.has(n))];
  if (p.org) for (const d of p.org.divisions) if (d.lead) namedIds.push(d.lead);
  for (const id of namedIds.sort()) if (F.byId.has(id)) model_names[id] = F.byId.get(id).name;
  return {
    version: PACKAGE_SCHEMA,
    generator_version: GENERATOR_VERSION,
    as_of: F.asOf,
    profile: p,
    parts,
    copy: copies,
    available,
    checks,
    roles,
    preview_facts: preview,
    facts_used: [...ctx.used].sort(),
    notes: allNotes,
    model_names,
  };
}

/* ------------------------------------------------------------------ preview */

// One plan label, no doubled vendor ("Google AI Pro", not "Google Google AI Pro"). The board's
// plan picker and the preview's answers line both use it.
function planLabel(row) {
  if (row.plan.indexOf(row.vendor) === 0) return row.plan;
  const first = String(row.vendor || '').split(' ')[0];
  if (first && row.plan.indexOf(first + ' ') === 0) return row.plan;
  return row.vendor + ' ' + row.plan;
}

function answersLine(pkg) {
  const p = pkg.profile || {};
  const bits = [p.who === 'org' ? `org${p.org && p.org.name ? ' ' + p.org.name : ''}` : 'person', `${p.scope} scope`];
  bits.push('tools: ' + (arr(p.tools).map((t) => TOOL_LABEL[t]).join(', ') || 'none'));
  const plans = arr(p.plans).map((x) => (x.vendor && x.plan ? planLabel(x) : [x.vendor, x.plan].filter(Boolean).join(' ')));
  if (p.api) plans.push('API');
  bits.push('plans: ' + (plans.join(', ') || 'none'));
  bits.push('limits: ' + (p.limits || 'not given'));
  bits.push('work: ' + (arr(p.work).join(', ') || 'any'));
  return bits.join(' · ');
}
function roleSummary(x, role) {
  if (x.from === 'inherit') return role === 'bulk' && x.choice ? 'inherit until you set its model (the tool\'s docs name no model string)' : 'inherit (runs on the lead\'s model)';
  const name = x.model_ref && x.model_ref !== x.model_id ? `${x.model_ref} = ${x.model_name}` : x.model_name;
  return `${name} · ${x.from === 'you' ? 'your choice' : role === 'lead' ? 'the tool\'s default, from its own docs' : x.from === 'lab' ? 'from the lab\'s own docs' : 'from the tool\'s own docs'}`;
}
function usageText(u) {
  return u && num(u.openrouter_share) ? `${u.openrouter_share}% of OpenRouter tokens${u.as_of ? ' (' + u.as_of + ')' : ''}` : null;
}

export function renderPreview(pkg) {
  const P = isObj(pkg) ? pkg : {};
  const out = [];
  out.push(`Modelproof package · facts as of ${P.as_of || 'unknown'} · generator ${P.generator_version || '?'}`);
  out.push('Your answers: ' + answersLine(P));
  const p = P.profile || {};
  const names = isObj(P.model_names) ? P.model_names : {};
  const nm = (id) => names[id] || id;
  const extra = [];
  if (arr(p.like).length) extra.push('you use: ' + p.like.map(nm).join(', '));
  if (arr(p.never).length) extra.push('never: ' + p.never.map(nm).join(', '));
  if (p.effort_cap) extra.push('effort cap: ' + p.effort_cap);
  if (p.set_default_model) extra.push('set the default model: yes');
  const chosen = ALL_ROLE_KEYS.filter((k) => p.roles && p.roles[k]).map((k) => `${k} ${nm(p.roles[k])}`);
  if (chosen.length) extra.push('your helper choices: ' + chosen.join(', '));
  if (extra.length) out.push('  ' + extra.join(' · '));

  const roles = isObj(P.roles) ? P.roles : {};
  const checks = arr(P.checks).filter((c) => isObj(c) && Number.isInteger(c.item));
  if (checks.length) {
    const several = HELPER_TOOLS.filter((t) => roles[t]).length > 1;
    const helper = (c) => `#${c.item} modelproof-${c.role}${several && TOOL_LABEL[c.tool] ? ` (${TOOL_LABEL[c.tool]})` : ''}`;
    out.push('', 'Check these before you say Go');
    for (const c of checks) {
      if (c.kind === 'rule') out.push(`  - ${c.file}:${c.line} says "${c.text}"; ${helper(c)} runs on ${c.runs || 'the lead\'s model'}. Make them match, or skip #${c.item}.`);
      else out.push(`  - Your helper ${c.name}${c.path ? ` (${c.path})` : ''} does the same job as ${helper(c)}. Keep both, or skip #${c.item}.`);
    }
  }

  if (Object.keys(roles).length) {
    out.push('', 'Lead, helpers and bulk per tool');
    const quotes = (list) => { for (const b of arr(list)) out.push(`             "${b.quote}"`, `             ${b.source_url} (${b.date})`); };
    for (const tool of TOOLS) {
      const t = roles[tool];
      if (!t) continue;
      out.push(`  ${TOOL_LABEL[tool]}${COPY_ONLY_TOOLS.includes(tool) ? ' (copy only)' : ''}`);
      for (const role of ALL_ROLE_KEYS) {
        const x = t[role];
        if (!x) continue;
        if (COPY_ONLY_TOOLS.includes(tool) && HELPER_ROLES.includes(role)) continue;
        if (role === 'lead' && x.from === 'inherit') {
          out.push(`    ${'lead'.padEnd(9)}${COPY_ONLY_TOOLS.includes(tool) ? 'the model you name in each request' : `the model you choose in ${tool === 'agents-md' ? 'your tool' : TOOL_LABEL[tool]}`}`);
          continue;
        }
        if (tool === 'agents-md' && role !== 'lead' && x.from === 'inherit') continue;
        out.push(`    ${role.padEnd(9)}${COPY_ONLY_TOOLS.includes(tool) && role === 'bulk' && x.from === 'inherit' ? 'the model you name per request' : roleSummary(x, role)}`);
        if (x.effort) out.push(`             effort ${x.effort}: your choice (your effort cap), written into the helper file`);
        const e = x.effort_info;
        if (e) out.push(`             effort ${e.effort} by default${e.raise_to && e.when ? `; ${e.raise_to} for ${e.when}` : ''} (information, not a setting)`);
        if (x.from !== 'inherit') quotes(e && x.from === 'you' ? e.basis : x.basis);
        if (x.model_id) {
          const u = usageText(x.usage);
          out.push(`             ${priceText(x.price)}${u ? ' · ' + u : ''}`);
        }
      }
      const nl = t.near_limit;
      if (nl) {
        out.push(`    near a full usage limit (a text line, not a setting): ${nl.model_id ? `${nl.when} can run on ${nl.model_ref && nl.model_ref !== nl.model_id ? `${nl.model_ref} = ${nl.model_name}` : nl.model_name}` : 'the tool\'s own words below'}`);
        quotes(nl.basis);
      }
    }
  }
  const pf = isObj(P.preview_facts) ? P.preview_facts : {};
  if (arr(pf.models_you_use).length) {
    out.push('', 'Models you use');
    for (const m of pf.models_you_use) {
      const u = usageText(m.usage);
      out.push(`  ${m.name}: ${priceText(m.price)}${u ? ' · ' + u : ''}`);
      if (m.claim) out.push(`    "${m.claim.quote}" ${m.claim.source_url} (${m.claim.date})`);
    }
  }
  if (arr(pf.tools_and_labs_say).length) {
    out.push('', 'What the tools and labs say (their own words)');
    for (const s of pf.tools_and_labs_say) {
      for (const c of s.claims) out.push(`  ${s.subject}: "${c.quote}"`, `    ${c.source_url} (${c.date})`);
    }
  }
  for (const c of arr(P.copy)) {
    if (!isObj(c) || typeof c.content !== 'string') continue;
    out.push('', `Copy only, not installed: ${TOOL_LABEL[c.tool] || c.tool} (paste into ${c.where}) · ${c.lines} lines`);
    for (const l of c.content.replace(/\n+$/, '').split('\n')) out.push(l ? `  ${l}` : '');
  }
  const parts = arr(P.parts);
  if (parts.length) {
    out.push('', 'Files (numbered; answer "no to 3" to leave one out)');
    parts.forEach((x, i) => {
      const where = x.target ? x.target.path : '?';
      let what;
      if (x.kind === 'json-keys') what = `keys   ${where}: ${Object.keys(x.keys || {}).join(', ')}`;
      else if (x.kind === 'block') what = `block  ${where} (added at the end) · ${x.lines} lines`;
      else what = `file   ${where} · ${x.lines} lines`;
      const tags = [x.enforced ? 'the tool obeys it' : 'text', x.optional ? 'optional' : null].filter(Boolean).join(', ');
      out.push(`  ${String(i + 1).padStart(2)}. ${what} · ${tags}`);
      if (x.why) out.push(`      ${x.why}`);
    });
  } else {
    out.push('', arr(P.copy).length ? 'Files: none (the installer writes nothing for a copy-only tool).' : 'Files: none (no tool with a file this package can write).');
  }
  for (const a of arr(P.available)) {
    if (!isObj(a) || !a.path) continue;
    out.push(`  Also available, not included: ${String(a.path).split('/').pop()}, ${a.what}. Say "add it" to include it (profile ${a.add}).`);
  }
  if (arr(P.notes).length) {
    out.push('', 'Notes');
    for (const n of P.notes) out.push(`  - ${n}`);
  }
  return out.join('\n') + '\n';
}

/* ------------------------------------------------------------------ board adapter */

const BOARD_ROLE_RULES = [
  { role: 'lead', re: /coordinat|\blead\b|orchestr|main|planner/i },
  { role: 'reviewer', re: /review|check|audit|\bqa\b|verif/i },
  { role: 'bulk', re: /bulk|mechanical|batch|boilerplate/i },
  { role: 'scout', re: /research|scout|explor|read|search/i },
  { role: 'builder', re: /code|coding|build|design|dev|engineer|frontend/i },
];
const USAGE_TO_LIMITS = { heavy: 'often', typical: 'sometimes', light: 'rarely', automated: 'api-budget' };

export function profileFromBoard(state, data) {
  const s = isObj(state) ? state : {};
  const d = isObj(data) ? data : {};
  const planRows = Array.isArray(d.plans) ? d.plans : arr(isObj(d.plans) ? d.plans.plans : null);
  const org = isObj(s.org) ? s.org : {};
  const personal = isObj(s.personal) ? s.personal : {};
  const me = isObj(personal.me) ? personal.me : {};
  const divisions = arr(org.divisions);
  const blocks = arr(org.blocks);
  const isOrg = s.mode === 'org' || (s.mode !== 'personal' && divisions.length > 0);

  const splitPlan = (label) => {
    const row = planRows.find((r) => isObj(r) && typeof r.plan === 'string' && planLabel(r) === label);
    if (row) return { vendor: row.vendor, plan: row.plan };
    const words = String(label || '').split(' ');
    return { vendor: words[0] || '', plan: words.slice(1).join(' ') };
  };
  // The tool a plan's vendor makes: a lab's own coding tool, or the tool the vendor is.
  const VENDOR_TOOL = { anthropic: 'claude-code', openai: 'codex', cursor: 'cursor', 'github copilot': 'copilot', google: 'antigravity', openrouter: 'openrouter' };
  const toolsFor = (plans) => {
    const t = plans.map((pl) => VENDOR_TOOL[labKey(pl.vendor)]).filter(Boolean);
    return TOOLS.filter((x) => t.includes(x));
  };
  // A plan billed per token (its row says the seat does not cover tokens) means API use.
  const rowOf = (pl) => planRows.find((r) => isObj(r) && r.vendor === pl.vendor && r.plan === pl.plan);
  const perToken = (plans) => plans.some((pl) => { const row = rowOf(pl); return !!row && row.covers_tokens === false; });
  const roles = {};
  for (const r of arr(personal.roles)) {
    if (!isObj(r) || r.auto || !r.model) continue;
    const rule = BOARD_ROLE_RULES.find((x) => x.re.test(String(r.role || '')));
    if (rule && !roles[rule.role]) roles[rule.role] = r.model;
  }
  const raw = {
    schema: PROFILE_SCHEMA,
    never: arr(s.neverSuggest),
  };
  if (isOrg) {
    const divs = divisions.map((dv) => {
      const members = blocks.filter((b) => isObj(b) && b.divisionId === dv.id && b.type !== 'routine');
      const people = members.reduce((n, b) => n + (arr(b.rows).length ? arr(b.rows).reduce((k, row) => k + (num(row.seats) ? row.seats : 0), 0) : num(b.seats) ? b.seats : 1), 0);
      const labels = arr(dv.defaultPlans).length ? arr(dv.defaultPlans) : uniq(members.flatMap((b) => arr(b.plans)));
      const plans = labels.map(splitPlan);
      return { name: dv.name, people, plans, api: perToken(plans), tools: toolsFor(plans), lead: dv.defaultModel || null };
    });
    const allPlans = divs.flatMap((x) => x.plans);
    raw.who = 'org';
    raw.scope = 'project';
    raw.plans = allPlans;
    raw.api = perToken(allPlans);
    raw.tools = uniq(divs.flatMap((x) => x.tools));
    raw.work = uniq(blocks.map((b) => (isObj(b) ? b.task : null)).filter(Boolean));
    raw.like = uniq(blocks.flatMap((b) => (isObj(b) ? arr(b.models) : [])));
    raw.org = { name: s.boardName, divisions: divs };
  } else {
    const plans = arr(me.plans).map(splitPlan);
    raw.who = 'person';
    raw.scope = 'user';
    raw.plans = plans;
    raw.api = perToken(plans);
    raw.tools = toolsFor(plans);
    raw.limits = USAGE_TO_LIMITS[me.usageLevel] || null;
    raw.work = uniq(arr(personal.taskDefs).map((t) => (isObj(t) ? t.task : null)).filter(Boolean));
    raw.like = arr(me.uses);
    raw.roles = roles;
  }
  if (!raw.tools.length) raw.tools = ['agents-md'];
  return normalizeProfile(raw, { models: d.models, guidance: d.guidance, plans: d.plans }).profile;
}

/* ------------------------------------------------------------------ block markers */

// The one definition of the marker lines around a block in someone's file. The installer
// (assets/install.mjs) imports these, and the board's Copy text uses them, so a block pasted by
// hand is the same bytes the installer writes and a later install adopts it instead of adding it
// again. The hash is SHA-256 (first 16 hex characters) of the body lines joined with "\n", in
// plain JS so it runs in a browser too.
export const BLOCK_BEGIN_RE = /^<!-- modelproof:begin v1(?: sha=([0-9a-f]{16}))? -->$/;
export const BLOCK_END_RE = /^<!-- modelproof:end -->$/;

const SHA_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
export function sha256Hex(text) {
  const msg = new TextEncoder().encode(String(text));
  const bitLen = msg.length * 8;
  const padded = new Uint8Array(((msg.length + 9 + 63) >> 6) << 6);
  padded.set(msg);
  padded[msg.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000));
  view.setUint32(padded.length - 4, bitLen >>> 0);
  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, k] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (k + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + SHA_K[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      k = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + k) >>> 0;
  }
  return h.map((x) => x.toString(16).padStart(8, '0')).join('');
}
export function blockBodyHash(bodyLines) { return sha256Hex(bodyLines.join('\n')).slice(0, 16); }
// A block part's body lines, wrapped in the begin/end marker lines, joined with `eol`.
export function blockText(bodyLines, eol = '\n') {
  return [`<!-- modelproof:begin v1 sha=${blockBodyHash(bodyLines)} -->`, ...bodyLines, '<!-- modelproof:end -->'].join(eol);
}
export function blockBodyLines(content) {
  const s = String(content).replace(/\r\n/g, '\n');
  return (s.endsWith('\n') ? s.slice(0, -1) : s).split('\n');
}

// An owned file's tag line, stamped with the hash of the generator's content, so a later run (or a
// teammate with no install record) can tell an untouched copy from an edited one. null when the
// content has no owned tag.
export function stampOwnedText(content) {
  const text = String(content);
  const sha = sha256Hex(text).slice(0, 16);
  let done = false;
  const out = text.split('\n').map((l) => {
    if (done) return l;
    if (l === OWNED_TAG) { done = true; return `<!-- modelproof:owned v1 sha=${sha} -->`; }
    if (l === OWNED_TAG_TOML) { done = true; return `# modelproof:owned v1 sha=${sha}`; }
    return l;
  });
  return done ? out.join('\n') : null;
}

// The package as plain text, for a setup with no Node: each part headed by where it goes. A block
// carries its marker lines, a file its stamped owned tag, and settings keys are listed to add by
// hand, so a later install adopts what was pasted.
export function packageText(pkg) {
  const parts = (isObj(pkg) ? arr(pkg.parts) : []).map((part) => {
    const where = part.target && part.target.path ? part.target.path : part.id;
    if (part.kind === 'block' && typeof part.content === 'string') {
      return `=== Add at the end of ${where} (keep the two modelproof marker lines) ===\n${blockText(blockBodyLines(part.content))}\n`;
    }
    if (part.kind === 'json-keys' && isObj(part.keys)) {
      const keys = Object.entries(part.keys).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
      return `=== Add these keys to ${where} (a key already there stays as it is) ===\n${keys.join(',\n')}\n`;
    }
    if (typeof part.content === 'string') return `=== New file ${where} ===\n${(stampOwnedText(part.content) || part.content).replace(/\n+$/, '')}\n`;
    return null;
  });
  const copies = (isObj(pkg) ? arr(pkg.copy) : []).filter((c) => isObj(c) && typeof c.content === 'string')
    .map((c) => `=== Copy into ${c.where} (copy only; the installer writes nothing for ${TOOL_LABEL[c.tool] || c.tool}) ===\n${c.content.replace(/\n+$/, '')}\n`);
  return [...parts, ...copies].filter(Boolean).join('\n');
}
