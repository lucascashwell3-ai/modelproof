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
                   // task_fit_judged, signals, standings, status and adoption — see
                   // scripts/derive-task-fit.mjs, scripts/derive-standings.mjs,
                   // scripts/derive-signals.mjs, scripts/derive-status-adoption.mjs)
       plans,      // data/plans.json's `plans` array
       presets,    // data/usage-presets.json's `presets` object ({light, typical, heavy}) —
                   // resolveVolume() also tolerates the whole parsed file (with its _readme/
                   // as_of wrapper) being passed here by mistake; see unwrapPresets() below
       vendors,    // data/vendors.json's `vendors` array — a vendor -> country map for rule 2
                   // (the noChinaHosted data rule).
     }
   returns { tasks: { <taskId>: { shortlist: [...], assumptions: [...] } } }

   THE RANKING RULE (brain v2, step 3 — replaces the AI-judged "band" ranking entirely)
   -----------------------------------------------------------------------------------------
   The AI never ranks. A model's grade for a task is AGREEMENT across three kinds of evidence,
   kept separate, never averaged into one number:

     measured   independent tester standings (data/testers.json's registry, scripts/derive-
                standings.mjs) — a rank out of n on a named benchmark.
     chosen     real spend share on OpenRouter for that task.
     preferred  blind human-vote rank on arena.ai for that task.

   All three live in model.standings[taskId] (measured: [{tester, benchmark, rank, n_models,
   score, as_of, url, licence}], chosen: {rank, share, n_models, as_of, url, tags}|null,
   preferred: {rank, n_models, board, as_of, url}|null). A row's `licence` ("display-ok" or
   "signal-only" — "banned" never appears in this data) only gates whether a number may be
   shown; it never gates ranking — both licence classes count exactly the same here.

   POSITION — for each evidence kind, every model that HAS that kind of evidence for this task
   gets a position (1 = best) AMONG JUST THE CATALOG MODELS THAT HAVE IT, independent of what the
   caller can reach; `of` = how many catalog models have it.
     measured:   ordering key = median of (rank / n_models) across the model's own measured rows
                 for this task (lower is better) — ties broken by MORE tester rows winning, then
                 by the single lowest (best) rank across those rows, then by id.
     chosen:     ordering key = spend share, descending (re-derived from `share`, not trusted off
                 the stored `rank` — chosen.rank on a token-volume task like `bulk` is the raw
                 feed's own rank among the WHOLE tracked ecosystem, not "among catalog models
                 with chosen evidence"; re-ranking by share sidesteps that regardless of which
                 source produced the record) — ties broken by the stored rank, then id.
     preferred:  ordering key = the board rank, ascending — re-positioned among just the catalog
                 models present on that board (the stored rank is the model's TRUE position on
                 the full external board, most of which isn't in this catalog) — ties by id.
   `near top` for a kind = position <= max(3, min(10, ceil(of / 4))) — top-10 once enough catalog
   models carry that kind of evidence, top-quartile when fewer do, never below 3 (fixed 2026-09,
   round 2: the original max(10, ceil(0.25*of)) formula made EVERY model "near top" whenever
   of <= 10 — e.g. a frontend `chosen` position of 7 of 9 counted as near top, which is really
   "near the bottom of a small field").

   TASK THINNESS — parametric (THIS_RULE below, exported so a caller/report can experiment with
   the boundary — see scripts/eval-report.mjs's --thin-share flag): a task is thin when its
   measured-evidence count is below THIN_RULE.minTested, OR below THIN_RULE.minShareOfCatalog *
   the catalog's own size. The shipped default is `{ minTested: 8, minShareOfCatalog: 0 }` — the
   share clause is off by default, so the rule is exactly "fewer than 8" unless a caller overrides
   it via input.thin_rule (today: chat, frontend, vision, bulk are thin under the default;
   agents, at 12, is not). Thin tasks never gate on measured at all; the tiers below just skip
   straight to the two human kinds.

   TIERS (a LOWER tier number is always better; `tier` is a plain number, `tier_name` a string,
   both returned per shortlist item; `label` is the reader-facing caveat, or null on tiers that
   carry none). "early" (see NEW-MODEL OVERRIDE below) is its own numbered tier in non-thin and
   thin-dual (fixed 2026-09, round 2) — it sits directly below the best tier(s) and above the tier
   it would otherwise have landed in — but does NOT exist in thin-single (fixed 2026-09, round 3 —
   see NEW-MODEL OVERRIDE for why):

   Non-thin task — a waterfall on (measured present?, measured near top?, any human kind near
   top?, is this model new?); every one of these six REQUIRES at least one kind of evidence
   present (an "untested" model with none at all is excluded before tiering ever runs — see
   filterCandidates):
     T1 "agreed"                    measured near top AND >=1 human kind near top.
     T2 "early"                     measured near top, no human kind near top, adoption: 'new'.
                                     Label: "early: too new for usage data".
     T3 "tests-only"                measured near top, no human kind near top, NOT new.
                                     Label: "strong on tests, low real-world use".
     T4 "tested, people-backed"     measured present, not near top, AND >=1 human kind near top.
     T5 "tested"                    measured present, not near top, no human kind near top.
     T6 "not independently tested"  measured ABSENT (any evidence level from chosen/preferred —
                                     near top or not; a model with a human kind near top simply
                                     sorts ahead of one without, via the within-tier order below,
                                     rather than needing its own numbered tier). Label: "not
                                     independently tested".
   T2/T3 both never start_here while any T1 candidate exists for this task (see
   isDisqualifiedFromStartHere). The six bullets above cover every combination the spec calls out
   by name; the one combination the spec's prose doesn't spell out (measured absent, some human
   evidence present, none of it near top) is folded into T6 rather than invented as an unnamed T7
   — it's still "not independently tested", it just sorts to the back of that tier via
   kindsNearTopCount (see withinTierCompare). This is a deliberate implementation choice at an
   edge the six named tiers don't fully partition; the invariant it satisfies is "any evidence at
   all is a candidate."

   Thin task, BOTH human kinds exist anywhere in the catalog for this task (chat, frontend):
     T1  chosen near top AND preferred near top.               Label: "not independently tested".
     T2  exactly one human kind near top, adoption: 'new'.     Label: "early: too new for usage
                                                                data".
     T3  exactly one human kind near top, NOT new.
     T4  evidenced, neither human kind near top.
   (tier_name: "human-agreed" / "early" / "one-signal" / "evidenced" — this file's own naming for
   T1/T3/T4; the spec only names T1's label, not a quoted tier_name, for the thin schemes.)

   Thin task, only ONE human kind exists anywhere in the catalog (vision: no chosen; bulk: no
   preferred) — NO "early" tier (see NEW-MODEL OVERRIDE):
     T1  that one kind near top.                                Label: "one signal only".
     T2  evidenced, not near top (adoption plays no role here at all any more).
   (tier_name: "single-signal" / "evidenced".)

   NEW-MODEL OVERRIDE — a model with `adoption === 'new'` (released <=60 days ago,
   scripts/derive-status-adoption.mjs) that is near the top on AT LEAST ONE kind but would
   otherwise land in the "near-top-on-one-kind-but-no-OTHER-backing" tier (non-thin's tests-only,
   thin-dual's one-signal) gets its OWN tier instead — "early", one slot better than where it
   would have landed — rather than being read as "only tests well" when the real reason is "too
   recent for usage/votes to have accumulated at all". Fixed 2026-09, round 3: round 2 also
   applied this to thin-single (any new+not-near-top model, regardless of HOW far from the top it
   was), which was wrong — "early" was meant to reward a genuine near-miss, not excuse a brand-new
   model that isn't close to the top on anything (e.g. a bulk model at chosen position 36 of 63
   read as "early" purely for being new — S13/S11 in the eval situations). thin-single has no
   intermediate near-miss state to carve "early" out of at all: "near top on the only kind" (T1)
   is already the most lenient bar that scheme has, so a new-but-not-near-top model there is
   simply T2 "evidenced", exactly like a non-new one — round 3 removes "early" from thin-single
   entirely rather than trying to patch its trigger condition.

   NEGATIVE CLAIMS — if a model.task_fit_judged[taskId].claims[] entry carries an explicit
   `polarity: 'negative'` marker (a field this pass ADDS support for; no claim in the data carries
   it yet — see hasNegativeClaim), the model drops one tier, clamped at the worst tier for that
   task's scheme, recomputed via the standard tier_name/label table for wherever it lands. The one
   guard: a demotion never LANDS a model on the "early" tier unless that model is itself
   adoption:'new' — "early" is a factual claim about the model's own age, never a generic "one
   notch down from the top" bucket, so a demoted-but-not-new model skips past it to the next tier
   down instead. `why`/`claims`/`reconciliation` are untouched; only the ranking bucket moves.

   `band` and `confidence` (the old AI-judged fields) have ZERO ranking authority any more — see
   scripts/refresh-judge.md for what still writes them (informational claims text only, via
   basisFromClaims/topClaimSentence below).

   ORDER WITHIN A TIER (best stance first): count of kinds near top (desc) -> measured position
   (asc, absent = worst) -> best human position (asc, absent = worst) -> GA before preview ->
   more tester rows -> cheaper -> id. See withinTierCompare/standardCompare.

   STANCES
     'best'     the order above, full stop.
     'balanced' find the cheapest priced candidate in the top tier PRESENT among the NON-"early"
                candidates (fixed 2026-09, round 2 — a brand-new cheap model must never set the
                budget floor just by existing); every candidate (any tier, "early" included) priced
                at or under 2x that reference cost is "in budget" and ranked first (by the order
                above); everyone else is ranked after (also by the order above) — never dropped,
                just deprioritized. No non-"early" candidate at all, or none of them priced ->
                behaves exactly like 'best'.
     'cheapest' cost-primary, but only among "qualifying" candidates — a tier counts as qualifying
                when it has (or stands in for — "early" counts) at least one kind of evidence near
                the top: tier <= 4 for a non-thin task, tier <= 3 for thin-dual, tier <= 2 for
                thin-single (fixed 2026-09, round 2 — thin-single previously let its OWN worst tier,
                "evidenced, not near top", qualify, which is exactly backwards: that tier is the one
                case in that scheme with NOTHING near top). Ties fall back to the order above. No
                qualifying candidate at all -> falls back to cost-primary among EVERY candidate.
                Non-qualifying candidates are still returned, ranked after by the order above,
                never dropped.
   'cheapest' never demotes a preview model at start_here (this stance stays cost-primary,
   period); every other stance keeps a status:'preview' item from outranking a GA/deprecated one
   in the SAME final tier, and a preview candidate is fully excluded from an enterprise-style
   input's candidate pool at rule 3 below (isEnterpriseInput), not merely demoted.

   Rule order before any of the above:
   1. Reachability — drop any model the caller cannot actually reach with `have` (unchanged from
      v1: 'any' clears everyone; 'openrouter' needs availability.openrouter === true; a named
      vendor key always reaches that vendor's own models, since a vendor sells its own models
      through its own API by definition).
   2. Data rule — dataRule.noChinaHosted drops any model whose vendor's data/vendors.json country
      is exactly "China" (unknown is never treated as a match; the caller is told so).
   3. Enterprise exclusion — an enterprise-style input (isEnterpriseInput) drops every
      status:'preview' model ENTIRELY, not just from start_here.
   4. Evidence gate — a model with NO measured/chosen/preferred evidence at all for this task is
      "untested" and is not a candidate, full stop; a plain assumption line says so when this
      empties a task's whole candidate pool.
   Only the top 3 survivors (after tiering + the chosen stance's order) are returned; item 0 is
   always start_here: true, UNLESS the top-ranked item is disqualified (see
   isDisqualifiedFromStartHere): an "early" or (non-thin only) "tests-only" item never starts
   while a T1 item is also a candidate, and (except under 'cheapest') a preview item never starts
   while a same-tier GA/deprecated item is also a candidate. Disqualification only ever changes
   which item gets start_here — it never drops a model from the returned shortlist.

   Kept unchanged from v1 (still exactly what the file header used to say): reachability rule 1's
   direct_api carve-out, the data rule's unknown-country handling, isEnterpriseInput's heuristic,
   basisFromClaims/topClaimSentence for the claims text a pick shows, findSeatPlanAlternative,
   monthlyCost/resolveVolume/unwrapPresets, and the vision-fit assumption line.
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
// why-text registry — the ONLY fields a `why` string is allowed to mention, used as the
// fallback why-text when a model has no task_fit_judged record for this task (its quantitative
// task_fit.basis[] still gets an honest sentence instead of nothing). Every task's basis[]
// (written by scripts/derive-task-fit.mjs) is drawn from this exact key set, so a `why` built
// only from these templates can never mention a field outside fit_basis. scripts/test-decide.mjs
// imports both this and derive-task-fit.mjs's BASIS_TOKENS to assert the two lists match.
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
    // availability.direct_api check here (see the file header for why).
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
// basis/claims text — unchanged from v1: still how a pick's `why`/`basis`/`claims` are built,
// just no longer a ranking gate (see the file header — evidence, not judgment, gates now).
// -----------------------------------------------------------------------------------------

/** 'reported' when at least one claim backing a judged record names a third party (reported/
 * measured/usage tier); 'lab-stated' when every claim is the vendor's own — see task_fit_judged's
 * `tier` field (scripts/refresh-judge.md). */
export function basisFromClaims(claims) {
  return (claims || []).some((c) => c && c.tier && c.tier !== 'lab') ? 'reported' : 'lab-stated';
}

/** `why` text for a judgment-backed pick: the record's own top claim sentence, verbatim — the
 * actual evidence a reader can check, not a generic restatement. "Top" prefers the first claim
 * that ISN'T just a usage/popularity signal (a capability claim says more than "people already
 * use this"), falling back to the first claim of any tier if that's all there is. */
export function topClaimSentence(claims) {
  const list = Array.isArray(claims) ? claims : [];
  const top = list.find((c) => c && c.tier !== 'usage' && c.sentence) || list.find((c) => c && c.sentence);
  return top ? top.sentence : 'No sourced claim on file for this pick.';
}

/** True when this model's task_fit_judged record for this task carries at least one claim
 * explicitly marked `polarity: 'negative'` — an optional field this pass adds SUPPORT for (no
 * claim in data/models.json carries it yet; see the file header). A model with such a claim drops
 * one tier — see classifyModelForTask. */
export function hasNegativeClaim(model, taskId) {
  const claims = model.task_fit_judged?.[taskId]?.claims;
  return Array.isArray(claims) && claims.some((c) => c && c.polarity === 'negative');
}

// -----------------------------------------------------------------------------------------
// Enterprise-style input detection (used by rule 3 — full preview exclusion — and by
// isDisqualifiedFromStartHere's GA-before-preview check indirectly through filterCandidates).
// -----------------------------------------------------------------------------------------

/** "Enterprise-style" input: EXPLICIT input.enterprise (true/false) wins outright when the
 * caller states it. Only when the caller doesn't say does this fall back to the heuristic: a
 * single named vendor at heavy volume (a team standardizing on one vendor's paid tier, not
 * shopping around), or any data rule turned on (noChinaHosted today — a compliance-flavored
 * ask). 'any'/'openrouter' don't count as "a single vendor". */
export function isEnterpriseInput(input) {
  if (input?.enterprise === true) return true;
  if (input?.enterprise === false) return false;
  const have = Array.isArray(input?.have) ? input.have : [];
  const singleNamedVendor = have.length === 1 && Object.keys(VENDOR_KEY_DISPLAY).includes(String(have[0] || '').toLowerCase());
  const heavyVolume = input?.volume === 'heavy';
  const dataRuleSet = !!input?.dataRule && Object.values(input.dataRule).some(Boolean);
  return (singleNamedVendor && heavyVolume) || dataRuleSet;
}

// -----------------------------------------------------------------------------------------
// Cost — unchanged from v1.
// -----------------------------------------------------------------------------------------
// Defensive unwrap: every real caller (lab.html, scripts/test-*.mjs) already passes
// data/usage-presets.json's `presets` sub-object as `data.presets`, per this file's own header
// contract — but a caller that instead hands over the WHOLE parsed file (with its _readme/as_of
// wrapper) silently gets `presets?.[key]` === undefined for every key, which makes monthlyCost()
// return null for every model with no error anywhere to catch it. The three named bands
// (light/typical/heavy) never collide with the wrapper's own keys, so unwrapping is unambiguous
// and a no-op for every caller already doing it right.
function unwrapPresets(presets) {
  if (presets && typeof presets === 'object' && !presets.light && !presets.typical && !presets.heavy
    && presets.presets && typeof presets.presets === 'object') {
    return presets.presets;
  }
  return presets;
}
export function resolveVolume(volume, presetsIn) {
  if (volume && typeof volume === 'object' && num(volume.tokens_in_month) && num(volume.tokens_out_month)) {
    return {
      tokens_in_month: volume.tokens_in_month,
      tokens_out_month: volume.tokens_out_month,
      assumption: `Custom usage: ${fmtTokens(volume.tokens_in_month)} in / ${fmtTokens(volume.tokens_out_month)} out tokens per month, as given.`,
    };
  }
  const presets = unwrapPresets(presetsIn);
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
// Seat-plan alternative — unchanged from v1: only ever set from a real, priced plans.json row
// whose own `includes` text names this model. Never a guessed price.
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
// Evidence positions — see the file header for the exact ordering key per kind and the "near
// top" threshold. Every function here is pure, computed once per (taskId, whole catalog) — not
// per candidate — since a model's position never depends on what the caller has access to.
// -----------------------------------------------------------------------------------------

function median(sortedInputArr) {
  const a = [...sortedInputArr].sort((x, y) => x - y);
  const n = a.length;
  if (!n) return null;
  const mid = Math.floor(n / 2);
  return n % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

/** "Near the top" for a kind with `of` catalog models carrying it — top-10 once `of` is large
 * enough that a quarter of it exceeds 10, top-quartile (rounded up) when `of` is smaller, and
 * never below 3 even for a tiny field. Fixed 2026-09 (round 2): the original max(10, ceil(of/4))
 * made EVERY position "near top" whenever of <= 10 (max(10, anything <= 10) is always 10), which
 * silently treated "7th of 9" as near the top. `of` <= 0 trivially returns 3, but no position can
 * ever qualify against it since no model has that kind of evidence at all in that case. */
export function nearTopThreshold(of) {
  return Math.max(3, Math.min(10, Math.ceil((of || 0) / 4)));
}

/** Every catalog model with >=1 measured row for this task, positioned 1..of among just those
 * models. Ordering key: median of (rank/n_models) across the model's own rows (lower/better) ->
 * more tester rows wins a tie -> lower single best rank -> id. Returns Map<modelId, {position,
 * of, rows, best}>; `best` is the one row (tester/benchmark/rank/n_models/url/as_of) with the
 * best rank/n_models ratio (ties -> lowest rank). Pure — reads only model.standings[taskId]. */
export function measuredIndexForTask(taskId, models) {
  const rows = [];
  for (const m of models || []) {
    const measured = m.standings?.[taskId]?.measured || [];
    const ratios = measured
      .map((r) => (num(r.rank) && num(r.n_models) && r.n_models > 0 ? r.rank / r.n_models : null))
      .filter((v) => v != null);
    if (!ratios.length) continue;
    let bestRow = null, bestRatio = Infinity;
    for (const r of measured) {
      const ratio = num(r.rank) && num(r.n_models) && r.n_models > 0 ? r.rank / r.n_models : Infinity;
      if (ratio < bestRatio || (ratio === bestRatio && bestRow && (r.rank ?? Infinity) < (bestRow.rank ?? Infinity))) {
        bestRow = r; bestRatio = ratio;
      }
    }
    const bestRank = Math.min(...measured.map((r) => (num(r.rank) ? r.rank : Infinity)));
    rows.push({ id: m.id, key: median(ratios), rowsCount: measured.length, bestRank, bestRow });
  }
  rows.sort((a, b) => (a.key - b.key) || (b.rowsCount - a.rowsCount) || (a.bestRank - b.bestRank) || String(a.id).localeCompare(String(b.id)));
  const of = rows.length;
  const out = new Map();
  rows.forEach((r, i) => out.set(r.id, {
    position: i + 1, of, rows: r.rowsCount,
    best: r.bestRow ? {
      tester: r.bestRow.tester, benchmark: r.bestRow.benchmark, rank: r.bestRow.rank,
      n_models: r.bestRow.n_models, url: r.bestRow.url, as_of: r.bestRow.as_of,
    } : null,
  }));
  return out;
}

/** Every catalog model with a `chosen` record for this task, positioned 1..of among just those
 * models by spend share descending (re-derived from `share`, never trusted off the stored
 * `rank` — see the file header for why a stored rank can be the feed's own, uncatalog-scoped
 * rank). Ties -> the stored rank -> id. Returns Map<modelId, {position, of, rank, share, url}>. */
export function chosenIndexForTask(taskId, models) {
  const rows = [];
  for (const m of models || []) {
    const c = m.standings?.[taskId]?.chosen;
    if (!c) continue;
    rows.push({ id: m.id, share: num(c.share) ? c.share : null, rank: num(c.rank) ? c.rank : null, raw: c });
  }
  rows.sort((a, b) => {
    const as = a.share ?? -Infinity, bs = b.share ?? -Infinity;
    if (as !== bs) return bs - as;
    const ar = a.rank ?? Infinity, br = b.rank ?? Infinity;
    if (ar !== br) return ar - br;
    return String(a.id).localeCompare(String(b.id));
  });
  const of = rows.length;
  const out = new Map();
  rows.forEach((r, i) => out.set(r.id, { position: i + 1, of, rank: r.raw.rank ?? null, share: r.raw.share ?? null, url: r.raw.url ?? null }));
  return out;
}

/** Every catalog model with a `preferred` record for this task, RE-POSITIONED 1..of among just
 * those models by the stored board rank ascending (the stored rank is the model's true position
 * on the full external board, which is mostly not-this-catalog). Ties -> id. Returns
 * Map<modelId, {position, of, rank, board, url}>. */
export function preferredIndexForTask(taskId, models) {
  const rows = [];
  for (const m of models || []) {
    const p = m.standings?.[taskId]?.preferred;
    if (!p) continue;
    rows.push({ id: m.id, rank: num(p.rank) ? p.rank : Infinity, raw: p });
  }
  rows.sort((a, b) => (a.rank - b.rank) || String(a.id).localeCompare(String(b.id)));
  const of = rows.length;
  const out = new Map();
  rows.forEach((r, i) => out.set(r.id, { position: i + 1, of, rank: r.raw.rank ?? null, board: r.raw.board ?? null, url: r.raw.url ?? null }));
  return out;
}

/** A task is THIN when its measured-evidence count is below THIN_RULE.minTested, OR below
 * THIN_RULE.minShareOfCatalog * the catalog's own size — parametric (round 2) so a caller can
 * experiment with the boundary (scripts/eval-report.mjs's --thin-share flag) without touching the
 * shipped default, which is exactly "fewer than 8" (the share clause is off by default: 0 *
 * anything is 0, so no catalog size ever fails it on its own). Today, under the default: chat/
 * frontend/vision/bulk are thin (0 measured each), agents (12) is not. */
export const THIN_RULE = { minTested: 8, minShareOfCatalog: 0 };

/** One task's full evidence index — computed once per (taskId, catalog), not per candidate.
 * `humanKinds` is which of {chosen, preferred} exist AT ALL anywhere in the catalog for this
 * task (used only to pick which thin-task tier scheme applies — vision has no chosen, bulk has
 * no preferred, chat/frontend have both). `thinRule` overrides THIN_RULE for this one call — see
 * filterCandidates/decide's `input.thin_rule`. */
export function buildEvidenceIndex(taskId, models, thinRule = THIN_RULE) {
  const measured = measuredIndexForTask(taskId, models);
  const chosen = chosenIndexForTask(taskId, models);
  const preferred = preferredIndexForTask(taskId, models);
  const rule = thinRule || THIN_RULE;
  const catalogSize = (models || []).length;
  const thin = measured.size < rule.minTested || measured.size < rule.minShareOfCatalog * catalogSize;
  const humanKinds = new Set();
  if (chosen.size) humanKinds.add('chosen');
  if (preferred.size) humanKinds.add('preferred');
  return { measured, chosen, preferred, thin, humanKinds };
}

// -----------------------------------------------------------------------------------------
// Tiers — see the file header for the full rationale and the exact waterfall/labels. "early" is
// tier 2 in non-thin and thin-dual (round 2) — a real numbered tier, not an overlay on T1. It does
// NOT exist in thin-single (round 3 fix — see baseTierNumber's own comment for why).
// -----------------------------------------------------------------------------------------
export const MAX_TIER = { nonThin: 6, thinDual: 4, thinSingle: 2 };

export function schemeFor(index) {
  if (!index.thin) return 'nonThin';
  return index.humanKinds.size >= 2 ? 'thinDual' : 'thinSingle';
}

// tier_name/label a model lands on before any negative-claim demotion — see classifyModelForTask.
// The prose in "" for non-thin tier names/labels are the spec's own wording; the thin schemes'
// tier_names are this file's own (the spec only quotes their labels, not tier names — see the
// file header). "early"'s tier_name/label are the same string in every scheme on purpose — it's
// the same fact (too new to have real-world signal yet) regardless of which scheme it's read in.
const EARLY_META = { tier_name: 'early', label: 'early: too new for usage data' };
const NON_THIN_TIER_META = {
  1: { tier_name: 'agreed', label: null },
  2: EARLY_META,
  3: { tier_name: 'tests-only', label: 'strong on tests, low real-world use' },
  4: { tier_name: 'tested, people-backed', label: null },
  5: { tier_name: 'tested', label: null },
  6: { tier_name: 'not independently tested', label: 'not independently tested' },
};
const THIN_DUAL_TIER_META = {
  1: { tier_name: 'human-agreed', label: 'not independently tested' },
  2: EARLY_META,
  3: { tier_name: 'one-signal', label: null },
  4: { tier_name: 'evidenced', label: null },
};
const THIN_SINGLE_TIER_META = {
  1: { tier_name: 'single-signal', label: 'one signal only' },
  2: { tier_name: 'evidenced', label: null },
};
function tierMetaTable(scheme) {
  return scheme === 'nonThin' ? NON_THIN_TIER_META : scheme === 'thinDual' ? THIN_DUAL_TIER_META : THIN_SINGLE_TIER_META;
}
function tierMeta(scheme, tier) {
  const table = tierMetaTable(scheme);
  return table[tier] || table[MAX_TIER[scheme]];
}

/** Tier number (1 = best), directly incorporating the new-model "early" carve-out — the
 * waterfall from the file header, on the three evidence booleans plus `isNew`. Only ever called
 * once a model has already cleared the evidence gate (evidenced === true), so the nonThin
 * "measured absent" branch always has some human evidence backing it. `isNew` is
 * model.adoption === 'new'; it only ever matters at the one spot non-thin/thin-dual each reserve
 * for it (the tier a model lands on when it's near-top-on-one-kind but has no OTHER human
 * backing) — every other branch ignores it entirely.
 *
 * Round 3 fix: "early" requires being near the top on AT LEAST ONE kind — a brand-new model that
 * isn't near top on ANYTHING gets no benefit of the doubt; it's graded on the standard table like
 * anyone else. thin-single has NO "early" tier at all (round 3 — round 2 wrongly gave one to
 * every new model regardless of position, e.g. a bulk model at position 36 of 63 read as "early"
 * purely for being new): "near top on the only kind" is already the most lenient bar thin-single
 * has, so there's no intermediate state left to carve "early" out of. */
export function baseTierNumber(scheme, measuredPresent, measuredNearTop, chosenNearTop, preferredNearTop, isNew = false) {
  const humanNearTop = chosenNearTop || preferredNearTop;
  if (scheme === 'nonThin') {
    if (measuredPresent) {
      if (measuredNearTop) return humanNearTop ? 1 : (isNew ? 2 : 3);
      return humanNearTop ? 4 : 5;
    }
    return 6;
  }
  if (scheme === 'thinDual') {
    if (chosenNearTop && preferredNearTop) return 1;
    if (humanNearTop) return isNew ? 2 : 3;
    return 4;
  }
  // thinSingle — no "early" branch (round 3): the sole existing human kind is whichever of
  // chosenNearTop/preferredNearTop can ever be true for this task (the other is always false,
  // since that kind has no coverage at all — see buildEvidenceIndex's humanKinds), so this is
  // just "that kind near top?" — isNew plays no role here at all any more.
  return humanNearTop ? 1 : 2;
}

/** { evidenced, tier, tier_name, label, evidence, thin_task, kindsNearTopCount, measuredPosition,
 * bestHumanPosition, measuredRows } for one model x task, given that task's evidence index.
 * `evidenced: false` means no measured/chosen/preferred record at all — the caller must exclude
 * such a model from candidacy entirely (see filterCandidates); every other field is only
 * meaningful when evidenced is true, except `evidence`/`thin_task`, which are always populated so
 * the caller can still show what (if anything) was checked. */
export function classifyModelForTask(model, taskId, index) {
  const measuredEntry = index.measured.get(model.id) || null;
  const chosenEntry = index.chosen.get(model.id) || null;
  const preferredEntry = index.preferred.get(model.id) || null;

  const measuredOf = index.measured.size;
  const chosenOf = index.chosen.size;
  const preferredOf = index.preferred.size;

  const measuredPresent = !!measuredEntry;
  const measuredNearTop = measuredPresent && measuredEntry.position <= nearTopThreshold(measuredOf);
  const chosenPresent = !!chosenEntry;
  const chosenNearTop = chosenPresent && chosenEntry.position <= nearTopThreshold(chosenOf);
  const preferredPresent = !!preferredEntry;
  const preferredNearTop = preferredPresent && preferredEntry.position <= nearTopThreshold(preferredOf);
  const evidenced = measuredPresent || chosenPresent || preferredPresent;

  const evidence = {
    measured: {
      present: measuredPresent, near_top: measuredNearTop,
      position: measuredEntry?.position ?? null, of: measuredOf,
      rows: measuredEntry?.rows ?? 0, best: measuredEntry?.best ?? null,
    },
    chosen: chosenPresent ? {
      present: true, near_top: chosenNearTop, position: chosenEntry.position, of: chosenOf,
      rank: chosenEntry.rank, share: chosenEntry.share, url: chosenEntry.url,
    } : null,
    preferred: preferredPresent ? {
      present: true, near_top: preferredNearTop, position: preferredEntry.position, of: preferredOf,
      rank: preferredEntry.rank, board: preferredEntry.board, url: preferredEntry.url,
    } : null,
  };

  if (!evidenced) return { evidenced: false, evidence, thin_task: index.thin };

  const scheme = schemeFor(index);
  const isNew = model.adoption === 'new';
  let tier = baseTierNumber(scheme, measuredPresent, measuredNearTop, chosenNearTop, preferredNearTop, isNew);
  let meta = tierMeta(scheme, tier);

  // Negative-claim demotion (see hasNegativeClaim) — drops one tier, clamped at the scheme's
  // worst tier. The one guard: a demotion never LANDS a model on the "early" tier (always tier 2)
  // unless that model is itself adoption:'new' — "early" is a factual claim about the model's
  // own age, not a generic "one notch down" bucket, so a demoted-but-not-new model skips past it
  // to the next tier down instead (see the file header).
  if (hasNegativeClaim(model, taskId)) {
    let dropped = tier + 1;
    if (dropped === 2 && !isNew) dropped = 3;
    dropped = Math.min(dropped, MAX_TIER[scheme]);
    if (dropped !== tier) { tier = dropped; meta = tierMeta(scheme, tier); }
  }

  const kindsNearTopCount = (measuredNearTop ? 1 : 0) + (chosenNearTop ? 1 : 0) + (preferredNearTop ? 1 : 0);

  return {
    evidenced: true, tier, tier_name: meta.tier_name, label: meta.label, evidence, thin_task: index.thin,
    kindsNearTopCount,
    measuredPosition: measuredEntry?.position ?? null,
    bestHumanPosition: Math.min(chosenEntry?.position ?? Infinity, preferredEntry?.position ?? Infinity),
    measuredRows: measuredEntry?.rows ?? 0,
  };
}

// -----------------------------------------------------------------------------------------
// Candidate filtering — rules 1-4 (reachability, data rule, enterprise preview exclusion,
// evidence gate). No domination-pruning step any more (v1's dropDominated/dominates) — with
// ranking reduced to (tier, explicit position/cost tie-breaks), a pricier model with strictly
// worse tier already sorts after every cheaper-or-equal better-tier model, and within a tier the
// cost tie-break already prefers the cheaper of two otherwise-equal picks; a separate domination
// pass would only re-derive what the tier/order system already guarantees, so it's dropped
// rather than kept as dead weight (the brief for this step explicitly allows removing it "if you
// can[not] express it on (tier, positions, cost)").
// -----------------------------------------------------------------------------------------
export function filterCandidates(taskId, input, data) {
  const vol = resolveVolume(input.volume, data.presets);
  // input.thin_rule optionally overrides THIN_RULE for this one call (see the file header and
  // scripts/eval-report.mjs's --thin-share flag) — never changes the shipped default.
  const index = buildEvidenceIndex(taskId, data.models || [], input.thin_rule || THIN_RULE);
  const candidates = [];
  for (const model of data.models || []) {
    if (!isReachable(model, input.have)) continue;
    const dr = passesDataRule(model, input.dataRule, data.vendors);
    if (!dr.ok) continue;
    // Rule 3 — enterprise-style input excludes a preview-status model ENTIRELY, not just from
    // start_here (an enterprise buyer can't ship a preview SKU at all).
    if (model.status === 'preview' && isEnterpriseInput(input)) continue;

    // Rule 4 — the evidence gate: no measured/chosen/preferred record anywhere for this task
    // means "untested", not a candidate, full stop — a real benchmark score alone (task_fit)
    // never creates a candidate on its own any more; only standings evidence does.
    const cls = classifyModelForTask(model, taskId, index);
    if (!cls.evidenced) continue;

    const judged = model.task_fit_judged?.[taskId] || null;
    const quant = model.task_fit?.[taskId] || null;
    const fitScore = num(quant?.score) ? quant.score : null;
    const fitBasis = quant?.basis || [];
    const basis = judged ? basisFromClaims(judged.claims) : null;
    const why = judged ? topClaimSentence(judged.claims) : buildWhy(model, fitBasis);

    candidates.push({
      model,
      tier: cls.tier, tier_name: cls.tier_name, label: cls.label,
      evidence: cls.evidence, thin_task: cls.thin_task,
      kindsNearTopCount: cls.kindsNearTopCount,
      measuredPosition: cls.measuredPosition,
      bestHumanPosition: cls.bestHumanPosition,
      measuredRows: cls.measuredRows,
      fit: fitScore, fit_basis: fitBasis, basis, why,
      claims: judged?.claims || [],
      reconciliation: judged?.reconciliation ?? null,
      monthly_cost_usd: monthlyCost(model, vol),
      seat_plan_alternative: findSeatPlanAlternative(model, input.have, data.plans),
      unknownCountryVendor: dr.unknownCountry ? model.vendor : null,
    });
  }
  return { candidates, vol, index };
}

// -----------------------------------------------------------------------------------------
// start_here eligibility — a model can win the shortlist without winning the TOP spot. Neither
// rule below drops a model from the shortlist; they only decide which of the top 3 gets
// `start_here: true`.
// -----------------------------------------------------------------------------------------

/** An "early" item (any scheme — tier 2, tier_name 'early') or a non-thin "tests-only" item never
 * gets start_here while a T1 "agreed" item is also a candidate for this task: neither "too new to
 * say" nor a benchmark-only edge should buy the top spot away from a pick real usage AND/OR votes
 * also back. A status:'preview' item never gets start_here (except under stance 'cheapest', which
 * stays cost-primary) while a GA/deprecated item shares its SAME final tier — a reader who can't
 * pin a preview model's version shouldn't be steered to start there when an equally-tiered GA
 * option exists. Checked against the FULL candidate pool for this task (not just the top 3), same
 * reasoning both times: a same-tier alternative that later ranked lower still has to count as "a
 * real alternative existed." */
export function isDisqualifiedFromStartHere(item, allCandidates, stance) {
  const anyT1 = (allCandidates || []).some((c) => c !== item && c.tier === 1);
  if (anyT1 && (item.tier_name === 'early' || (!item.thin_task && item.tier_name === 'tests-only'))) return true;
  if (item.model.status === 'preview' && stance !== 'cheapest') {
    const gaSameTier = (allCandidates || []).some((c) => c !== item && c.tier === item.tier && c.model.status !== 'preview');
    if (gaSameTier) return true;
  }
  return false;
}

// -----------------------------------------------------------------------------------------
// Ranking — tier first, then the within-tier order (see the file header). Every candidate
// reaching rankByStance already cleared the evidence gate in filterCandidates.
// -----------------------------------------------------------------------------------------
const costOrInf = (x) => (num(x.monthly_cost_usd) ? x.monthly_cost_usd : Infinity);
// GA(1) before preview(0) — a ranking tie-break, not a filter; an enterprise-style input already
// removed every preview model entirely, back in filterCandidates.
const statusRank = (status) => (status === 'preview' ? 0 : 1);

/** Within-tier tie-break: more kinds of evidence near the top wins first, then a better
 * (lower) measured position, then a better best-human position, then GA before preview, then
 * more tester rows, then cheaper, then id (fully deterministic). */
export function withinTierCompare(a, b) {
  return (b.kindsNearTopCount - a.kindsNearTopCount)
    || ((a.measuredPosition ?? Infinity) - (b.measuredPosition ?? Infinity))
    || ((a.bestHumanPosition ?? Infinity) - (b.bestHumanPosition ?? Infinity))
    || (statusRank(b.model.status) - statusRank(a.model.status))
    || (b.measuredRows - a.measuredRows)
    || (costOrInf(a) - costOrInf(b))
    || String(a.model.id).localeCompare(String(b.model.id));
}
/** Tier ascending (T1 first), then the within-tier order above — the full 'best' order, and the
 * tie-break every other stance falls back on inside its own budget/qualifying partition. */
export function standardCompare(a, b) {
  return (a.tier - b.tier) || withinTierCompare(a, b);
}

// 'cheapest'"s qualifying-tier ceiling per scheme — a tier counts as qualifying when it has (or,
// for "early", stands in for) at least one kind of evidence near the top. thin-single's ceiling is
// 1 (round 3 fix — thin-single has no "early" tier any more, so its only qualifying tier is T1
// "single-signal"; T2 "evidenced" is the one tier in that scheme with nothing near top, same as
// non-thin's T5/T6 and thin-dual's T4).
export const CHEAPEST_MAX_TIER = { nonThin: 4, thinDual: 3, thinSingle: 1 };

// The tier at and below which NOTHING is near the top of any evidence kind for this task, per
// scheme — non-thin's T5 "tested" and T6 "not independently tested" (the honest floor from T5
// on, even though a T6 pick can technically carry a non-near-top human kind — see the file
// header's T6 note), thin-dual's T4 "evidenced" (its only tier with nothing near top), thin-
// single's T2 "evidenced" (ditto, now that thin-single has no "early" tier — round 3). Used only
// for the "weak field" assumption line in decide() below, round 3 item 2 — never for ranking.
export const WEAK_FIELD_MIN_TIER = { nonThin: 5, thinDual: 4, thinSingle: 2 };

/** Rank a task's candidates by stance — see the file header for the exact semantics of each.
 * `scheme` (schemeFor(index): 'nonThin' | 'thinDual' | 'thinSingle') sets 'cheapest'"s qualifying-
 * tier ceiling (CHEAPEST_MAX_TIER) and 'balanced'"s exclusion of "early" from the reference tier.
 * Never mutates `candidates`. */
export function rankByStance(candidates, stance, scheme) {
  const list = [...(candidates || [])];
  if (!list.length) return list;

  if (stance === 'best') return list.sort(standardCompare);

  if (stance === 'cheapest') {
    const maxTier = CHEAPEST_MAX_TIER[scheme];
    const qualify = list.filter((c) => c.tier <= maxTier);
    const pool = qualify.length ? qualify : list; // "falling back to any candidate"
    const rest = qualify.length ? list.filter((c) => c.tier > maxTier) : [];
    pool.sort((a, b) => (costOrInf(a) - costOrInf(b)) || standardCompare(a, b));
    rest.sort(standardCompare);
    return [...pool, ...rest];
  }

  // 'balanced' (default): among the top tier PRESENT among the NON-"early" candidates, find its
  // cheapest priced member as the reference cost (round 2 fix — a brand-new cheap model must
  // never set the budget floor just by existing; it can still land in the shortlist within 2x of
  // whatever the real top tier's floor is). Everyone (any tier, "early" included) at or under 2x
  // that cost is "in budget" and ranked first by the standard order, everyone else is ranked
  // after, also by the standard order — never dropped, just deprioritized. No non-"early"
  // candidate at all, or none of them priced -> behave like 'best'.
  const nonEarly = list.filter((c) => c.tier_name !== 'early');
  const referencePool = nonEarly.length ? nonEarly : list;
  const topTier = Math.min(...referencePool.map((c) => c.tier));
  const topTierPriced = referencePool.filter((c) => c.tier === topTier && num(c.monthly_cost_usd));
  if (!topTierPriced.length) return list.sort(standardCompare);
  const cheapestRef = Math.min(...topTierPriced.map((c) => c.monthly_cost_usd));
  const threshold = cheapestRef * 2;
  const inBudget = [], overBudget = [];
  for (const c of list) (num(c.monthly_cost_usd) && c.monthly_cost_usd <= threshold ? inBudget : overBudget).push(c);
  inBudget.sort(standardCompare);
  overBudget.sort(standardCompare);
  return [...inBudget, ...overBudget];
}

// -----------------------------------------------------------------------------------------
// Tagging — one of 'cheapest-that-clears' | 'strongest' | 'best-per-dollar' | 'in-your-kit'
// per shortlist item. Purely descriptive (unchanged from v1): the cheapest item in the
// shortlist always reads 'cheapest-that-clears', the highest quantitative-fit item always reads
// 'strongest' (falls back to -Infinity when fit is null, e.g. a purely judgment-backed pick with
// no quantitative task_fit score), a model whose vendor the caller already has directly reads
// 'in-your-kit' when neither of those applies, and everything else reads 'best-per-dollar'.
// -----------------------------------------------------------------------------------------
function tagFor(item, shortlist, have) {
  const cheapest = shortlist.reduce((a, b) => (costOrInf(b) < costOrInf(a) ? b : a));
  const strongest = shortlist.reduce((a, b) => ((b.fit ?? -Infinity) > (a.fit ?? -Infinity) ? b : a));
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
    const { candidates, vol, index } = filterCandidates(taskId, { ...input, stance }, data);
    const scheme = schemeFor(index);
    const ranked = rankByStance(candidates, stance, scheme);

    // start_here eligibility (see isDisqualifiedFromStartHere): find the first-ranked candidate
    // that ISN'T disqualified and move it to the front, keeping everyone else's relative order —
    // a disqualified model still shows up in the top 3 if it ranks there, it just doesn't get the
    // start_here flag. If every candidate is disqualified there's no alternative to prefer, so
    // the normal #1 keeps start_here.
    let startIdx = ranked.findIndex((item) => !isDisqualifiedFromStartHere(item, candidates, stance));
    if (startIdx === -1) startIdx = 0;
    const reordered = startIdx === 0 ? ranked : [ranked[startIdx], ...ranked.slice(0, startIdx), ...ranked.slice(startIdx + 1)];
    const top = reordered.slice(0, 3);

    const shortlist = top.map((item, idx) => ({
      id: item.model.id,
      name: item.model.name,
      tag: tagFor(item, top, have),
      why: item.why,
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
      // Repurposed v1 field names (kept so no caller field name breaks): families = count of the
      // three evidence kinds near the top for this pick (0-3); calibration_note = the tier's
      // label, or null when this tier carries none — same value as the new `label` field below.
      families: item.kindsNearTopCount,
      calibration_note: item.label ?? null,
      // New in this step — see the file header for what each means.
      tier: item.tier,
      tier_name: item.tier_name,
      label: item.label ?? null,
      evidence: item.evidence,
      thin_task: item.thin_task,
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
      assumptions.push('No catalog model reachable with these inputs has any independent evidence (tester standings, OpenRouter usage share, or Arena votes) for this task — a model with no evidence of any kind is not a candidate at all, regardless of any benchmark score it carries.');
    }
    if (startIdx > 0) {
      const skipped = ranked[0];
      const anyT1 = candidates.some((c) => c.tier === 1);
      let reason;
      if (anyT1 && skipped.tier_name === 'early') {
        reason = 'it\'s too new for real-world usage/votes to have caught up yet, while at least one candidate with that real-world backing already exists for this task';
      } else if (anyT1 && !skipped.thin_task && skipped.tier_name === 'tests-only') {
        reason = 'it only tests well — no real-world usage share or votes back it — while at least one candidate with that real-world backing also exists for this task';
      } else {
        reason = 'it\'s a preview-status model and a GA/deprecated model at the same tier is also a candidate — pin a version before you\'d actually rely on a preview SKU';
      }
      assumptions.push(`"${skipped.model.name}" ranked highest before the start_here check but wasn't set as start_here — ${reason}. It's still listed below if it placed in the top 3.`);
    }
    const missingPrice = top.filter((item) => item.monthly_cost_usd == null);
    for (const item of missingPrice) {
      assumptions.push(`"${item.model.name}" has no monthly cost shown — its price isn't on file in data/models.json (price_input/price_output missing), not a computation gap; cost comparisons involving it are unavailable until that's sourced.`);
    }
    // Weak-field honesty line (round 3, item 2): the start_here pick itself is below the tiers
    // that have any kind of evidence near the top for this task (WEAK_FIELD_MIN_TIER) — it's the
    // best of what's here, but "best of a weak field" is a different claim from "a strong pick",
    // and a reader comparing it against a task where the winner IS near-top somewhere should know
    // the difference before committing.
    if (top.length && top[0].tier >= WEAK_FIELD_MIN_TIER[scheme]) {
      assumptions.push(`"${top[0].model.name}" is the best-evidenced pick here, but no model in this set is near the top on any evidence kind (measured, chosen, or preferred) for this task — this is the strongest pick of a weak field, not a strong pick; widen the vendor set or trial it before committing.`);
    }

    tasks[taskId] = { shortlist, assumptions };
  }
  return { tasks };
}
