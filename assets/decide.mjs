/* ============================================================
   Modelproof decision layer — the shared rule engine behind
   lab.html today, and the MCP server (mcp/) later.
   One dependency-free ES module: no imports, runs unchanged in
   a browser <script type="module"> and under plain Node. The
   caller loads the data and injects it — this file never
   fetches or reads a file itself, so it works the same whether
   the data came from a local JSON import, an HTTP fetch, or a
   test fixture.

   decide(input, data)
     input: {
       tasks: [taskId, ...],                          // data/tasks.json ids, e.g. 'coding'
       have: ['anthropic'|'openai'|'google'|'xai'|'openrouter'|'any', ...],
       stance: 'cheapest' | 'balanced' | 'best',       // default 'balanced'
       volume: 'light' | 'typical' | 'heavy'           // a data/usage-presets.json key
              | { tokens_in_month, tokens_out_month }, // or a custom monthly volume
                                                        // default 'typical'
       dataRule: { noChinaHosted?: boolean },
     }
     data: {
       models,     // data/models.json's `models` array (each already carrying task_fit,
                   // task_fit_judged and availability — see scripts/derive-task-fit.mjs and
                   // scripts/derive-availability.mjs)
       plans,      // data/plans.json's `plans` array
       presets,    // data/usage-presets.json's `presets` object ({light, typical, heavy})
       vendors,    // data/vendors.json's `vendors` array — NOT in the original three-field
                   // spec for this function, but rule 2 (the noChinaHosted data rule) can't be
                   // implemented without a vendor -> country map, so it's a required fourth
                   // key here. Documented as a deliberate addition, not an oversight.
     }
   returns { tasks: { <taskId>: { shortlist: [...], assumptions: [...] } } }

   RULE ORDER (fixed — this is the one thing every caller can rely on staying stable)
   -----------------------------------------------------------------------------------------
   1. Reachability — drop any model the caller cannot actually reach with `have`.
        have includes 'any'        -> no filter, every model passes this step.
        have includes 'openrouter' -> keep if model.availability.openrouter === true.
        have includes a vendor key -> keep if model.vendor is that vendor's canonical name
                                       AND model.availability.direct_api === true. Requiring
                                       the sourced direct_api flag (not just a vendor-name
                                       match) means an Anthropic/OpenAI/Google/xAI model whose
                                       own direct_api flag hasn't been sourced yet is excluded
                                       here too — the same "unsourced is never assumed true"
                                       rule the rest of this repo runs on, even though it can
                                       feel too strict for a vendor's own first-party model.
       A model passes step 1 if ANY key in `have` clears it (the array is "everything you
       have", not "all of these at once").
   2. Data rule — dataRule.noChinaHosted drops any model whose vendor's data/vendors.json
      country is exactly "China". A vendor with no country on file is KEPT (unknown is never
      treated as a match) and the caller is told so in that task's assumptions[].
   3. Capability floor — drop any model with no sourced fit score for this task at all
      (model.task_fit[taskId].score == null). This is the whole floor in v1: "has a real basis"
      rather than "clears some invented numeric bar" — a numeric threshold beyond that would be
      an opinion this data doesn't support. model.task_fit_judged[taskId], once a Judge exists
      to write it, would override the rule-based score here; today it is always null so this is
      a no-op.
   4. Rank by stance, ties -> cheaper (see rankByStance). Before ranking, any model strictly
      dominated by a cheaper-or-equal, at-least-as-fit model already in the candidate set is
      dropped (dropDominated) — so the returned shortlist can never contain a pricier model
      that isn't at least justified by a higher fit than every cheaper option.
   Only the top 3 survivors are returned; item 0 is always start_here: true.
   ============================================================ */

const num = (v) => typeof v === 'number' && Number.isFinite(v);
const round2 = (v) => Math.round(v * 100) / 100;

// vendor key (as used in `have`) -> canonical vendor display name. Mirrors the four relevant
// spellings in scripts/naming.mjs's VENDORS exactly; duplicated (not imported) so this stays
// the single dependency-free module the spec calls for — scripts/test-decide.mjs checks the
// two haven't drifted apart.
export const VENDOR_KEY_DISPLAY = { anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google', xai: 'xAI' };
export const STANCES = ['cheapest', 'balanced', 'best'];

function fmtContext(n) {
  if (!num(n)) return 'unknown';
  if (n >= 1_000_000) return `${Number.isInteger(n / 1_000_000) ? n / 1_000_000 : (n / 1_000_000).toFixed(1)}M-token`;
  if (n >= 1000) return `${Math.round(n / 1000)}K-token`;
  return `${n}-token`;
}
function fmtTokens(n) {
  if (!num(n)) return 'unknown';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return `${n}`;
}

// -----------------------------------------------------------------------------------------
// why-text registry — the ONLY fields a `why` string is allowed to mention. Every task's
// basis[] (written by scripts/derive-task-fit.mjs) is drawn from this exact key set, so a
// `why` built only from these templates can never mention a field outside fit_basis.
// scripts/test-decide.mjs imports both this and derive-task-fit.mjs's BASIS_TOKENS to assert
// the two lists match.
// -----------------------------------------------------------------------------------------
export const WHY_FIELDS = {
  'coding_score': { say: (m) => `coding score ${m.coding_score}/100`, mention: /coding score/i },
  'context_window': { say: (m) => `${fmtContext(m.context_window)} context`, mention: /\bcontext\b/i },
  'benchmarks.gpqa': { say: (m) => `GPQA ${m.benchmarks.gpqa}`, mention: /gpqa/i },
  'benchmarks.mmlu_pro': { say: (m) => `MMLU-Pro ${m.benchmarks.mmlu_pro}`, mention: /mmlu-pro/i },
  'price_output': { say: (m) => `$${num(m.price_input) ? m.price_input : '—'}/$${m.price_output} per 1M tokens`, mention: /per 1m tokens/i },
  'best_for:vision': { say: () => 'tagged for vision', mention: /tagged for vision/i },
  'best_for:speed': { say: () => 'tagged for speed', mention: /tagged for speed/i },
  'effort_ladders': { say: () => 'has a published agentic-benchmark result', mention: /agentic-benchmark result/i },
};

export function buildWhy(model, basis) {
  const parts = (basis || []).map((f) => WHY_FIELDS[f]?.say(model)).filter(Boolean);
  if (!parts.length) return 'No sourced basis for this task.';
  const s = parts.join(', ');
  return s.charAt(0).toUpperCase() + s.slice(1) + '.';
}

// -----------------------------------------------------------------------------------------
// Rule 1 — reachability
// -----------------------------------------------------------------------------------------
export function reachableVia(model, have) {
  const list = (Array.isArray(have) ? have : []).map((h) => String(h || '').toLowerCase());
  if (list.includes('any')) return ['any'];
  const via = [];
  if (list.includes('openrouter') && model.availability?.openrouter === true) via.push('openrouter');
  for (const key of Object.keys(VENDOR_KEY_DISPLAY)) {
    if (list.includes(key) && model.vendor === VENDOR_KEY_DISPLAY[key] && model.availability?.direct_api === true) via.push(key);
  }
  return via;
}
export const isReachable = (model, have) => reachableVia(model, have).length > 0;

// -----------------------------------------------------------------------------------------
// Rule 2 — data rule (noChinaHosted)
// -----------------------------------------------------------------------------------------
export function vendorCountry(vendorName, vendorsList) {
  const row = (vendorsList || []).find((v) => v.vendor === vendorName);
  return row ? (row.country ?? null) : null;
}
export function passesDataRule(model, dataRule, vendorsList) {
  if (!dataRule?.noChinaHosted) return { ok: true, unknownCountry: false };
  const country = vendorCountry(model.vendor, vendorsList);
  if (country === 'China') return { ok: false, unknownCountry: false };
  return { ok: true, unknownCountry: country == null };
}

// -----------------------------------------------------------------------------------------
// Rule 3 — capability floor (task fit)
// -----------------------------------------------------------------------------------------
export function taskFitFor(model, taskId) {
  const judged = model.task_fit_judged?.[taskId];
  if (judged && judged.score != null) return judged; // Judge override — not implemented v1
  return model.task_fit?.[taskId] ?? { score: null, basis: [], reason: `task "${taskId}" is not in this model's task_fit` };
}

// -----------------------------------------------------------------------------------------
// Cost
// -----------------------------------------------------------------------------------------
export function resolveVolume(volume, presets) {
  if (volume && typeof volume === 'object' && num(volume.tokens_in_month) && num(volume.tokens_out_month)) {
    return {
      tokens_in_month: volume.tokens_in_month,
      tokens_out_month: volume.tokens_out_month,
      assumption: `Custom usage: ${fmtTokens(volume.tokens_in_month)} in / ${fmtTokens(volume.tokens_out_month)} out tokens per month, as given.`,
    };
  }
  const key = typeof volume === 'string' && presets?.[volume] ? volume : 'typical';
  const preset = presets?.[key];
  if (!preset) return null;
  return {
    tokens_in_month: preset.tokens_in_month,
    tokens_out_month: preset.tokens_out_month,
    assumption: `"${key}" usage: ${fmtTokens(preset.tokens_in_month)} in / ${fmtTokens(preset.tokens_out_month)} out tokens per month — ${preset.rationale}`,
  };
}
export function monthlyCost(model, vol) {
  if (!vol || !num(model.price_input) || !num(model.price_output)) return null;
  return round2((vol.tokens_in_month / 1e6) * model.price_input + (vol.tokens_out_month / 1e6) * model.price_output);
}

// -----------------------------------------------------------------------------------------
// Seat-plan alternative — only ever set from a real, priced plans.json row whose own
// `includes` text names this model. Never a guessed price.
// -----------------------------------------------------------------------------------------
export function findSeatPlanAlternative(model, have, plans) {
  const list = (Array.isArray(have) ? have : []).map((h) => String(h || '').toLowerCase());
  const vendorKey = Object.keys(VENDOR_KEY_DISPLAY).find((k) => list.includes(k) && VENDOR_KEY_DISPLAY[k] === model.vendor);
  if (!vendorKey) return null;
  const display = VENDOR_KEY_DISPLAY[vendorKey];
  const nameNorm = String(model.name || '').toLowerCase();
  if (!nameNorm) return null;
  const hits = (plans || []).filter((p) => p.vendor === display && num(p.price_usd_month) && String(p.includes || '').toLowerCase().includes(nameNorm));
  if (!hits.length) return null;
  const cheapest = hits.reduce((a, b) => (b.price_usd_month < a.price_usd_month ? b : a));
  return { plan: cheapest.plan, price_usd_month: cheapest.price_usd_month };
}

// -----------------------------------------------------------------------------------------
// Candidate filtering (rules 1-3) and domination pruning
// -----------------------------------------------------------------------------------------
export function filterCandidates(taskId, input, data) {
  const vol = resolveVolume(input.volume, data.presets);
  const candidates = [];
  for (const model of data.models || []) {
    if (!isReachable(model, input.have)) continue;
    const dr = passesDataRule(model, input.dataRule, data.vendors);
    if (!dr.ok) continue;
    const fit = taskFitFor(model, taskId);
    if (fit.score == null) continue; // rule 3: no basis at all = never recommended
    candidates.push({
      model,
      fit: fit.score,
      fit_basis: fit.basis,
      monthly_cost_usd: monthlyCost(model, vol),
      seat_plan_alternative: findSeatPlanAlternative(model, input.have, data.plans),
      unknownCountryVendor: dr.unknownCountry ? model.vendor : null,
    });
  }
  return { candidates, vol };
}

/** Drop any candidate strictly dominated by a cheaper-or-equal, at-least-as-fit candidate —
 * guarantees the eventual shortlist never contains a pricier model with a lower (or equal)
 * fit than a cheaper one. Candidates with an unknown cost can't be compared either way, so
 * they're never dropped by this step. */
export function dropDominated(list) {
  return list.filter((x) => !list.some((y) => {
    if (y === x || !num(x.monthly_cost_usd) || !num(y.monthly_cost_usd)) return false;
    const cheaperOrEqual = y.monthly_cost_usd <= x.monthly_cost_usd;
    const atLeastAsFit = y.fit >= x.fit;
    const strictlyBetter = y.monthly_cost_usd < x.monthly_cost_usd || y.fit > x.fit;
    return cheaperOrEqual && atLeastAsFit && strictlyBetter;
  }));
}

// -----------------------------------------------------------------------------------------
// Rule 4 — rank by stance, ties -> cheaper
// -----------------------------------------------------------------------------------------
const costOrInf = (x) => (num(x.monthly_cost_usd) ? x.monthly_cost_usd : Infinity);

export function rankByStance(list, stance) {
  const arr = [...list];
  if (stance === 'cheapest') {
    arr.sort((a, b) => costOrInf(a) - costOrInf(b) || b.fit - a.fit);
    return arr;
  }
  if (stance === 'best') {
    arr.sort((a, b) => b.fit - a.fit || costOrInf(a) - costOrInf(b));
    return arr;
  }
  // 'balanced' (default): a 50/50 blend of normalized fit and normalized cheapness, same
  // min-max / log-price style as scripts/derive-task-fit.mjs and the site's own app.js.
  const fits = list.map((x) => x.fit);
  const minF = Math.min(...fits), maxF = Math.max(...fits);
  const fitNorm = (f) => (maxF === minF ? 0.5 : (f - minF) / (maxF - minF));
  const knownCosts = list.map((x) => x.monthly_cost_usd).filter(num).map((c) => Math.log(Math.max(c, 1e-9)));
  const minC = knownCosts.length ? Math.min(...knownCosts) : 0;
  const maxC = knownCosts.length ? Math.max(...knownCosts) : 0;
  const cheapNorm = (c) => {
    if (!num(c)) return 0; // unknown cost never helps a balanced ranking, never hurts either
    if (maxC === minC) return 0.5;
    return 1 - (Math.log(Math.max(c, 1e-9)) - minC) / (maxC - minC);
  };
  const blended = (x) => 0.5 * fitNorm(x.fit) + 0.5 * cheapNorm(x.monthly_cost_usd);
  arr.sort((a, b) => blended(b) - blended(a) || costOrInf(a) - costOrInf(b));
  return arr;
}

// -----------------------------------------------------------------------------------------
// Tagging — one of 'cheapest-that-clears' | 'strongest' | 'best-per-dollar' | 'in-your-kit'
// per shortlist item. Purely descriptive (v1 heuristic): the cheapest item in the shortlist
// always reads 'cheapest-that-clears', the highest-fit item always reads 'strongest', a model
// whose vendor the caller already has directly reads 'in-your-kit' when neither of those
// applies, and everything else reads 'best-per-dollar'.
// -----------------------------------------------------------------------------------------
function tagFor(item, shortlist, have) {
  const cheapest = shortlist.reduce((a, b) => (costOrInf(b) < costOrInf(a) ? b : a));
  const strongest = shortlist.reduce((a, b) => (b.fit > a.fit ? b : a));
  if (item === cheapest) return 'cheapest-that-clears';
  if (item === strongest) return 'strongest';
  const list = (Array.isArray(have) ? have : []).map((h) => String(h || '').toLowerCase());
  if (Object.keys(VENDOR_KEY_DISPLAY).some((k) => list.includes(k) && VENDOR_KEY_DISPLAY[k] === item.model.vendor)) return 'in-your-kit';
  return 'best-per-dollar';
}

// -----------------------------------------------------------------------------------------
// decide()
// -----------------------------------------------------------------------------------------
export function decide(input, data) {
  const have = Array.isArray(input?.have) ? input.have : [];
  const stance = STANCES.includes(input?.stance) ? input.stance : 'balanced';
  const tasks = {};
  for (const taskId of input?.tasks || []) {
    const { candidates, vol } = filterCandidates(taskId, { ...input, stance }, data);
    const pruned = dropDominated(candidates);
    const ranked = rankByStance(pruned, stance);
    const top = ranked.slice(0, 3);

    const shortlist = top.map((item, idx) => ({
      id: item.model.id,
      name: item.model.name,
      tag: tagFor(item, top, have),
      why: buildWhy(item.model, item.fit_basis),
      monthly_cost_usd: item.monthly_cost_usd,
      fit: item.fit,
      fit_basis: item.fit_basis,
      start_here: idx === 0,
      seat_plan_alternative: item.seat_plan_alternative,
    }));

    const assumptions = [];
    if (vol?.assumption) assumptions.push(vol.assumption);
    const unknownVendors = [...new Set(candidates.map((c) => c.unknownCountryVendor).filter(Boolean))];
    for (const v of unknownVendors) {
      assumptions.push(`"${v}"'s headquarters country isn't confirmed in data/vendors.json — kept under the no-China-hosted filter since "unknown" is never treated as a match; verify independently if this matters.`);
    }
    if (taskId === 'vision') {
      assumptions.push('Vision fit is a yes/no tag match (no graded multimodal score exists in the data) — every vision-tagged model scores the same, and ties break on price.');
    }
    if (!candidates.length) {
      assumptions.push('No model in the catalog clears every filter (reachability, data rule, task floor) for this task with the given inputs.');
    }

    tasks[taskId] = { shortlist, assumptions };
  }
  return { tasks };
}
