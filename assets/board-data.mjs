/* What the board shows, worked out from the site's data files and nothing else.

   Every function here is pure: it takes the data it reads as arguments and touches no page, no
   storage and no network. board.html imports this file and calls it with the files it fetched;
   a test can import it with any copy of data/ and see exactly the lists the board would show —
   the model picker, what each plan reaches and costs, the measured request a routine is billed
   at, and the default "me" block — without a browser.

   No model, plan, price or date is written in this file. A plan's reach and whether its seat
   pays for tokens come from the plan row (`reaches`, `covers_tokens`, `base_usd_month`); when a
   row does not say, the rule below reads the row's own text, and an unknown plan is never
   credited with paying for tokens. */

/* ---------- small helpers ---------- */
export function normalizeKey(s) { return String(s || '').toLowerCase().replace(/[\s\-_.]+/g, ''); }
export function isPriced(m) { return !!m && m.price_input != null && m.price_output != null; }
export function modelById(models, id) { return (models || []).find((m) => m.id === id) || null; }

// The day formatter lives with the freshness stamps (assets/freshness.mjs); it is re-exported here
// so the board and its tests keep reading it as BD.dayLabel.
import { dayLabel } from './freshness.mjs';
export { dayLabel };

/* ---------- plans ---------- */
// "Anthropic" + "Pro" -> "Anthropic Pro", but a plan whose own name already opens with the
// vendor's first word ("Microsoft 365 Business Standard with Copilot") is left alone.
export function planLabel(p) {
  if (!p) return '';
  if (p.plan.indexOf(p.vendor) === 0) return p.plan;
  const lead = String(p.vendor || '').split(' ')[0];
  if (lead && p.plan.indexOf(lead + ' ') === 0) return p.plan;
  return p.vendor + ' ' + p.plan;
}
export function planByName(plans, name) {
  if (!name) return null;
  return (plans || []).find((p) => planLabel(p) === name) || null;
}
// One field per fact: a plan's price lives in the row's own `price_usd_month`. A row with no
// price on file (an enterprise "contact sales" tier) is worth nothing to the seat maths.
export function planPriceUnknown(p) { return !!p && typeof p.price_usd_month !== 'number'; }
export function planPrice(p) { return (p && typeof p.price_usd_month === 'number') ? p.price_usd_month : 0; }
// A flat monthly fee on top of the seats (a team fee), when the row carries one.
export function planBaseFee(p) {
  return (p && typeof p.base_usd_month === 'number' && p.base_usd_month > 0) ? p.base_usd_month : 0;
}

// "Mistral" and the catalog's "Mistral AI" are the same lab; match the shorter name inside the
// longer one so a plan feed and a model feed need not spell a vendor identically.
export function modelVendorFor(models, planVendor) {
  const key = normalizeKey(planVendor);
  if (!key) return null;
  const exact = (models || []).find((m) => m.vendor === planVendor);
  if (exact) return exact.vendor;
  const hit = (models || []).find((m) => {
    const k = normalizeKey(m.vendor);
    return k === key || k.indexOf(key) === 0 || key.indexOf(k) === 0;
  });
  return hit ? hit.vendor : null;
}

export const PER_TOKEN_TEXT = /pay[- ]as[- ]you[- ]go|per[- ]token|usage[- ]based|token pricing|marketplace/i;
export const HARNESS_TEXT = /harness|any (model|provider|lab)|every (model|provider|lab)|multi[- ]model|models from (several|multiple|many)|frontier models from/i;

/* What a plan reaches, and whether its seat pays for the tokens. In this order:
     1. the row says so (`reaches`: "all" or a list of lab vendor names; `covers_tokens`: bool)
                                                          -> the row's own words, field by field;
     2. its vendor is also a model vendor in the data     -> it reaches that vendor's models;
     3. its name or billing line says per token, or its text says it is a harness that reaches
        several labs                                      -> read from that text;
     4. nothing matched                                   -> reaches every lab (never hide models
        behind a plan the data can't place) and does NOT cover tokens (never claim a seat pays for
        something the data doesn't show).
   A per-token name or billing line always means the seat does not cover tokens — "Pay as you go"
   is never a seat, whatever else the row says. */
export function planReachOf(p, models) {
  if (!p) return { reaches: 'all', covers: true };   // a plan the data doesn't carry can't restrict anything
  const text = String(p.plan || '') + ' ' + String(p.billing || '') + ' ' + String(p.includes || '');
  // Read "per token" from the plan's NAME and its BILLING line only: a feature list often
  // mentions usage-based billing for one add-on, which doesn't make the seat itself per token.
  const perToken = PER_TOKEN_TEXT.test(String(p.plan || '') + ' ' + String(p.billing || ''));
  let inferred;
  const own = modelVendorFor(models, p.vendor);
  if (own) inferred = { reaches: [own], covers: !perToken };
  else if (perToken) inferred = { reaches: 'all', covers: false };
  else if (HARNESS_TEXT.test(text)) inferred = { reaches: 'all', covers: true };
  else inferred = { reaches: 'all', covers: false };
  const reaches = p.reaches === 'all' ? 'all'
    : (Array.isArray(p.reaches) && p.reaches.length) ? p.reaches.slice() : inferred.reaches;
  const covers = typeof p.covers_tokens === 'boolean' ? (perToken ? false : p.covers_tokens) : inferred.covers;
  return { reaches, covers };
}
export function planReach(plans, models, planName) { return planReachOf(planByName(plans, planName), models); }

// The model vendors a set of plans reaches together; null means "every lab" (or no plans).
export function reachableVendorsFor(plans, models, planNames) {
  const list = (planNames || []).filter(Boolean);
  if (!list.length) return null;
  const out = [];
  for (const name of list) {
    const r = planReach(plans, models, name);
    if (r.reaches === 'all') return null;
    r.reaches.forEach((v) => { if (out.indexOf(v) === -1) out.push(v); });
  }
  return out.length ? out : null;
}

/* Seats: every plan on the block added up, times the seat count, plus any flat monthly fee a plan
   carries on top of its seats. No seats, no seat cost. */
export function planSeatCost(plans, planNames, seats) {
  const list = (planNames || []).filter(Boolean);
  const n = Math.max(0, seats || 0);
  let each = 0, base = 0;
  const fees = [];
  list.forEach((name) => {
    const p = planByName(plans, name);
    if (!p) return;
    each += planPrice(p);
    const fee = planBaseFee(p);
    if (fee) { base += fee; fees.push({ plan: name, amount: fee }); }
  });
  const total = n > 0 ? (each > 0 ? each * n : 0) + base : 0;
  return { each, base: n > 0 ? base : 0, fees: n > 0 ? fees : [], seats: n, total };
}

/* A plan the data renamed keeps working on a board saved under the old name: each row's
   `renamed_from` lists its old names, either as the board showed them ("<vendor> <plan>") or as
   the row's old `plan` name under the same vendor. Returns { oldLabel: currentLabel }. */
export function planRenames(plans) {
  const map = {};
  (plans || []).forEach((p) => {
    const now = planLabel(p);
    (Array.isArray(p.renamed_from) ? p.renamed_from : []).forEach((old) => {
      if (!old || typeof old !== 'string') return;
      [old, planLabel({ vendor: p.vendor, plan: old })].forEach((k) => {
        if (k !== now && !planByName(plans, k)) map[k] = now;
      });
    });
  });
  return map;
}
// Rewrites every plan name inside a saved board (any `plans` / `defaultPlans` list and any `plan`
// string, at any depth) to its current name. Returns how many names moved.
export function migratePlanNames(saved, plans) {
  const map = planRenames(plans);
  if (!Object.keys(map).length) return 0;
  let moved = 0;
  const fix = (name) => {
    if (typeof name === 'string' && Object.prototype.hasOwnProperty.call(map, name)) { moved++; return map[name]; }
    return name;
  };
  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    Object.keys(node).forEach((k) => {
      const v = node[k];
      if ((k === 'plans' || k === 'defaultPlans') && Array.isArray(v)) node[k] = v.map(fix);
      else if (k === 'plan' && typeof v === 'string') node[k] = fix(v);
      else walk(v);
    });
  })(saved);
  return moved;
}

/* ---------- models: the picker's order ---------- */
// A release date as a number: YYYY-MM-DD, a quarter (YYYY-Qn, its first day), or anything Date
// can read. Unknown or missing sorts last.
export function releasedRank(r) {
  if (!r || r === 'unknown') return 0;
  const qm = String(r).match(/^(\d{4})-Q([1-4])$/);
  if (qm) return Date.UTC(+qm[1], (+qm[2] - 1) * 3, 1);
  const dm = String(r).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dm) return Date.UTC(+dm[1], +dm[2] - 1, +dm[3]);
  const t = Date.parse(r);
  return isNaN(t) ? 0 : t;
}
// The picker is ordered by how much a model is actually used: `usage.openrouter.share`, this
// model's percentage of the tokens OpenRouter served. A model with no usage row sorts after every
// model that has one, newest first among themselves. The order is the signal; nothing is ranked.
export function popularityOf(m) {
  const u = m && m.usage && m.usage.openrouter;
  return (u && typeof u.share === 'number') ? u.share : null;
}
export function byPopularity(a, b) {
  const pa = popularityOf(a), pb = popularityOf(b);
  if (pa != null && pb == null) return -1;
  if (pa == null && pb != null) return 1;
  if (pa != null && pb != null && pa !== pb) return pb - pa;
  return releasedRank(b.released) - releasedRank(a.released);
}

/* The model picker's three lists. `restrict` is a list of vendors the plans reach (null: every
   lab); `beyond` shows models outside it; `query` filters by name or vendor; `ownedIds` lists
   the user's own models first. "Beyond your plan" only fills when a search finds nothing inside
   the plan. */
export function pickerLists(models, opts = {}) {
  const all = models || [];
  const q = String(opts.query || '').trim().toLowerCase();
  const restrict = opts.restrict && opts.restrict.length ? opts.restrict : null;
  const beyond = !!(restrict && opts.beyond);
  const owned = opts.ownedIds || [];
  const named = (m) => !q || m.name.toLowerCase().indexOf(q) !== -1 || m.vendor.toLowerCase().indexOf(q) !== -1;
  const matches = (m) => (!restrict || beyond || restrict.indexOf(m.vendor) !== -1) && named(m);
  const yours = owned.length ? all.filter((m) => owned.indexOf(m.id) !== -1 && matches(m)).sort(byPopularity) : [];
  const rest = all.filter(matches).slice().sort(byPopularity);
  const outside = (!yours.length && !rest.length && q && restrict && !beyond)
    ? all.filter(named).sort(byPopularity) : [];
  return { owned: yours, rest, outside };
}

/* ---------- the measured request (data/per-request.json) ---------- */
// The average request for these models from the per-request feed. A model with no row of its own
// falls back to the feed's median request; with no feed at all nothing is measured and the
// result says so (`missing`), rather than costing a routine at a number we don't have.
export function perRequestFor(feed, ids) {
  const list = ids || [];
  const rows = (feed && Array.isArray(feed.rows)) ? feed.rows : null;
  if (!rows) return { in: 0, out: 0, matched: 0, of: list.length, missing: true };
  const byId = new Map(rows.map((r) => [r.model_id, r]));
  const hit = list.map((id) => byId.get(id)).filter(Boolean);
  if (!hit.length) {
    const med = feed.median;
    if (!med || typeof med.in !== 'number' || typeof med.out !== 'number') {
      return { in: 0, out: 0, matched: 0, of: list.length, missing: true };
    }
    return { in: med.in, out: med.out, matched: 0, of: list.length, median: true };
  }
  let i = 0, o = 0;
  hit.forEach((r) => { i += r.in; o += r.out; });
  return { in: Math.round(i / hit.length), out: Math.round(o / hit.length), matched: hit.length, of: list.length };
}
// The feed's date as the page prints it ("D Mon YYYY"), or null with no feed.
export function perRequestDate(feed) { return feed && feed.as_of ? dayLabel(feed.as_of) : null; }

/* ---------- the default "me" block ---------- */
// From board-samples.json `personal_default`: plan names (as the board shows them, or a row's
// own `plan` name when only one row carries it) and model ids, each kept only if the data still
// has it. No key, or nothing that resolves, means an empty block — never a typed fallback.
export function personalDefault(samples, plans, models) {
  const def = samples && samples.personal_default;
  if (!def || typeof def !== 'object') return { plans: [], models: [] };
  const renames = planRenames(plans);
  const labels = [];
  (Array.isArray(def.plans) ? def.plans : []).forEach((name) => {
    let p = planByName(plans, name);
    if (!p) {
      const rows = (plans || []).filter((r) => r.plan === name);
      if (rows.length === 1) p = rows[0];
    }
    if (!p && renames[name]) p = planByName(plans, renames[name]);
    if (p && labels.indexOf(planLabel(p)) === -1) labels.push(planLabel(p));
  });
  const ids = (Array.isArray(def.models) ? def.models : [])
    .filter((id, i, a) => typeof id === 'string' && a.indexOf(id) === i && !!modelById(models, id));
  return { plans: labels, models: ids };
}

/* ---------- everything at once ---------- */
// What the board would show for a given data set: the picker (every model, in picker order), each
// plan with its reach, coverage and seat price, the measured-request date, and the default "me"
// block. `data` = { models, plans, perRequest, samples } — the parsed files' contents.
export function boardView(data) {
  const models = (data && data.models) || [];
  const plans = (data && data.plans) || [];
  return {
    picker: pickerLists(models).rest.map((m) => m.id),
    plans: plans.map((p) => {
      const r = planReachOf(p, models);
      return { label: planLabel(p), reaches: r.reaches, covers: r.covers,
               price: planPriceUnknown(p) ? null : planPrice(p), base: planBaseFee(p) };
    }),
    perRequest: { as_of: (data && data.perRequest && data.perRequest.as_of) || null,
                  label: perRequestDate(data && data.perRequest) },
    personalDefault: personalDefault(data && data.samples, plans, models),
  };
}
