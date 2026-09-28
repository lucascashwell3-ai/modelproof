/* ARCHIVED — not loaded by any page. The ranking half of assets/app.js as it stood when it
   was retired: the goal/budget/labs console, the scorer, the "Your pick" card and its basis panel,
   the per-lab kit, the upgrade check, the old compare seeding (top 3 by score) and the goal maps.
   None of this had markup on any shipped page except seedCompare, which ranked the compare board.
   Kept for history; see archive/README.md. It depends on helpers that still live in app.js
   (num, capVal, fmtPrice, fmtScore, fmtCoding, fmtCtx, esc, shortUrl, metricLabel, LAB_LABEL…). */

// budget is a continuum (the spring slider) — words are derived, not buckets
function prioLabel(p) { return p <= 16 ? 'cheapest' : p <= 38 ? 'value' : p <= 66 ? 'balanced' : 'best'; }

// ----

// which benchmark a goal cares about
const GOAL_METRIC = {
  coding: 'coding_score',   // unified 0-100 coding score (blends SWE-bench + other sourced signals)
  research: 'gpqa',
  writing: 'gpqa',          // no clean writing benchmark — general reasoning is the fallback (LMArena dropped 2026-08-22: no-redistribution source, feed dead)
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
  coding: 'Writing, fixing & refactoring code — including multi-step agent tasks. Ranked on a 0–100 coding score: SWE-bench where it exists, otherwise sourced signals (agentic suites, vendor-published evals) so new models aren\'t stuck at "—".',
  research: 'Deep thinking, analysis & planning. Ranked on graduate-level reasoning (GPQA).',
  writing: 'Drafting prose, emails & content. No clean writing benchmark exists, so only models the data tags for prose are ranked — on general ability + price.',
  'cheap-bulk': 'High-volume simple work — classification, tagging, extraction. Cheapest capable option first.',
};


// ----

const CONF_TXT = { high: 'high', medium: 'med', low: 'low' };
const confMark = (m, conf) => { const c = conf || m.confidence || 'low'; return `<i class="conf conf-${c}"></i><span class="conf-txt">${CONF_TXT[c] || c}</span>`; };

// ----

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
  const echo = $('#queryEcho');
  if (echo) { const q = queryText(); echo.innerHTML = `${q.task} · ${q.budget} cost · <b>${q.labs}</b>`; }
  syncURL();         // the selection is shareable — it lives in the query string
  renderVerdict();
  seedCompare();     // the side-by-side board follows the engine until the user hand-picks
}


// ----

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

// ----

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


// ----

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

// ---------- cost vs capability chart ----------

// ----

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

// ----

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

