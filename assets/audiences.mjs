// Three kinds of visitor on one board, on top of the shipped generator.
// - Everyday: every box shows a model. A tool with no documented default asks for the lead; once it is set, each
//   helper gets the cheapest model the tool can run that scores close enough to the lead on outside tests (Spend).
// - Power user: "Any model" runs models by route (OpenRouter, Ollama on your computer, or both); every box picks.
// - Company rules: limit models by where the lab is based.
import { TOOLS, WORK, ROLE_INFO, ROLE_ORDER, setupFromTaps, modelsForTool, profileFromTaps } from './taps.mjs';
import { LAB_GROUPS, fmtPrice, fmtDate } from './site-core.js';

const DATA_URL = new URL('../data/', import.meta.url);
const DEAD = ['deprecated', 'retired', 'shutdown', 'removed'];
const EUROPE = ['France', 'Germany', 'United Kingdom', 'Netherlands', 'Switzerland', 'Sweden', 'Italy', 'Spain', 'Finland', 'Poland', 'Ireland', 'Belgium', 'Austria', 'Denmark', 'Norway', 'Portugal'];

export const ROUTES = [
  { id: 'openrouter', label: 'OpenRouter' },
  { id: 'ollama', label: 'Local (Ollama)' },
  { id: 'both', label: 'Both' },
];
export const GROUP_LABEL = { us: 'United States', eu: 'Europe', cn: 'China', other: 'Other' };
export const GROUP_SHORT = { us: 'US', eu: 'Europe', cn: 'China', other: 'Other' };

// Tools that run one lab's models only (what modelsForTool already enforces).
const ONE_LAB = { 'claude-code': 'Anthropic', codex: 'OpenAI', antigravity: 'Google' };
// The lab's own pick for high-volume, checkable work: the bulk model in the guidance plan of the lab's own tool
// (data/guidance.json, with its sourced claims). A lab with no such pick on file has no rule: bulk runs on the lead.
function labBulk(facts, vendor) {
  const t = TOOLS.find((x) => x.vendor === vendor);
  const plan = t && (facts.guidance.tool_plans || []).find((p) => p.tool === t.id);
  const b = plan && plan.bulk;
  if (!b || !b.model_id) return null;
  const claims = (b.basis || []).map((id) => claimOf(facts, id)).filter(Boolean);
  const c = claims.find((x) => x.tier === 'lab') || claims[0];
  return c ? { model_id: b.model_id, claim: c.id } : null;
}

/* ---------- load: where each lab is based, and the models that run on your own computer ---------- */
export async function loadAudiences(facts) {
  const get = async (name) => { const r = await fetch(new URL(name, DATA_URL)); if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`); return r.json(); };
  const [lo, vendors] = await Promise.all([get('local-models.json'), get('vendors.json')]);
  const country = new Map(vendors.vendors.map((v) => [v.vendor, v.country]));
  // A lab with no country on file is in no group, so any "Lab based in" limit leaves it out.
  const groupOf = (vendor) => {
    const c = country.get(vendor);
    if (!c) return null;
    if (c === 'United States') return 'us';
    if (c === 'China') return 'cn';
    if (EUROPE.includes(c)) return 'eu';
    return 'other';
  };
  facts.aud = { local: lo.models.map((x) => ({ ...x })), localSource: lo.source, localChecked: lo.checked, groupOf };
  return facts.aud;
}

/* ---------- one shape for anything a box can hold ---------- */
const live = (m) => !DEAD.includes(String(m.status || '').toLowerCase());
function catalogEntry(m) {
  const a = m.availability || {};
  return {
    id: m.id, model_id: m.id, name: m.name, vendor: m.vendor, route: 'cloud', released: m.released || '',
    price: m.price_input != null ? { input: m.price_input, output: m.price_output } : null,
    open: a.open_weights === true, avail: a, sources: m.sources || [],
  };
}
function localEntry(x) {
  return { id: x.id, model_id: x.model_id || null, name: x.name, vendor: x.vendor, route: 'local', tag: x.tag, gb: x.gb, open: true, released: '' };
}
export function entryOf(facts, id) {
  const l = facts.aud.local.find((x) => x.id === id);
  if (l) return localEntry(l);
  const m = facts.models.models.find((x) => x.id === id);
  return m ? catalogEntry(m) : null;
}
// Release dates come as 2026-10-07, 2026-07, 2026-Q1 or 2026; read them all as sortable months so a quarter or a bare
// year never jumps ahead of a dated release.
const relKey = (r) => {
  const s = String(r || '');
  let m = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(s); if (m) return `${m[1]}-${m[2]}-${m[3] || '00'}`;
  m = /^(\d{4})-Q(\d)/.exec(s); if (m) return `${m[1]}-${String((+m[2] - 1) * 3 + 1).padStart(2, '0')}-00`;
  m = /^(\d{4})$/.exec(s); return m ? `${m[1]}-00-00` : '';
};
const byNewest = (a, b) => relKey(b.released).localeCompare(relKey(a.released)) || a.name.localeCompare(b.name);

/** Everything a box could hold for this tool (Any model: everything on the route). Local models first. */
export function universe(facts, S) {
  if (S.tool !== 'any') return modelsForTool(facts, S.tool).map((m) => catalogEntry(facts.models.models.find((x) => x.id === m.id))).sort(byNewest);
  const out = [];
  if (S.plan !== 'openrouter') out.push(...facts.aud.local.map(localEntry));
  if (S.plan !== 'ollama') out.push(...facts.models.models.filter((m) => live(m) && m.availability && m.availability.openrouter === true).map(catalogEntry).sort(byNewest));
  return out;
}

/* ---------- limits ---------- */
export const isLimited = (L) => !!L && L.labs.length < LAB_GROUPS.length;
export function fits(facts, e, L) {
  if (!e) return false;
  if (!isLimited(L)) return true;
  return L.labs.includes(facts.aud.groupOf(e.vendor));
}
/** "US, Europe" */
export function limitsText(L) {
  return L.labs.length ? LAB_GROUPS.filter((g) => L.labs.includes(g)).map((g) => GROUP_SHORT[g]).join(', ') : 'No labs';
}
/** The same limits as one rule an installer can follow. */
export function limitsRule(L) {
  const join = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} or ${xs[xs.length - 1]}` : xs[0]);
  const where = { us: 'the United States', eu: 'Europe', cn: 'China', other: 'a country outside the United States, Europe and China' };
  const s = `Only use models from labs based in ${join(LAB_GROUPS.filter((g) => L.labs.includes(g)).map((g) => where[g]))}`;
  return `${s}. Never set a model outside this rule; if a job has no model inside it, ask me.`;
}

/* ---------- the board's setup: the generator's answer, then the three audiences on top ---------- */
const claimOf = (facts, id) => (facts.guidance.claims || []).find((c) => c.id === id);
export const priceLine = (p) => (p ? `${fmtPrice(p.input)} in · ${fmtPrice(p.output)} out per 1M` : 'No list price on file');
export const localLine = (gb) => `Runs on your machine, about ${gb} GB`;

/* ---------- spend: price against independent scores ---------- */
// Thresholds: a helper's average score as a share of the lead's, across the percentage-type tests both appear in.
// heavy = builder, reviewer, checker (two shared tests or more); light = scout, bulk (one or more). null = the lead.
export const SPEND = {
  less: { heavy: 0.80, light: 0.65 },
  balanced: { heavy: 0.90, light: 0.75 },
  more: { heavy: null, light: 0.90 },
};
export const SPEND_LABEL = { less: 'Less', balanced: 'Balanced', more: 'More' };
const LIGHT = ['scout', 'bulk'];
const TESTER = { 'epoch-ai': 'Epoch AI', livebench: 'LiveBench' };
/** Blended price per 1M tokens: three parts input to one part output. */
export function blended(e) {
  return e && e.price && e.price.input != null && e.price.output != null ? (3 * e.price.input + e.price.output) / 4 : null;
}
// "CursorBench (best rung: Max)" and "CursorBench (best rung: High)" are the same test at each model's best setting.
const benchBase = (b) => String(b).replace(/\s*\((best rung:[^)]*|best of \d+ rows)\)/gi, '').trim();
const scoreCache = new WeakMap();
function scoresOf(facts, id) {
  let byId = scoreCache.get(facts.models);
  if (!byId) {
    byId = new Map();
    // Only percentage-type tests count (0 to 1, or 0 to 100). A test with any score above 100 is a rating (Elo-style,
    // such as ALE-Bench) and is left out: its ratios do not mean "share of the lead's quality".
    const all = facts.models.models.flatMap((m) => (((m.standings || {}).coding || {}).measured || []).map((x) => ({ m, x })));
    const rating = new Set(all.filter(({ x }) => typeof x.score === 'number' && x.score > 100).map(({ x }) => benchBase(x.benchmark)));
    for (const m of facts.models.models) {
      const ms = (((m.standings || {}).coding || {}).measured || []).filter((x) => typeof x.score === 'number' && x.score > 0 && !rating.has(benchBase(x.benchmark)));
      byId.set(m.id, ms.map((x) => ({ bench: benchBase(x.benchmark), tester: TESTER[x.tester] || x.tester, score: x.score, url: x.url, as_of: x.as_of })));
    }
    scoreCache.set(facts.models, byId);
  }
  return byId.get(id) || [];
}
/** Two models on one test both appear in: CursorBench first, else the first other test in the lead's list. */
export function sharedTest(facts, lead, cand) {
  const a = scoresOf(facts, lead.model_id), b = scoresOf(facts, cand.model_id);
  if (!a.length || !b.length) return null;
  const pickBench = a.find((x) => x.bench === 'CursorBench' && b.some((y) => y.bench === 'CursorBench')) || a.find((x) => b.some((y) => y.bench === x.bench));
  if (!pickBench) return null;
  const other = b.find((y) => y.bench === pickBench.bench);
  return { bench: pickBench.bench, tester: pickBench.tester, ratio: other.score / pickBench.score, lead: pickBench.score, cand: other.score, url: other.url || pickBench.url, as_of: other.as_of || pickBench.as_of };
}
/** Every test both models appear in, CursorBench first, then the lead's own order. */
export function sharedTests(facts, lead, cand) {
  const a = scoresOf(facts, lead.model_id), b = scoresOf(facts, cand.model_id);
  const out = [];
  for (const x of [...a.filter((t) => t.bench === 'CursorBench'), ...a.filter((t) => t.bench !== 'CursorBench')]) {
    const y = b.find((t) => t.bench === x.bench);
    if (y && !out.some((o) => o.bench === x.bench)) out.push({ bench: x.bench, tester: x.tester, ratio: y.score / x.score, lead: x.score, cand: y.score, url: y.url || x.url, as_of: y.as_of || x.as_of });
  }
  return out;
}
const shortBench = (b) => b.replace(/\s*\(Epoch mirror[^)]*\)/, '').replace(/ category$/, '');
const andList = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs[0]);
function pricePhrase(r) {
  if (Math.abs(r - 0.5) < 0.03) return 'half the price';
  if (Math.abs(r - 1 / 3) < 0.02) return 'a third of the price';
  if (Math.abs(r - 0.25) < 0.02) return 'a quarter of the price';
  if (r < 0.2) return `${Math.round(1 / r)}x cheaper`;
  return `${Math.round((1 - r) * 100)}% cheaper`;
}

export function boardSetup(S, facts) {
  const T = TOOLS.find((t) => t.id === S.tool) || TOOLS[0];
  const label = T.label;
  const L = S.limits;
  const pool = universe(facts, S);
  const inPool = (id) => pool.find((e) => e.id === id) || null;
  let base, roles, rejected;
  if (S.tool !== 'any') {
    // "tool-default" is the visitor's "Not sure" on the lead: not a model, so the generator never sees it.
    const passRoles = { ...S.roles }; if (passRoles.lead === 'tool-default') delete passRoles.lead;
    base = setupFromTaps({ tool: S.tool, plan: S.plan, work: S.work }, facts, { roles: passRoles });
    rejected = Object.keys(passRoles).filter((k) => { const r = base.roles.find((x) => x.key === k); return !r || r.model_id !== passRoles[k]; });
    roles = base.roles.map((r) => ({
      ...r, entry: r.model_id ? entryOf(facts, r.model_id) : null,
      rule: r.from === 'inherit' ? (r.key === 'lead' ? 'pick' : 'lead') : r.from,
    }));
  } else {
    const w = WORK.find((x) => x.id === S.work) || WORK[0];
    base = { toolLabel: label, big_job: w.big_job, near_limit: null, files: [], asOf: facts.guidance.as_of };
    rejected = Object.keys(S.roles).filter((k) => !inPool(S.roles[k]));
    roles = ROLE_ORDER.map((k) => {
      const e = S.roles[k] ? inPool(S.roles[k]) : null;
      return e
        ? { key: k, ...ROLE_INFO[k], from: 'you', model_id: e.model_id, model_name: e.name, entry: e, rule: 'you', quote: null }
        : { key: k, ...ROLE_INFO[k], from: 'inherit', model_id: null, model_name: null, entry: null, rule: k === 'lead' ? 'pick' : 'lead', quote: null };
    });
  }
  const lead = roles.find((r) => r.key === 'lead');
  for (const r of roles) r.outside = !!r.entry && !fits(facts, r.entry, L);
  const leadReady = !!lead.entry && !lead.outside;
  // "Not sure": the visitor leaves the main model to the tool; every helper then runs on whatever it picks.
  const toolDefault = S.tool !== 'any' && S.roles.lead === 'tool-default' && !lead.entry;

  // Cost-aware fill (10-17, round 3): every box the visitor left open gets the cheapest model this tool, route and
  // limits allow whose independent tester score is close enough to the lead's. Scout and bulk fall back to the lead
  // maker's own-docs pick when nothing scored qualifies and that pick is cheaper.
  const spend = SPEND[S.spend] ? S.spend : 'balanced';
  if (leadReady) {
    const lp = blended(lead.entry);
    // A tool that runs several labs' models but publishes no per-model list (Cursor, Copilot): fill from the lead's own
    // lab only, so the board never names a model the tool may not offer.
    const multiLab = S.tool !== 'any' && !ONE_LAB[S.tool];
    const cands = pool.filter((e) => e.route === 'cloud' && e.id !== lead.entry.id && fits(facts, e, L) && blended(e) != null && lp != null && blended(e) < lp && (!multiLab || e.vendor === lead.entry.vendor));
    for (const r of roles) {
      if (r.key === 'lead' || S.roles[r.key] || r.rule === 'you') continue;
      const light = LIGHT.includes(r.key);
      const T = SPEND[spend][light ? 'light' : 'heavy'];
      let pick = null;
      if (T !== null && lp != null) {
        for (const e of cands) {
          // Builder, reviewer, checker: at least two shared tests. Scout and bulk: at least one. Average ratio vs T.
          const tests = sharedTests(facts, lead.entry, e);
          if (tests.length < (light ? 1 : 2)) continue;
          const avg = tests.reduce((a, t) => a + t.ratio, 0) / tests.length;
          if (avg < T) continue;
          const p = blended(e);
          if (!pick || p < pick.p || (p === pick.p && avg > pick.avg)) pick = { e, tests, avg, p };
        }
      }
      if (pick) {
        const save = Math.round((1 - pick.p / lp) * 100);
        const t0 = pick.tests[0];
        const testers = [...new Set(pick.tests.map((t) => t.tester))].join(', ');
        const pct = Math.round(pick.avg * 100);
        const names = andList(pick.tests.map((t) => shortBench(t.bench)));
        Object.assign(r, { from: 'cost', rule: 'cost', entry: pick.e, model_id: pick.e.model_id, model_name: pick.e.name, outside: false, save, avg: pick.avg,
          priceWord: pricePhrase(pick.p / lp),
          costLine: pick.tests.length > 1
            ? `${pct}% of ${lead.entry.name} on average across ${names} (${testers}), ${pricePhrase(pick.p / lp)}`
            : `${pct}% of ${lead.entry.name} on ${names} (${testers}), ${pricePhrase(pick.p / lp)}`,
          quote: { text: '', url: t0.url, date: t0.as_of }, test: t0, tests: pick.tests });
        continue;
      }
      // nothing scored qualifies
      const rule = light ? labBulk(facts, lead.entry.vendor) : null;
      const e = rule ? inPool(rule.model_id) : null;
      const c = rule ? claimOf(facts, rule.claim) : null;
      if (e && c && e.id !== lead.entry.id && fits(facts, e, L) && lp != null && blended(e) != null && blended(e) < lp) {
        Object.assign(r, { from: 'lab', rule: 'lab', entry: e, model_id: e.model_id, model_name: e.name, outside: false,
          save: Math.round((1 - blended(e) / lp) * 100), priceWord: pricePhrase(blended(e) / lp), quote: { text: c.quote, url: c.source_url, date: c.date }, labName: lead.entry.vendor });
      } else {
        Object.assign(r, { from: 'inherit', rule: 'lead', entry: null, model_id: null, model_name: null, outside: false, save: 0, quote: null });
      }
    }
  }

  const any = S.tool === 'any';
  for (const r of roles) {
    const v = { model: '', src: '', meta: '', open: false, state: 'set', save: 0 };
    if (r.key === 'lead' && toolDefault) {
      Object.assign(v, { model: `${label}'s default`, src: `Whatever ${label} picks for you`, state: 'tooldefault' });
    } else if (r.rule === 'lead' && toolDefault) {
      Object.assign(v, { model: "The lead's model", src: "Runs on the lead's model", state: 'shared' });
    } else if (r.rule === 'pick' && !r.entry) {
      Object.assign(v, { model: 'Choose a model', src: any ? 'Pick the model you want to lead' : `Pick the model you use in ${label}`, state: 'pick' });
    } else if (r.outside) {
      Object.assign(v, { model: 'Not available under your limits', src: 'Pick a model inside them', state: 'outside' });
    } else if (r.rule === 'lead') {
      if (leadReady) Object.assign(v, { model: lead.entry.name, src: "Runs on the lead's model", state: 'shared' });
      else Object.assign(v, { model: 'Waits for the lead', src: "Runs on the lead's model", state: 'wait' });
    } else {
      v.model = r.entry ? r.entry.name : r.model_name;
      v.src = r.rule === 'you' ? (r.example ? 'From the example setup' : 'Your choice')
        : r.rule === 'tool' ? `${label}'s own docs`
        : r.rule === 'lab' ? `${r.labName || (r.entry && r.entry.vendor)}'s own docs`
        : r.rule === 'cost' ? r.costLine : (r.source || '');
      if (any && r.entry) { v.meta = r.entry.route === 'local' ? localLine(r.entry.gb) : priceLine(r.entry.price); v.open = r.entry.open; }
    }
    r.view = v;
    r.source = v.src;
  }
  // One line under the board: what the six jobs cost against running every job on the lead (blended price).
  let saving = null;
  if (leadReady && blended(lead.entry) != null && roles.some((r) => r.key !== 'lead' && r.entry && blended(r.entry) != null && blended(r.entry) < blended(lead.entry))) {
    const lp = blended(lead.entry);
    let sum = 0, base = 0;
    for (const r of roles) {
      const p = r.view.state === 'shared' || r.view.state === 'wait' ? lp : blended(r.entry);
      if (p == null) continue;
      sum += p; base += lp;
    }
    const n = Math.round((1 - sum / base) * 100);
    const avgs = roles.filter((r) => r.rule === 'cost' && r.avg).map((r) => Math.round(r.avg * 100));
    if (n > 0) saving = { pct: n, lead: lead.entry.name, lo: avgs.length ? Math.min(...avgs) : null, hi: avgs.length ? Math.max(...avgs) : null };
  }
  // Nothing cheaper qualified: every box runs the lead's model. One line says so, so six identical boxes read as a choice.
  const sameModel = leadReady && !saving && roles.every((r) => r.key === 'lead' || r.view.state === 'shared' || (r.entry && r.entry.id === lead.entry.id));
  const fitCount = pool.filter((e) => fits(facts, e, L)).length;
  return { ...base, tool: S.tool, toolLabel: label, roles, rejected, oneLab: ONE_LAB[S.tool] || null, limited: isLimited(L), count: { fit: fitCount, total: pool.length }, pool, saving, sameModel: sameModel ? lead.entry.name : null };
}

/** The picker's list for one box: the tool's (or route's) models inside the limits, newest first, local first. */
export function pickList(facts, S) { return universe(facts, S).filter((e) => fits(facts, e, S.limits)); }

/** One line under a model in the picker. */
export function optionLine(e, { any, multi }) {
  const bits = [];
  if (multi || any) bits.push(e.vendor);
  if (any) bits.push(e.route === 'local' ? localLine(e.gb) : priceLine(e.price));
  return { text: bits.join(' · '), open: any && e.open && e.route !== 'local' };
}

/* ---------- install prompt: the board's own answers, only when they go past the tool's defaults ---------- */
/** The model's OpenRouter id as Collect saved it from OpenRouter's own list; no id on file → the plain name. */
export function orSlug(facts, e) {
  return (e.avail && e.avail.openrouter_id) || e.name;
}
function idFor(facts, e, route) {
  if (e.route === 'local') return route === 'both' ? `${e.tag} on this computer (Ollama)` : e.tag;
  return route === 'both' ? `${orSlug(facts, e)} on OpenRouter` : orSlug(facts, e);
}
/** The board in the installer's own profile format (modelproof.profile/1), so it does not ask again what the board
 *  already says. Only boxes with a model the visitor chose or the board filled go in; the rest stay the tool's own. */
export function promptBlock(setup, S, facts) {
  const any = S.tool === 'any';
  const custom = any || setup.roles.some((r) => r.rule === 'you' || r.rule === 'lab' || r.rule === 'cost' || r.view.state === 'pick' || r.view.state === 'outside') || setup.limited;
  if (!custom) return '';
  const set = (r) => r.entry && r.view.state === 'set' && r.rule !== 'tool';
  const roles = {};
  for (const r of setup.roles) if (set(r) && r.entry.model_id) roles[r.key] = r.entry.model_id;
  const profile = profileFromTaps({ tool: S.tool, plan: S.plan, work: S.work }, { roles });
  const out = ['', '', 'MY BOARD (my Modelproof profile from the site: use it as my answers, and still show me the plan first):', JSON.stringify(profile, null, 2)];
  if (any) {
    const how = { openrouter: 'through OpenRouter', ollama: 'on this computer with Ollama', both: 'some through OpenRouter, some on this computer with Ollama' }[S.plan];
    out.push(`My models run ${how}; I need an agent that can run a different model for each job. The IDs to use:`);
    for (const r of setup.roles) if (set(r)) out.push(`- ${ROLE_INFO[r.key].name}: ${idFor(facts, r.entry, S.plan)}`);
  }
  const ask = setup.roles.filter((r) => r.view.state === 'pick' || r.view.state === 'outside').map((r) => ROLE_INFO[r.key].name);
  if (setup.roles.some((r) => r.view.state === 'tooldefault')) out.push(`Lead: whatever ${setup.toolLabel} picks by default; helpers run on the same model.`);
  if (ask.length) out.push(`Ask me which model to use for: ${ask.join(', ')}.`);
  if (setup.limited) out.push(`RULE: ${limitsRule(S.limits)}`);
  return out.join('\n');
}
