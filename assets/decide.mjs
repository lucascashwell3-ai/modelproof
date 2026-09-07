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
                                       (VENDOR_KEY_DISPLAY, mirroring scripts/naming.mjs's
                                       canonical spelling). A vendor sells its own models
                                       through its own API by definition, so no availability
                                       flag can veto that — model.availability.direct_api is a
                                       sourced fact about whether the pipeline found that
                                       vendor's own pricing-page URL (see
                                       scripts/derive-availability.mjs), not about whether the
                                       model is reachable, and treating an unsourced direct_api
                                       as "unreachable" wrongly hid a vendor's own brand-new
                                       model before that page got indexed (fixed 2026-09-06 —
                                       e.g. claude-fable-5-1, gpt-6-astra, gpt-6-astra-pro,
                                       gemini-3-8-flash, grok-4-6, all real/sellable/direct_api:
                                       null). direct_api stays a supporting signal only for a
                                       model of some OTHER vendor that the chosen vendor
                                       resells (e.g. a marketplace reselling a third party's
                                       model) — no such cross-vendor field exists in this data
                                       yet, so today this case never fires; add it back here if
                                       that data ever lands.
       A model passes step 1 if ANY key in `have` clears it (the array is "everything you
       have", not "all of these at once").
   2. Data rule — dataRule.noChinaHosted drops any model whose vendor's data/vendors.json
      country is exactly "China". A vendor with no country on file is KEPT (unknown is never
      treated as a match) and the caller is told so in that task's assumptions[].
   3. Capability floor — THE JUDGMENT IS THE GATE (rewritten 2026-09-07; see the PR this
      shipped in for why). A model needs a real, sourced judged band for THIS task
      (model.task_fit_judged[taskId], scripts/refresh-judge.md) to be a candidate at all —
      "strong" or "capable" clears the floor, "weak" or no record at all ("unknown") doesn't,
      full stop. A high quantitative score with no judged record NEVER creates a candidate on
      its own any more — that was the exact bug that let a 0.16%-usage-share preview SKU
      ("Gemini 3.1 Pro (Preview)", rank 53 of ~380 on OpenRouter) top "research" purely because
      its GPQA was high: the brain was asking for judgment only on the models that HAD no
      number, so a number alone could always win. Quantitative fit (model.task_fit[taskId].score)
      still matters — see rule 4 — but only as a tie-breaker among models a judged record already
      cleared, never as a way to skip judgment. taskFitFor() still computes the numeric `fit`
      shown alongside a pick (real score when sourced, else the flat JUDGED_BAND_SCORE constant),
      but judgedBandOf() — not taskFitFor() — decides who's even in the running. Every shortlist
      item carries `basis: 'reported' | 'lab-stated'` (see basisFromClaims()) so the caller always
      knows whether at least one backing claim names an independent third party, plus the model's
      own `status` ('ga'|'preview'|'deprecated') and `adoption` ('broad'|'moderate'|'low'|'unknown',
      from usage.openrouter.share — scripts/derive-status-adoption.mjs) and its top claim's own
      sentence as `why`.
   4. Rank by judged band (strong > capable), then confidence (high > medium > low), then the
      chosen stance's cost/fit comparator, ties -> cheaper (see rankByStance) — band and
      confidence come first for every stance, "cheapest" included: a cheaper but lower-judged or
      less-confident pick never outranks a better-judged one, it only wins the tie-break inside
      the same (band, confidence) tier. Before ranking, any model strictly dominated by a
      cheaper-or-equal, at-least-as-fit model already in the candidate set is dropped
      (dropDominated) — so the returned shortlist can never contain a pricier model that isn't at
      least justified by a higher fit than every cheaper option.
      Two more rules decide which survivor gets `start_here: true` (see isDisqualifiedFromStartHere):
        - a `status: 'preview'` model is never start_here under stance 'best', or on an
          "enterprise-style" input (isEnterpriseInput: a single named vendor + volume 'heavy',
          or any truthy dataRule key) — it can still place lower in the shortlist, labelled preview.
        - an `adoption: 'low'` model is never start_here while a 'broad' or 'moderate'-adoption
          model of the SAME judged band is also a candidate — a benchmark win doesn't buy the top
          spot away from a model people are actually already running, in the same tier of judged
          quality.
      Neither rule removes a model from the shortlist — it only decides which of the top 3 gets
      the start_here flag; a disqualified model that still ranks in the top 3 stays there, just
      not first.
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
    // A vendor's own models are reachable through that vendor's own API by definition — no
    // availability.direct_api check here (see the rule-1 comment in the file header for why).
    if (list.includes(key) && model.vendor === VENDOR_KEY_DISPLAY[key]) via.push(key);
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
// A judged band stands in for a score only when it actually clears the floor. "weak"/"unknown"
// are real judged outcomes too (the Judge looked and found thin/negative evidence) — they must
// never be silently promoted to a passing score. The two numbers below are v1's only invented
// constants in this whole file: a deliberate mid-table placement (well above "weak", well below
// most sourced coding_score leaders) so a judged model can rank sensibly next to measured ones
// without a bare qualitative band ever reading as equivalent to a benchmarked 95.
export const JUDGED_BAND_SCORE = { strong: 88, capable: 68, weak: null, unknown: null };

/** 'reported' when at least one claim backing the band names a third party (reported/measured/
 * usage tier); 'lab-stated' when every claim is the vendor's own — see task_fit_judged's `tier`
 * field (scripts/refresh-judge.md). */
export function basisFromClaims(claims) {
  return (claims || []).some((c) => c && c.tier && c.tier !== 'lab') ? 'reported' : 'lab-stated';
}

/** THE gate for rule 3 (see the file header): { band, confidence, judged: record|null }. Looks at
 * model.task_fit_judged[taskId] ONLY — a quantitative task_fit score, however high, is never
 * consulted here, so it can never manufacture a candidate on its own. No record on file reads the
 * same as an explicit "unknown" band: both fail the floor. This is deliberately a different
 * question from taskFitFor() below (which still answers "what number do we show", preferring a
 * real score when one exists) — judgedBandOf answers "is this model even in the running", and
 * only a human/agent judgment call can answer that now. */
export function judgedBandOf(model, taskId) {
  const rec = model.task_fit_judged?.[taskId];
  if (!rec || !rec.band) return { band: 'unknown', confidence: null, judged: null };
  return { band: rec.band, confidence: rec.confidence ?? null, judged: rec };
}
const BAND_RANK = { strong: 3, capable: 2, weak: 1, unknown: 0 };
const CONFIDENCE_RANK = { high: 3, medium: 2, low: 1 };
export const bandRank = (band) => BAND_RANK[band] ?? 0;
export const confidenceRank = (confidence) => CONFIDENCE_RANK[confidence] ?? 0;

/** { score, basis, reason?, source: 'measured'|'reported'|'lab-stated', judged: record|null } —
 * quantitative fit wins whenever it's sourced; a judged record only ever fills a gap, never
 * overrides a real number. */
export function taskFitFor(model, taskId) {
  const quant = model.task_fit?.[taskId];
  if (quant && quant.score != null) return { score: quant.score, basis: quant.basis || [], source: 'measured', judged: null };
  const judged = model.task_fit_judged?.[taskId];
  const bandScore = judged ? JUDGED_BAND_SCORE[judged.band] : null;
  if (judged && bandScore != null) {
    return { score: bandScore, basis: [], source: basisFromClaims(judged.claims), judged };
  }
  if (quant) return { score: null, basis: quant.basis || [], reason: quant.reason, source: 'measured', judged: null };
  return { score: null, basis: [], reason: `task "${taskId}" is not in this model's task_fit`, source: 'measured', judged: null };
}

/** `why` text for a judged-fit shortlist item — deliberately generic (never echoes a claim's own
 * wording), so it can never accidentally mention a WHY_FIELDS phrase (GPQA, context, etc.) that
 * isn't in fit_basis. The actual claims (sentence + source link) render separately — see
 * lab.html — this is just the one-line summary next to the pick. */
export function buildJudgedWhy(item) {
  const n = (item.claims || []).length;
  const band = item.judgedBand || 'unknown';
  const confidence = item.judgedConfidence || 'unknown';
  return `Judged ${band} fit (${confidence} confidence) from ${n} sourced claim${n === 1 ? '' : 's'}, not a benchmark score.`;
}

/** `why` for the new judgment-first shortlist: the record's own top claim sentence, verbatim —
 * the actual evidence a reader can check, not a generic restatement of the band. "Top" prefers
 * the first claim that ISN'T just a usage/popularity signal (a capability claim says more than
 * "people already use this"), falling back to the first claim of any tier if that's all there
 * is. Every judged record has at least one claim (validate-data.mjs requires a non-empty
 * claims[]), so this only ever returns the fallback string for a malformed/missing record. */
export function topClaimSentence(claims) {
  const list = Array.isArray(claims) ? claims : [];
  const top = list.find((c) => c && c.tier !== 'usage' && c.sentence) || list.find((c) => c && c.sentence);
  return top ? top.sentence : 'No sourced claim on file for this pick.';
}

// -----------------------------------------------------------------------------------------
// start_here eligibility — a model can win the shortlist without winning the TOP spot. Neither
// rule below drops a model from the shortlist; they only decide which of the top 3 gets
// `start_here: true` (see decide()'s reordering step).
// -----------------------------------------------------------------------------------------

/** "Enterprise-style" input, for the preview-status rule: a single named vendor at heavy volume
 * (a team standardizing on one vendor's paid tier, not shopping around), or any data rule turned
 * on (noChinaHosted today — a compliance-flavored ask). 'any'/'openrouter' don't count as "a
 * single vendor" — they're explicitly the opposite of standardizing on one vendor's own paid API. */
export function isEnterpriseInput(input) {
  const have = Array.isArray(input?.have) ? input.have : [];
  const singleNamedVendor = have.length === 1 && Object.keys(VENDOR_KEY_DISPLAY).includes(String(have[0] || '').toLowerCase());
  const heavyVolume = input?.volume === 'heavy';
  const dataRuleSet = !!input?.dataRule && Object.values(input.dataRule).some(Boolean);
  return (singleNamedVendor && heavyVolume) || dataRuleSet;
}

/** A `status: 'preview'` model never gets start_here under stance 'best' or an enterprise-style
 * input — a team explicitly asking for "the best" or standardizing on one vendor at scale
 * shouldn't be pointed at a SKU the vendor itself hasn't finished shipping. An `adoption: 'low'`
 * model never gets start_here while a 'broad'/'moderate'-adoption model of the SAME judged band
 * is also a candidate — a benchmark edge doesn't buy the top spot away from a model people are
 * actually already running, once judgment has already put both in the same tier of quality. */
export function isDisqualifiedFromStartHere(item, allCandidates, stance, input) {
  if (item.model.status === 'preview' && (stance === 'best' || isEnterpriseInput(input))) return true;
  if (item.model.adoption === 'low') {
    const betterAdoptionSameBand = (allCandidates || []).some((other) => (
      other !== item && other.band === item.band &&
      (other.model.adoption === 'broad' || other.model.adoption === 'moderate')
    ));
    if (betterAdoptionSameBand) return true;
  }
  return false;
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
    // Rule 3 — the judgment IS the gate (see the file header). A judged record for THIS task is
    // required to be a candidate at all; a quantitative score with no judged band never gets in
    // on its own any more.
    const { band, confidence, judged } = judgedBandOf(model, taskId);
    if (band !== 'strong' && band !== 'capable') continue;
    // taskFitFor still decides the NUMBER shown alongside the pick (a real score when sourced,
    // else the flat JUDGED_BAND_SCORE) — but never whether the model is here at all (that's
    // judgedBandOf, above). Claims/reconciliation always come from the judged record itself
    // (never from taskFitFor's `judged`, which is null on its 'measured' branch) so a model with
    // BOTH a real score and a judged record still shows the evidence that actually earned it a
    // place in the running.
    const fit = taskFitFor(model, taskId);
    candidates.push({
      model,
      band,
      confidence,
      // Guaranteed non-null in practice (taskFitFor always resolves a score once a strong/capable
      // judged record exists), but falls back to the band constant rather than ever sorting on a
      // NaN if that guarantee is ever violated by a future edit.
      fit: fit.score ?? JUDGED_BAND_SCORE[band],
      fit_basis: fit.basis,
      basis: basisFromClaims(judged.claims),
      claims: judged.claims,
      reconciliation: judged.reconciliation ?? null,
      judgedBand: band,
      judgedConfidence: confidence,
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
// Rule 4 — rank by judged band, then confidence, then the stance's cost/fit comparator
// -----------------------------------------------------------------------------------------
const costOrInf = (x) => (num(x.monthly_cost_usd) ? x.monthly_cost_usd : Infinity);

/** Band, then confidence — the primary sort key for EVERY stance (see the file header). Every
 * candidate reaching this function already cleared rule 3, so band is always 'strong' or
 * 'capable' here; this comparator still checks the general case rather than hard-coding those
 * two values, so it keeps working if a future band is ever added. */
const byBandThenConfidence = (a, b) => bandRank(b.band) - bandRank(a.band) || confidenceRank(b.confidence) - confidenceRank(a.confidence);

export function rankByStance(list, stance) {
  const arr = [...list];
  if (stance === 'cheapest') {
    arr.sort((a, b) => byBandThenConfidence(a, b) || costOrInf(a) - costOrInf(b) || b.fit - a.fit);
    return arr;
  }
  if (stance === 'best') {
    arr.sort((a, b) => byBandThenConfidence(a, b) || b.fit - a.fit || costOrInf(a) - costOrInf(b));
    return arr;
  }
  // 'balanced' (default): a 50/50 blend of normalized fit and normalized cheapness, same
  // min-max / log-price style as scripts/derive-task-fit.mjs and the site's own app.js — used to
  // break ties WITHIN a (band, confidence) tier, same as the other two stances.
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
  arr.sort((a, b) => byBandThenConfidence(a, b) || blended(b) - blended(a) || costOrInf(a) - costOrInf(b));
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

    // start_here eligibility (see isDisqualifiedFromStartHere / the file header): find the
    // first-ranked candidate that ISN'T disqualified and move it to the front, keeping everyone
    // else's relative order — a disqualified model still shows up in the top 3 if it ranks there,
    // it just doesn't get the start_here flag. If every candidate is disqualified there's no
    // alternative to prefer, so the normal #1 keeps start_here (a rule with nothing better to
    // point at doesn't block the only option).
    let startIdx = ranked.findIndex((item) => !isDisqualifiedFromStartHere(item, ranked, stance, input));
    if (startIdx === -1) startIdx = 0;
    const reordered = startIdx === 0 ? ranked : [ranked[startIdx], ...ranked.slice(0, startIdx), ...ranked.slice(startIdx + 1)];
    const top = reordered.slice(0, 3);

    const shortlist = top.map((item, idx) => ({
      id: item.model.id,
      name: item.model.name,
      tag: tagFor(item, top, have),
      why: topClaimSentence(item.claims),
      monthly_cost_usd: item.monthly_cost_usd,
      fit: item.fit,
      fit_basis: item.fit_basis,
      basis: item.basis,
      status: item.model.status ?? null,
      adoption: item.model.adoption ?? null,
      claims: item.claims,
      reconciliation: item.reconciliation,
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
      assumptions.push('No model in the catalog clears every filter (reachability, data rule, or the judged-fit floor) for this task with the given inputs — a real benchmark score alone is never enough; something has to have actually judged this model for this task.');
    }
    if (startIdx > 0) {
      const skipped = ranked[0];
      const reason = skipped.model.status === 'preview'
        ? 'it\'s still a preview release'
        : `its adoption is low while a broader-adoption model of the same judged band is also a candidate`;
      assumptions.push(`"${skipped.model.name}" ranked highest before the start_here check but wasn't set as start_here — ${reason}. It's still listed below if it placed in the top 3.`);
    }

    tasks[taskId] = { shortlist, assumptions };
  }
  return { tasks };
}
