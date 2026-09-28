/* The facts the MCP tools hand back, kept apart from the MCP wiring so they can be tested
   without the SDK. Facts only: the editorial prose in models.json (ratings, strengths,
   weaknesses, usage tips, task copy) is never passed on. */

export const num = (v) => v === null || v === undefined || Number.isNaN(v);

// What the labs and reporters say about a model, as quotes with their source — grouped so a
// quote cited for several kinds of work appears once. Empty when nothing is sourced.
export function sourcedClaims(m) {
  const byQuote = new Map();
  for (const [task, entry] of Object.entries(m.task_fit_judged || {})) {
    for (const c of entry?.claims || []) {
      if (!c?.quote || !c?.source_url) continue;
      const key = c.quote + '\u0000' + c.source_url;
      if (!byQuote.has(key)) byQuote.set(key, { quote: c.quote, source_url: c.source_url, date: c.date || null, from: c.tier === 'lab' ? 'the lab' : 'a reporter or tester', kinds_of_work: [] });
      byQuote.get(key).kinds_of_work.push(task);
    }
  }
  return [...byQuote.values()];
}

// coding_score is SWE-bench Verified where the lab publishes it; otherwise it is Modelproof's own
// estimate from other sourced results, and coding_score_is_estimate says so (the site marks it "est").
export const brief = (m) => {
  const swe = num(m.benchmarks?.swe_bench) ? null : m.benchmarks.swe_bench;
  const coding = num(m.coding_score) ? null : m.coding_score;
  return {
    name: m.name, vendor: m.vendor,
    status: m.status || null,
    released: m.released || null,
    coding_score: coding,
    coding_score_is_estimate: coding !== null && swe === null,
    swe_bench: swe,
    gpqa: num(m.benchmarks?.gpqa) ? null : m.benchmarks.gpqa,
    price_input_per_1m: num(m.price_input) ? null : m.price_input,
    price_output_per_1m: num(m.price_output) ? null : m.price_output,
    context_window: m.context_window ?? null,
    sourced_claims: sourcedClaims(m),
  };
};

export const disclaimer = (asOf) => `Data as of ${asOf}. Prices, context, swe_bench and gpqa are published figures with sources. coding_score is SWE-bench Verified where published; otherwise it is Modelproof's own estimate from other sourced results, marked coding_score_is_estimate: true. null = no public figure. Verify cost-critical prices against the vendor's own page. Independent tool, not affiliated with any vendor.`;
