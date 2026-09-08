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
       presets,    // data/usage-presets.json's `presets` object ({light, typical, heavy}) —
                   // resolveVolume() also tolerates the whole parsed file (with its _readme/
                   // as_of wrapper) being passed here by mistake; see unwrapPresets() below
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
      own `status` ('ga'|'preview'|'deprecated') and `adoption` ('broad'|'moderate'|'low'|'unknown'|
      'new', from usage.openrouter.share, or 'new' when `released` is within 60 days of the data
      snapshot regardless of share — scripts/derive-status-adoption.mjs) and its top claim's own
      sentence as `why`.
   3b. Calibration — a judged band alone still let a SINGLE vendor benchmark claim buy the exact
      same "strong" band as a model backed by real usage, human votes, AND vendor guidance (fixed
      2026-09-07, the PR after the rule-3 rewrite above — e.g. kat-coder-pro-v2-5 and
      muse-spark-1-3 topped "coding" over claude-opus-5/claude-sonnet-5/gpt-5-6-sol on nothing but
      their own arXiv paper / vendor listing, with ~0% real usage and zero independent-vote or
      expert-default presence; see the PR this shipped in, eval/signals.md, and
      scripts/derive-signals.mjs's header for the full story and the three real-world signal
      families it collects). `model.signals[taskId]` (scripts/derive-signals.mjs; shape:
      `{ usage_rank, usage_share, arena_rank, expert_default, families }`) counts how many of
      THREE independent families back a model for a task — OpenRouter task-spend top-10 (usage),
      arena.ai human-vote top-10 (arena), and a real tool's own featured/default roster (expert) —
      `families` is 0-3, never invented; a model with no row in a given family for this task is
      absent from it, not a zero standing in for evidence. The rule: a judged `strong` band needs
      `families >= 2` to STAY `strong`; with fewer than 2 it is downgraded to `capable` at
      decision time (the underlying judged record, its claims, and its `confidence` are untouched
      — only the effective band this engine ranks and gates on changes), and the shortlist item
      carries `calibration_note: "strong on vendor evidence; limited real-world signal"` so a
      reader sees exactly why a pick that reads "strong" in the raw data shows up ranked as
      `capable` here. `capable` (native OR just-downgraded) then needs its OWN family support —
      `families >= 1` — to survive as a candidate at all ("or a judged record" is the escape hatch
      right below, not a free pass): a $0.05/Mtok model whose only "capable" evidence is its own
      vendor's arXiv paper and a near-zero usage stat must not out-cost-rank real, cross-checked
      picks just because nobody happened to call it "strong". filterCandidates() applies this in
      two passes for exactly one reason — a WEAK-COVERAGE escape hatch that mirrors
      eval/METHOD.md's own rule for the cold answer key this engine is graded against: if NOT ONE
      otherwise-eligible candidate for a given (task, access) combination has any family support
      at all, the gap is in what got collected, not in every candidate's quality — collecting
      OpenRouter/Arena/expert-default data for every (task, vendor-restriction) combination in the
      catalog was never attempted, and a vendor-restricted ask (e.g. "Google only") can land
      entirely outside what got sampled. In that one case, and only that case, every `capable`
      record stands on its judged record alone, same as before this rule existed — that's the "or
      a judged record" clause. Any (task, access) pair where even ONE candidate has real family
      signal enforces the floor normally on every other candidate in that pair. `taskFitFor()`'s
      numeric `fit` is recalculated at the calibrated band (not the raw record's) whenever it's the
      flat JUDGED_BAND_SCORE placeholder rather than a real measured score — so a downgraded pick's
      shown fit number is honest about which band it actually ranks in now.
   4. Rank by judged band (strong > capable), THEN by calibration's own `families` count, THEN by
      confidence (high > medium > low) — FIRST within
      the candidate set — every candidate here already cleared rule 3, so this never lets a
      lower-judged model outrank a better-judged one. What breaks a tie inside the same (band,
      confidence) tier is where the three stances actually differ (fixed 2026-09-07 — a prior
      version of this file used the same band/confidence/cost/fit order for every stance, which
      meant 'cheapest' silently returned the exact same shortlist as 'best' whenever candidates
      spanned more than one tier — the price never got a chance to matter):
        - 'cheapest': cost is the primary key — the cheapest candidate at the given volume wins
          outright, REGARDLESS of band/confidence tier, as long as it already cleared rule 3's
          strong-or-capable floor. Ties on cost fall back to band, then confidence (see
          rankByStance).
        - 'best': band, then GA-before-preview status, then families, then usage_rank (lower is
          better — see below), then confidence, then raw fit (cheaper is never a reason on its own
          here — "best regardless of price" is the point of this stance, e.g.
          data/eval/situations.json's S01), cost only as the final tie-break when fit also ties.
        - 'balanced': restricted to the candidates priced at or under 2x the monthly cost of the
          cheapest 'strong'-band candidate (or the cheapest 'capable'-band candidate if no
          'strong' one is priced) — i.e. "the candidates a buyer already comparison-shopping the
          best option could actually justify" — ranked the same way as 'best' inside that in-budget
          set; every candidate priced over that line is still returned (so it can still show up
          lower in the shortlist), just always ranked after every in-budget one.
      Before ranking, dropDominated removes any candidate a cheaper-or-equal rival already covers —
      but what counts as "covers" now depends on the stance (rewritten AGAIN 2026-09-07, same day
      as the ranking-order change above — see dominates()'s own comment for the full story and the
      concrete catalog bug this fixes):
        - 'best'/'balanced': y (the candidate that would survive) may only eliminate x when y is
          at least as good as x on EVERY evidence dimension — band, confidence, usage_rank
          (scripts/derive-signals.mjs; lower is better, no rank on file counts as worse than any
          real rank), families as a SET (evidenceFamilySet/familiesAtLeastAsGood — WHICH of the
          three real-world signal families back a model, not merely how many; two models can share
          the same families COUNT while backing entirely different, non-overlapping claims), and
          quantitative fit ONLY when both candidates carry a real measured score (a flat
          JUDGED_BAND_SCORE placeholder is never treated as "quantitative fit" for this purpose) —
          AND y is cheaper-or-equal, with at least one of those comparisons strict. Before this,
          domination compared only band/confidence/fit/cost, which let a cheaper, marginally
          higher-scoring model erase a rival with just as much real-world standing but a different
          evidence profile (Kimi K3 was erasing BOTH Claude Opus 5 — the actual usage_rank-1 pick
          for "coding" at 37% of OpenRouter spend — and GPT-5.6 Sol, a differently-evidenced
          same-tier peer, from the shortlist entirely).
        - 'cheapest': keeps the plain, tier-scoped cheaper-and-at-least-as-fit check this stance
          has always used (this stance is explicitly cost-primary and does not apply the fuller
          evidence check above) — but with one added guard: it may never fully eliminate a
          'strong'-band candidate that carries MORE families (a plain count here) than the cheaper
          candidate trying to dominate it. That candidate can still rank far below the cheapest
          pick — 'cheapest' stays cost-first, full stop — but it must remain in the returned list,
          not disappear from it.
      Two rules gate start_here selection only (see isDisqualifiedFromStartHere) — neither ever
      removes a model from the shortlist, only the start_here flag:
        - an `adoption: 'low'` model is never start_here while a 'broad' or 'moderate'-adoption
          model of the SAME judged band is also a candidate — a benchmark win doesn't buy the top
          spot away from a model people are actually already running, in the same tier of judged
          quality.
        - (added 2026-09-07) GA before preview, in ranking too: within the SAME band, a
          status:'preview' model never outranks a GA/deprecated one any more (rankByStance's
          byBandThenConfidence, ahead of families/confidence/fit) — before this, a preview SKU
          with slightly more real-world signal families than its GA rivals could still take #2/#3
          under plain 'best' (e.g. gemini-3-1-pro over claude-sonnet-5 for "writing", both
          'capable'). At start_here specifically, a preview model is disqualified whenever ANY GA
          model shares its band, checked against the full pre-domination candidate pool (same
          reasoning as the adoption rule above). Scoped OUT of 'cheapest': that stance stays
          cost-primary, full stop — if the actual cheapest candidate is a preview SKU, 'cheapest'
          still recommends it. This does NOT reintroduce the blanket preview demotion removed
          earlier that day: a preview model with NO same-band GA rival — including gemini-3-1-pro
          under data/eval/situations.json's S33 (Google-only vision, no GA model even clears the
          judged floor there) — still legitimately wins start_here under plain "best" when its
          own judged evidence earns it. The absolute preview bar stays the enterprise-style full
          exclusion at rule 3 above; this file never duplicates a milder version of it here again.
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

// -----------------------------------------------------------------------------------------
// Rule 3b — calibration (see the file header). A judged `strong` needs real-world signal
// support (scripts/derive-signals.mjs's `families`, 0-3) to stay `strong`; fewer than 2 families
// downgrades it to `capable` at decision time. This function only ever computes the DOWNGRADE —
// whether a `capable` band (native or just-downgraded) also needs its own family support to stay
// a candidate at all is a SEPARATE decision (see filterCandidates' own "capable floor" step,
// right after this runs) that needs the whole per-(task, access) candidate pool to answer
// correctly (the weak-coverage escape hatch below), so it can't be decided per-model in isolation
// here. families is always read here, even when no downgrade happens, so rule 4 can order by it.
// -----------------------------------------------------------------------------------------
export const CALIBRATION_LABEL = 'strong on vendor evidence; limited real-world signal';
export const STRONG_FAMILIES_FLOOR = 2;
export const CAPABLE_FAMILIES_FLOOR = 1;

/** { band, families, calibration } — `band` is the post-downgrade band; `calibration` is null
 * unless a downgrade happened, in which case it's `{ downgraded_from: 'strong', families, note:
 * CALIBRATION_LABEL }`. Pure — reads only model.signals[taskId], never mutates the model. */
export function calibrateBand(model, taskId, rawBand) {
  const families = model.signals?.[taskId]?.families ?? 0;
  if (rawBand === 'strong' && families < STRONG_FAMILIES_FLOOR) {
    return { band: 'capable', families, calibration: { downgraded_from: 'strong', families, note: CALIBRATION_LABEL } };
  }
  return { band: rawBand, families, calibration: null };
}

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

/** "Enterprise-style" input, for the preview-status rule: EXPLICIT input.enterprise (true/false)
 * wins outright when the caller states it — the eval harness (data/eval/situations.json, built
 * from an independently-drafted answer key) tells us plainly per situation, and there's no reason
 * to argue with a caller who already knows their own context. Only when the caller doesn't say
 * does this fall back to the heuristic: a single named vendor at heavy volume (a team
 * standardizing on one vendor's paid tier, not shopping around), or any data rule turned on
 * (noChinaHosted today — a compliance-flavored ask). 'any'/'openrouter' don't count as "a single
 * vendor" — they're explicitly the opposite of standardizing on one vendor's own paid API. */
export function isEnterpriseInput(input) {
  if (input?.enterprise === true) return true;
  if (input?.enterprise === false) return false;
  const have = Array.isArray(input?.have) ? input.have : [];
  const singleNamedVendor = have.length === 1 && Object.keys(VENDOR_KEY_DISPLAY).includes(String(have[0] || '').toLowerCase());
  const heavyVolume = input?.volume === 'heavy';
  const dataRuleSet = !!input?.dataRule && Object.values(input.dataRule).some(Boolean);
  return (singleNamedVendor && heavyVolume) || dataRuleSet;
}

/** An `adoption: 'low'` model never gets start_here while a 'broad'/'moderate'-adoption model of
 * the SAME judged band is also a candidate — a benchmark edge doesn't buy the top spot away from
 * a model people are actually already running, once judgment has already put both in the same
 * tier of quality.
 *
 * A blanket `status: 'preview'` demotion used to live here under plain stance 'best', even with
 * no enterprise signal at all — removed 2026-09-07 against the independently-drafted 40-situation
 * answer key this engine is graded on: it explicitly expects a preview model to legitimately WIN
 * start_here in a plain, non-enterprise "best" ask when its own judged evidence earns it
 * (data/eval/situations.json's S33: Google-only, stance 'best', enterprise:false, vision task —
 * Gemini 3.1 Pro (Preview) is the required start_here, with no GA model even clearing the judged
 * floor for that task under that access).
 *
 * A narrower version comes back below (2026-09-07, same day): GA never loses start_here to a
 * preview model that shares its SAME judged band — S33 still passes because Google-only vision
 * has no GA candidate in gemini-3-1-pro's 'capable' band at all, so the "no GA rival in this
 * band" escape hatch below still lets it through. What this closes is the case S33 never covered:
 * plain 'best'/'balanced' where a preview SKU AND a GA model both clear the SAME band (e.g.
 * gemini-3-1-pro vs. claude-sonnet-5, both 'capable', for "writing") — a reader who can't pin a
 * preview model's version shouldn't be told to start there when an equally-judged GA option
 * exists. Scoped OUT of 'cheapest' on purpose: that stance is cost-primary, full stop (rule 4) —
 * if the actual cheapest candidate is a preview SKU, 'cheapest' still recommends it; the absolute
 * bar on preview stays the enterprise-style full exclusion at rule 3
 * (filterCandidates — an enterprise-style input drops a preview model from the candidate set
 * ENTIRELY before this function ever runs on it), not this start_here-only rule. Checked against
 * the FULL pre-dropDominated `allCandidates`, exactly like the adoption gate above and for the
 * same reason: a same-band GA rival that dropDominated later pruned on pure price/fit must still
 * count as "a real alternative existed," or a numeric domination check would silently undo this
 * judgment-based rule. */
export function isDisqualifiedFromStartHere(item, allCandidates, stance, input) {
  if (item.model.adoption === 'low') {
    const betterAdoptionSameBand = (allCandidates || []).some((other) => (
      other !== item && other.band === item.band &&
      (other.model.adoption === 'broad' || other.model.adoption === 'moderate')
    ));
    if (betterAdoptionSameBand) return true;
  }
  if (item.model.status === 'preview' && stance !== 'cheapest') {
    const gaSameBand = (allCandidates || []).some((other) => (
      other !== item && other.band === item.band && other.model.status !== 'preview'
    ));
    if (gaSameBand) return true;
  }
  return false;
}

// -----------------------------------------------------------------------------------------
// Cost
// -----------------------------------------------------------------------------------------
// Defensive unwrap (2026-09-07): every real caller (lab.html, scripts/test-*.mjs) already
// passes data/usage-presets.json's `presets` sub-object as `data.presets`, per this file's own
// header contract — but a caller that instead hands over the WHOLE parsed file (with its
// _readme/as_of wrapper) silently gets `presets?.[key]` === undefined for every key, which
// makes monthlyCost() return null for every model with no error anywhere to catch it. The
// three named bands (light/typical/heavy) never collide with the wrapper's own keys, so
// unwrapping is unambiguous and a no-op for every caller already doing it right.
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
// Evidence-family SET (2026-09-07, dropDominated evidence rewrite) — WHICH of the three
// real-world signal families (scripts/derive-signals.mjs: usage-top-10, arena-top-10,
// expert-default) actually back a model for this task, not just how many. Two models can share
// the exact same `families` COUNT while backing entirely different claims — e.g. one model's 2
// families are {usage, arena} and another's are {usage, expert} — and a count alone can't tell
// those apart. dominates() below needs the real set: a count tie must never let a model missing
// one family (say, expert-default backing) be treated as "at least as evidenced" as a model that
// actually has it, just because both happen to total 2.
// -----------------------------------------------------------------------------------------
export function evidenceFamilySet(model, taskId) {
  const sig = model?.signals?.[taskId];
  const set = new Set();
  if (!sig) return set;
  if (num(sig.usage_rank)) set.add('usage');
  if (num(sig.arena_rank)) set.add('arena');
  if (sig.expert_default) set.add('expert');
  return set;
}
/** true when every family backing `x` also backs `y` (y's set is a superset of x's, ties
 * included) — the "at least as good on families" half of dominates()'s evidence check. */
export function familiesAtLeastAsGood(ySet, xSet) {
  if (!xSet || !xSet.size) return true;
  if (!ySet) return false;
  for (const f of xSet) if (!ySet.has(f)) return false;
  return true;
}
/** usage_rank comparison for dominates()/ranking — lower is better; no rank on file (null)
 * counts as worse than any real rank, so nothing can be "at least as good" as an actual #1 except
 * another #1 (which can't coexist for the same task). */
export function usageRankAtLeastAsGood(yRank, xRank) {
  if (!num(xRank)) return true;
  if (!num(yRank)) return false;
  return yRank <= xRank;
}
const usageRankValue = (item) => (num(item.usage_rank) ? item.usage_rank : Infinity);

// -----------------------------------------------------------------------------------------
// Candidate filtering (rules 1-3) and domination pruning
// -----------------------------------------------------------------------------------------
export function filterCandidates(taskId, input, data) {
  const vol = resolveVolume(input.volume, data.presets);
  // Pass 1 — everything up through calibration (rules 1-3 + 3b's downgrade), but NOT yet rule
  // 3b's "capable also needs its own family support" floor — that floor needs to see the WHOLE
  // pool for this (task, access) combination first, to tell a genuinely thin pick apart from a gap
  // in what got collected (the weak-coverage escape hatch right below).
  const preGate = [];
  for (const model of data.models || []) {
    if (!isReachable(model, input.have)) continue;
    const dr = passesDataRule(model, input.dataRule, data.vendors);
    if (!dr.ok) continue;
    // An enterprise-style input excludes a preview-status model ENTIRELY, not just from
    // start_here — see isDisqualifiedFromStartHere's comment for why this is stronger than the
    // plain-"best" case. An enterprise buyer can't ship a preview SKU at all, so it shouldn't be
    // offered lower in the shortlist either.
    if (model.status === 'preview' && isEnterpriseInput(input)) continue;
    // Rule 3 — the judgment IS the gate (see the file header). A judged record for THIS task is
    // required to be a candidate at all; a quantitative score with no judged band never gets in
    // on its own any more.
    const { band: rawBand, confidence, judged } = judgedBandOf(model, taskId);
    if (rawBand !== 'strong' && rawBand !== 'capable') continue;
    // Rule 3b — calibration (see the file header and calibrateBand's own comment): a claimed
    // `strong` with fewer than 2 real-world signal families downgrades to `capable` here, before
    // ranking ever sees it. Everything below this line uses the EFFECTIVE (post-calibration)
    // `band`, never the raw judged record's own band — that's what makes the downgrade actually
    // stick through domination pruning and ranking, not just cosmetic on the label.
    const { band, families, calibration } = calibrateBand(model, taskId, rawBand);
    preGate.push({ model, dr, band, confidence, families, calibration, judged });
  }
  // Weak-coverage escape hatch (mirrors eval/METHOD.md's own rule for the cold answer key this
  // engine is graded against: "a task's coverage counts as weak... when zero reachable candidates
  // have any family's top-set support... must_not_start is left empty, since there is no
  // comparative evidence to justify singling any reachable model out"). If NOT ONE otherwise-
  // eligible candidate for this specific (task, access) combination has any real-world signal
  // family at all, then nobody collected usage/arena/expert-default data for this corner of the
  // catalog — that is a gap in what got collected, not evidence every candidate is unproven, so
  // the "capable needs >=1 family" floor below would be punishing a data gap, not a bad pick.
  // Widen back to every judged-eligible candidate in that case, exactly as if rule 3b's capable
  // floor didn't exist for this call. This only ever WIDENS the candidate pool for a (task,
  // access) pair with literally zero family signal anywhere in it — a pair where even one
  // candidate has real signal always enforces the floor normally.
  const hasAnyRealSignal = preGate.some((c) => c.families >= 1);
  // Pass 2 — rule 3b's capable floor: a `capable` band (native or just-downgraded) also needs its
  // own family support, unless the weak-coverage escape above applies. `strong` is never subject
  // to this (it already passed the stricter families >= STRONG_FAMILIES_FLOOR check above).
  const candidates = [];
  for (const c of preGate) {
    if (c.band === 'capable' && c.families < CAPABLE_FAMILIES_FLOOR && hasAnyRealSignal) continue;
    const { model, dr, band, confidence, families, calibration, judged } = c;
    // taskFitFor still decides the NUMBER shown alongside the pick (a real score when sourced,
    // else the flat JUDGED_BAND_SCORE) — but never whether the model is here at all (that's
    // judgedBandOf, above). Claims/reconciliation always come from the judged record itself
    // (never from taskFitFor's `judged`, which is null on its 'measured' branch) so a model with
    // BOTH a real score and a judged record still shows the evidence that actually earned it a
    // place in the running.
    const fit = taskFitFor(model, taskId);
    // A downgraded pick's flat placeholder score is recalculated at the CALIBRATED band (68 for
    // capable, not 88 for the raw record's strong) — but only when fit.score is itself that flat
    // placeholder (fit.source !== 'measured'); a real measured quant score (e.g. coding_score) is
    // never touched by calibration, since it's independent evidence, not the judged claim this
    // rule exists to discount.
    const fitScore = calibration && fit.source !== 'measured' ? JUDGED_BAND_SCORE[band] : (fit.score ?? JUDGED_BAND_SCORE[band]);
    candidates.push({
      model,
      band,
      confidence,
      families,
      calibration,
      // Guaranteed non-null in practice (taskFitFor always resolves a score once a strong/capable
      // judged record exists), but falls back to the band constant rather than ever sorting on a
      // NaN if that guarantee is ever violated by a future edit.
      fit: fitScore,
      // Whether `fit` above is a real, sourced measurement (fit.source === 'measured', e.g. a
      // coding_score) or the flat JUDGED_BAND_SCORE placeholder standing in for a judged record
      // with no number of its own. dominates() below only ever compares fit as a domination axis
      // when BOTH sides carry a real measurement — see dominates()'s own comment for why.
      fitSource: fit.source,
      fit_basis: fit.basis,
      basis: basisFromClaims(judged.claims),
      claims: judged.claims,
      reconciliation: judged.reconciliation ?? null,
      judgedBand: band,
      judgedConfidence: confidence,
      monthly_cost_usd: monthlyCost(model, vol),
      seat_plan_alternative: findSeatPlanAlternative(model, input.have, data.plans),
      unknownCountryVendor: dr.unknownCountry ? model.vendor : null,
      // Rule 4 domination/ranking now also weigh usage_rank and WHICH real-world signal families
      // (not merely how many) back a candidate — see evidenceFamilySet()/dominates() below.
      usage_rank: num(model.signals?.[taskId]?.usage_rank) ? model.signals[taskId].usage_rank : null,
      familyTypes: evidenceFamilySet(model, taskId),
    });
  }
  return { candidates, vol };
}

/** y dominates x only if y's judged tier (band, then confidence) is AT LEAST AS GOOD as x's —
 * a 'capable' model can never dominate-and-eliminate a 'strong' one just by being cheaper or
 * carrying a higher raw fit number, or the exact bug this whole rewrite exists to kill (a number
 * outranking a judgment) would sneak back in through domination pruning instead of ranking. Within
 * the SAME (band, confidence) tier this is exactly the old fit+cost comparison; across tiers, a
 * strictly-better-tier model dominates a cheaper-or-equal one outright (its judgment already
 * establishes "at least as fit" — no numeric fit comparison needed), and a worse-tier model can
 * never dominate a better-tier one regardless of price. */
// 'new' (scripts/derive-status-adoption.mjs's 60-day-since-release rule) ranks the same as
// 'unknown' on purpose — a model too recently released for its usage share to mean anything is in
// exactly the same "no real signal either way" position, so it gets the same neutral protection
// from domination by a cheaper 'low'-adoption model, without being penalized the way an actually
// low-measured-share model is.
const ADOPTION_RANK = { broad: 3, moderate: 2, unknown: 1, new: 1, low: 0 };
const adoptionRank = (adoption) => ADOPTION_RANK[adoption] ?? 1;

/** y dominates x only if y's judged tier (band, then confidence) is AT LEAST AS GOOD as x's — a
 * 'capable' model can never dominate-and-eliminate a 'strong' one just by being cheaper or
 * carrying a higher raw fit number.
 *
 * REWRITTEN AGAIN 2026-09-07, same day: the ABOVE guarantee (tier can't be bought back with
 * price/fit) turned out not to be enough — within the SAME tier, this function used to compare
 * only cost and fit, which let a cheaper, marginally-higher-fit model erase a rival with just as
 * much real-world standing but a different profile. Concretely, for "coding" under 'best': Kimi
 * K3 ($28.50/mo, coding_score 96, both strong/high, families:2) was dominating BOTH Claude Opus 5
 * ($47.50/mo, score 95, families:2, usage_rank 1 at 37% of OpenRouter coding spend — the actual
 * #1 real-usage pick) and GPT-5.6 Sol ($38/mo, score 90, families:2, usage_rank 3) — erasing them
 * from the shortlist entirely on nothing but a slightly higher score and a lower price. Now, for
 * 'best'/'balanced' (see the 'cheapest' branch below for that stance's own, narrower rule), y
 * must be at least as good as x on EVERY one of these before cost/fit ever gets a vote:
 *   - band, confidence — as before.
 *   - usage_rank (usageRankAtLeastAsGood — lower is better, no rank counts as worse than any
 *     real one). This alone protects Opus 5: nothing can be "at least as good" as its usage_rank
 *     1 except another rank 1, which can't coexist for the same task — so a rank-1 model can
 *     never be dominated away by anything, at any price.
 *   - families, as a SET, not a count (familiesAtLeastAsGood/evidenceFamilySet). Kimi K3 and
 *     GPT-5.6 Sol both show families:2, but Kimi's are {usage, arena} and Sol's are {usage,
 *     expert} — different, independently-collected evidence, not "the same support, just less of
 *     it". A families-COUNT tie would still have let Kimi erase Sol; the SET check means Kimi is
 *     missing Sol's expert-default backing, so Kimi is not "at least as good" on this axis either.
 *   - quantitative fit — but ONLY when BOTH candidates carry a real measured score
 *     (fitSource === 'measured' on both, see filterCandidates). A flat JUDGED_BAND_SCORE
 *     placeholder is not "quantitative fit"; comparing it as if it were would let one judged-only
 *     model's arbitrary placeholder outrank another's, so this axis is simply skipped (treated as
 *     satisfied) whenever either side is unmeasured.
 * Within the SAME (band, confidence) tier this is exactly the old fit+cost comparison, now with
 * usage_rank/families added as further required axes; across tiers, a strictly-better-tier model
 * still dominates a cheaper-or-equal one outright (its judgment already establishes "at least as
 * fit" on band/confidence — but it must still clear the usage_rank/families/fit axes too, now
 * that those are checked regardless of tier), and a worse-tier model can never dominate a
 * better-tier one regardless of price. */
export function dominates(y, x, stance = 'best') {
  if (y === x || !num(x.monthly_cost_usd) || !num(y.monthly_cost_usd)) return false;

  if (stance === 'cheapest') {
    // Cost-primary stance — keep the plain, tier-scoped cheaper+at-least-as-fit check this stance
    // has always used (not the fuller evidence check below; 'cheapest' is explicitly allowed to
    // recommend the actual cheapest candidate regardless of its evidence profile). The ONE guard
    // added here (2026-09-07): never let this simpler check fully ERASE a 'strong'-band candidate
    // that carries MORE families (a plain count, unlike the set check above — see this
    // function's own header) than the cheaper candidate trying to dominate it. It may still rank
    // far below the cheapest pick — this stance stays cost-first, full stop — but it must remain
    // in the returned list, not disappear from it.
    if (x.band === 'strong' && (x.families ?? 0) > (y.families ?? 0)) return false;
    const sameBandConfidence = bandRank(y.band) === bandRank(x.band) && confidenceRank(y.confidence) === confidenceRank(x.confidence);
    const yTierAtLeastAsGood = bandRank(y.band) > bandRank(x.band) ||
      (bandRank(y.band) === bandRank(x.band) && confidenceRank(y.confidence) >= confidenceRank(x.confidence));
    if (!yTierAtLeastAsGood) return false;
    if (sameBandConfidence && adoptionRank(y.model.adoption) < adoptionRank(x.model.adoption)) return false;
    const cheaperOrEqual = y.monthly_cost_usd <= x.monthly_cost_usd;
    const atLeastAsFit = sameBandConfidence ? y.fit >= x.fit : true;
    const strictlyBetter = !sameBandConfidence || y.monthly_cost_usd < x.monthly_cost_usd || y.fit > x.fit;
    return cheaperOrEqual && atLeastAsFit && strictlyBetter;
  }

  // 'best' / 'balanced' — every evidence dimension below must favor (or tie) y before cost/fit
  // ever gets a vote; failing any one of them blocks domination outright.
  if (bandRank(y.band) < bandRank(x.band)) return false;
  if (confidenceRank(y.confidence) < confidenceRank(x.confidence)) return false;
  if (!usageRankAtLeastAsGood(y.usage_rank, x.usage_rank)) return false;
  if (!familiesAtLeastAsGood(y.familyTypes, x.familyTypes)) return false;
  const bothMeasured = y.fitSource === 'measured' && x.fitSource === 'measured';
  if (bothMeasured && y.fit < x.fit) return false;

  // Within the SAME (band, confidence) tier, a lower-adoption model can never dominate-and-
  // eliminate a higher-adoption one either — otherwise a cheap, low-adoption model could erase
  // the very broader-adoption alternative the start_here adoption gate exists to prefer, before
  // that gate ever runs (2026-09-07 regression, caught by the vision task's own catalog: a
  // $0.93/mo low-adoption model was dominating a $1.90/mo moderate-adoption one at equal fit).
  const sameBandConfidence = bandRank(y.band) === bandRank(x.band) && confidenceRank(y.confidence) === confidenceRank(x.confidence);
  if (sameBandConfidence && adoptionRank(y.model.adoption) < adoptionRank(x.model.adoption)) return false;

  if (y.monthly_cost_usd > x.monthly_cost_usd) return false;

  const strictlyBetter = y.monthly_cost_usd < x.monthly_cost_usd
    || bandRank(y.band) > bandRank(x.band)
    || confidenceRank(y.confidence) > confidenceRank(x.confidence)
    || (num(y.usage_rank) && (!num(x.usage_rank) || y.usage_rank < x.usage_rank))
    || (y.familyTypes?.size ?? 0) > (x.familyTypes?.size ?? 0)
    || (bothMeasured && y.fit > x.fit);
  return strictlyBetter;
}
/** Drop any candidate dominated by another per dominates() above — guarantees the eventual
 * shortlist never contains a pricier model that isn't at least justified by evidence over every
 * cheaper option (see dominates()'s own comment for exactly which evidence dimensions that now
 * covers, and how 'cheapest' differs). Candidates with an unknown cost can't be compared either
 * way, so they're never dropped by this step. `stance` must match whatever rankByStance() will
 * be called with right after — dominates()'s behavior genuinely differs by stance now. */
export function dropDominated(list, stance = 'best') {
  return list.filter((x) => !list.some((y) => dominates(y, x, stance)));
}

// -----------------------------------------------------------------------------------------
// Rule 4 — rank by the chosen stance. Every candidate reaching this function already cleared
// rule 3 (a real "strong" or "capable" judged band for this task — "weak"/"unknown" never get
// this far), so all three stances rank strictly within that pre-cleared set; none of them can
// ever promote a candidate judgment itself rejected. What differs per stance is what breaks a
// tie, and for 'cheapest' specifically, WHETHER band/confidence even outrank cost at all — see
// the file header's rule 4 for the full rationale (rewritten 2026-09-07: a prior version put
// band/confidence ahead of cost for every stance, which made 'cheapest' silently return the same
// order as 'best' whenever candidates spanned more than one judged tier).
// -----------------------------------------------------------------------------------------
const costOrInf = (x) => (num(x.monthly_cost_usd) ? x.monthly_cost_usd : Infinity);

// GA-before-preview (2026-09-07): within the SAME band, a status:'preview' model never
// outranks a GA (or deprecated) one, full stop — no families/confidence/fit count can buy it
// back. Before this, families/confidence sat ahead of status, so a preview SKU with slightly
// more real-world signal (e.g. gemini-3-1-pro's 2 families vs. a GA rival's 1) could still take
// the #2/#3 spot under plain 'best' over a GA model people can actually pin a version of. This
// is a RANKING rule, not a filter — a preview model with no same-band GA rival (or a genuinely
// higher band) is untouched (see isDisqualifiedFromStartHere for the matching start_here rule,
// which also has to look at the full pre-domination candidate pool, not just survivors here).
const statusRank = (status) => (status === 'preview' ? 0 : 1);
/** Band, then GA-before-preview, then calibration's own `families` count (rule 3b — more
 * independent real-world signal outranks less, inside the same band+status), then usage_rank
 * (2026-09-07, evidence rewrite — lower is better, no rank counts as worse than any real one;
 * this is what puts Claude Opus 5, the actual #1 real-usage pick for "coding" at 37% of
 * OpenRouter spend, ahead of Kimi K3's one-point-higher raw score within their shared strong/high/
 * families:2 tier), then confidence — used as the primary key for 'best' and 'balanced', and as a
 * tie-break (after cost) for 'cheapest'. Every candidate reaching this function already cleared
 * rule 3, so band is always 'strong' or 'capable' here; this comparator still checks the general
 * case rather than hard-coding those two values, so it keeps working if a future band is ever
 * added. */
const byBandThenConfidence = (a, b) => bandRank(b.band) - bandRank(a.band)
  || statusRank(b.model.status) - statusRank(a.model.status)
  || (b.families ?? 0) - (a.families ?? 0)
  || usageRankValue(a) - usageRankValue(b)
  || confidenceRank(b.confidence) - confidenceRank(a.confidence);
/** Band -> confidence -> fit -> cost, the shared comparator 'best' uses outright and 'balanced'
 * uses within its in-budget set (see below) — kept as one function so the two stances can never
 * quietly drift apart on how they break a tie. Fit (not cost) is the first tie-break inside a
 * (band, confidence) tier: two candidates can share a band and confidence yet still carry very
 * different evidence — a real, measured coding_score/GPQA/etc. score differentiates them far more
 * than price does, and "best" is explicitly the price-agnostic stance (that's what "best,
 * regardless of price" means in practice — see data/eval/situations.json's S01). This is
 * unchanged from before the 2026-09-07 stance rewrite; that rewrite's actual bug (see the file
 * header) was 'cheapest' silently copying this exact order and never letting price matter at all
 * — 'best' itself was never broken. */
const byBandConfidenceFitCost = (a, b) => byBandThenConfidence(a, b) || b.fit - a.fit || costOrInf(a) - costOrInf(b);

export function rankByStance(list, stance) {
  const arr = [...list];

  if (stance === 'cheapest') {
    // Cost is the PRIMARY key, full stop — the cheapest candidate at the given volume wins
    // outright regardless of judged tier, as long as it already cleared rule 3's floor. Ties on
    // cost (including two candidates with an equally unknown cost) fall back to band, then
    // confidence, then raw fit — this is the actual fix for the bug this rewrite exists to kill.
    arr.sort((a, b) => costOrInf(a) - costOrInf(b) || byBandThenConfidence(a, b) || b.fit - a.fit);
    return arr;
  }

  if (stance === 'best') {
    arr.sort(byBandConfidenceFitCost);
    return arr;
  }

  // 'balanced' (default): restrict to the candidates priced at or under 2x the monthly cost of
  // the cheapest 'strong'-band candidate (or the cheapest 'capable'-band candidate if no priced
  // 'strong' one exists) — "the options a buyer already comparison-shopping the best pick could
  // actually justify" — then rank THAT in-budget set by band -> confidence -> fit -> cost, same as
  // 'best'. A candidate priced over that line (or with no known cost at all, so it can't be
  // judged "in budget" either way) is never dropped from the returned list — it's still ranked,
  // always after every in-budget candidate, so it can still show up lower in the shortlist.
  const known = (x) => num(x.monthly_cost_usd);
  const referencePool = list.filter((x) => x.band === 'strong' && known(x));
  const fallbackPool = referencePool.length ? referencePool : list.filter((x) => x.band === 'capable' && known(x));
  const inBudget = [];
  const overBudget = [];
  if (fallbackPool.length) {
    const cheapestRef = Math.min(...fallbackPool.map((x) => x.monthly_cost_usd));
    const threshold = cheapestRef * 2;
    for (const x of list) (known(x) && x.monthly_cost_usd <= threshold ? inBudget : overBudget).push(x);
  } else {
    // No priced strong/capable candidate at all (every cost is unknown) — nothing to bound the
    // budget against, so every candidate is treated as in-budget and ranked on band/confidence/
    // cost alone, same as 'best'.
    inBudget.push(...list);
  }
  inBudget.sort(byBandConfidenceFitCost);
  overBudget.sort(byBandConfidenceFitCost);
  return [...inBudget, ...overBudget];
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
    const pruned = dropDominated(candidates, stance);
    const ranked = rankByStance(pruned, stance);

    // start_here eligibility (see isDisqualifiedFromStartHere / the file header): find the
    // first-ranked candidate that ISN'T disqualified and move it to the front, keeping everyone
    // else's relative order — a disqualified model still shows up in the top 3 if it ranks there,
    // it just doesn't get the start_here flag. If every candidate is disqualified there's no
    // alternative to prefer, so the normal #1 keeps start_here (a rule with nothing better to
    // point at doesn't block the only option).
    //
    // The adoption check is evaluated against the FULL pre-dropDominated `candidates`, not the
    // pruned/ranked survivors — dropDominated only ever compares raw fit and cost (numbers), so a
    // broader-adoption same-band model that lost a pure price/fit domination check must still
    // count as "a real alternative existed" for the adoption gate, or the exact bug this rewrite
    // exists to kill (a numeric comparison quietly overriding a judgment-based rule) would sneak
    // back in through domination pruning instead of ranking.
    let startIdx = ranked.findIndex((item) => !isDisqualifiedFromStartHere(item, candidates, stance, input));
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
      // Rule 3b calibration (see the file header): how many of the 3 real-world signal families
      // (usage-top-10 / arena-top-10 / expert-default — scripts/derive-signals.mjs) back this
      // model for this task, and, when a claimed "strong" got downgraded to "capable" for lacking
      // them, the exact label a reader should see next to it. calibration_note is null on every
      // pick whose band was never downgraded (including a native "capable" record, which was
      // never a "strong" claim to begin with).
      families: item.families ?? 0,
      calibration_note: item.calibration?.note ?? null,
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
      // Two start_here disqualifiers exist now (isDisqualifiedFromStartHere): low adoption with a
      // same-band broader-adoption alternative, or (2026-09-07) preview status with a same-band GA
      // alternative. Re-derive which one actually applied for the reason text — both can't fire on
      // the same skipped item's OWN attributes at once (adoption and status are independent facts),
      // so checking adoption first and falling back to preview is unambiguous.
      const skipped = ranked[0];
      const reason = skipped.model.adoption === 'low'
        ? 'its adoption is low while a broader-adoption model of the same judged band is also a candidate'
        : 'it\'s a preview-status model and a GA model of the same judged band is also a candidate — pin a version before you\'d actually rely on a preview SKU';
      assumptions.push(`"${skipped.model.name}" ranked highest before the start_here check but wasn't set as start_here — ${reason}. It's still listed below if it placed in the top 3.`);
    }
    const missingPrice = top.filter((item) => item.monthly_cost_usd == null);
    for (const item of missingPrice) {
      assumptions.push(`"${item.model.name}" has no monthly cost shown — its price isn't on file in data/models.json (price_input/price_output missing), not a computation gap; cost comparisons involving it are unavailable until that's sourced.`);
    }

    tasks[taskId] = { shortlist, assumptions };
  }
  return { tasks };
}
