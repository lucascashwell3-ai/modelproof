/* ============================================================
   MODELproof — client-side decision engine
   Loads data/models.json and renders: recommender, cost/capability
   chart, compare table, releases feed. Honest with missing data.
   ============================================================ */

const state = {
  data: null,
  // faceted console: task + budget + optional labs COMPOSE (no more By-task/By-lab modes)
  goal: 'coding',        // the task facet (single-select)
  priority: 48,          // the budget facet: 0 = cheapest … 100 = best
  labs: [],              // vendors the user pays for; [] = all labs. A filter layered on the task, not a mode.
  filter: 'all',
  showAll: false,        // compare table defaults to the common flagships; opt in to all 21
  sort: { key: 'coding_score', dir: 'desc' },
  expanded: new Set(),
  compare: [],           // model ids on the side-by-side board (2–5)
  cmpCustom: false,      // true once the user hand-picks — stops auto-reseeding from the engine
};
const CMP_MAX = 5;

// compare-table default: one flagship per major lab (neutral — no lab over-represented).
// The full 21 (incl. cheap/specialized tiers) are one click away via "Show all".
const COMMON_IDS = ['claude-opus-4-8', 'gpt-5-6-sol', 'gemini-3-1-pro', 'grok-4-5', 'deepseek-v4-pro', 'llama-4-maverick', 'qwen3-max'];

// vendor -> the brand people actually say ("I use Claude / ChatGPT / Grok…")
const LAB_LABEL = {
  'Anthropic': 'Claude', 'OpenAI': 'ChatGPT', 'Google': 'Gemini', 'xAI': 'Grok',
  'DeepSeek': 'DeepSeek', 'Meta': 'Llama', 'Alibaba (Qwen)': 'Qwen', 'Moonshot AI': 'Kimi',
  'Mistral AI': 'Mistral',
};
// order the lab chips by how commonly people reach for them (unknown vendors fall to the end)
const LAB_ORDER = ['Anthropic', 'OpenAI', 'Google', 'xAI', 'DeepSeek', 'Meta', 'Alibaba (Qwen)', 'Moonshot AI', 'Mistral AI'];
const PRIO_LABEL = { 6: 'cheapest', 28: 'value', 48: 'balanced', 85: 'best' };

// which benchmark a goal cares about
const GOAL_METRIC = {
  coding: 'coding_score',   // unified 0-100 coding score (blends SWE-bench + other sourced signals)
  research: 'gpqa',
  writing: 'lmarena_elo',
  'cheap-bulk': 'mmlu_pro',
};

// data still carries the finer-grained best_for tags; these map goals → tags
// that satisfy them (agentic folds into coding; reasoning/research → research).
const GOAL_TAGS = {
  coding: ['coding', 'agentic'],
  research: ['reasoning', 'research'],
  writing: ['writing'],
  'cheap-bulk': ['cheap-bulk'],
};

const GOAL_DESC = {
  coding: 'Writing, fixing & refactoring code — including multi-step agent tasks. Ranked on a 0–100 coding score: SWE-bench where it exists, otherwise sourced signals (LMArena Code Elo, AA Coding Index) so new models aren\'t stuck at "—".',
  research: 'Deep thinking, analysis & planning. Ranked on graduate-level reasoning (GPQA).',
  writing: 'Drafting prose, emails & content. Ranked on general ability + human preference — there is no clean writing benchmark.',
  'cheap-bulk': 'High-volume simple work — classification, tagging, extraction. Cheapest capable option first.',
};

const TAG_LABEL = {
  coding: 'coding', agentic: 'agentic', writing: 'writing', reasoning: 'reasoning',
  'cheap-bulk': 'cheap bulk', vision: 'vision', 'long-context': 'long context',
  speed: 'speed', research: 'research',
};

// ---------- helpers ----------
const $ = (s, r = document) => r.querySelector(s);
const el = (t, c) => { const e = document.createElement(t); if (c) e.className = c; return e; };
const num = (v) => (v === null || v === undefined || Number.isNaN(v));
// coding_score lives on the model root; other metrics live under benchmarks
const capVal = (m, metric) => (metric === 'coding_score' ? m.coding_score : m.benchmarks?.[metric]);

function fmtPrice(v) {
  if (num(v)) return '<span class="na">—</span>';
  if (v < 1) return '$' + v.toFixed(2);
  if (v < 10) return '$' + v.toFixed(2);
  return '$' + v.toFixed(0);
}
function fmtCtx(t) {
  if (num(t)) return '<span class="na">—</span>';
  if (t >= 1000000) return (t / 1000000).toFixed(t % 1000000 ? 1 : 0) + 'M';
  if (t >= 1000) return Math.round(t / 1000) + 'K';
  return '' + t;
}
function fmtScore(v) { return num(v) ? '<span class="na">—</span>' : v + (v <= 100 ? '%' : ''); }
function fmtPriceRange(m) {
  if (num(m.price_input) && num(m.price_output)) return '<span class="na">—</span>';
  return `${fmtPrice(m.price_input)}<span class="pslash">/</span>${fmtPrice(m.price_output)}`;
}

// normalize an array of {v} ignoring nulls → returns fn(v)->0..1
function normalizer(values, { log = false } = {}) {
  const vals = values.filter((v) => !num(v)).map((v) => (log ? Math.log(v) : v));
  if (!vals.length) return () => 0.5;
  const min = Math.min(...vals), max = Math.max(...vals);
  if (max === min) return () => 0.5;
  return (v) => {
    if (num(v)) return 0.5;
    return ((log ? Math.log(v) : v) - min) / (max - min);
  };
}

// ---------- recommender ----------
// Build a per-model capability estimate for a goal. A model is only "measured"
// if it has the goal's own benchmark OR a proxy from another sourced benchmark
// (SWE-bench / GPQA). Truly unmeasured models are excluded from quality-goal
// recommendations — we never crown a model we have no performance data for.
// Goals with no reliable dedicated benchmark fall back to a general-ability
// blend. Coding/agentic/reasoning each have a direct metric and must NOT be
// cross-proxied (a GPQA reasoning score is not evidence of coding skill).
const PROXY_GOALS = new Set(['writing']);

function scorer(models, goal) {
  const metric = GOAL_METRIC[goal];
  const primaryNorm = normalizer(models.map((m) => capVal(m, metric)));
  const sweNorm = normalizer(models.map((m) => m.coding_score));
  const gpqaNorm = normalizer(models.map((m) => m.benchmarks?.gpqa));
  const priceNorm = normalizer(models.map((m) => m.price_output), { log: true });
  const allowProxy = PROXY_GOALS.has(goal);

  return (m) => {
    const primary = capVal(m, metric);
    let cap, measured, via;
    if (!num(primary)) {
      cap = primaryNorm(primary); measured = true; via = metric;
    } else if (allowProxy) {
      const parts = [];
      if (!num(m.coding_score)) { parts.push(sweNorm(m.coding_score)); via = via || 'coding'; }
      if (!num(m.benchmarks?.gpqa)) { parts.push(gpqaNorm(m.benchmarks.gpqa)); via = via || 'gpqa'; }
      if (parts.length) { cap = (parts.reduce((a, b) => a + b, 0) / parts.length) * 0.9; measured = true; }
      else { cap = 0.3; measured = false; via = null; }
    } else {
      cap = 0.3; measured = false; via = null;   // no direct score for a strict goal
    }
    const cheap = 1 - priceNorm(m.price_output);
    return { cap, cheap, measured, via };
  };
}

function score(models, goal, priority) {
  const f = scorer(models, goal);
  // capability floor: even "Cheapest" keeps ~22% weight on ability, so a weak model
  // can't win a quality goal on price alone; "Best" tops out ~90%.
  const w = 0.22 + 0.68 * (priority / 100);
  const bulk = goal === 'cheap-bulk';
  const tags = GOAL_TAGS[goal] || [goal];
  return models
    .map((m) => {
      const hasTag = (m.best_for || []).some((t) => tags.includes(t));
      const { cap, cheap, measured, via } = f(m);
      let s = bulk ? 0.30 * cap + 0.70 * cheap : w * cap + (1 - w) * cheap;
      if (hasTag) s += 0.03;               // small nudge for explicit fit
      // cheap-bulk is price-led (include everything); quality goals require a sourced score
      const inRec = bulk ? true : measured;
      return { m, s, measured, via, inRec };
    })
    .filter((x) => x.inRec)
    .sort((a, b) => b.s - a.s);
}

// pick the most defensible headline number for a goal: the goal's own metric,
// else a sourced proxy, else an honest dash.
function headlineStat(m, metric) {
  const v = capVal(m, metric);
  if (!num(v)) return { value: fmtScore(v), label: metricLabel(metric) };
  if (!num(m.benchmarks?.gpqa)) return { value: fmtScore(m.benchmarks.gpqa), label: 'GPQA' };
  if (!num(m.coding_score)) return { value: fmtScore(m.coding_score), label: 'Coding' };
  return { value: '<span class="na">—</span>', label: metricLabel(metric) };
}

// the field the recommender ranks: all models, or (if labs are chosen) just those vendors
function currentModels() {
  return state.labs.length ? state.data.models.filter((m) => state.labs.includes(m.vendor)) : state.data.models;
}
const TASK_LABEL = { coding: 'Coding', research: 'Strategy', writing: 'Writing', 'cheap-bulk': 'Cheap bulk' };
// the read-only sentence the console echoes back — the tool restating your query
function queryText() {
  const labs = state.labs.length ? state.labs.map((v) => LAB_LABEL[v] || v).join(' + ') : 'any lab';
  return { task: TASK_LABEL[state.goal] || state.goal, budget: PRIO_LABEL[state.priority] || 'balanced', labs };
}

function renderResult() {
  // a generated prompt reflects the selection at generation time — reset it when the selection changes
  const pp = document.getElementById('promptPanel'); if (pp) pp.hidden = true;
  const cs = document.getElementById('copyStatus'); if (cs) cs.textContent = '';
  const echo = $('#queryEcho');
  if (echo) { const q = queryText(); echo.innerHTML = `${q.task} · ${q.budget} cost · <b>${q.labs}</b>`; }
  renderVerdict();
  seedCompare();     // the side-by-side board follows the engine until the user hand-picks
}

// ---------- side-by-side comparator ----------
// Auto-seeded from the engine's answer (top pick + runners, or the chosen lab's best);
// the user can hand-pick 2–5 models, which stops the auto-reseeding.
function seedCompare() {
  if (!state.cmpCustom) {
    let ids = score(currentModels(), state.goal, state.priority).slice(0, 3).map((r) => r.m.id);
    if (ids.length < 2) {   // a narrow lab pick — top up from the whole field so there's something to compare
      for (const r of score(state.data.models, state.goal, state.priority)) {
        if (!ids.includes(r.m.id)) ids.push(r.m.id);
        if (ids.length >= 3) break;
      }
    }
    if (ids.length >= 2) state.compare = ids;
  }
  renderCompare();
}

function renderCompare() {
  const all = state.data.models;
  const pk = $('#cmpPicker'), bd = $('#cmpBoard');
  if (!pk || !bd) return;

  pk.innerHTML = all.map((m) => {
    const on = state.compare.includes(m.id);
    return `<button class="chip ${on ? 'is-active' : ''}" data-cmp="${m.id}" type="button">${m.name}</button>`;
  }).join('');
  pk.querySelectorAll('[data-cmp]').forEach((b) => b.addEventListener('click', () => {
    const id = b.getAttribute('data-cmp');
    const i = state.compare.indexOf(id);
    if (i >= 0) { if (state.compare.length <= 2) return; state.compare.splice(i, 1); }
    else { if (state.compare.length >= CMP_MAX) return; state.compare.push(id); }
    state.cmpCustom = true;
    renderCompare();
  }));

  const ms = state.compare.map((id) => all.find((m) => m.id === id)).filter(Boolean);
  bd.style.setProperty('--n', ms.length);
  const confDot = (m) => `<i class="conf conf-${m.confidence || 'low'}" title="confidence: ${m.confidence || 'low'}"></i>`;
  const rows = [
    ['', (m) => `<div class="cmp-model">${m.name}</div><div class="cmp-vendor">${m.vendor}</div>`],
    ['Best for', (m) => (m.best_for || []).slice(0, 3).map((t) => `<span class="mini-tag">${TAG_LABEL[t] || t}</span>`).join(' ') || '<span class="na">—</span>'],
    ['Coding /100', (m) => `<span class="cmp-num">${num(m.coding_score) ? '<span class="na">—</span>' : m.coding_score}</span>${num(m.coding_score) ? '' : confDot(m)}`],
    ['GPQA', (m) => `<span class="cmp-num">${fmtScore(m.benchmarks?.gpqa)}</span>`],
    ['Context', (m) => `<span class="cmp-num">${fmtCtx(m.context_window)}</span>`],
    ['$ in / 1M', (m) => `<span class="cmp-num">${fmtPrice(m.price_input)}</span>`],
    ['$ out / 1M', (m) => `<span class="cmp-num">${fmtPrice(m.price_output)}</span>`],
    ['Verdict', (m) => `<span class="cmp-verdict">${m.verdict || '<span class="na">—</span>'}</span>`],
  ];
  bd.innerHTML = rows.map(([label, fn], ri) =>
    `<div class="cmp-cell cmp-lbl${ri === 0 ? ' cmp-head' : ''}">${label}</div>` +
    ms.map((m) => `<div class="cmp-cell${ri === 0 ? ' cmp-head' : ''}">${fn(m)}</div>`).join('')
  ).join('');
}

function renderVerdict() {
  const box = $('#result');
  if (!box) return;
  const ranked = score(currentModels(), state.goal, state.priority);
  if (!ranked.length) {
    const who = state.labs.length ? state.labs.map((v) => LAB_LABEL[v] || v).join(' + ') : 'this goal';
    box.innerHTML = `<div class="empty">No sourced model for <b>${who}</b> on this task yet. Add another lab, or browse the full table below.</div>`;
    renderChart();
    return;
  }
  const top = ranked[0].m;
  const runners = ranked.slice(1, 3).map((r) => r.m);
  state.pickId = top.id;

  const metric = GOAL_METRIC[state.goal];
  const hv = headlineStat(top, metric);
  const caption = state.goal === 'cheap-bulk'
    ? 'Ranked mostly on price. Cheapest capable option first.'
    : 'Ranked on sourced benchmarks + price. Models with no sourced score for this task sit in the full table, not here.';

  box.innerHTML = `
    <div class="pick">
      <span class="pick__flag">Your pick</span>
      <div class="pick__name">${top.name}</div>
      <div class="pick__vendor">${top.vendor}</div>
      <p class="pick__verdict">${top.verdict || 'A strong all-round choice for this goal.'}</p>
      <div class="pick__stats">
        <div class="stat"><span class="stat__v">${hv.value}</span><span class="stat__l">${hv.label}</span></div>
        <div class="stat"><span class="stat__v">${fmtPrice(top.price_output)}</span><span class="stat__l">out / 1M tok</span></div>
        <div class="stat"><span class="stat__v">${fmtPrice(top.price_input)}</span><span class="stat__l">in / 1M tok</span></div>
        <div class="stat"><span class="stat__v">${fmtCtx(top.context_window)}</span><span class="stat__l">context</span></div>
      </div>
    </div>
    <div class="runners">
      ${runners.map((m) => { const rv = headlineStat(m, metric); return `
        <div class="runner" data-jump="${m.id}">
          <div class="runner__name">${m.name}</div>
          <div class="runner__meta"><b>${rv.value}</b> ${rv.label} · <b>${fmtPrice(m.price_output)}</b>/1M out</div>
        </div>`; }).join('')}
    </div>
    ${labsFootnote(top, metric)}
    <p class="rec-caption">${caption}</p>`;

  box.querySelectorAll('[data-jump]').forEach((n) =>
    n.addEventListener('click', () => {
      document.getElementById('compare').scrollIntoView({ behavior: 'smooth' });
      const id = n.getAttribute('data-jump');
      state.expanded.add(id);
      renderTable();
    })
  );
  renderChart();
}

// independence guardrail: when labs are constrained and a materially cheaper OR higher-scoring
// model exists OUTSIDE them, state the fact — neutral, cost-first, never "switch to X".
function labsFootnote(top, metric) {
  if (!state.labs.length) return '';
  const globalTop = (score(state.data.models, state.goal, state.priority)[0] || {}).m;
  if (!globalTop || state.labs.includes(globalTop.vendor) || globalTop.id === top.id) return '';
  const gp = globalTop.price_output, tp = top.price_output;
  const gCap = capVal(globalTop, metric), tCap = capVal(top, metric);
  const cheaper = !num(gp) && !num(tp) && gp <= tp * 0.8;
  const better = !num(gCap) && !num(tCap) && gCap > tCap;
  if (!cheaper && !better) return '';
  const gv = headlineStat(globalTop, metric);
  return `<p class="rec-footnote">Outside your labs, <b>${globalTop.name}</b> scores ${gv.value} ${gv.label} at ${fmtPrice(gp)}/1M out — vs your pick's ${headlineStat(top, metric).value} at ${fmtPrice(tp)}. Your call.</p>`;
}

function metricLabel(metric) {
  return { coding_score: 'Coding', swe_bench: 'SWE-bench', gpqa: 'GPQA', aime: 'AIME', lmarena_elo: 'LMArena Elo', mmlu_pro: 'MMLU-Pro' }[metric] || metric;
}

// ---------- labs facet: multi-select vendor chips + an "All labs" default ----------
const LAB_ALL = '__all__';
function renderLabChips() {
  if (!state.data) return;
  const vendors = [...new Set(state.data.models.map((m) => m.vendor))]
    .sort((a, b) => (LAB_ORDER.indexOf(a) + 1 || 99) - (LAB_ORDER.indexOf(b) + 1 || 99));
  const allOn = state.labs.length === 0;
  const chip = (v, label, on) => `<button class="chip labchip ${on ? 'is-active' : ''}" data-lab="${v}" role="button" aria-pressed="${on}">${label}</button>`;
  const html = chip(LAB_ALL, 'All labs', allOn) + vendors.map((v) => chip(v, LAB_LABEL[v] || v, state.labs.includes(v))).join('');
  document.querySelectorAll('.labctl').forEach((c) => { c.innerHTML = html; });
  document.querySelectorAll('[data-lab]').forEach((b) =>
    b.addEventListener('click', () => setLabs(b.getAttribute('data-lab')))
  );
}

// ---------- prompt generator: a paste-in "model advisor" for the user's own AI ----------
const GOAL_PLAIN = {
  coding: 'writing, fixing and refactoring code (including multi-step agent tasks)',
  research: 'research, analysis, reasoning and strategy',
  writing: 'writing and drafting prose, emails and content',
  'cheap-bulk': 'high-volume simple work like classification, tagging and extraction',
};
function numPlain(v, money) { if (num(v)) return 'n/a'; if (money) return '$' + (v < 10 ? v.toFixed(2) : String(Math.round(v))); return String(v); }
function ctxPlain(t) { if (num(t)) return ''; if (t >= 1e6) return (t / 1e6).toFixed(t % 1e6 ? 1 : 0) + 'M'; if (t >= 1e3) return Math.round(t / 1e3) + 'K'; return '' + t; }

function modelFactLine(m) {
  const bits = [];
  if (!num(m.coding_score)) bits.push(`coding ${m.coding_score}/100`);
  if (!num(m.benchmarks?.gpqa)) bits.push(`GPQA ${m.benchmarks.gpqa}`);
  bits.push((num(m.price_input) && num(m.price_output)) ? 'price n/a'
    : `${numPlain(m.price_input, true)} in / ${numPlain(m.price_output, true)} out per 1M`);
  const ctx = ctxPlain(m.context_window); if (ctx) bits.push(`${ctx} context`);
  const good = (m.best_for || []).slice(0, 3).map((t) => TAG_LABEL[t] || t).join(', ');
  return `- ${m.name} (${m.vendor}): ${bits.join('; ')}${good ? `; good for ${good}` : ''}.`;
}

const DATA_URL = 'https://lucascashwell3-ai.github.io/modelproof/data/models.json';
function buildAdvisorPrompt() {
  const asof = state.data.as_of || 'recently';
  const prio = PRIO_LABEL[state.priority] || 'balanced';
  // facts list ALL models (so the advisor can name a cheaper option outside my labs), but MY SETUP
  // states my labs as a soft preference — the same "task + optional lab filter" the site uses.
  const scope = state.labs.length
    ? `I mostly work on ${GOAL_PLAIN[state.goal] || state.goal}. I mainly pay for ${state.labs.map((v) => LAB_LABEL[v] || v).join(' + ')}, so prefer those — but if a model outside them is much cheaper or clearly better for a task, name it as an option and let me decide.`
    : `I mostly work on ${GOAL_PLAIN[state.goal] || state.goal}. You may recommend from any model listed below.`;
  const list = state.data.models.slice().sort((a, b) => (num(b.coding_score) ? -1 : b.coding_score) - (num(a.coding_score) ? -1 : a.coding_score));
  const facts = list.map(modelFactLine).join('\n');

  return `You are my AI model-selection advisor. When I describe a task, tell me which model to use and why — optimizing for a "${prio}" balance of cost versus quality, and always honest about cost.

MY SETUP
${scope}

STAY CURRENT (do this first if you can)
Before advising, fetch the live data at ${DATA_URL} and use those numbers — they are kept up to date. If you can't browse, use the dated snapshot below and warn me it may be stale.

MODEL FACTS — a snapshot from MODELproof, dated ${asof}. Prices are USD per 1M tokens. Benchmarks are directional (coding is a 0–100 blended score; GPQA is graduate-level reasoning). "n/a" means the figure wasn't publicly sourced — treat it as unknown, never guess. Verify anything cost-critical against the vendor's own pricing page.
${facts}

HOW TO ADVISE ME
1. For any task I describe, recommend ONE model in a sentence, with the reason.
2. If a cheaper model is nearly as good for that task, name it and let me choose.
3. Call it out when I'm about to use a premium model for something a cheap one handles well — save me money.
4. Recommend on merit and cost only. Stay neutral; do not favor any company.
5. Never invent a price or benchmark. If a number is "n/a", say it's unknown rather than guessing.
6. This snapshot is dated ${asof}. If it is now much later and you couldn't fetch live data, remind me that AI prices and models change fast and to re-check current figures at ${DATA_URL}.`;
}

// ---------- cost vs capability chart ----------
// bayer-dithered density field (bright top-left, dissolving toward bottom-right) as a
// data-URI — the "sweet spot" shading, in the same dither language as the hero
function ditherFieldURI(w, h) {
  const B = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];
  const cw = Math.max(2, Math.round(w / 4)), ch = Math.max(2, Math.round(h / 4));
  const c = document.createElement('canvas'); c.width = cw; c.height = ch;
  const x = c.getContext('2d'); x.fillStyle = 'rgba(242,193,78,0.34)';
  for (let j = 0; j < ch; j++) for (let i = 0; i < cw; i++) {
    const v = Math.max(0, 1 - (i / cw) * 1.5) * Math.max(0, 1 - (j / ch) * 1.5) * 0.6;
    if (v > (B[j & 3][i & 3] + 0.5) / 16) x.fillRect(i, j, 1, 1);
  }
  return c.toDataURL();
}

// a model as a halftone dot-cluster (dense core dissolving outward) instead of a flat circle
function ditherCluster(color, n) {
  let s = '';
  for (let a = 0; a < n; a++) {
    const rr = Math.sqrt(a) * 2.7, t = a * 2.4;
    const al = Math.max(0.25, 1 - a / n);
    s += `<rect x="${(Math.cos(t) * rr - 1.5).toFixed(1)}" y="${(Math.sin(t) * rr - 1.5).toFixed(1)}" width="3" height="3" fill="${color}" opacity="${al.toFixed(2)}"/>`;
  }
  return s;
}

function renderChart() {
  const wrap = $('#chart');
  const metric = GOAL_METRIC[state.goal];
  const pts = state.data.models
    .map((m) => ({ m, x: m.price_output, y: capVal(m, metric) }))
    .filter((p) => !num(p.x) && !num(p.y));

  $('#mapLegend').innerHTML =
    `<span><i style="background:var(--gold)"></i>On the value frontier — a smart buy</span>
     <span><i style="background:rgba(233,230,223,0.45)"></i>Beaten on price + quality</span>
     <span class="dim">↑ ${metricLabel(metric)} &nbsp;·&nbsp; → $ / 1M out (log)</span>`;

  if (pts.length < 2) {
    wrap.innerHTML = `<div class="empty" style="padding:60px 0">Not enough sourced price + ${metricLabel(metric)} data to plot this goal yet.</div>`;
    return;
  }

  const W = 920, H = 460, padL = 62, padR = 28, padT = 30, padB = 56;
  const plotW = W - padL - padR, plotH = H - padT - padB;

  const xN = normalizer(pts.map((p) => p.x), { log: true });
  const yvals = pts.map((p) => p.y);
  const yMin = Math.min(...yvals), yMax = Math.max(...yvals);
  const yPad = (yMax - yMin) * 0.12 || 5;
  const y0 = yMin - yPad, y1 = yMax + yPad;

  const X = (v) => padL + xN(v) * plotW;   // v = a price value
  const Y = (v) => padT + (1 - (v - y0) / (y1 - y0)) * plotH;

  // nice x ticks across the sourced price range
  const prices = pts.map((p) => p.x);
  const pMin = Math.min(...prices), pMax = Math.max(...prices);
  const tickCandidates = [0.1, 0.3, 0.5, 1, 2, 3, 5, 10, 15, 30, 60, 100, 150];
  const xticks = tickCandidates.filter((t) => t >= pMin * 0.9 && t <= pMax * 1.1);
  if (xticks.length < 2) { xticks.length = 0; xticks.push(pMin, pMax); }

  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Model map: cost versus capability, with the value frontier">`;

  // the value (Pareto) frontier: models nothing else beats on BOTH price and capability
  const frontier = pts
    .filter((p) => !pts.some((q) => q !== p && q.x <= p.x && q.y >= p.y && (q.x < p.x || q.y > p.y)))
    .sort((a, b) => a.x - b.x || a.y - b.y);
  const onFrontier = new Set(frontier.map((p) => p.m.id));
  const drawFrontier = frontier.length >= 3 && pts.length >= 5;   // else a 2-step line looks thin — fall back to scatter

  // dither fill of the strong region (above/left of the frontier) — the texture, made meaningful
  if (drawFrontier) {
    const fx = (p) => X(p.x).toFixed(1), fy = (p) => Y(p.y).toFixed(1);
    const poly = [`${fx(frontier[0])},${padT}`, `${fx(frontier[0])},${fy(frontier[0])}`];
    for (let i = 1; i < frontier.length; i++) { poly.push(`${fx(frontier[i])},${Y(frontier[i - 1].y).toFixed(1)}`); poly.push(`${fx(frontier[i])},${fy(frontier[i])}`); }
    poly.push(`${fx(frontier[frontier.length - 1])},${padT}`);
    svg += `<defs><clipPath id="froClip"><polygon points="${poly.join(' ')}"/></clipPath></defs>`;
    svg += `<image href="${ditherFieldURI(plotW, plotH)}" x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" preserveAspectRatio="none" style="image-rendering:pixelated" opacity="0.5" clip-path="url(#froClip)"/>`;
  }

  // axes
  svg += `<line class="axis-line" x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}"/>`;
  svg += `<line class="axis-line" x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + plotH}"/>`;

  xticks.forEach((t) => {
    const xx = X(t);
    svg += `<text class="axis-lbl" x="${xx}" y="${padT + plotH + 18}" text-anchor="middle">$${t < 1 ? t : t.toFixed(0)}</text>`;
    svg += `<line class="grid-line" x1="${xx}" y1="${padT}" x2="${xx}" y2="${padT + plotH}" opacity="0.3"/>`;
  });
  [y0, (y0 + y1) / 2, y1].forEach((v) => {
    const yy = Y(v);
    svg += `<text class="axis-lbl" x="${padL - 10}" y="${yy + 4}" text-anchor="end">${Math.round(v)}</text>`;
  });
  svg += `<text class="axis-title" x="${padL + plotW / 2}" y="${H - 10}" text-anchor="middle">PRICE — $ / 1M OUTPUT TOKENS (LOG)</text>`;
  svg += `<text class="axis-title" transform="translate(16 ${padT + plotH / 2}) rotate(-90)" text-anchor="middle">${metricLabel(metric).toUpperCase()} →</text>`;

  // the gold staircase — the best capability available at each price
  if (drawFrontier) {
    let d = `M ${X(frontier[0].x).toFixed(1)} ${Y(frontier[0].y).toFixed(1)}`;
    for (let i = 1; i < frontier.length; i++) d += ` L ${X(frontier[i].x).toFixed(1)} ${Y(frontier[i - 1].y).toFixed(1)} L ${X(frontier[i].x).toFixed(1)} ${Y(frontier[i].y).toFixed(1)}`;
    svg += `<path class="frontier-line" d="${d}" fill="none" stroke="var(--gold)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" opacity="0.85"/>`;
  }

  // teaching moment: if the pick sits BELOW the frontier, connect it to the model that beats it
  const pickPt = pts.find((p) => p.m.id === state.pickId);
  if (drawFrontier && pickPt && !onFrontier.has(pickPt.m.id)) {
    const dom = frontier.filter((q) => q.x <= pickPt.x && q.y >= pickPt.y).sort((a, b) => (b.y - a.y) || (a.x - b.x))[0];
    if (dom) svg += `<line x1="${X(pickPt.x).toFixed(1)}" y1="${Y(pickPt.y).toFixed(1)}" x2="${X(dom.x).toFixed(1)}" y2="${Y(dom.y).toFixed(1)}" stroke="var(--gold)" stroke-width="1.4" stroke-dasharray="3 3" opacity="0.55"/>`;
  }

  // dots: frontier + pick burn gold and labelled; dominated models recede to pale gray
  pts.forEach((p) => {
    const cx = X(p.x), cy = Y(p.y);
    const isPick = p.m.id === state.pickId;
    const fro = drawFrontier && onFrontier.has(p.m.id);
    const hot = isPick || fro;
    const nearRight = cx > padL + plotW * 0.72;
    const lx = nearRight ? -12 : 12;
    svg += `<g class="dot ${isPick ? 'is-pick' : ''} ${fro ? 'is-frontier' : ''}" data-id="${p.m.id}" transform="translate(${cx.toFixed(1)} ${cy.toFixed(1)})">`;
    svg += `<circle class="d-hit" r="24" fill="transparent"/>`;
    svg += `<g class="dot__marks">${ditherCluster(hot ? '#f2c14e' : 'rgba(233,230,223,0.42)', isPick ? 44 : hot ? 28 : 16)}</g>`;
    svg += `<text class="dot__label" x="${lx}" y="4" text-anchor="${nearRight ? 'end' : 'start'}">${p.m.name}</text>`;
    svg += `</g>`;
  });

  svg += `</svg>`;
  wrap.innerHTML = svg;

  // tooltips
  wrap.querySelectorAll('.dot').forEach((g) => {
    const id = g.getAttribute('data-id');
    const m = state.data.models.find((x) => x.id === id);
    g.addEventListener('mousemove', (e) => showTip(e, m, metric));
    g.addEventListener('mouseleave', hideTip);
    g.addEventListener('click', () => {
      hideTip();
      state.expanded.add(id);
      renderTable();
      document.getElementById('compare').scrollIntoView({ behavior: 'smooth' });
    });
  });
}

function showTip(e, m, metric) {
  const tip = $('#tooltip');
  tip.innerHTML =
    `<b>${m.name}</b> <span style="color:var(--ink-3)">${m.vendor}</span>
     <div class="tt-row"><span>${metricLabel(metric)}</span><span>${fmtScore(m.benchmarks?.[metric])}</span></div>
     <div class="tt-row"><span>$ out / 1M</span><span>${fmtPrice(m.price_output)}</span></div>
     <div class="tt-row"><span>context</span><span>${fmtCtx(m.context_window)}</span></div>`;
  tip.classList.add('show');
  const pad = 14;
  let x = e.clientX + pad, y = e.clientY + pad;
  if (x + 250 > window.innerWidth) x = e.clientX - 250;
  tip.style.left = x + 'px'; tip.style.top = y + 'px';
}
function hideTip() { const t = $('#tooltip'); if (t) t.classList.remove('show'); }

// ---------- compare table ----------
function renderFilters() {
  const goals = ['all', 'coding', 'research', 'writing', 'cheap-bulk', 'vision', 'long-context', 'speed'];
  const box = $('#filters');
  if (!box) return;
  box.innerHTML = goals.map((g) =>
    `<button class="chip ${state.filter === g ? 'is-active' : ''}" data-f="${g}">${g === 'all' ? 'All' : TAG_LABEL[g] || g}</button>`
  ).join('');
  box.querySelectorAll('.chip').forEach((c) =>
    c.addEventListener('click', () => { state.filter = c.getAttribute('data-f'); renderFilters(); renderTable(); })
  );
}

function sortedModels() {
  let list = state.data.models.slice();
  if (state.filter !== 'all') {
    const syn = GOAL_TAGS[state.filter] || [state.filter];
    list = list.filter((m) => (m.best_for || []).some((t) => syn.includes(t)));
  } else if (!state.showAll) {
    list = list.filter((m) => COMMON_IDS.includes(m.id));   // default: the common flagships only
  }
  const { key, dir } = state.sort;
  const val = (m) => {
    if (key === 'name') return m.name.toLowerCase();
    if (key === 'best') return (m.best_for || []).length;
    if (key === 'context') return m.context_window;
    if (key === 'price_input') return m.price_input;
    if (key === 'price_output') return m.price_output;
    if (key === 'coding_score') return m.coding_score;
    return m.benchmarks?.[key];
  };
  list.sort((a, b) => {
    const va = val(a), vb = val(b);
    if (num(va) && num(vb)) return 0;
    if (num(va)) return 1;              // nulls always last
    if (num(vb)) return -1;
    if (typeof va === 'string') return dir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
    return dir === 'asc' ? va - vb : vb - va;
  });
  return list;
}

function renderTable() {
  const body = $('#tblBody');
  if (!body) return;
  const list = sortedModels();
  body.innerHTML = '';
  list.forEach((m) => {
    const tr = el('tr');
    tr.innerHTML = `
      <td class="cell-model col-model"><b>${m.name}</b><span>${m.vendor}</span></td>
      <td class="cell-best col-best"><div class="tags">${(m.best_for || []).slice(0, 3).map((t) => `<span class="mini-tag">${TAG_LABEL[t] || t}</span>`).join('') || '<span class="na">—</span>'}</div></td>
      <td class="num col-code">${num(m.coding_score) ? '<span class="na">—</span>' : m.coding_score}<span class="conf conf-${m.coding_confidence}" title="basis: ${m.coding_basis || '—'}"></span></td>
      <td class="num col-ctx">${fmtCtx(m.context_window)}</td>
      <td class="num col-price">${fmtPriceRange(m)}<span class="conf conf-${m.confidence}" title="confidence: ${m.confidence}"></span></td>
      <td class="is-right col-exp" style="text-align:right;color:var(--ink-4)">${state.expanded.has(m.id) ? '−' : '+'}</td>`;
    tr.addEventListener('click', () => {
      if (state.expanded.has(m.id)) state.expanded.delete(m.id); else state.expanded.add(m.id);
      renderTable();
    });
    body.appendChild(tr);

    if (state.expanded.has(m.id)) {
      const mr = el('tr', 'row-more');
      const td = el('td'); td.colSpan = 6;
      td.innerHTML = `
        <div class="rm-grid">
          <div>
            <h4>Verdict</h4>
            <p>${m.verdict || '—'}</p>
            <h4 style="margin-top:14px">Strengths</h4>
            <ul>${(m.strengths || []).map((s) => `<li>${s}</li>`).join('') || '<li class="na">—</li>'}</ul>
          </div>
          <div>
            <h4>Watch out for</h4>
            <ul>${(m.weaknesses || []).map((s) => `<li>${s}</li>`).join('') || '<li class="na">—</li>'}</ul>
            <h4 style="margin-top:14px">Coding score: <span style="color:var(--ink)">${num(m.coding_score) ? '—' : m.coding_score}/100</span> <span style="color:var(--ink-4);font-weight:400;text-transform:none;letter-spacing:0">· ${m.coding_confidence || '—'} confidence</span></h4>
            <p style="font-size:12.5px;color:var(--ink-3);margin-top:-4px">Basis: ${m.coding_basis || '—'}</p>
            <h4 style="margin-top:14px">Benchmarks</h4>
            <ul>
              <li>SWE-bench Verified: ${fmtScore(m.benchmarks?.swe_bench)}</li>
              <li>GPQA (reasoning): ${fmtScore(m.benchmarks?.gpqa)}</li>
              <li>AIME (math): ${fmtScore(m.benchmarks?.aime)}</li>
              <li>LMArena Elo: ${num(m.benchmarks?.lmarena_elo) ? '<span class="na">—</span>' : m.benchmarks.lmarena_elo}</li>
            </ul>
            <h4 style="margin-top:14px">Confidence: <span style="color:var(--ink)">${m.confidence}</span></h4>
            <div class="srcs">${(m.sources || []).slice(0, 3).map((u) => `<a href="${u}" target="_blank" rel="noopener">${shortUrl(u)}</a>`).join(' · ') || '<span class="na">no public source recorded</span>'}</div>
          </div>
        </div>`;
      mr.appendChild(td);
      body.appendChild(mr);
    }
  });

  // header sort indicators
  document.querySelectorAll('.tbl thead th').forEach((th) => {
    th.classList.remove('sorted-asc', 'sorted-desc');
    if (th.getAttribute('data-sort') === state.sort.key) th.classList.add(state.sort.dir === 'asc' ? 'sorted-asc' : 'sorted-desc');
  });

  // "show all 21" toggle — only when unfiltered (a filter is its own narrowing).
  // The dedicated table page always shows all 21, so it has no toggle.
  const more = $('#tblMore');
  if (more && document.body.dataset.page !== 'table') {
    if (state.filter === 'all') {
      const total = state.data.models.length;
      more.innerHTML = state.showAll
        ? `<button class="tbl-toggle" id="tblToggle">Show fewer</button>`
        : `<span class="tbl-more__note">Showing one flagship from each major lab.</span> <button class="tbl-toggle" id="tblToggle">Show all ${total} models</button>`;
      const t = $('#tblToggle');
      if (t) t.addEventListener('click', () => { state.showAll = !state.showAll; renderTable(); });
    } else {
      more.innerHTML = '';
    }
  }
}

function shortUrl(u) { try { return new URL(u).hostname.replace('www.', ''); } catch { return u.slice(0, 28); } }

// ---------- who's using what ----------
function renderUsage() {
  const u = state.data.usage;
  const section = $('#usage');
  if (!u || !u.lenses || !u.lenses.length) { if (section) section.style.display = 'none'; return; }
  $('#lenses').innerHTML = u.lenses.map((l) => `
    <div class="lens">
      <div class="lens__head">
        <span class="lens__label">${l.label}</span>
        <span class="lens__sub">${l.sub}</span>
      </div>
      <ol class="lens__top">
        ${l.top.map((t, i) => `
          <li>
            <span class="lens__rank">${i + 1}</span>
            <span class="lens__name">${t.name}</span>
            <span class="lens__detail">${t.detail}</span>
          </li>`).join('')}
      </ol>
      <p class="lens__note">${l.note}</p>
      ${l.source ? `<a class="lens__src" href="${l.source}" target="_blank" rel="noopener">${shortUrl(l.source)}</a>` : ''}
    </div>`).join('');
  $('#lensesBasis').textContent = u.basis || '';
}

// ---------- releases ----------
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
function relWhen(d) {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(d || '');
  if (!m) return { mon: (d || '?').slice(5, 8).toUpperCase() || '·', day: '' };
  return { mon: MONTHS[+m[2] - 1] || '', day: m[3] || ("'" + m[1].slice(2)) };
}
function renderFeed() {
  const feed = $('#feed');
  if (!feed) return;
  const rel = (state.data.releases || []).slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  if (!rel.length) { feed.innerHTML = '<li class="empty">No recent releases recorded.</li>'; return; }
  feed.innerHTML = rel.map((r) => {
    const w = relWhen(r.date);
    const title = r.source
      ? `<a href="${r.source}" target="_blank" rel="noopener">${r.title}<span class="rel__ext">↗</span></a>`
      : r.title;
    return `
    <li class="rel">
      <div class="rel__when"><span class="rel__mon">${w.mon}</span><span class="rel__day">${w.day}</span></div>
      <div class="rel__card">
        ${r.vendor ? `<span class="rel__vendor">${r.vendor}</span>` : ''}
        <h3 class="rel__title">${title}</h3>
        <p class="rel__sum">${r.summary || ''}</p>
        ${r.why ? `<p class="rel__why"><span>Should you care?</span> ${r.why}</p>` : ''}
      </div>
    </li>`;
  }).join('');
}

// ---------- controls ----------
// goal + priority controls appear in two places (hero picker + result panel);
// keep every matching button in sync from one source of truth.
function setActive(attr, val) {
  document.querySelectorAll('[' + attr + ']').forEach((b) => {
    const on = b.getAttribute(attr) === String(val);
    b.classList.toggle('is-active', on);
    b.setAttribute(b.getAttribute('role') === 'radio' ? 'aria-checked' : 'aria-selected', on ? 'true' : 'false');
  });
}
function setGoal(goal) {
  state.goal = goal;
  setActive('data-goal', goal);
  renderResult();
}
function setPriority(p) {
  state.priority = +p;
  setActive('data-p', p);
  renderResult();
}
// labs are a multi-select filter: "All labs" clears the set; any vendor toggles in/out
function setLabs(v) {
  if (v === LAB_ALL) state.labs = [];
  else { const i = state.labs.indexOf(v); if (i >= 0) state.labs.splice(i, 1); else state.labs.push(v); }
  renderLabChips();     // refresh active states (All auto-toggles with the set)
  renderResult();
}
function wire() {
  document.querySelectorAll('[data-goal]').forEach((b) =>
    b.addEventListener('click', () => setGoal(b.getAttribute('data-goal')))
  );
  document.querySelectorAll('[data-p]').forEach((b) =>
    b.addEventListener('click', () => setPriority(b.getAttribute('data-p')))
  );

  document.querySelectorAll('.tbl thead th[data-sort]').forEach((th) =>
    th.addEventListener('click', () => {
      const key = th.getAttribute('data-sort');
      if (state.sort.key === key) state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
      else state.sort = { key, dir: key === 'name' ? 'asc' : 'desc' };
      renderTable();
    })
  );

  // prompt generator
  const gen = $('#genPrompt'), ta = $('#promptText'), panel = $('#promptPanel'), copyStatus = $('#copyStatus');
  function copyPrompt() {
    if (!ta) return;
    const ok = () => { if (copyStatus) copyStatus.textContent = 'Copied ✓'; };
    const manual = () => { ta.focus(); ta.select(); if (copyStatus) copyStatus.textContent = 'Select all + copy'; };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(ta.value).then(ok).catch(manual);
    else manual();
  }
  if (gen) gen.addEventListener('click', () => {
    if (!ta || !panel) return;
    ta.value = buildAdvisorPrompt();
    panel.hidden = false;
    copyPrompt();                              // auto-copy the moment it's generated
  });
  const copyBtn = $('#copyPrompt'); if (copyBtn) copyBtn.addEventListener('click', copyPrompt);
}

// ---------- hero: animated dithered sunset (bounded to the hero; pauses off-screen) ----------
// Ordered-dither (Bayer 4x4) golden-hour scene: near-black sky banking warm at the horizon,
// a half-set dithered sun, and a shimmering reflection column in dark water. Rendered into a
// low-res buffer and upscaled with smoothing off for chunky lofi pixels. Paused the moment
// the page scrolls (same discipline as the ASCII scene it replaces — never janks the page).
function initScene() {
  const cv = document.getElementById('heroScene');
  const host = document.getElementById('hero');
  if (!cv || !host) return;
  const ctx = cv.getContext('2d', { alpha: false });
  const rm = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const BAYER = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];
  // warm ramp: ember -> rust -> gold -> cream, over a deep dusk base
  const PAL = [[122, 48, 30], [196, 92, 44], [242, 193, 78], [255, 233, 196]];
  const BASE = [12, 10, 18];
  const CELL = 4;                       // css px per dither pixel (the lofi chunk size)
  const V_HOR = 0.66, V_SUN = 0.675;    // horizon + sun centre (sun half-set just below the wordmark)

  let W, H, bw, bh, off, octx, img;
  function resize() {
    const cssW = (cv.parentElement ? cv.parentElement.clientWidth : 0) || host.clientWidth || innerWidth;
    // the scene band — same formula as the CSS (min(58vh, 600px));
    // computed here, not measured, so the inline size never feeds back into itself
    const cssH = Math.min(Math.round(innerHeight * 0.58), 600);   // matches .hero__band CSS
    if (cssW < 8 || cssH < 8) { W = H = 0; img = null; return; }   // zero-size viewport (prerender) — retry later
    W = cv.width = cssW; H = cv.height = cssH;
    cv.style.width = cssW + 'px'; cv.style.height = cssH + 'px';
    bw = Math.ceil(cssW / CELL); bh = Math.ceil(cssH / CELL);
    off = document.createElement('canvas'); off.width = bw; off.height = bh;
    octx = off.getContext('2d');
    img = octx.createImageData(bw, bh);
    ctx.imageSmoothingEnabled = false;
  }

  function render(tSec) {
    if (!img) { resize(); if (!img) return; }   // buffer missing (zero-size viewport at init)
    const hy = bh * V_HOR, sunY = bh * V_SUN, cx = bw * 0.5;
    const sunR = Math.max(10, Math.min(bh * 0.14, bw * 0.075));
    const d8 = img.data;
    let p = 0;
    for (let j = 0; j < bh; j++) {
      const isSky = j <= hy;
      for (let i = 0; i < bw; i++, p += 4) {
        let v;
        if (isSky) {
          const g = j / hy;
          v = 0.03 + 0.24 * g * g * g;                                   // near-black -> warm at horizon
          const d = Math.hypot(i - cx, (j - sunY) * 1.25);
          v += Math.max(0, 1 - d / (sunR * 2.8)) * 0.7;                  // halo
          if (d < sunR) v = 1.05 + 0.35 * (1 - d / sunR);                // disc bright enough to survive the scrim
          v += 0.025 * Math.sin(i * 0.05 + j * 0.35 + tSec * 0.2);       // faint cloud drift
        } else {
          const jj = 2 * hy - j;
          const ii = i + Math.sin(j * 0.7 + tSec * 1.6) * 2.5;
          const d = Math.hypot(ii - cx, (jj - sunY) * 1.25);
          const depth = Math.max(0, 1 - (j - hy) / (bh - hy) * 1.15);    // reflection fades with depth
          v = 0.02 + Math.max(0, 1 - d / (sunR * 2.2)) * 0.62 * depth;
          if (d < sunR) v = 0.85 * depth;
          v *= 0.5 + 0.5 * Math.sin(j * 1.3 + tSec * 2);                 // wave glints
        }
        // dim the scene behind the wordmark/promise zone — lettering wins, always
        const mdx = (i / bw - 0.5) * 2.6, mdy = (j / bh - 0.44) * 3.2;
        v *= 1 - 0.45 * Math.exp(-(mdx * mdx + mdy * mdy));
        if (v > ((BAYER[j & 3][i & 3] + 0.5) / 16) * 0.92) {
          const c = PAL[Math.min(3, (v * 3.2) | 0)];
          d8[p] = c[0]; d8[p + 1] = c[1]; d8[p + 2] = c[2];
        } else {
          d8[p] = BASE[0]; d8[p + 1] = BASE[1]; d8[p + 2] = BASE[2];
        }
        d8[p + 3] = 255;
      }
    }
    octx.putImageData(img, 0, 0);
    ctx.drawImage(off, 0, 0, W, H);
  }

  let lastT = 0, raf = 0, running = false, visible = true, scrolling = 0;
  function loop(now) {
    if (!running) return;
    if (W < 4 || H < 4) { resize(); raf = requestAnimationFrame(loop); return; }
    if (now - lastT >= 32) { lastT = now; render(now / 1000); }   // ~30fps, calm + battery-friendly
    raf = requestAnimationFrame(loop);
  }
  function start() { if (running || rm) return; running = true; lastT = 0; raf = requestAnimationFrame(loop); }
  function stop() { running = false; if (raf) cancelAnimationFrame(raf); raf = 0; }
  // Animate ONLY while parked at the very top. The moment the page scrolls at all, stop and
  // stay stopped — repainting a big canvas mid-scroll is exactly what froze the software
  // renderer before. It resumes when you settle back at the top. (NB: don't gate on
  // document.hidden — some embedded/preview renderers report hidden permanently; the
  // visibilitychange listener still pauses for real users who switch tabs.)
  const atTop = () => (window.scrollY || document.documentElement.scrollTop || 0) < 40;
  function maybeStart() { if (visible && !scrolling && atTop()) start(); }

  addEventListener('resize', () => { resize(); render(0); });
  resize();
  render(0);            // ALWAYS paint one static frame synchronously — rAF never fires in
                        // hidden/embedded documents, and the scene must exist without it
  if (rm) return;       // reduced motion: keep the static frame, no animation
  addEventListener('scroll', () => {
    stop();
    clearTimeout(scrolling);
    scrolling = setTimeout(() => { scrolling = 0; maybeStart(); }, 200);
  }, { passive: true });
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : maybeStart()));
  if ('IntersectionObserver' in window) {
    new IntersectionObserver((es) => es.forEach((e) => { visible = e.isIntersecting; visible ? maybeStart() : stop(); }), { threshold: 0 }).observe(host);
  } else { maybeStart(); }
}

// ---------- scroll-reveal: sections resolve in on first sight ----------
function initReveal() {
  if (!('IntersectionObserver' in window) || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  document.documentElement.classList.add('js-reveal');
  const els = document.querySelectorAll('.panel, .evidence-mark');
  const io = new IntersectionObserver((es) => es.forEach((e) => {
    if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target); }
  }), { threshold: 0.08 });
  els.forEach((el2) => io.observe(el2));
  // safety: if nothing has intersected shortly after load (odd embedded panes), show everything
  setTimeout(() => els.forEach((el2) => el2.classList.add('is-in')), 2500);
}

// ---------- boot ----------
// set text on an element only if it exists (app.js runs on both index.html and table.html)
function setText(sel, txt) { const e = $(sel); if (e) e.textContent = txt; }

async function boot() {
  try { initScene(); } catch (e) { /* the scene must never block the data */ }
  // the standalone full-table page (table.html) marks itself so we always show all 21
  const isTablePage = document.body.dataset.page === 'table';
  if (isTablePage) state.showAll = true;
  try {
    const res = await fetch('data/models.json', { cache: 'no-store' });
    state.data = await res.json();
  } catch (e) {
    const r = $('#result') || $('#tblBody');
    if (r) r.innerHTML = '<div class="empty">Could not load data/models.json.</div>';
    return;
  }
  const asof = state.data.as_of || '—';
  setText('#navAsof', '● snapshot ' + asof + ' · pricing verified');
  setText('#footAsof', asof);
  setText('#footNotes', state.data.notes || 'Pricing from official vendor pages; benchmarks from public leaderboards. Every figure carries a confidence flag; unsourced numbers are left blank rather than guessed.');

  wire();
  initReveal();
  renderFilters();
  renderLabChips();          // build the "which lab" chips from the data's vendors + wire them
  if ($('#result')) renderResult();   // engine + comparator live on the home page only
  renderTable();             // full table lives on table.html; guarded no-op elsewhere
  renderFeed();
}
// robust boot: fire once on whichever lifecycle signal arrives first — some embedded
// panes/bfcache restores swallow DOMContentLoaded, so belt-and-braces with load + a timer
let _booted = false;
function bootOnce() { if (_booted) return; _booted = true; boot(); }
if (document.readyState !== 'loading') bootOnce();
else {
  document.addEventListener('DOMContentLoaded', bootOnce);
  addEventListener('load', bootOnce);
  setTimeout(bootOnce, 800);
}
// watchdog: if the initial fetch stalled (hidden/prerendered documents can suspend network),
// re-run boot until the data actually lands. No-op in a normal browser: data loads first try.
let _bootTries = 0;
const _watch = setInterval(() => {
  if (state.data) { clearInterval(_watch); return; }
  if (++_bootTries > 6) { clearInterval(_watch); return; }
  _booted = false; bootOnce();
}, 1500);
