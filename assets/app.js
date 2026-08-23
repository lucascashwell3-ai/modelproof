/* ============================================================
   Modelproof — client-side decision engine
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
  showAll: false,        // compare table defaults to the common flagships; opt in to all 22
  sort: { key: 'coding_score', dir: 'desc' },
  expanded: new Set(),
  compare: [],           // model ids on the side-by-side board (2–5)
  cmpCustom: false,      // true once the user hand-picks — stops auto-reseeding from the engine
  ladder: 0,             // which published effort ladder is on screen
  ladderOff: new Set(),  // model ids toggled off in the effort chart
};
const CMP_MAX = 5;

// compare-table default: one flagship per major lab (neutral — no lab over-represented).
// The full 22 (incl. cheap/specialized tiers) are one click away via "Show all".
const COMMON_IDS = ['claude-opus-5', 'gpt-5-6-sol', 'gemini-3-1-pro', 'grok-4-5', 'kimi-k3', 'deepseek-v4-pro', 'llama-4-maverick', 'qwen3-max'];

// vendor -> the brand people actually say ("I use Claude / ChatGPT / Grok…")
const LAB_LABEL = {
  'Anthropic': 'Claude', 'OpenAI': 'ChatGPT', 'Google': 'Gemini', 'xAI': 'Grok',
  'DeepSeek': 'DeepSeek', 'Meta': 'Llama', 'Alibaba (Qwen)': 'Qwen', 'Moonshot AI': 'Kimi',
  'Mistral AI': 'Mistral',
};
// order the lab chips by how commonly people reach for them (unknown vendors fall to the end)
const LAB_ORDER = ['Anthropic', 'OpenAI', 'Google', 'xAI', 'DeepSeek', 'Meta', 'Alibaba (Qwen)', 'Moonshot AI', 'Mistral AI'];
// budget is a continuum (the spring slider) — words are derived, not buckets
function prioLabel(p) { return p <= 16 ? 'cheapest' : p <= 38 ? 'value' : p <= 66 ? 'balanced' : 'best'; }

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
  writing: 'Drafting prose, emails & content. No clean writing benchmark exists, so only models the data tags for prose are ranked — on general ability + price.',
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
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
// The coding score has ONE identity everywhere it appears — pick card, runner chips, board,
// table, advisor prompt: "N/100, SWE-bench Verified where published, otherwise a sourced
// estimate marked est". A score with no published SWE-bench is an estimate, and the est mark
// travels with the number instead of hiding in a hover dot.
const CODING_DEF = 'Coding score, 0–100 — SWE-bench Verified where published, otherwise a sourced estimate (marked est)';
const isEst = (m) => num(m.benchmarks?.swe_bench);
function fmtCoding(m, { unit = true } = {}) {
  if (num(m.coding_score)) return '<span class="na">—</span>';
  return m.coding_score + (unit ? '<span class="unit">/100</span>' : '') +
    (isEst(m) ? `<sup class="est" title="estimate — SWE-bench Verified not published. Basis: ${esc(m.coding_basis || 'sourced signals')}">est</sup>` : '');
}
const CONF_TXT = { high: 'high', medium: 'med', low: 'low' };
const confMark = (m, conf) => { const c = conf || m.confidence || 'low'; return `<i class="conf conf-${c}"></i><span class="conf-txt">${CONF_TXT[c] || c}</span>`; };
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
  // Writing has no clean benchmark (one Elo in the whole dataset), so ranking every model on
  // the reasoning proxy just cloned the Strategy tab. Rank only the models the data actually
  // tags for prose — the same set the full table's writing filter shows.
  const strictTag = goal === 'writing';
  const tags = GOAL_TAGS[goal] || [goal];
  return models
    .map((m) => {
      const hasTag = (m.best_for || []).some((t) => tags.includes(t));
      const { cap, cheap, measured, via } = f(m);
      let s = bulk ? 0.30 * cap + 0.70 * cheap : w * cap + (1 - w) * cheap;
      if (hasTag) s += 0.03;               // small nudge for explicit fit
      // cheap-bulk is price-led (include everything); quality goals require a sourced score
      const inRec = bulk ? true : strictTag ? (hasTag && measured) : measured;
      return { m, s, measured, via, inRec };
    })
    .filter((x) => x.inRec)
    .sort((a, b) => b.s - a.s);
}

// pick the most defensible headline number for a goal: the goal's own metric,
// else a sourced proxy, else an honest dash.
function headlineStat(m, metric) {
  if (metric === 'coding_score') {
    if (!num(m.coding_score)) return { value: fmtCoding(m), label: 'coding score' };
  } else {
    const v = capVal(m, metric);
    if (!num(v)) return { value: fmtScore(v), label: metricLabel(metric) };
  }
  if (!num(m.benchmarks?.gpqa)) return { value: fmtScore(m.benchmarks.gpqa), label: 'GPQA' };
  if (!num(m.coding_score)) return { value: fmtCoding(m), label: 'coding score' };
  return { value: '<span class="na">—</span>', label: metricLabel(metric) };
}

// stat-grounded fallback verdict for research/writing when no hand-written task copy exists —
// never editorial, never borrowed from the coding pitch
function genericTaskVerdict(m, metric) {
  const v = capVal(m, metric);
  const ev = !num(v)
    ? (metric === 'gpqa' ? `GPQA ${v} (graduate-level reasoning)` : `${metricLabel(metric)} ${v}`)
    : 'general ability — no direct benchmark is sourced for this task';
  return `The ${(TASK_LABEL[state.goal] || state.goal).toLowerCase()} pick at this budget, ranked on ${ev} + price. Basis and sources below.`;
}

// the evidence trail ON the pick card (cold review #8): basis, confidence, sources, permalink —
// so the one artifact people screenshot can survive a "says who?"
function pickBasisHTML(m, metric, hvLabel) {
  const conf = metric === 'coding_score' ? (m.coding_confidence || m.confidence) : m.confidence;
  const basis = metric === 'coding_score'
    ? (m.coding_basis || 'No basis recorded.')
    : `${hvLabel || metricLabel(metric)} and pricing as sourced in the full table; every figure carries a confidence flag and unsourced cells stay blank.`;
  const srcs = (m.sources || []).slice(0, 3).map((u) => `<a href="${u}" target="_blank" rel="noopener">${shortUrl(u)}</a>`).join(' · ');
  return `<details class="pick__basis">
    <summary>Basis &amp; sources — ${CONF_TXT[conf] || conf || 'low'} confidence</summary>
    <p>${esc(basis)}</p>
    <div class="srcs">${srcs || '<span class="na">no public source recorded</span>'}</div>
    <button class="pick__link" type="button" data-copylink>Copy link to this pick</button>
    <span class="pick__linkstatus" role="status" aria-live="polite"></span>
  </details>`;
}

// ---------- shareable state: the pick lives in the URL (cold review #9) ----------
// task/budget/labs mirror into query params so a selection can be sent to someone else;
// replaceState is debounced — Safari rate-limits it, and the slider fires per-frame.
let _urlT = 0;
function syncURL() {
  clearTimeout(_urlT);
  _urlT = setTimeout(() => {
    const p = new URLSearchParams();
    if (state.goal !== 'coding') p.set('task', state.goal);
    if (state.priority !== 48) p.set('budget', String(state.priority));
    if (state.labs.length) p.set('labs', state.labs.map((v) => LAB_LABEL[v] || v).join(','));
    const qs = p.toString();
    try { history.replaceState(null, '', qs ? '?' + qs : location.pathname); } catch (e) { /* ignore */ }
  }, 250);
}
function readURL() {
  const p = new URLSearchParams(location.search);
  const t = p.get('task');
  if (t && GOAL_METRIC[t]) state.goal = t;
  const b = parseInt(p.get('budget'), 10);
  if (!Number.isNaN(b)) state.priority = Math.min(100, Math.max(0, b));
  const byLabel = Object.fromEntries(Object.entries(LAB_LABEL).map(([v, l]) => [l.toLowerCase(), v]));
  const vendors = new Set(state.data.models.map((m) => m.vendor));
  state.labs = (p.get('labs') || '').split(',')
    .map((s) => byLabel[s.trim().toLowerCase()] || s.trim())
    .filter((v) => vendors.has(v));
}

// the field the recommender ranks: all models, or (if labs are chosen) just those vendors
function currentModels() {
  return state.labs.length ? state.data.models.filter((m) => state.labs.includes(m.vendor)) : state.data.models;
}
const TASK_LABEL = { coding: 'Coding', research: 'Strategy', writing: 'Writing', 'cheap-bulk': 'Cheap bulk' };
// the read-only sentence the console echoes back — the tool restating your query
function queryText() {
  const labs = state.labs.length ? state.labs.map((v) => LAB_LABEL[v] || v).join(' + ') : 'any lab';
  return { task: TASK_LABEL[state.goal] || state.goal, budget: prioLabel(state.priority), labs };
}

function renderResult() {
  // a generated prompt reflects the selection at generation time — reset it when the selection changes
  const pp = document.getElementById('promptPanel'); if (pp) pp.hidden = true;
  const cs = document.getElementById('copyStatus'); if (cs) cs.textContent = '';
  const echo = $('#queryEcho');
  if (echo) { const q = queryText(); echo.innerHTML = `${q.task} · ${q.budget} cost · <b>${q.labs}</b>`; }
  syncURL();         // the selection is shareable — it lives in the query string
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

  // Three dropdowns, one per column (2026-08-22 — the 49-chip wall was unreadable). Each
  // lists every model grouped by vendor; a column can be cleared to "—" down to two.
  const byVendor = {};
  all.forEach((m) => { (byVendor[m.vendor] = byVendor[m.vendor] || []).push(m); });
  const vendors = Object.keys(byVendor).sort();
  const slots = [0, 1, 2].map((i) => state.compare[i] || '');
  pk.innerHTML = slots.map((sel, i) => `
    <label class="cmp-slot">
      <span class="cmp-slot__n">${i + 1}</span>
      <select class="cmp-select" data-slot="${i}" aria-label="Model ${i + 1}">
        <option value="">${i < 2 ? 'Pick a model' : '— none —'}</option>
        ${vendors.map((v) => `<optgroup label="${v}">${byVendor[v].map((m) =>
          `<option value="${m.id}" ${m.id === sel ? 'selected' : ''} ${state.compare.includes(m.id) && m.id !== sel ? 'disabled' : ''}>${m.name}</option>`).join('')}</optgroup>`).join('')}
      </select>
    </label>`).join('');
  pk.querySelectorAll('.cmp-select').forEach((el) => el.addEventListener('change', () => {
    const i = Number(el.dataset.slot), id = el.value;
    const next = [0, 1, 2].map((k) => (k === i ? id : (state.compare[k] || ''))).filter(Boolean);
    if (next.length < 2) { el.value = state.compare[i] || ''; return; }   // keep at least two to compare
    state.compare = next;
    state.cmpCustom = true;
    renderCompare();
  }));

  const ms = state.compare.map((id) => all.find((m) => m.id === id)).filter(Boolean);
  bd.style.setProperty('--n', ms.length);
  const rows = [
    ['', (m) => `<div class="cmp-model">${m.name}</div><div class="cmp-vendor">${m.vendor}</div>`],
    ['Best for', (m) => (m.best_for || []).slice(0, 3).map((t) => `<span class="mini-tag">${TAG_LABEL[t] || t}</span>`).join(' ') || '<span class="na">—</span>'],
    ['Coding', (m) => `<span class="cmp-num">${fmtCoding(m)}</span>${num(m.coding_score) ? '' : confMark(m, m.coding_confidence)}`],
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
  const caption = {
    coding: `Ranked on the coding score + price. ${CODING_DEF}. Models with no sourced score for this task sit in the full table, not here.`,
    research: 'Ranked on GPQA (graduate-level reasoning) + price. Models with no sourced score for this task sit in the full table, not here.',
    writing: 'No clean writing benchmark exists — these are the models the data tags for prose, ranked on general ability + price.',
    'cheap-bulk': 'Ranked mostly on price. Cheapest capable option first.',
  }[state.goal] || 'Ranked on sourced benchmarks + price.';

  // The verdict and tips must argue THIS task. Hand-written per-task copy wins; for
  // research/writing without it, a stat-grounded neutral line renders and coding tips are
  // suppressed entirely — a strategy pick may never ship a coding sales pitch (cold review #1).
  const tc = top.task_copy?.[state.goal];
  const baseCopy = state.goal === 'coding' || state.goal === 'cheap-bulk';
  const verdict = tc?.verdict || (baseCopy ? (top.verdict || 'A strong all-round choice for this goal.') : genericTaskVerdict(top, metric));
  const tips = (tc?.tips || (baseCopy ? top.use_well : []) || []).slice(0, 3);
  box.innerHTML = `
    <div class="pick">
      <span class="pick__flag">Your pick</span>
      <div class="pick__name">${top.name}</div>
      <div class="pick__vendor">${top.vendor}</div>
      <p class="pick__verdict">${verdict}</p>
      <div class="pick__stats">
        <div class="stat"><span class="stat__v">${hv.value}</span><span class="stat__l" title="${hv.label === 'GPQA' ? 'GPQA — PhD-level science questions; a proxy for reasoning' : esc(CODING_DEF)}">${hv.label}</span></div>
        <div class="stat"><span class="stat__v">${fmtPrice(top.price_output)}</span><span class="stat__l" title="what 1M output tokens (≈ 750k words) costs">out / 1M tok</span></div>
        <div class="stat"><span class="stat__v">${fmtPrice(top.price_input)}</span><span class="stat__l" title="what 1M input tokens (≈ 750k words read) costs">in / 1M tok</span></div>
        <div class="stat"><span class="stat__v">${fmtCtx(top.context_window)}</span><span class="stat__l" title="how much it can hold in one conversation">context</span></div>
      </div>
      <p class="pick__gloss">${hv.label === 'GPQA' ? 'GPQA = PhD-level science quiz, a reasoning proxy' : 'coding score = /100, SWE-bench where published, est = sourced estimate'} · 1M tokens ≈ 750k words</p>
      ${tips.length ? `<div class="pick__use"><h4>Use it well</h4><ul>${tips.map((t) => `<li>${t}</li>`).join('')}</ul></div>` : ''}
      ${pickBasisHTML(top, metric, hv.label)}
    </div>
    <div class="runners">
      ${runners.map((m) => { const rv = headlineStat(m, metric); return `
        <div class="runner" data-jump="${m.id}">
          <div class="runner__name">${m.name}</div>
          <div class="runner__meta"><b>${rv.value}</b> ${rv.label} · <b>${fmtPrice(m.price_output)}</b>/1M out</div>
        </div>`; }).join('')}
    </div>
    ${labKitHTML()}
    ${upgradeCheck(top, metric)}
    <p class="rec-caption">${caption}</p>`;

  tickStats(box);   // odometer the numbers from the previous pick's values

  // permalink for the pick — flush the debounced URL write first so the copied link is current
  const cl = box.querySelector('[data-copylink]');
  if (cl) cl.addEventListener('click', () => {
    clearTimeout(_urlT); _urlT = 0;
    const p = new URLSearchParams();
    if (state.goal !== 'coding') p.set('task', state.goal);
    if (state.priority !== 48) p.set('budget', String(state.priority));
    if (state.labs.length) p.set('labs', state.labs.map((v) => LAB_LABEL[v] || v).join(','));
    const qs = p.toString();
    try { history.replaceState(null, '', qs ? '?' + qs : location.pathname); } catch (e) { /* ignore */ }
    const st = box.querySelector('.pick__linkstatus');
    const done = () => { if (st) st.textContent = 'Link copied ✓'; };
    const fail = () => { if (st) st.textContent = location.href; };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(location.href).then(done).catch(fail);
    else fail();
  });

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

// ---------- "make the most of what you have": the per-task kit from the user's labs ----------
function labKitHTML() {
  if (!state.labs.length || !state.data) return '';
  const mine = currentModels();
  const rows = Object.keys(GOAL_METRIC).map((goal) => {
    const ranked = score(mine, goal, state.priority);
    if (!ranked.length) {
      return `<div class="labkit__row labkit__row--none"><span class="labkit__goal">${TASK_LABEL[goal]}</span><span class="labkit__model">No sourced pick yet</span><span class="labkit__meta"></span></div>`;
    }
    const m = ranked[0].m;
    return `<div class="labkit__row" data-jump="${m.id}"><span class="labkit__goal">${TASK_LABEL[goal]}</span><span class="labkit__model">${m.name}</span><span class="labkit__meta">${fmtPrice(m.price_output)}/1M out</span></div>`;
  }).join('');
  const who = state.labs.map((v) => LAB_LABEL[v] || v).join(' + ');
  return `<div class="kitpanel">
    <span class="kit__title">Make the most of ${who}</span>
    <p class="kit__how">Your best model for each kind of work — tap a row for its full card and "use it well" notes.</p>
    <div class="labkit">${rows}</div>
  </div>`;
}

// number odometer: when the pick swaps, prices/scores count to their new value instead of
// jumping. Keyed by the stat's label so values track across re-renders; skips "—" and
// respects prefers-reduced-motion (plus renders mid-drag retarget smoothly).
const _statPrev = {};
function tickStats(scope) {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  scope.querySelectorAll('.pick .stat').forEach((st) => {
    const el = st.querySelector('.stat__v'), label = st.querySelector('.stat__l');
    if (!el || !label) return;
    const key = label.textContent;
    const m = /^(\$?)(\d+(?:\.\d+)?)\s*([%MK]?)$/.exec(el.textContent.trim());
    if (!m) { delete _statPrev[key]; return; }
    const to = parseFloat(m[2]), from = _statPrev[key];
    _statPrev[key] = to;
    if (reduce || from === undefined || from === to) return;
    const pre = m[1], suf = m[3], dec = (m[2].split('.')[1] || '').length;
    const t0 = performance.now(), dur = 440;
    cancelAnimationFrame(el._tick || 0);
    const step = (now) => {
      const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 4);   // ease-out-quart
      el.textContent = pre + (from + (to - from) * e).toFixed(dec) + suf;
      if (k < 1) el._tick = requestAnimationFrame(step);
    };
    el._tick = requestAnimationFrame(step);
  });
}

// the upgrade check — independence made visible. When labs are constrained: either a
// plain-spoken "you're set" (the answer most tools won't give), or a factual, COST-FIRST
// delta for the one model outside their labs that's materially better/cheaper. Never a nudge.
function upgradeCheck(top, metric) {
  if (!state.labs.length) return '';
  const set = `<div class="upcheck upcheck--set"><span class="upcheck__k">Upgrade check</span>You're set — nothing outside your labs is meaningfully better than <b>${top.name}</b> for this task at this budget.</div>`;
  const globalTop = (score(state.data.models, state.goal, state.priority)[0] || {}).m;
  if (!globalTop || state.labs.includes(globalTop.vendor) || globalTop.id === top.id) return set;
  const gp = globalTop.price_output, tp = top.price_output;
  const gCap = capVal(globalTop, metric), tCap = capVal(top, metric);
  const cheaper = !num(gp) && !num(tp) && gp <= tp * 0.8;
  const better = !num(gCap) && !num(tCap) && gCap > tCap;
  if (!cheaper && !better) return set;
  const gv = headlineStat(globalTop, metric), tv = headlineStat(top, metric);
  return `<div class="upcheck"><span class="upcheck__k">Upgrade check</span>Outside your labs: <b>${globalTop.name}</b> at ${fmtPrice(gp)}/1M out vs your pick's ${fmtPrice(tp)} — ${gv.value} ${gv.label} vs ${tv.value}. A fact, not a pitch; your call.</div>`;
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
  // an estimate stays an estimate when it travels — the caveat rides in the export too
  if (!num(m.coding_score)) bits.push(`coding ${m.coding_score}/100${isEst(m) ? ' (est — SWE-bench not published)' : ''}`);
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
  const prio = prioLabel(state.priority);
  // facts list ALL models (so the advisor can name a cheaper option outside my labs), but MY SETUP
  // states my labs as a soft preference — the same "task + optional lab filter" the site uses.
  const scope = state.labs.length
    ? `I mostly work on ${GOAL_PLAIN[state.goal] || state.goal}. I mainly pay for ${state.labs.map((v) => LAB_LABEL[v] || v).join(' + ')}, so prefer those — but if a model outside them is much cheaper or clearly better for a task, name it as an option and let me decide.`
    : `I mostly work on ${GOAL_PLAIN[state.goal] || state.goal}. You may recommend from any model listed below.`;
  const list = state.data.models.slice().sort((a, b) => (num(b.coding_score) ? -1 : b.coding_score) - (num(a.coding_score) ? -1 : a.coding_score));
  const facts = list.map(modelFactLine).join('\n');
  // "use it well" tips ride along for MY models (or the common flagships when no labs picked)
  const tipPool = state.labs.length
    ? list.filter((m) => state.labs.includes(m.vendor))
    : list.filter((m) => COMMON_IDS.includes(m.id));
  const tipLines = tipPool
    .filter((m) => (m.use_well || []).length)
    .map((m) => `- ${m.name}: ${m.use_well.join(' ')}`)
    .join('\n');

  return `You are my AI model-selection advisor. When I describe a task, tell me which model to use and why — optimizing for a "${prio}" balance of cost versus quality, and always honest about cost. Your first job is making the most of what I already have; suggesting something new comes second.

MY SETUP
${scope}

STAY CURRENT (do this first if you can)
Before advising, fetch the live data at ${DATA_URL} and use those numbers — they are kept up to date. If you can't browse, use the dated snapshot below and warn me it may be stale.

MODEL FACTS — a snapshot from Modelproof, dated ${asof}. Prices are USD per 1M tokens. Benchmarks are directional (coding is a 0–100 score — SWE-bench Verified where published, otherwise a sourced estimate marked "est"; GPQA is graduate-level reasoning). "n/a" means the figure wasn't publicly sourced — treat it as unknown, never guess. Verify anything cost-critical against the vendor's own pricing page.
${facts}

HOW TO USE MY MODELS WELL — practical notes per model (from the same sourced data):
${tipLines || '- (pick labs on the Modelproof site to get per-model usage notes here)'}

HOW TO ADVISE ME
1. For any task I describe, recommend ONE model in a sentence, with the reason — from my own models first.
2. Then tell me HOW to use it for this task, using the notes above: when a thinking/reasoning mode earns its cost, when my cheap tier handles it fine, context-length and cache tactics, pricing cliffs to avoid.
3. If a cheaper model I already have is nearly as good, name it — saving me money inside my own subscriptions comes before anything else.
4. Only after that: if a model outside my setup is meaningfully better or much cheaper for the task, state it as a neutral, cost-first fact ("X does this at $A vs your $B") and let me decide. If nothing outside is meaningfully better, tell me plainly that I'm set.
5. Recommend on merit and cost only. Stay neutral; do not favor any company.
6. Never invent a price or benchmark. If a number is "n/a", say it's unknown rather than guessing.
7. This snapshot is dated ${asof}. If it is now much later and you couldn't fetch live data, remind me that AI prices and models change fast and to re-check current figures at ${DATA_URL}.`;
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
    `<span><i style="background:var(--gold)"></i>Smart buy — nothing is both cheaper and better</span>
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

  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Model map: cost versus capability; the value zone is top-left">`;

  // the value (Pareto) frontier: models nothing else beats on BOTH price and capability
  const frontier = pts
    .filter((p) => !pts.some((q) => q !== p && q.x <= p.x && q.y >= p.y && (q.x < p.x || q.y > p.y)))
    .sort((a, b) => a.x - b.x || a.y - b.y);
  const onFrontier = new Set(frontier.map((p) => p.m.id));
  const drawFrontier = frontier.length >= 3 && pts.length >= 5;   // else a 2-step line looks thin — fall back to scatter

  // the value zone (2026-08-22): a diagonal wash, strongest in the top-left corner (cheap and
  // capable) fading to nothing bottom-right. A direction, not a box — no arbitrary edge.
  svg += `<defs><radialGradient id="zoneG" cx="0" cy="0" r="1" gradientUnits="objectBoundingBox"><stop offset="0" stop-color="#f2c14e" stop-opacity="0.20"/><stop offset="0.55" stop-color="#f2c14e" stop-opacity="0.05"/><stop offset="1" stop-color="#f2c14e" stop-opacity="0"/></radialGradient></defs>`;
  svg += `<rect x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="url(#zoneG)"/>`;
  svg += `<text class="zone-lbl" x="${padL + 14}" y="${padT + 20}">↖ VALUE ZONE</text>`;
  svg += `<text class="zone-sub" x="${padL + 14}" y="${padT + 36}">cheaper and more capable, this way</text>`;

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

  // teaching moment: if the pick sits BELOW the frontier, connect it to the model that beats it
  const pickPt = pts.find((p) => p.m.id === state.pickId);
  if (drawFrontier && pickPt && !onFrontier.has(pickPt.m.id)) {
    const dom = frontier.filter((q) => q.x <= pickPt.x && q.y >= pickPt.y).sort((a, b) => (b.y - a.y) || (a.x - b.x))[0];
    if (dom) svg += `<line x1="${X(pickPt.x).toFixed(1)}" y1="${Y(pickPt.y).toFixed(1)}" x2="${X(dom.x).toFixed(1)}" y2="${Y(dom.y).toFixed(1)}" stroke="var(--gold)" stroke-width="1.4" stroke-dasharray="3 3" opacity="0.55"/>`;
  }

  // dots: frontier + pick burn gold and labelled; dominated models recede to pale gray
  // labelled (hot) dots that sit within 14px of each other get their labels pushed apart
  const placed = [];
  const labelDy = (cx, cy) => {
    let dy = 0;
    for (const q of placed) if (Math.abs(q.cx - cx) < 120 && Math.abs(q.cy + q.dy - (cy + dy)) < 14) dy = (q.cy + q.dy) - cy + (cy >= q.cy ? 14 : -14);
    placed.push({ cx, cy, dy });
    return dy;
  };
  pts.forEach((p) => {
    const cx = X(p.x), cy = Y(p.y);
    const isPick = p.m.id === state.pickId;
    const fro = drawFrontier && onFrontier.has(p.m.id);
    const hot = isPick || fro;
    const dy = hot ? labelDy(cx, cy) : 0;
    const nearRight = cx > padL + plotW * 0.72;
    const lx = nearRight ? -12 : 12;
    svg += `<g class="dot ${isPick ? 'is-pick' : ''} ${fro ? 'is-frontier' : ''}" data-id="${p.m.id}" transform="translate(${cx.toFixed(1)} ${cy.toFixed(1)})">`;
    svg += `<circle class="d-hit" r="24" fill="transparent"/>`;
    svg += `<circle class="d-core" r="${isPick ? 7 : hot ? 5.5 : 4}" fill="${hot ? 'var(--gold)' : 'rgba(233,230,223,0.38)'}" stroke="${hot ? '#0a0b0f' : 'none'}" stroke-width="1.5"/>`;
    svg += `<text class="dot__label${hot ? '' : ' dot__label--quiet'}" x="${lx}" y="${4 + dy}" text-anchor="${nearRight ? 'end' : 'start'}">${p.m.name}</text>`;
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

// ---------- effort ladders: what extra spend actually buys ----------
// Same axes as the model map (cost →, capability ↑) but each model becomes a CURVE:
// one point per effort/reasoning setting. The shape is the point — it shows where a
// model stops converting money into accuracy. Data is whatever ladders the labs have
// actually published; nothing here is modelled from list prices.

const EFFORT_LBL = { low: 'low', medium: 'med', high: 'high', xhigh: 'xhigh', max: 'max' };

function activeLadder() {
  const list = state.data?.effort_ladders || [];
  return list[Math.min(state.ladder, list.length - 1)] || null;
}

function money(v) { return '$' + (v >= 100 ? Math.round(v) : v.toFixed(2)); }

// the honest read of one curve: where it peaks, and whether the top rung was worth it
function ladderInsight(s) {
  const p = s.points;
  const peak = p.reduce((a, b) => (b.score > a.score ? b : a), p[0]);
  const last = p[p.length - 1];
  const overshoot = last !== peak && last.cost > peak.cost;
  const pct = (n) => Math.round(n * 100);
  const prev = p[p.length - 2];
  let note;
  if (overshoot) {
    note = `Going on to <em>${EFFORT_LBL[last.effort]}</em> costs ${pct(last.cost / peak.cost - 1)}% more
            and scores ${(peak.score - last.score).toFixed(1)} lower. Stop at <em>${EFFORT_LBL[peak.effort]}</em>.`;
  } else {
    note = `Still climbing at the top rung: the last step buys
            +${(last.score - prev.score).toFixed(1)} pts for ${pct(last.cost / prev.cost - 1)}% more spend.`;
  }
  return { peak, last, note };
}

function renderEffort() {
  const wrap = $('#effortChart');
  if (!wrap) return;
  const L = activeLadder();
  const head = $('#effortMeta'), legend = $('#effortLegend'), read = $('#effortRead'), src = $('#effortSource');

  // provenance travels with the chart — rendered from the data, never hand-written here,
  // so a ladder can't end up on screen without its harness, method and caveat attached
  if (src) {
    src.innerHTML = L
      ? `<b>Where this comes from.</b> ${L.publisher}, ${L.suite} (${L.source_kind}, ${L.as_of}) —
         <a href="${L.source}" target="_blank" rel="noopener">source</a>.
         <span class="lad-source__block">${L.harness}</span>
         <span class="lad-source__block">${L.method}</span>
         <span class="lad-source__block lad-source__warn">${L.caveat}</span>`
      : '';
  }

  if (!L) {
    wrap.innerHTML = `<div class="empty" style="padding:60px 0">No lab has published an effort ladder we can source yet.</div>`;
    if (legend) legend.innerHTML = '';
    if (read) read.innerHTML = '';
    return;
  }

  const series = L.series.filter((s) => !state.ladderOff.has(s.model_id));

  // suite picker only appears if there's more than one ladder to choose between
  if (head) {
    const suites = (state.data.effort_ladders || []);
    head.innerHTML = suites.length > 1
      ? suites.map((s, i) => `<button class="lad-suite ${i === state.ladder ? 'is-on' : ''}" data-lad="${i}">${s.suite} · ${s.task}</button>`).join('')
      : `<span class="lad-suite is-static">${L.suite} · ${L.task}</span>`;
  }

  // legend doubles as the on/off control — click a lab to isolate its curve
  if (legend) {
    legend.innerHTML = L.series.map((s) => {
      const off = state.ladderOff.has(s.model_id);
      return `<button class="lad-chip ${off ? 'is-off' : ''}" data-mid="${s.model_id}"
                aria-pressed="${!off}" title="Show or hide ${s.label}">
                <i style="background:${s.color}"></i>${s.label}</button>`;
    }).join('');
  }

  if (!series.length) {
    wrap.innerHTML = `<div class="empty" style="padding:60px 0">Every curve is hidden — switch one back on.</div>`;
    if (read) read.innerHTML = '';
    wireEffortChips();
    return;
  }

  const W = 920, H = 470, padL = 60, padR = 104, padT = 26, padB = 62;
  const plotW = W - padL - padR, plotH = H - padT - padB;

  const all = series.flatMap((s) => s.points);
  const cMin = Math.min(...all.map((p) => p.cost)), cMax = Math.max(...all.map((p) => p.cost));
  const lo = Math.log10(cMin * 0.82), hi = Math.log10(cMax * 1.18);
  const X = (v) => padL + ((Math.log10(v) - lo) / (hi - lo)) * plotW;

  const sMax = Math.max(...all.map((p) => p.score)), sMin = Math.min(...all.map((p) => p.score));
  const yTop = Math.max(5, Math.ceil((sMax * 1.1) / 5) * 5);
  // y floor: when every score sits high (CursorBench runs 48–73), starting at 0 squashes the
  // curves into the top quarter. Start a rung below the lowest point instead; the axis label
  // says so. Ladders that reach down near 0 (Frontier-Bench) keep the full scale.
  const yBot = sMin > 20 ? Math.max(0, Math.floor((sMin - 5) / 5) * 5) : 0;
  const yCap = yBot > 0 ? Math.ceil((sMax + 2) / 5) * 5 : yTop;   // no empty headroom on a floored axis
  const Y = (v) => padT + (1 - (v - yBot) / (yCap - yBot)) * plotH;

  const TICKS = [0.5, 1, 1.5, 2, 3, 5, 7, 10, 15, 20, 30, 50, 70, 100, 150];
  let xticks = TICKS.filter((t) => t >= cMin * 0.82 && t <= cMax * 1.18);
  if (xticks.length < 2) xticks = [cMin, cMax];

  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${L.task} score versus cost per attempt, one curve per model with a point at each effort level">`;

  // grid first, so curves sit on top
  const ystep = (yCap - yBot) > 40 ? 10 : 5;
  for (let v = yBot; v <= yCap; v += ystep) {
    const yy = Y(v);
    svg += `<line class="grid-line" x1="${padL}" y1="${yy.toFixed(1)}" x2="${padL + plotW}" y2="${yy.toFixed(1)}" opacity="${v === yBot ? 0 : 0.55}"/>`;
    svg += `<text class="axis-lbl" x="${padL - 10}" y="${(yy + 4).toFixed(1)}" text-anchor="end">${v}</text>`;
  }
  xticks.forEach((t) => {
    const xx = X(t);
    svg += `<line class="grid-line" x1="${xx.toFixed(1)}" y1="${padT}" x2="${xx.toFixed(1)}" y2="${padT + plotH}" opacity="0.3"/>`;
    svg += `<text class="axis-lbl" x="${xx.toFixed(1)}" y="${padT + plotH + 20}" text-anchor="middle">${money(t)}</text>`;
  });

  svg += `<line class="axis-line" x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}"/>`;
  svg += `<line class="axis-line" x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + plotH}"/>`;
  svg += `<text class="axis-title" x="${padL + plotW / 2}" y="${H - 16}" text-anchor="middle">${(L.x_label || 'COST PER ATTEMPT (LOG)').toUpperCase()}</text>`;
  svg += `<text class="axis-title" transform="translate(15 ${padT + plotH / 2}) rotate(-90)" text-anchor="middle">${(L.y_label || 'SCORE').toUpperCase()}${yBot > 0 ? ` · AXIS STARTS AT ${yBot}` : ''} →</text>`;

  // one curve per model: line, then a dot per effort rung, then the name at the last rung
  series.forEach((s) => {
    const pts = s.points.slice().sort((a, b) => a.cost - b.cost);
    const d = pts.map((p, i) => `${i ? 'L' : 'M'} ${X(p.cost).toFixed(1)} ${Y(p.score).toFixed(1)}`).join(' ');
    svg += `<g class="lad-series" data-mid="${s.model_id}">`;
    svg += `<path class="lad-line" d="${d}" fill="none" stroke="${s.color}" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>`;
    pts.forEach((p, i) => {
      const cx = X(p.cost), cy = Y(p.score);
      svg += `<g class="lad-pt" data-mid="${s.model_id}" data-i="${i}">`;
      svg += `<circle class="lad-hit" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="18" fill="transparent"/>`;
      svg += `<circle class="lad-ring" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="9" fill="none" stroke="${s.color}" stroke-width="1.6" opacity="0"/>`;
      svg += `<circle class="lad-dot" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="5.6" fill="${s.color}" stroke="var(--bg-2)" stroke-width="1.6"/>`;
      svg += `</g>`;
    });
    const end = pts[pts.length - 1];
    svg += `<text class="lad-name" x="${(X(end.cost) + 14).toFixed(1)}" y="${(Y(end.score) + 4).toFixed(1)}" fill="${s.color}">${s.label}</text>`;
    svg += `</g>`;
  });

  svg += `</svg>`;
  wrap.innerHTML = svg;

  // narrow screens pan instead of shrinking (see the 860px breakpoint). Open centred —
  // parked at the left edge a phone shows only the cheapest tail and the chart reads empty.
  if (wrap.scrollWidth > wrap.clientWidth) wrap.scrollLeft = (wrap.scrollWidth - wrap.clientWidth) / 2;

  // the "so what" — derived from the curve, not written by hand
  if (read) {
    read.innerHTML = series.map((s) => {
      const { peak, note } = ladderInsight(s);
      return `<li><b style="color:${s.color}">${s.label}</b> peaks at <b>${peak.score}%</b> on
              <em>${EFFORT_LBL[peak.effort]}</em>, at ${money(peak.cost)} an attempt. ${note}</li>`;
    }).join('');
  }

  // hover: raise the point, fade the other curves, show the rung-to-rung delta
  wrap.querySelectorAll('.lad-pt').forEach((g) => {
    const mid = g.getAttribute('data-mid');
    const s = L.series.find((x) => x.model_id === mid);
    const pts = s.points.slice().sort((a, b) => a.cost - b.cost);
    const p = pts[+g.getAttribute('data-i')], prev = pts[+g.getAttribute('data-i') - 1];
    g.addEventListener('mousemove', (e) => showLadderTip(e, s, p, prev, L));
    g.addEventListener('click', (e) => showLadderTip(e, s, p, prev, L));   // touch: tap a dot for the same read
    g.addEventListener('mouseenter', () => { wrap.classList.add('is-focus'); g.closest('.lad-series')?.classList.add('is-hot'); });
    g.addEventListener('mouseleave', () => { wrap.classList.remove('is-focus'); g.closest('.lad-series')?.classList.remove('is-hot'); hideTip(); });
  });

  wireEffortChips();
}

function wireEffortChips() {
  document.querySelectorAll('.lad-chip').forEach((b) => {
    b.onclick = () => {
      const id = b.getAttribute('data-mid');
      if (state.ladderOff.has(id)) state.ladderOff.delete(id); else state.ladderOff.add(id);
      renderEffort();
    };
  });
  document.querySelectorAll('.lad-suite[data-lad]').forEach((b) => {
    b.onclick = () => { state.ladder = +b.getAttribute('data-lad'); state.ladderOff.clear(); renderEffort(); };
  });
}

function showLadderTip(e, s, p, prev, L) {
  const tip = $('#tooltip');
  const delta = prev
    ? `<div class="tt-row"><span>vs ${EFFORT_LBL[prev.effort]}</span><span>${p.score >= prev.score ? '+' : ''}${(p.score - prev.score).toFixed(1)} pts · ${p.cost >= prev.cost ? '+' : ''}${Math.round((p.cost / prev.cost - 1) * 100)}% cost</span></div>`
    : '';
  tip.innerHTML =
    `<b>${s.label}</b> <span style="color:var(--ink-3)">${EFFORT_LBL[p.effort]} effort</span>
     <div class="tt-row"><span>${L.suite}</span><span>${p.score}%</span></div>
     <div class="tt-row"><span>cost / attempt</span><span>${money(p.cost)}</span></div>
     ${delta}`;
  tip.classList.add('show');
  const pad = 14;
  let x = e.clientX + pad, y = e.clientY + pad;
  if (x + 250 > window.innerWidth) x = e.clientX - 250;
  tip.style.left = x + 'px'; tip.style.top = y + 'px';
}

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
      <td class="num col-code">${fmtCoding(m, { unit: false })}${num(m.coding_score) ? '' : confMark(m, m.coding_confidence)}</td>
      <td class="num col-ctx">${fmtCtx(m.context_window)}</td>
      <td class="num col-price">${fmtPriceRange(m)}${confMark(m)}</td>
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

  // "show all 22" toggle — only when unfiltered (a filter is its own narrowing).
  // The dedicated table page always shows all 22, so it has no toggle.
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
  feed.innerHTML = rel.map((r, i) => {
    const w = relWhen(r.date);
    const title = r.source
      ? `<a href="${r.source}" target="_blank" rel="noopener">${r.title}<span class="rel__ext">↗</span></a>`
      : r.title;
    return `
    <li class="rel" style="--i:${Math.min(i, 6)}">
      <div class="rel__when"><span class="rel__mon">${w.mon}</span><span class="rel__day">${w.day}</span></div>
      <div class="rel__card">
        ${r.vendor ? `<span class="rel__vendor">${r.vendor}</span>` : ''}
        <h3 class="rel__title">${title}</h3>
        <p class="rel__sum">${r.summary || ''}</p>
        ${r.why ? `<p class="rel__why"><span>Should you care?</span> ${r.why}</p>` : ''}
      </div>
    </li>`;
  }).join('');

  // staggered reveal: entries resolve in one after another on first sight (same
  // .js-reveal gate + safety timeout discipline as the section reveals)
  if (document.documentElement.classList.contains('js-reveal')) {
    const items = feed.querySelectorAll('.rel');
    const io = new IntersectionObserver((es) => es.forEach((e) => {
      if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target); }
    }), { threshold: 0.06 });
    items.forEach((el2) => io.observe(el2));
    setTimeout(() => items.forEach((el2) => el2.classList.add('is-in')), 3000);
  }
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
  movePill();
  renderResult();
}
// budget slider: keep the input, its gold fill (--p) and the scale words in sync
function syncBudgetUI() {
  const r = $('#budgetRange');
  if (!r) return;
  if (+r.value !== state.priority) r.value = state.priority;
  r.style.setProperty('--p', state.priority + '%');
  const word = prioLabel(state.priority);
  document.querySelectorAll('.budget__word').forEach((b) =>
    b.classList.toggle('is-on', prioLabel(+b.getAttribute('data-bp')) === word));
}
function setPriority(p) {
  state.priority = +p;
  syncBudgetUI();
  renderResult();
}
// live-updating recommendation while dragging: renders are rAF-throttled so the
// answer tracks the thumb without flooding the main thread.
let _budgetRaf = 0;
function onBudgetInput() {
  const r = $('#budgetRange');
  state.priority = +r.value;
  syncBudgetUI();
  if (_budgetRaf) return;
  _budgetRaf = requestAnimationFrame(() => { _budgetRaf = 0; renderResult(); });
}

// ---------- sliding-pill indicator on the task control ----------
// one gold pill glides behind the active segment (spring-eased); buttons stay transparent.
function movePill() {
  document.querySelectorAll('.segmented--goals').forEach((group) => {
    const pill = group.querySelector('.seg-pill');
    const act = group.querySelector('.seg.is-active');
    if (!pill || !act) return;
    pill.style.width = act.offsetWidth + 'px';
    pill.style.transform = `translateX(${act.offsetLeft}px)`;
    // first placement is instant; every one after glides (avoids an entrance animation)
    if (!pill.classList.contains('is-ready')) requestAnimationFrame(() => pill.classList.add('is-ready'));
  });
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
  // budget: spring slider + tap-to-jump scale words
  const range = $('#budgetRange');
  if (range) {
    range.addEventListener('input', onBudgetInput);
    syncBudgetUI();
  }
  document.querySelectorAll('.budget__word').forEach((b) =>
    b.addEventListener('click', () => setPriority(b.getAttribute('data-bp')))
  );

  // task pill follows layout changes (font load shifts widths; resizes reflow the grid)
  addEventListener('resize', movePill);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(movePill);

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
  // the status says what actually happened: the generate button auto-copies and SAYS so;
  // a bare "Copied ✓" next to an unclicked button read as a lie (cold review #18)
  function copyPrompt(auto) {
    if (!ta) return;
    const ok = () => { if (copyStatus) copyStatus.textContent = auto ? 'Copied to your clipboard automatically ✓' : 'Copied ✓'; };
    const manual = () => { ta.focus(); ta.select(); if (copyStatus) copyStatus.textContent = 'Select all + copy'; };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(ta.value).then(ok).catch(manual);
    else manual();
  }
  if (gen) gen.addEventListener('click', () => {
    if (!ta || !panel || !state.data) return;   // no data, no prompt — the button stays disabled until data lands
    ta.value = buildAdvisorPrompt();
    panel.hidden = false;
    copyPrompt(true);                          // auto-copy the moment it's generated — and say so
  });
  const copyBtn = $('#copyPrompt'); if (copyBtn) copyBtn.addEventListener('click', () => copyPrompt(false));
}

// ---------- site-wide ASCII sunset (fixed, full-viewport background) ----------
// A living monospace ASCII scene: a near-black dusk sky banking warm to a low sun on the
// horizon, its light spilling down a shimmering column into flowing water. The water is a
// sum of travelling sine waves (three incommensurate octaves), so it drifts smoothly and
// never repeats — the "asciiwaves" quality. Fixed to the viewport, it sits behind every
// section on every page as the house backdrop, yet stays cheap: the browser composites a
// fixed canvas on its own layer, so scrolling never repaints it. ~30fps, blank cells
// skipped, paused when the tab is backgrounded. Honors prefers-reduced-motion.
function initScene() {
  const cv = document.getElementById('asciiScene');
  if (!cv) return;
  const ctx = cv.getContext('2d', { alpha: false });
  const rm = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // brightness -> glyph ramp (dark .. light). Mid glyphs are doubled so the texture eases
  // between levels; the top is a medium-weight '&', never a solid blob, so the sun reads as
  // a soft bright core rather than a hard mass.
  const RAMP = [' ', '.', '.', "'", '`', ':', ':', '-', '~', '~', '=', '+', '+', '*', 'o', 'o', 'c', 'x', 'X', '&'];
  const RMAX = RAMP.length - 1;

  // warm sunset temperature ramp, sampled by "temp" [0..1]:
  // indigo dusk -> violet -> mauve -> rose -> amber -> gold -> warm cream (never pure white).
  const STOPS = [
    [0.00, 16, 24, 48], [0.16, 36, 36, 72], [0.32, 78, 62, 102], [0.48, 124, 94, 128],
    [0.60, 158, 104, 116], [0.70, 182, 120, 116], [0.80, 210, 140, 104], [0.88, 226, 158, 104],
    [0.94, 238, 182, 116], [0.98, 246, 206, 142], [1.00, 252, 228, 186]
  ];
  const NBUCK = 48, PAL = new Array(NBUCK);
  for (let i = 0; i < NBUCK; i++) {
    const t = i / (NBUCK - 1);
    let k = 0; while (k < STOPS.length - 2 && t > STOPS[k + 1][0]) k++;
    const a = STOPS[k], b = STOPS[k + 1], f = (b[0] - a[0]) ? (t - a[0]) / (b[0] - a[0]) : 0;
    PAL[i] = 'rgb(' + (a[1] + (b[1] - a[1]) * f | 0) + ',' + (a[2] + (b[2] - a[2]) * f | 0) + ',' + (a[3] + (b[3] - a[3]) * f | 0) + ')';
  }

  const V_HOR = 0.47;            // horizon (fraction of viewport height) — a touch high so the
                                // busiest band sits behind the hero, leaving calmer water mid-scroll
  const SUN_U = 0.64;            // sun x (fraction of width) — right of centre, clear of the wordmark
  const SUN_V = V_HOR - 0.035;   // sun sits just above the horizon
  const SUN_R0 = 0.056, GSIG0 = 0.20;

  let W, H, DPR, cols, rows, cw, ch, aspect, sunXh, bgGrad, sunR, gsig2;
  function resize() {
    DPR = Math.min(devicePixelRatio || 1, 2);
    W = cv.width = Math.round(innerWidth * DPR);
    H = cv.height = Math.round(innerHeight * DPR);
    if (W < 8 || H < 8) { W = H = 0; return; }          // zero-size (prerender) — retry later
    cv.style.width = innerWidth + 'px'; cv.style.height = innerHeight + 'px';
    const cellCSS = innerWidth < 480 ? 11 : 13;          // bg cells: calm + cheap
    const fontPx = cellCSS * DPR;
    ctx.font = fontPx + 'px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textBaseline = 'top';
    cw = ctx.measureText('M').width || fontPx * 0.6;     // monospace advance (device px)
    ch = fontPx;                                         // row height (device px)
    cols = Math.ceil(W / cw) + 1; rows = Math.ceil(H / ch) + 1;
    aspect = innerWidth / innerHeight; sunXh = SUN_U * aspect;
    const sunScale = Math.min(1, Math.max(0.6, aspect)); // shrink the disc on tall narrow phones
    sunR = SUN_R0 * sunScale;
    const sig = GSIG0 * (0.72 + 0.28 * sunScale); gsig2 = sig * sig;
    bgGrad = ctx.createLinearGradient(0, 0, 0, H);
    bgGrad.addColorStop(0, '#0a0812'); bgGrad.addColorStop(V_HOR, '#150d16'); bgGrad.addColorStop(1, '#07060e');
  }

  // travelling-wave field: three incommensurate octaves => organic, non-repeating flow
  function waves(u, d, t) {
    return 0.55 * Math.sin(u * 6.2 + t * 0.60 + d * 3.0)
         + 0.30 * Math.sin(u * 11.7 - t * 0.42 + d * 6.4 + 1.7)
         + 0.16 * Math.sin(u * 19.3 + t * 0.83 + d * 2.1 + 4.1);
  }

  function render(tSec) {
    if (!W) { resize(); if (!W) return; }
    const breathe = rm ? 1 : (1 + 0.012 * Math.sin(tSec * 0.15));  // barely-there global swell
    ctx.globalAlpha = 1; ctx.fillStyle = bgGrad; ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = 0.85;                                        // gentler per-glyph read (text sits over this)
    let last = -1;
    for (let row = 0; row < rows; row++) {
      const v = row / (rows - 1), y = row * ch, dvh = v - SUN_V, below = v >= V_HOR, s = v / V_HOR;
      let depth = 0, sm = 0;
      if (below) { depth = (v - V_HOR) / (1 - V_HOR); const vm = 2 * V_HOR - v; sm = vm > 0 ? vm / V_HOR : 0; }
      const wCol = 0.05 + depth * 0.32;                            // reflection widens downward
      for (let col = 0; col < cols; col++) {
        const u = col / (cols - 1), dxh = u * aspect - sunXh, dist = Math.sqrt(dxh * dxh + dvh * dvh);
        const glow = Math.exp(-(dist * dist) / gsig2);             // radial sun glow 0..1
        let b, temp;
        if (!below) {
          /* ---- SKY: dark top -> warm horizon, with a slow flowing shimmer ---- */
          b = 0.05 + 0.34 * Math.pow(s, 1.9);
          b += 0.15 * Math.exp(-Math.pow((v - V_HOR) / 0.12, 2));  // soft horizon band
          b += 0.020 * waves(u, s, tSec * 0.35);                   // gentle atmosphere drift
          temp = Math.pow(s, 1.2);
        } else {
          /* ---- WATER: mirror of the sky, darker, undulating on the wave field ---- */
          const wf = waves(u, depth, tSec);                        // -1..1 flowing
          b = (0.02 + 0.42 * Math.pow(sm, 1.9)) * 0.5;
          b += 0.12 * Math.exp(-Math.pow((v - V_HOR) / 0.11, 2));  // reflected horizon glow
          b *= (1 - 0.40 * depth);                                 // darken toward foreground
          const colFall = Math.exp(-Math.pow(dxh / wCol, 2));      // reflection under the sun
          const band = 0.55 + 0.30 * Math.sin(Math.pow(depth, 0.6) * 15 - tSec * 0.32 + wf * 1.1);
          const refl = colFall * band * (0.78 * (1 - depth * 0.5));
          b += refl + 0.012 * wf * (1 - depth * 0.3);              // column + faint field ripple
          temp = 0.9 * (1 - Math.pow(depth, 0.8)) + refl * 0.7;    // gold along the reflected path
        }
        b += 0.48 * glow; temp += 0.78 * glow;                     // glow lifts brightness + warmth
        if (dist < sunR) { const c = 1 - dist / sunR; b += 0.4 * c; temp += 0.5 * c; }  // the disc
        b *= breathe;
        b = 1 - Math.exp(-1.35 * b);                               // soft tone-map: roll off highlights
        if (b <= 0.012) continue;                                  // skip near-blank cells -> fast
        if (b > 1) b = 1;
        const chi = (b * RMAX + 0.5) | 0; if (chi <= 0) continue;
        if (temp > 1) temp = 1; else if (temp < 0) temp = 0;
        const ci = (temp * (NBUCK - 1) + 0.5) | 0;
        if (ci !== last) { ctx.fillStyle = PAL[ci]; last = ci; }
        ctx.fillText(RAMP[chi], col * cw, y);
      }
    }
    ctx.globalAlpha = 1;
  }

  let lastT = 0, raf = 0, running = false;
  function loop(now) {
    if (!running) return;
    if (!W || !H) { resize(); raf = requestAnimationFrame(loop); return; }
    if (now - lastT >= 32) { lastT = now; render(now / 1000); }    // ~30fps, calm + battery-friendly
    raf = requestAnimationFrame(loop);
  }
  function start() { if (running || rm) return; running = true; lastT = 0; raf = requestAnimationFrame(loop); }
  function stop() { running = false; if (raf) cancelAnimationFrame(raf); raf = 0; }

  addEventListener('resize', () => { resize(); render(0); });
  resize();
  render(0);          // always paint one static frame synchronously — rAF never fires when hidden
  if (rm) return;     // reduced motion: keep the static frame, no animation
  // A fixed canvas is never repainted by scrolling, so we let it flow continuously and only
  // pause when the tab is truly backgrounded. (Don't gate the initial start on document.hidden —
  // some embedded/preview renderers report hidden permanently and would freeze the scene.)
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
  start();
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

// a broken fetch must fail like a product, not a stack trace: plain words, a retry,
// and no live controls pretending there's data behind them (cold review #15)
function renderLoadError() {
  setText('#navAsof', '● data unavailable');
  const msg = `<div class="loaderr" role="alert">
      <p>Couldn't load the model data — the connection may have dropped.</p>
      <button class="tbl-toggle" id="retryLoad" type="button">Try again</button>
    </div>`;
  const tb = $('#tblBody');
  if (tb) tb.innerHTML = `<tr><td colspan="6">${msg}</td></tr>`;
  const r = $('#result');
  if (r) r.innerHTML = msg;
  const gen = $('#genPrompt'); if (gen) gen.disabled = true;   // no data behind the CTA
  const retry = $('#retryLoad');
  if (retry) retry.addEventListener('click', () => {
    retry.disabled = true; retry.textContent = 'Loading…';
    _booted = false; bootOnce();
  });
}

async function boot() {
  try { initScene(); } catch (e) { /* the scene must never block the data */ }
  // the standalone full-table page (table.html) marks itself so we always show all 22
  const isTablePage = document.body.dataset.page === 'table';
  if (isTablePage) state.showAll = true;
  try {
    const ctl = new AbortController();
    const kill = setTimeout(() => ctl.abort(), 8000);   // a hung fetch surfaces as the error state, not eternal "loading…"
    const res = await fetch('data/models.json', { cache: 'no-store', signal: ctl.signal });
    clearTimeout(kill);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    state.data = await res.json();
  } catch (e) {
    renderLoadError();
    return;
  }
  readURL();                 // restore a shared selection before anything renders
  const asof = state.data.as_of || '—';
  const nav = $('#navAsof');
  if (nav) nav.innerHTML = '● snapshot ' + asof + '<span class="nav__asof-extra"> · pricing verified</span>';
  setText('#footAsof', asof);
  setText('#allCount', `all ${state.data.models.length} models`);   // never hand-count the roster again
  // the snapshot date is injected from the same field as the badge — the sourcing note
  // itself carries no hand-written dates, so the two can never disagree (cold review #3)
  setText('#footNotes', 'Data snapshot ' + asof + '. ' + (state.data.notes || 'Pricing from official vendor pages; benchmarks from public leaderboards. Every figure carries a confidence flag; unsourced numbers are left blank rather than guessed.'));
  const gen = $('#genPrompt'); if (gen) gen.disabled = false;   // data's here — the advisor can work now

  wire();
  setActive('data-goal', state.goal);   // reflect a URL-restored task on the console
  initReveal();
  renderFilters();
  renderLabChips();          // build the "which lab" chips from the data's vendors + wire them
  if ($('#cmpBoard')) seedCompare();  // the side-by-side board seeds from the default task until the user hand-picks
  if ($('#chart')) renderChart();      // the model map used to hang off the hero engine's verdict; it stands alone now
  renderEffort();            // published effort ladders; guarded no-op on table.html
  renderTable();             // full table lives on table.html; guarded no-op elsewhere
  renderFeed();
  movePill();                // place the task pill once the layout is real
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
