/* ============================================================
   Modelproof — client-side decision engine
   Loads data/models.json and renders: recommender, cost/capability
   chart, compare table, releases feed. Honest with missing data.
   ============================================================ */

const state = {
  data: null,
  goal: 'coding',
  priority: 48,          // 0 = cheapest, 100 = best (set by the discrete selector)
  filter: 'all',
  sort: { key: 'coding_score', dir: 'desc' },
  expanded: new Set(),
};

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

function renderResult() {
  const box = $('#result');
  const ranked = score(state.data.models, state.goal, state.priority);
  if (!ranked.length) {
    box.innerHTML = '<div class="empty">No model has a sourced score for this goal yet — see the full table below.</div>';
    return;
  }
  const top = ranked[0].m;
  const runners = ranked.slice(1, 3).map((r) => r.m);
  state.pickId = top.id;

  const metric = GOAL_METRIC[state.goal];
  const hv = headlineStat(top, metric);
  const caption = state.goal === 'cheap-bulk'
    ? 'Ranked mostly on price. Cheapest capable option first.'
    : 'Ranked on sourced benchmarks + price. Models with no sourced score for this goal sit in the table below, not here.';

  box.innerHTML = `
    <div class="pick">
      <span class="pick__flag">Top pick</span>
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

function metricLabel(metric) {
  return { coding_score: 'Coding', swe_bench: 'SWE-bench', gpqa: 'GPQA', aime: 'AIME', lmarena_elo: 'LMArena Elo', mmlu_pro: 'MMLU-Pro' }[metric] || metric;
}

// ---------- cost vs capability chart ----------
function renderChart() {
  const wrap = $('#chart');
  const metric = GOAL_METRIC[state.goal];
  const pts = state.data.models
    .map((m) => ({ m, x: m.price_output, y: capVal(m, metric) }))
    .filter((p) => !num(p.x) && !num(p.y));

  $('#mapLegend').innerHTML =
    `<span><i style="background:var(--gold)"></i>Your top pick</span>
     <span><i style="background:var(--gold-line)"></i>Other models</span>
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

  const midX = padL + plotW / 2, midY = padT + plotH / 2;
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Cost versus capability scatter plot">`;

  // sweet-spot tint (top-left = cheap + capable)
  svg += `<rect x="${padL}" y="${padT}" width="${plotW / 2}" height="${plotH / 2}" fill="var(--gold)" opacity="0.05"/>`;

  // quadrant guide lines
  svg += `<line class="grid-line" x1="${midX}" y1="${padT}" x2="${midX}" y2="${padT + plotH}"/>`;
  svg += `<line class="grid-line" x1="${padL}" y1="${midY}" x2="${padL + plotW}" y2="${midY}"/>`;

  // quadrant labels
  svg += `<text class="quad-lbl" x="${padL + 8}" y="${padT + 16}">sweet spot · cheap + capable</text>`;
  svg += `<text class="quad-lbl" x="${padL + plotW - 8}" y="${padT + 16}" text-anchor="end">premium</text>`;
  svg += `<text class="quad-lbl" x="${padL + 8}" y="${padT + plotH - 8}">budget</text>`;
  svg += `<text class="quad-lbl" x="${padL + plotW - 8}" y="${padT + plotH - 8}" text-anchor="end">overpriced</text>`;

  // axes
  svg += `<line class="axis-line" x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}"/>`;
  svg += `<line class="axis-line" x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + plotH}"/>`;

  // x ticks
  xticks.forEach((t) => {
    const xx = X(t);
    svg += `<text class="axis-lbl" x="${xx}" y="${padT + plotH + 18}" text-anchor="middle">$${t < 1 ? t : t.toFixed(0)}</text>`;
    svg += `<line class="grid-line" x1="${xx}" y1="${padT}" x2="${xx}" y2="${padT + plotH}" opacity="0.4"/>`;
  });
  // y ticks (3)
  [y0, (y0 + y1) / 2, y1].forEach((v) => {
    const yy = Y(v);
    svg += `<text class="axis-lbl" x="${padL - 10}" y="${yy + 4}" text-anchor="end">${Math.round(v)}</text>`;
  });

  svg += `<text class="axis-title" x="${padL + plotW / 2}" y="${H - 10}" text-anchor="middle">Price — $ per 1M output tokens (log scale)</text>`;
  svg += `<text class="axis-title" transform="translate(16 ${padT + plotH / 2}) rotate(-90)" text-anchor="middle">${metricLabel(metric)} score →</text>`;

  // dots — big hit target + hover-scaled marks; label stays put
  pts.forEach((p) => {
    const cx = X(p.x), cy = Y(p.y);
    const isPick = p.m.id === state.pickId;
    const r = isPick ? 9 : 7;
    const nearRight = cx > padL + plotW * 0.7;   // keep labels inside the plot
    const lx = nearRight ? -(r + 6) : (r + 6);
    svg += `<g class="dot ${isPick ? 'is-pick' : ''}" data-id="${p.m.id}" transform="translate(${cx} ${cy})">`;
    svg += `<circle class="d-hit" r="26" fill="transparent"/>`;                 // easy hover/click target
    svg += `<g class="dot__marks">`;
    if (isPick) svg += `<circle class="d-halo" r="18" fill="var(--gold)" opacity="0.18"/>`;
    svg += `<circle class="d-core" r="${r}" fill="${isPick ? 'var(--gold)' : 'var(--panel)'}" stroke="var(--gold-line)" stroke-width="1.8"/>`;
    svg += `</g>`;
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
function hideTip() { $('#tooltip').classList.remove('show'); }

// ---------- compare table ----------
function renderFilters() {
  const goals = ['all', 'coding', 'research', 'writing', 'cheap-bulk', 'vision', 'long-context', 'speed'];
  const box = $('#filters');
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
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
}
function setGoal(goal) {
  state.goal = goal;
  setActive('data-goal', goal);
  const d = $('#goalDesc'); if (d) d.textContent = GOAL_DESC[goal] || '';
  renderResult();          // table sort stays independent of goal (less surprising)
}
function setPriority(p) {
  state.priority = +p;
  setActive('data-p', p);
  renderResult();
}
function wire() {
  document.querySelectorAll('[data-goal]').forEach((b) =>
    b.addEventListener('click', () => {
      setGoal(b.getAttribute('data-goal'));
      // asked in the sunset, answered in the dark: hero picks scroll to the result
      if (b.closest('.hero')) {
        const eng = document.getElementById('engine');
        if (eng) eng.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    })
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
}

// ---------- hero: living ASCII sunset (bounded to the hero; pauses off-screen) ----------
// Brightness->glyph ramp + warm dusk->gold palette, mirrored into a calm sea with a
// shimmering sun-reflection column. Adapted from design/hero-ascii-reference.html; sized to
// the hero box (not the window) and paused when scrolled away so it never janks the page.
function initScene() {
  const cv = document.getElementById('heroScene');
  const host = document.getElementById('hero');
  if (!cv || !host) return;
  const ctx = cv.getContext('2d', { alpha: false });
  const rm = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const RAMP = [' ', '.', '.', "'", '`', ':', ':', '-', '~', '~', '=', '+', '+', '*', 'o', 'o', 'c', 'x', 'X', '&'];
  const RMAX = RAMP.length - 1;
  const STOPS = [
    [0.00, 16, 24, 48], [0.16, 36, 36, 72], [0.32, 78, 62, 102], [0.48, 124, 94, 128],
    [0.60, 158, 104, 116], [0.70, 182, 120, 116], [0.80, 210, 140, 104], [0.88, 226, 158, 104],
    [0.94, 238, 182, 116], [0.98, 246, 206, 142], [1.00, 252, 228, 186],
  ];
  const NBUCK = 48;
  const PAL = new Array(NBUCK);
  for (let i = 0; i < NBUCK; i++) {
    const t = i / (NBUCK - 1);
    let k = 0; while (k < STOPS.length - 2 && t > STOPS[k + 1][0]) k++;
    const a = STOPS[k], b = STOPS[k + 1];
    const f = (b[0] - a[0]) ? (t - a[0]) / (b[0] - a[0]) : 0;
    const r = (a[1] + (b[1] - a[1]) * f) | 0, g = (a[2] + (b[2] - a[2]) * f) | 0, bl = (a[3] + (b[3] - a[3]) * f) | 0;
    PAL[i] = 'rgb(' + r + ',' + g + ',' + bl + ')';
  }

  const V_HOR = 0.55, SUN_U = 0.60, SUN_V = V_HOR - 0.03, SUN_R0 = 0.100, GSIG0 = 0.280;
  let W, H, DPR, cols, rows, cw, ch, aspect, sunXh, bgGrad, sunR, gsig2;

  function resize() {
    const cssW = host.clientWidth || innerWidth;
    const cssH = host.clientHeight || innerHeight;
    DPR = Math.min(devicePixelRatio || 1, 2);
    W = cv.width = Math.round(cssW * DPR);
    H = cv.height = Math.round(cssH * DPR);
    cv.style.width = cssW + 'px'; cv.style.height = cssH + 'px';
    const cellCSS = cssW < 480 ? 10 : 11;
    const fontPx = cellCSS * DPR;
    ctx.font = fontPx + 'px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textBaseline = 'top';
    cw = ctx.measureText('M').width || fontPx * 0.6;
    ch = fontPx;
    cols = Math.ceil(W / cw) + 1; rows = Math.ceil(H / ch) + 1;
    aspect = cssW / cssH; sunXh = SUN_U * aspect;
    const sunScale = Math.min(1, Math.max(0.62, aspect / 1.0));
    sunR = SUN_R0 * sunScale;
    const sig = GSIG0 * (0.72 + 0.28 * sunScale); gsig2 = sig * sig;
    bgGrad = ctx.createLinearGradient(0, 0, 0, H);
    bgGrad.addColorStop(0.00, '#0a0812');
    bgGrad.addColorStop(V_HOR, '#140d16');
    bgGrad.addColorStop(1.00, '#080610');
  }

  function render(tSec) {
    const breathe = rm ? 1 : (1 + 0.014 * Math.sin(tSec * 0.16));
    ctx.globalAlpha = 1;
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = 0.96;
    let last = -1;
    for (let row = 0; row < rows; row++) {
      const v = row / (rows - 1);
      const y = row * ch;
      const dvh = v - SUN_V;
      const below = v >= V_HOR;
      const s = v / V_HOR;
      let depth = 0, sm = 0;
      if (below) {
        depth = (v - V_HOR) / (1 - V_HOR);
        const vm = 2 * V_HOR - v;
        sm = vm > 0 ? vm / V_HOR : 0;
      }
      const wCol = 0.045 + depth * 0.30;
      for (let col = 0; col < cols; col++) {
        const u = col / (cols - 1);
        const dxh = u * aspect - sunXh;
        const dist = Math.sqrt(dxh * dxh + dvh * dvh);
        const glow = Math.exp(-(dist * dist) / gsig2);
        let b, temp;
        if (!below) {
          b = 0.09 + 0.46 * Math.pow(s, 1.9);
          b += 0.30 * Math.exp(-Math.pow((v - V_HOR) / 0.14, 2));
          b += 0.025 * Math.sin(u * 6.3 + v * 13 + 1.0);
          temp = Math.pow(s, 1.2);
        } else {
          b = (0.02 + 0.42 * Math.pow(sm, 1.9)) * 0.62;
          b += 0.12 * Math.exp(-Math.pow((v - V_HOR) / 0.11, 2));
          b *= (1 - 0.42 * depth);
          const colFall = Math.exp(-Math.pow(dxh / wCol, 2));
          const band = 0.55 + 0.30 * Math.sin(Math.pow(depth, 0.6) * 16 - tSec * 0.34 + Math.sin(u * 18) * 0.6);
          const refl = colFall * band * (0.92 * (1 - depth * 0.5));
          b += refl;
          temp = 0.9 * (1 - Math.pow(depth, 0.8)) + refl * 0.7;
        }
        b += 0.72 * glow;
        temp += 0.8 * glow;
        if (dist < sunR) { const c = 1 - dist / sunR; b += 0.4 * c; temp += 0.5 * c; }
        b *= breathe;
        b = 1 - Math.exp(-1.35 * b);
        const mdx = (u - 0.5) * 4.7619;
        const mdy = (v - 0.47) * 4.3478;
        const mask = Math.exp(-(mdx * mdx + mdy * mdy));
        b *= (1 - 0.12 * mask);   // gentle — legibility comes from the CSS scrim + text-shadow
        if (b <= 0.01) continue;
        if (b > 1) b = 1;
        const chi = (b * RMAX + 0.5) | 0;
        if (chi <= 0) continue;
        if (temp > 1) temp = 1; else if (temp < 0) temp = 0;
        const ci = (temp * (NBUCK - 1) + 0.5) | 0;
        if (ci !== last) { ctx.fillStyle = PAL[ci]; last = ci; }
        ctx.fillText(RAMP[chi], col * cw, y);
      }
    }
    ctx.globalAlpha = 1;
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

  addEventListener('resize', () => { resize(); if (rm) render(0); });
  resize();
  if (rm) { render(0); return; }                                 // one static frame, no rAF
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

// ---------- boot ----------
async function boot() {
  initScene();                     // paint the sunset immediately, independent of data
  try {
    const res = await fetch('data/models.json', { cache: 'no-store' });
    state.data = await res.json();
  } catch (e) {
    $('#result').innerHTML = '<div class="empty">Could not load data/models.json.</div>';
    return;
  }
  const asof = state.data.as_of || '—';
  $('#navAsof').textContent = 'as of ' + asof;
  $('#footAsof').textContent = asof;
  $('#footNotes').textContent = state.data.notes || 'Pricing from official vendor pages; benchmarks from public leaderboards. Every figure carries a confidence flag; unsourced numbers are left blank rather than guessed.';

  wire();
  $('#goalDesc').textContent = GOAL_DESC[state.goal] || '';
  renderFilters();
  renderResult();
  renderTable();
  renderUsage();
  renderFeed();
}
document.addEventListener('DOMContentLoaded', boot);
