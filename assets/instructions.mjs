// Modelproof instruction package generator — the ONE generator.
//
// Pure ES module: no imports, no clock, no network, no randomness. The board (browser), the
// installer (Node) and the skill all call it, so the same answers always give the same bytes.
//
// A package is a list of parts: helper-agent files that set a model the tool obeys (the backbone),
// plus one short text part per tool (never the only lever). Which model a helper runs comes from,
// in order: the user's own choice; a tool or lab that names a model for that exact job in its own
// docs (data/guidance.json, quoted with url + date); otherwise `inherit` (the lead's model). Two or
// more labs in use and no choice → every helper inherits and each lab's own descriptions are shown
// side by side as facts. Nothing here ranks models.

export const GENERATOR_VERSION = '1.0.0';
export const TOOLS = ['claude-code', 'codex', 'cursor', 'agents-md'];
export const ROLES = ['scout', 'builder', 'reviewer'];

/* ------------------------------------------------------------------ constants */

const PROFILE_SCHEMA = 'modelproof.profile/1';
const PACKAGE_SCHEMA = 'modelproof.package/1';
const SITE_EFFORT_URL = 'https://lucascashwell3-ai.github.io/modelproof/#effort';
const OWNED_TAG = '<!-- modelproof:owned v1 -->';
const OWNED_TAG_TOML = '# modelproof:owned v1';
const LIMITS = ['often', 'sometimes', 'rarely', 'api-budget'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const WORK_IDS = ['coding', 'agents', 'bulk', 'writing', 'research', 'extraction', 'chat', 'vision', 'frontend', 'exec-summaries'];
const ALL_ROLE_KEYS = ['lead', 'scout', 'builder', 'reviewer'];
const TEXT_CAP = { person: 40, org: 60 };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const URL_RE = /^https:\/\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+$/;
// Built from escapes so the source file holds no raw U+2028 / U+2029 characters.
const LINE_BREAK = new RegExp('\\r\\n|\\r|\\n|\\u2028|\\u2029|\\u0085');
const DEAD_STATUS =['deprecated', 'retired', 'shutdown', 'removed'];

const TOOL_LABEL = { 'claude-code': 'Claude Code', codex: 'Codex', cursor: 'Cursor', 'agents-md': 'AGENTS.md' };
const TOOL_SUBJECTS = { 'claude-code': ['claude code'], codex: ['codex cli', 'codex'], cursor: ['cursor'], 'agents-md': ['agents.md'] };
const TOOL_ALIASES = {
  'claude-code': 'claude-code', 'claude code': 'claude-code', claude: 'claude-code', cc: 'claude-code',
  codex: 'codex', 'codex cli': 'codex', 'openai codex': 'codex', 'codex-cli': 'codex',
  cursor: 'cursor',
  'agents-md': 'agents-md', 'agents.md': 'agents-md', agentsmd: 'agents-md', 'agents md': 'agents-md',
};
// The lab whose models a tool runs, when it runs only one lab's models.
const TOOL_LAB = { 'claude-code': 'anthropic', codex: 'openai' };
const HELPER_TOOLS = ['claude-code', 'codex', 'cursor'];
// Plan vendors that reach more than one lab (same table the board uses). A plan whose vendor is a
// model vendor reaches that lab; an unknown vendor reaches every lab (never hide models behind a
// plan the data doesn't carry).
const PLAN_REACH = {
  cursor: 'all', 'github copilot': 'all', codex: 'all', windsurf: 'all', perplexity: 'all',
  'microsoft 365 copilot': ['openai', 'anthropic'],
  openrouter: 'all', 'amazon bedrock': 'all', 'google vertex': 'all', 'microsoft azure ai foundry': 'all',
};
const PER_TOKEN_VENDORS = ['openrouter', 'amazon bedrock', 'google vertex', 'microsoft azure ai foundry'];

// Words a displayed quote or sentence must not carry: the package shows facts, never a ranking.
// Two terms are split so the shipped-wording scan stays clean on this file.
const RANKING_WORDS = new RegExp('\\b(best|better|top|winner|pick\\w*|recommend\\w*|suggest\\w*|'
  + 'ver' + 'dict|confi' + 'dence|start(s|ing)? (here|with))\\b', 'i');

const JOB = {
  scout: 'reads and searches',
  builder: 'makes the planned change',
  reviewer: 'reviews the diff cold',
};
const AGENT_DESCRIPTION = {
  scout: 'Reads, searches and sums up code or docs for the lead. Use it for long reading and lookups. It does not edit files.',
  builder: 'Makes one planned change from a brief (exact files, goal, done check) and reports the check result.',
  reviewer: 'Reviews a change cold from the diff, runs the checks itself, and reports problems with file:line.',
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
  const roleDefaults = [];
  for (const d of arr(g.role_defaults)) {
    if (!isObj(d) || !TOOLS.includes(d.tool) || !ROLES.includes(d.role)) continue;
    roleDefaults.push({
      tool: d.tool, role: d.role, lab: labKey(d.lab),
      model_ref: typeof d.model_ref === 'string' && REF_RE.test(d.model_ref) ? d.model_ref : null,
      model_id: typeof d.model_id === 'string' ? d.model_id : null,
      basis: arr(d.basis).filter((id) => claimById.has(id)),
    });
  }
  const plans = [];
  const prow = Array.isArray(f.plans) ? f.plans : arr(isObj(f.plans) ? f.plans.plans : null);
  for (const p of prow) {
    if (!isObj(p) || typeof p.vendor !== 'string' || typeof p.plan !== 'string') continue;
    plans.push({ vendor: safeLine(p.vendor, 60), plan: safeLine(p.plan, 80), price: num(p.price_usd_month) ? p.price_usd_month : null });
  }
  const asOf = safeDate(g.as_of) || safeDate(isObj(mfile) ? mfile.as_of : null) || null;
  const labNames = new Map();
  for (const m of models) if (m.lab && !labNames.has(m.lab)) labNames.set(m.lab, m.vendor);
  const modelsAsOf = safeDate(isObj(mfile) ? mfile.as_of : null);
  return { models, byId, terms, claims, claimById, refs, roleDefaults, plans, asOf, modelsAsOf, labNames, namedCache: new Map() };
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

function planReach(F, vendor) {
  const key = labKey(vendor);
  if (!key) return 'all';
  if (Object.prototype.hasOwnProperty.call(PLAN_REACH, key)) return PLAN_REACH[key];
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
    if (TOOL_LAB[t]) r.labs.add(TOOL_LAB[t]);
    if (t === 'cursor') r.all = true;
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
    else problems.push(`${label}: "${cleanText(t, 30)}" is not a tool this package covers (Claude Code, Codex, Cursor, AGENTS.md)`);
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
  for (const k of Object.keys(srcRoles)) if (!ALL_ROLE_KEYS.includes(k)) problems.push(`roles.${cleanText(k, 20)}: not a role (lead, scout, builder, reviewer); left out`);
  for (const k of ALL_ROLE_KEYS) { const id = checkModel(srcRoles[k], `roles.${k}`); if (id) roles[k] = id; }
  const effortCap = pickEnum('effort_cap', EFFORTS);

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
  for (const t of p.tools) if (TOOL_LAB[t]) inUse.add(TOOL_LAB[t]);
  const chosen = [...p.like, ...Object.values(p.roles)];
  if (p.org) for (const d of p.org.divisions) { if (d.lead) chosen.push(d.lead); for (const t of d.tools) if (TOOL_LAB[t]) inUse.add(TOOL_LAB[t]); }
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
const INHERIT_CLAIM = { 'claude-code': 'cc-inherit-follows-switch', codex: 'codex-subagent-inherits', cursor: 'cursor-subagent-inherit-default' };

function roleFor(F, p, ctx, tool, role) {
  const modelRec = (m, from, basis) => ({
    model_ref: refFor(F, tool, m), model_id: m.id, model_name: m.name, from,
    basis: basis.map(basisRec), price: m.price, usage: m.usage,
  });
  const chosenId = p.roles[role];
  if (chosenId) {
    const m = F.byId.get(chosenId);
    if (m && canUse(ctx, m) && toolRuns(tool, m)) {
      const rec = modelRec(m, 'you', []);
      // A helper the user put on one model stays on that model: Claude Code's helper files take a
      // full model id (cc-subagent-model-values), so a floating alias never moves it to a later
      // release. Aliases stay only for the tool's own documented defaults (from: 'tool').
      if (role !== 'lead' && tool === 'claude-code' && REF_RE.test(m.id)) rec.model_ref = m.id;
      return rec;
    }
    if (m && !toolRuns(tool, m)) ctx.notes.push(`${TOOL_LABEL[tool]} runs only ${labName(F, TOOL_LAB[tool])} models, so your ${role} choice (${m.name}) applies to your other tools; in ${TOOL_LABEL[tool]} the ${role} follows the lead.`);
  }
  if (role !== 'lead' && HELPER_TOOLS.includes(tool) && !ctx.multiLab) {
    for (const d of F.roleDefaults) {
      if (d.tool !== tool || d.role !== role || !d.model_ref || !d.model_id) continue;
      const m = F.byId.get(d.model_id);
      const basis = d.basis.map((id) => F.claimById.get(id)).filter((c) => claimShowable(F, ctx, c, 'quote', tool));
      if (!m || !canUse(ctx, m) || !toolRuns(tool, m) || !basis.length) continue;
      if (d.lab && d.lab !== m.lab) continue;
      const rec = modelRec(m, basis.every((c) => c.tier === 'tool') ? 'tool' : 'lab', basis);
      rec.model_ref = d.model_ref;
      return rec;
    }
  }
  const ic = role === 'lead' ? null : F.claimById.get(INHERIT_CLAIM[tool]);
  const basis = ic && claimShowable(F, ctx, ic, 'quote', tool) ? [basisRec(ic)] : [];
  return { model_ref: null, model_id: null, model_name: null, from: 'inherit', basis, price: null, usage: null };
}
function rolesFor(F, p, ctx) {
  const out = {};
  for (const tool of p.tools) {
    const t = {};
    for (const role of ALL_ROLE_KEYS) {
      t[role] = roleFor(F, p, ctx, tool, role);
      for (const b of t[role].basis) ctx.used.add(b.id);
    }
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
    dirs: { claude: safePath(dirs.claude, '~/.claude'), codex: safePath(dirs.codex, '~/.codex'), cursor: '~/.cursor' },
    claudeReadsAgents: reads === true ? true : reads === false ? false : 'unsure',
    override: { user: ov.user === true, project: ov.project === true },
    force: !!(s && isObj(s.env) && s.env.subagent_model_force === true),
    agents, settings, present, headsUp, readersOf,
  };
}

/* ------------------------------------------------------------------ text parts */

function sourceOf(c) { return `Source: ${c.subject} docs, ${c.source_url} (${c.date})`; }
function youSource(m, asOf) { return `Source: your choice (${priceText(m.price)}${asOf ? ', as of ' + asOf : ''})`; }

function helperLines(F, p, ctx, roles, tool, prefix) {
  const t = roles[tool];
  const lines = [];
  const lead = prefix ? `- ${TOOL_LABEL[tool]}: ` : '- ';
  if (ROLES.every((r) => t[r].from === 'inherit')) {
    lines.push({ t: `${lead}modelproof-scout, modelproof-builder, modelproof-reviewer → inherit: they run on the lead's model` });
    const b = t.scout.basis[0];
    if (b) lines.push({ t: `  ${sourceOf(F.claimById.get(b.id))}` });
    return lines;
  }
  for (const r of ROLES) {
    const x = t[r];
    if (x.from === 'inherit') {
      lines.push({ t: `${lead}modelproof-${r} (${JOB[r]}) → inherit: runs on the lead's model` });
      if (x.basis[0]) lines.push({ t: `  ${sourceOf(F.claimById.get(x.basis[0].id))}` });
      continue;
    }
    const m = F.byId.get(x.model_id);
    const shown = x.model_ref && x.model_ref !== m.id ? `${x.model_ref} (${m.name})` : x.model_ref ? m.name : `${m.name} (choose it in ${TOOL_LABEL[tool]}'s model menu; the file says inherit)`;
    lines.push({ t: `${lead}modelproof-${r} (${JOB[r]}) → ${shown}` });
    lines.push({ t: x.from === 'you' ? `  ${youSource(m, F.modelsAsOf)}` : `  ${sourceOf(F.claimById.get(x.basis[0].id))}` });
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
  const wants = (...ids) => !work.length || ids.some((w) => work.includes(w));

  const head = [{ t: `${h1} Modelproof helpers and hand-off (facts as of ${F.asOf || 'the data date'})` }];
  // Lead line.
  const leadTools = readers.filter((t) => roles[t] && roles[t].lead.from === 'you');
  if (leadTools.length) {
    const m = F.byId.get(roles[leadTools[0]].lead.model_id);
    const where = leadTools.length === readers.filter((t) => roles[t]).length ? '' : ` in ${leadTools.map((t) => TOOL_LABEL[t]).join(' and ')}; elsewhere the model you choose`;
    head.push({ t: `Lead: ${m.name}${where}. ${youSource(m, F.modelsAsOf)}` });
  } else {
    const inherits = helperReaders.some((t) => ROLES.some((r) => roles[t][r].from === 'inherit'));
    head.push({ t: `Lead: the model you choose in the tool.${inherits ? ' Helpers marked inherit run on it.' : ''}` });
  }
  if (p.who === 'org') head.push({ t: `Shared by ${p.org && p.org.name ? p.org.name : 'the team'}; each person keeps their own rules in their own files.` });

  const sections = [];
  // Helpers.
  const helpers = [];
  if (has('claude-code')) {
    const l = claimLine(F, ctx, 'cc-subagent-model-order', 'claude-code', 0, 'Call these helpers by name and pass no model: a model given per call overrides the file.');
    if (l) helpers.push(l);
  }
  for (const t of helperReaders) helpers.push(...helperLines(F, p, ctx, roles, t, helperReaders.length > 1));
  if (has('agents-md') && !helperReaders.length) {
    const r = roles['agents-md'];
    for (const role of ROLES) {
      if (!r || r[role].from !== 'you') continue;
      const m = F.byId.get(r[role].model_id);
      helpers.push({ t: `- If your tool has helpers, the ${role} (${JOB[role]}) runs ${m.name}.` });
      helpers.push({ t: `  ${youSource(m, F.modelsAsOf)}` });
    }
  }
  if (helpers.length) sections.push({ title: 'Helpers', lines: helpers });

  // When to hand off: the sourced cost facts, framed as when a helper is worth it (Claude Code).
  if (has('claude-code')) {
    const wh = [];
    const v = claimLine(F, ctx, 'cc-delegate-verbose', 'claude-code', 3, 'Hand helpers verbose work (test runs, logs): only a summary comes back.');
    if (v) wh.push(v);
    const b = claimLine(F, ctx, 'anthropic-multi-agent-token-use', null, wants('agents') ? 3 : 5, 'Hand helpers parallel or separable work; each adds tokens (multi-agent systems used about 15 times the tokens of chat in Anthropic\'s data).');
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
  const effortLabs = [];
  if (has('claude-code')) effortLabs.push('anthropic');
  if (has('codex')) effortLabs.push('openai');
  if (has('cursor') || has('agents-md')) for (const l of ctx.labs) if (!effortLabs.includes(l)) effortLabs.push(l);
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
  const total = () => head.length + sections.reduce((n, s) => n + (s.lines.length ? s.lines.length + 2 : 0), 0) + (opts.owned ? 1 : 0) + (opts.extra || 0);
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
    const fixed = total() - who.lines.length - sections.reduce((n, s) => n + (s === who ? 0 : s.lines.filter((l) => l.prio).length), 0);
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

function helperEffort(p, role) {
  const base = p.limits === 'often' ? { scout: 'low', builder: 'medium', reviewer: null }[role] : null;
  const cap = p.effort_cap;
  if (!cap) return base;
  if (!base) return cap;
  return EFFORTS.indexOf(base) <= EFFORTS.indexOf(cap) ? base : cap;
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
  if (effort) out.push(`model_reasoning_effort = ${tomlString(effort === 'max' ? 'xhigh' : effort)}`);
  out.push('developer_instructions = """', ...AGENT_BODY[role], '"""');
  return out.join('\n') + '\n';
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
    const c = F.claims.find((x) => x.topic === 'model-per-job' && claimModels(F, x).includes(id) && claimShowable(F, ctx, x, 'quote'));
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
    const ok = s.list.filter((c) => claimShowable(F, ctx, c, 'quote', s.tool));
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
  const notes = [];
  const available = [];
  const scope = p.scope;
  const user = scope === 'user';

  // Where the project AGENTS.md block goes, and who reads it.
  const codexOverride = p.tools.includes('codex') && (user ? S.override.user : S.override.project);
  const projectAgentsBlock = !user && ((p.tools.includes('codex') && !codexOverride) || p.tools.includes('agents-md'));
  const agentsReaders = [];

  const setupHasAgent = (tool, name) => S.agents.some((a) => !a.modelproof && a.name.toLowerCase() === name.toLowerCase() && (!a.tool || a.tool === tool));
  const setupHasKey = (key) => S.settings.some((x) => x.scope === scope && x.keys.includes(key));

  for (const tool of p.tools) {
    const r = roles[tool];
    if (tool === 'claude-code') {
      const dir = user ? S.dirs.claude : '.claude';
      for (const role of ROLES) {
        const x = r[role];
        const ref = x.model_ref || 'inherit';
        parts.push({
          id: `claude-code:agent:${role}`, tool, kind: 'owned-file', enforced: true,
          target: { scope, path: `${dir}/agents/modelproof-${role}.md` },
          content: ccAgent(`modelproof-${role}`, AGENT_DESCRIPTION[role], ref, helperEffort(p, role), AGENT_BODY[role]),
          why: ref === 'inherit' ? 'Claude Code runs this helper on the lead\'s model (model: inherit).' : `Claude Code runs this helper on ${ref}, the model named in the file.`,
        });
      }
      // The Explore override is opt-in: it is in the package only when the profile says
      // explore_override: true. Otherwise, for someone who hits limits often, the preview lists
      // it under "Also available, not included".
      const haiku = F.refs.find((x) => x.tool === 'claude-code' && x.ref === 'haiku');
      const exploreClaim = F.claimById.get('cc-explore-override-haiku');
      const exploreFits = !ctx.multiLab && !!haiku && !!exploreClaim && canUse(ctx, F.byId.get(haiku.model_id));
      const explorePath = `${dir}/agents/modelproof-explore.md`;
      if (exploreFits && setupHasAgent('claude-code', 'Explore')) {
        if (p.explore_override) notes.push('You already have your own Explore helper, so the haiku Explore is left out.');
      } else if (exploreFits && p.explore_override) {
        ctx.used.add(exploreClaim.id);
        parts.push({
          id: 'claude-code:agent:explore', tool, kind: 'owned-file', enforced: true, optional: true,
          target: { scope, path: explorePath },
          content: ccAgent('Explore', 'Fast read-only search of the codebase for files, symbols and answers.', 'haiku', null, EXPLORE_BODY, ['disallowedTools: Write, Edit, NotebookEdit']),
          why: 'Optional, added because you asked: replaces the built-in Explore helper\'s model with haiku (since v2.1.198 the built-in follows the lead).',
          basis: [basisRec(exploreClaim)],
        });
      } else if (exploreFits && p.limits === 'often') {
        available.push({ id: 'claude-code:agent:explore', path: explorePath, what: 'Claude Code\'s built-in Explore helper on haiku', add: '"explore_override": true' });
      } else if (p.explore_override) {
        notes.push('The haiku Explore helper you asked for is left out: it needs haiku within reach and models from one lab.');
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
        const leadM = r.lead.model_id ? F.byId.get(r.lead.model_id) : null;
        const opus55 = F.byId.get('claude-opus-5-5');
        const newLead = !leadM || (opus55 && opus55.released && leadM.released && leadM.released >= opus55.released && leadM.lab === 'anthropic');
        if (setupHasKey('maxEffortLevel')) notes.push('settings.json already sets maxEffortLevel; it is left as is.');
        else if (user && newLead) notes.push('Your effort cap stays in the text only: Claude Code ignores user-level effort keys on Opus 5.5 and later, and your lead may be one.');
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
        parts.push({
          id: `codex:agent:${role}`, tool, kind: 'owned-file', enforced: true,
          target: { scope, path: `${dir}/agents/modelproof-${role}.toml` },
          content: codexAgent(role, x.model_ref, helperEffort(p, role)),
          why: x.model_ref ? `Codex runs this helper on ${x.model_ref}; a model in a custom agent file wins for that agent.` : 'No model set, so Codex runs this helper on the lead\'s model and effort.',
        });
      }
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
        parts.push({
          id: `cursor:agent:${role}`, tool, kind: 'owned-file', enforced: true,
          target: { scope, path: `${dir}/agents/modelproof-${role}.md` },
          content: ccAgent(`modelproof-${role}`, AGENT_DESCRIPTION[role], x.model_ref || 'inherit', null, AGENT_BODY[role]),
          why: 'Cursor loads helpers from .cursor/agents; this copy wins over same-named .claude or .codex ones.',
        });
        if (x.from === 'you' && !x.model_ref) notes.push(`Cursor has no documented model string for ${x.model_name}; its ${role} file says inherit, so choose ${x.model_name} in Cursor's model menu.`);
      }
      if (user) notes.push('Cursor keeps user rules in its app (Customize → Rules), not in a file; paste the Cursor lines there to use them everywhere.');
      else if (projectAgentsBlock) {
        agentsReaders.push('cursor');
        notes.push('Cursor reads the project AGENTS.md, so no .cursor/rules file is added.');
      } else {
        textParts.push({ id: 'cursor:rules', tool, readers: ['cursor'], kind: 'owned-file', path: '.cursor/rules/modelproof.mdc', why: 'Cursor applies a rule with alwaysApply: true in every chat.', mdc: true });
      }
    } else if (tool === 'agents-md') {
      if (user) notes.push('AGENTS.md is a project file; answer "this project" to add it.');
      else agentsReaders.push('agents-md');
    }
  }
  if (projectAgentsBlock && agentsReaders.length) {
    const readers = TOOLS.filter((t) => agentsReaders.includes(t));
    textParts.push({ id: 'agents-md:text', tool: readers.includes('agents-md') ? 'agents-md' : readers[0], readers, kind: 'block', path: 'AGENTS.md', why: `One block at the end of AGENTS.md, read by ${readers.map((t) => TOOL_LABEL[t]).join(', ')}; your own text is untouched.` });
  }
  for (const tp of textParts) {
    let content = renderText(F, p, ctx, roles, tp.readers, { kind: tp.kind, owned: tp.kind === 'owned-file', capKey: tp.capKey, extra: tp.mdc ? 4 : 0 });
    if (tp.mdc) content = ['---', 'description: Modelproof helpers and hand-off', 'alwaysApply: true', '---', content].join('\n');
    const part = { id: tp.id, tool: tp.tool, readers: tp.readers, kind: tp.kind, enforced: false, target: { scope, path: tp.path }, content, why: tp.why };
    parts.push(part);
  }
  for (const part of parts) part.lines = part.kind === 'json-keys' ? Object.keys(part.keys).length : countLines(part.content);

  if (S.present) for (const t of p.tools) if (S.present[t] === false) notes.push(`${TOOL_LABEL[t]} was not found on this machine; its files are still listed.`);
  if (ctx.multiLab) notes.push(`You use models from ${ctx.labs.length} labs (${ctx.labs.map((l) => labName(F, l)).join(', ')}), so helpers run on the lead's model unless you choose one; each lab's own descriptions are listed as facts.`);
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
function roleSummary(x) {
  if (x.from === 'inherit') return 'inherit (runs on the lead\'s model)';
  const name = x.model_ref && x.model_ref !== x.model_id ? `${x.model_ref} = ${x.model_name}` : x.model_name;
  return `${name} · ${x.from === 'you' ? 'your choice' : 'from the tool\'s own docs'}`;
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
    out.push('', 'Which model each helper runs');
    for (const tool of TOOLS) {
      const t = roles[tool];
      if (!t) continue;
      out.push(`  ${TOOL_LABEL[tool]}`);
      for (const role of ALL_ROLE_KEYS) {
        const x = t[role];
        if (!x) continue;
        if (role === 'lead' && x.from === 'inherit') { out.push(`    ${'lead'.padEnd(9)}the model you choose in ${tool === 'agents-md' ? 'your tool' : TOOL_LABEL[tool]}`); continue; }
        if (tool === 'agents-md' && role !== 'lead' && x.from === 'inherit') continue;
        out.push(`    ${role.padEnd(9)}${roleSummary(x)}`);
        for (const b of arr(x.basis)) if (x.from !== 'inherit') out.push(`             "${b.quote}"`, `             ${b.source_url} (${b.date})`);
        if (x.model_id) {
          const u = usageText(x.usage);
          out.push(`             ${priceText(x.price)}${u ? ' · ' + u : ''}`);
        }
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
    out.push('', 'Files: none (no tool with a file this package can write).');
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
  { role: 'scout', re: /research|scout|explor|read|search|bulk/i },
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
  const toolsFor = (plans) => {
    const t = [];
    for (const pl of plans) {
      const v = labKey(pl.vendor);
      if (v === 'anthropic') t.push('claude-code');
      else if (v === 'openai') t.push('codex');
      else if (v === 'cursor') t.push('cursor');
    }
    return TOOLS.filter((x) => t.includes(x));
  };
  const perToken = (plans) => plans.some((pl) => PER_TOKEN_VENDORS.includes(labKey(pl.vendor)));
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
  return normalizeProfile(raw, { models: d.models, guidance: d.guidance }).profile;
}
