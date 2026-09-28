/* ============================================================
   Modelproof — client-side facts renderer
   Loads data/models.json and renders: side-by-side compare, price vs
   score map, effort ladders, full table, releases feed. Sourced or
   blank — it never ranks models or names one for a job.
   ============================================================ */

const state = {
  data: null,
  filter: 'all',         // full-table lab filter: 'all', a vendor name, or 'other'
  showAll: false,        // compare table defaults to the common flagships; opt in to all 22
  // Opens newest release first: never by coding_score, which for many models is Modelproof's own
  // estimate (marked est). Any column header still sorts by that column.
  sort: { key: 'released', dir: 'desc' },
  expanded: new Set(),
  compare: [],           // model ids on the side-by-side board (2–5)
  cmpCustom: false,      // true once the user chooses models — stops the auto-seeding
  ladder: 0,             // which published effort ladder is on screen
  ladderOff: new Set(),  // model ids toggled off in the effort chart
  feedExpanded: false,   // timeline defaults to the latest FEED_CAP; "Show all" reveals the rest
};
const FEED_CAP = 6;
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
// The coding score has ONE identity everywhere it appears — compare board, map, table,
// and the effort chart: "N/100, SWE-bench Verified where published, otherwise a sourced
// estimate marked est". A score with no published SWE-bench is an estimate, and the est mark
// travels with the number instead of hiding in a hover dot.
const CODING_DEF = 'Coding score, 0–100 — SWE-bench Verified where published, otherwise a sourced estimate (marked est)';
const isEst = (m) => num(m.benchmarks?.swe_bench);
function fmtCoding(m, { unit = true } = {}) {
  if (num(m.coding_score)) return '<span class="na">—</span>';
  return m.coding_score + (unit ? '<span class="unit">/100</span>' : '') +
    (isEst(m) ? '<sup class="est" title="estimate — SWE-bench Verified not published">est</sup>' : '');
}
function fmtPriceRange(m) {
  if (num(m.price_input) && num(m.price_output)) return '<span class="na">—</span>';
  return `${fmtPrice(m.price_input)}<span class="pslash">/</span>${fmtPrice(m.price_output)}`;
}

// What the labs and reporters say about a model, from its sourced claims (task_fit_judged):
// each quote once, with its link and the date it was checked. A lab's own words come first
// (tier "lab"); the compare board's "Lab says" row shows only those.
// Empty when nothing is sourced — then nothing renders.
function sourcedClaims(m) {
  const seen = new Map();
  for (const entry of Object.values(m.task_fit_judged || {})) {
    for (const c of entry?.claims || []) {
      if (!c?.quote || !c?.source_url) continue;
      const k = c.quote + '\u0000' + c.source_url;
      if (!seen.has(k)) seen.set(k, c);
    }
  }
  return [...seen.values()].sort((a, b) => (a.tier === 'lab' ? 0 : 1) - (b.tier === 'lab' ? 0 : 1));
}
function claimHTML(c) {
  return `<q class="claim__q">${esc(c.quote)}</q> <a class="claim__src" href="${esc(c.source_url)}" target="_blank" rel="noopener">${shortUrl(c.source_url)}</a>${c.date ? ` <span class="claim__date">${esc(c.date)}</span>` : ''}`;
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

// ---------- side-by-side comparator ----------
// Seeded with the newest generally available model (with a sourced price and coding score)
// from each of the first three labs in LAB_ORDER — a fixed, neutral starting set, never a
// ranking. The user can choose 2–3 models from the dropdowns; that stops the auto-seeding.
function seedCompare() {
  if (!state.cmpCustom) {
    const ids = [];
    for (const lab of LAB_ORDER) {
      // only models with a real date, a sourced price and a coding score (so the board has facts
      // to show); same-day ties go by name
      const newest = state.data.models
        .filter((m) => m.vendor === lab && m.status === 'ga' && /^\d{4}/.test(String(m.released || '')) && !num(m.coding_score) && !num(m.price_output))
        .sort((a, b) => String(b.released).localeCompare(String(a.released)) || a.name.localeCompare(b.name))[0];
      if (newest) ids.push(newest.id);
      if (ids.length >= 3) break;
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
        <option value="">${i < 2 ? 'Choose a model' : '— none —'}</option>
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
    ['Coding', (m) => `<span class="cmp-num">${fmtCoding(m)}</span>`],
    ['GPQA', (m) => `<span class="cmp-num">${fmtScore(m.benchmarks?.gpqa)}</span>`],
    ['Context', (m) => `<span class="cmp-num">${fmtCtx(m.context_window)}</span>`],
    ['$ in / 1M', (m) => `<span class="cmp-num">${fmtPrice(m.price_input)}</span>`],
    ['$ out / 1M', (m) => `<span class="cmp-num">${fmtPrice(m.price_output)}</span>`],
    ['Lab says', (m) => { const c = sourcedClaims(m).find((x) => x.tier === 'lab'); return c ? `<span class="cmp-claim">${claimHTML(c)}</span>` : '<span class="na">—</span>'; }],
  ];
  bd.innerHTML = rows.map(([label, fn], ri) =>
    `<div class="cmp-cell cmp-lbl${ri === 0 ? ' cmp-head' : ''}">${label}</div>` +
    ms.map((m) => `<div class="cmp-cell${ri === 0 ? ' cmp-head' : ''}">${fn(m)}</div>`).join('')
  ).join('');
}

function metricLabel(metric) {
  return { coding_score: 'Coding', swe_bench: 'SWE-bench', gpqa: 'GPQA', aime: 'AIME', mmlu_pro: 'MMLU-Pro' }[metric] || metric;
}

// ---------- price vs score map ----------
// The y axis is the coding score (0–100). The map plots facts; it never names a model.
const MAP_METRIC = 'coding_score';

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
  const metric = MAP_METRIC;
  const pts = state.data.models
    .map((m) => ({ m, x: m.price_output, y: capVal(m, metric) }))
    .filter((p) => !num(p.x) && !num(p.y));

  $('#mapLegend').innerHTML =
    `<span><i style="background:var(--gold)"></i>No model scores higher for less</span>
     <span><i style="background:rgba(233,230,223,0.45)"></i>Another model scores higher for less</span>
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

  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Model map: price versus coding score; lower price and higher score is top-left">`;

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
  svg += `<text class="zone-lbl" x="${padL + 14}" y="${padT + 20}">↖ LOWER PRICE, HIGHER SCORE</text>`;

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

  // dots: frontier models burn gold and are labelled; the rest recede to pale gray
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
    const fro = drawFrontier && onFrontier.has(p.m.id);
    const hot = fro;
    const dy = hot ? labelDy(cx, cy) : 0;
    const nearRight = cx > padL + plotW * 0.72;
    const lx = nearRight ? -12 : 12;
    svg += `<g class="dot ${fro ? 'is-frontier' : ''}" data-id="${p.m.id}" transform="translate(${cx.toFixed(1)} ${cy.toFixed(1)})">`;
    svg += `<circle class="d-hit" r="24" fill="transparent"/>`;
    svg += `<circle class="d-core" r="${hot ? 5.5 : 4}" fill="${hot ? 'var(--gold)' : 'rgba(233,230,223,0.38)'}" stroke="${hot ? '#0a0b0f' : 'none'}" stroke-width="1.5"/>`;
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
     <div class="tt-row"><span>${metricLabel(metric)}</span><span>${metric === 'coding_score' ? fmtCoding(m) : fmtScore(capVal(m, metric))}</span></div>
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
         <details class="lad-source__details">
           <summary>Read the method notes</summary>
           <span class="lad-source__block">${L.harness}</span>
           <span class="lad-source__block">${L.method}</span>
           <span class="lad-source__block lad-source__warn">${L.caveat}</span>
         </details>`
      : '';
  }

  if (!L) {
    wrap.innerHTML = `<div class="empty" style="padding:60px 0">No lab has published an effort ladder we can source yet.</div>`;
    if (legend) legend.innerHTML = '';
    if (read) read.innerHTML = '';
    return;
  }

  const series = L.series.filter((s) => !state.ladderOff.has(s.model_id));

  // suite chooser only appears if there's more than one ladder to choose between
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

  const W = 920, H = 470, padL = 60, padR = 136, padT = 26, padB = 62;
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

  const TICKS = [0.1, 0.15, 0.2, 0.3, 0.5, 1, 1.5, 2, 3, 5, 7, 10, 15, 20, 30, 50, 70, 100, 150];
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

  // end labels: sorted by where they land, pushed apart so no two sit within 15px; a short
  // leader ties a pushed label back to its rung
  const ends = series.map((s) => { const e = s.points.slice().sort((a, b) => a.cost - b.cost).pop(); return { s, x: X(e.cost), y: Y(e.score) }; })
    .sort((a, b) => a.y - b.y);
  let prevY = -Infinity;
  ends.forEach((e) => { e.ly = Math.max(e.y, prevY + 15); prevY = e.ly; });
  const over = ends.length ? ends[ends.length - 1].ly - (padT + plotH) : 0;   // stack ran off the bottom — shift it all up
  if (over > 0) ends.forEach((e) => { e.ly -= over; });
  const labelAt = Object.fromEntries(ends.map((e) => [e.s.model_id, e]));

  // one curve per model: line, then a dot per effort rung, then the name at the last rung
  series.forEach((s) => {
    const pts = s.points.slice().sort((a, b) => a.cost - b.cost);
    const d = pts.map((p, i) => `${i ? 'L' : 'M'} ${X(p.cost).toFixed(1)} ${Y(p.score).toFixed(1)}`).join(' ');
    svg += `<g class="lad-series" data-mid="${s.model_id}">`;
    svg += `<path class="lad-line" d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-opacity="0.85" stroke-linejoin="round" stroke-linecap="round"/>`;
    pts.forEach((p, i) => {
      const cx = X(p.cost), cy = Y(p.score);
      svg += `<g class="lad-pt" data-mid="${s.model_id}" data-i="${i}">`;
      svg += `<circle class="lad-hit" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="18" fill="transparent"/>`;
      svg += `<circle class="lad-ring" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="9" fill="none" stroke="${s.color}" stroke-width="1.6" opacity="0"/>`;
      svg += `<circle class="lad-dot" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="5.6" fill="${s.color}" stroke="var(--bg-2)" stroke-width="1.6"/>`;
      svg += `</g>`;
    });
    // names live in a column at the plot's right edge, never on top of another model's line
    const e = labelAt[s.model_id], lx = padL + plotW + 12;
    svg += `<line x1="${(e.x + 7).toFixed(1)}" y1="${e.y.toFixed(1)}" x2="${(lx - 4).toFixed(1)}" y2="${e.ly.toFixed(1)}" stroke="${s.color}" stroke-width="1" stroke-opacity="0.3" stroke-dasharray="2 3"/>`;
    svg += `<text class="lad-name" x="${lx.toFixed(1)}" y="${(e.ly + 4).toFixed(1)}" fill="${s.color}">${s.label}</text>`;
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
// Filter by lab — a plain fact about each model, never a judgement about what it's for.
function renderFilters() {
  const box = $('#filters');
  if (!box || !state.data) return;
  // The main labs get a chip each; every other vendor shares one "Other labs" chip.
  const present = new Set(state.data.models.map((m) => m.vendor));
  const keys = ['all', ...LAB_ORDER.filter((v) => present.has(v))];
  if ([...present].some((v) => !LAB_ORDER.includes(v))) keys.push('other');
  const label = (k) => (k === 'all' ? 'All' : k === 'other' ? 'Other labs' : k);
  box.innerHTML = keys.map((k) =>
    `<button class="chip ${state.filter === k ? 'is-active' : ''}" data-f="${esc(k)}" aria-pressed="${state.filter === k}">${esc(label(k))}</button>`
  ).join('');
  box.querySelectorAll('.chip').forEach((c) =>
    c.addEventListener('click', () => { state.filter = c.getAttribute('data-f'); renderFilters(); renderTable(); })
  );
}

// A release date as a sortable string: 2026-09-21, 2026-09 and 2026 as they are; a quarter
// (2026-Q3) as its first month. Anything else sorts last.
function releasedKey(v) {
  const s = String(v || '');
  if (/^\d{4}(-\d{2}){0,2}$/.test(s)) return s;
  const q = /^(\d{4})-Q([1-4])$/.exec(s);
  return q ? `${q[1]}-${String((q[2] - 1) * 3 + 1).padStart(2, '0')}` : null;
}

function sortedModels() {
  let list = state.data.models.slice();
  if (state.filter !== 'all') {
    list = list.filter((m) => (state.filter === 'other' ? !LAB_ORDER.includes(m.vendor) : m.vendor === state.filter));
  } else if (!state.showAll) {
    list = list.filter((m) => COMMON_IDS.includes(m.id));   // default: the common flagships only
  }
  const { key, dir } = state.sort;
  const val = (m) => {
    if (key === 'name') return m.name.toLowerCase();
    if (key === 'released') return releasedKey(m.released);
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
      <td class="num col-code">${fmtCoding(m, { unit: false })}</td>
      <td class="num col-ctx">${fmtCtx(m.context_window)}</td>
      <td class="num col-price">${fmtPriceRange(m)}</td>
      <td class="is-right col-exp" style="text-align:right;color:var(--ink-4)">${state.expanded.has(m.id) ? '−' : '+'}</td>`;
    tr.addEventListener('click', () => {
      if (state.expanded.has(m.id)) state.expanded.delete(m.id); else state.expanded.add(m.id);
      renderTable();
    });
    body.appendChild(tr);

    if (state.expanded.has(m.id)) {
      const mr = el('tr', 'row-more');
      const td = el('td'); td.colSpan = 5;
      const claims = sourcedClaims(m);
      td.innerHTML = `
        <div class="rm-grid">
          <div>
            <h4>Sourced quotes</h4>
            ${claims.length
              ? `<ul class="claims">${claims.slice(0, 3).map((c) => `<li>${claimHTML(c)}</li>`).join('')}</ul>`
              : '<p class="na" style="font-size:12.5px">No sourced quote on file yet.</p>'}
          </div>
          <div>
            <h4>Coding score: <span style="color:var(--ink)">${num(m.coding_score) ? '—' : m.coding_score}/100</span></h4>
            <p style="font-size:12.5px;color:var(--ink-3);margin-top:-4px">Basis: ${sourceLinks(m)}</p>
            <h4 style="margin-top:14px">Benchmarks</h4>
            <ul>
              <li>SWE-bench Verified: ${fmtScore(m.benchmarks?.swe_bench)}</li>
              <li>GPQA (reasoning): ${fmtScore(m.benchmarks?.gpqa)}</li>
              <li>AIME (math): ${fmtScore(m.benchmarks?.aime)}</li>
            </ul>
            <h4 style="margin-top:14px">Sources</h4>
            <div class="srcs">${sourceLinks(m)}</div>
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

// The model's own source links. Shown instead of free-text basis prose, which can carry
// third-party ranking wording.
function sourceLinks(m) {
  return (m.sources || []).slice(0, 3).map((u) => `<a href="${u}" target="_blank" rel="noopener">${shortUrl(u)}</a>`).join(' · ') || '<span class="na">no public source recorded</span>';
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
  // kinds: model (default view) · price · retired. The chips add the other two in.
  const all = state.data.releases || [];
  const kinds = $('#feedKinds');
  state.feedKinds = state.feedKinds || new Set(['model']);
  if (kinds && !kinds.childElementCount) {
    const counts = { price: all.filter((r) => r.kind === 'price').length, retired: all.filter((r) => r.kind === 'retired').length };
    kinds.innerHTML = `
      <span class="feed-kind feed-kind--fixed">New models</span>
      <button class="feed-kind" type="button" data-kind="price" aria-pressed="false">+ Price changes <i>${counts.price}</i></button>
      <button class="feed-kind" type="button" data-kind="retired" aria-pressed="false">+ Retirements <i>${counts.retired}</i></button>`;
    kinds.querySelectorAll('[data-kind]').forEach((b) => b.addEventListener('click', () => {
      const k = b.dataset.kind;
      if (state.feedKinds.has(k)) state.feedKinds.delete(k); else state.feedKinds.add(k);
      b.setAttribute('aria-pressed', String(state.feedKinds.has(k)));
      renderFeed();
    }));
  }
  const rel = all.filter((r) => state.feedKinds.has(r.kind || 'model')).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const more = $('#feedMore');
  if (!rel.length) {
    feed.innerHTML = '<li class="empty">Nothing recorded for this view yet.</li>';
    if (more) more.innerHTML = '';
    return;
  }
  // 6-cap applies after filtering — chips narrow `rel` first, then the cap trims the view.
  const visible = state.feedExpanded ? rel : rel.slice(0, FEED_CAP);
  if (more) {
    more.innerHTML = rel.length > FEED_CAP
      ? `<button class="feed-kind feed-more__btn" type="button" id="feedToggle">${state.feedExpanded ? 'Show fewer' : `Show all ${rel.length}`}</button>`
      : '';
    const toggle = $('#feedToggle');
    if (toggle) toggle.addEventListener('click', () => { state.feedExpanded = !state.feedExpanded; renderFeed(); });
  }
  feed.innerHTML = visible.map((r, i) => {
    const w = relWhen(r.date);
    const title = r.source
      ? `<a href="${r.source}" target="_blank" rel="noopener">${r.title}<span class="rel__ext">↗</span></a>`
      : r.title;
    return `
    <li class="rel" style="--i:${Math.min(i, 6)}">
      <div class="rel__when"><span class="rel__mon">${w.mon}</span><span class="rel__day">${w.day}</span></div>
      <div class="rel__card">
        ${r.vendor ? `<span class="rel__vendor">${r.vendor}</span>` : ''}${r.kind === 'price' ? '<span class="rel__kind">price</span>' : r.kind === 'retired' ? '<span class="rel__kind rel__kind--off">retired</span>' : ''}
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

function wire() {
  document.querySelectorAll('.tbl thead th[data-sort]').forEach((th) =>
    th.addEventListener('click', () => {
      const key = th.getAttribute('data-sort');
      if (state.sort.key === key) state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
      else state.sort = { key, dir: key === 'name' ? 'asc' : 'desc' };
      renderTable();
    })
  );

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

// footer "How it's sourced" — general sourcing facts only. Per-model caveats (which benchmark
// run a given score comes from, unverified releases, etc.) belong on the full table, not here.
const SOURCING_FACTS = [
  'Pricing is pulled from official vendor pages — standard tier, USD per 1M tokens.',
  'Benchmarks are cited with their source; treat them as directional, not ground truth.',
  'A blank ("—") means the figure wasn’t reliably sourced — never a guess.',
  'Independent project, not affiliated with or sponsored by any model vendor.',
];
function renderSourcingNotes() {
  const el = $('#footNotes');
  if (el) el.innerHTML = SOURCING_FACTS.map((f) => `<li>${f}</li>`).join('');
}

// a broken fetch must fail like a product, not a stack trace: plain words, a retry,
// and no live controls pretending there's data behind them (cold review #15)
function renderLoadError() {
  setText('#navAsof', '● data unavailable');
  const msg = `<div class="loaderr" role="alert">
      <p>Couldn't load the model data — the connection may have dropped.</p>
      <button class="tbl-toggle" id="retryLoad" type="button">Try again</button>
    </div>`;
  const tb = $('#tblBody');
  if (tb) tb.innerHTML = `<tr><td colspan="5">${msg}</td></tr>`;
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
  const asof = state.data.as_of || '—';
  const nav = $('#navAsof');
  if (nav) nav.innerHTML = '● snapshot ' + asof + '<span class="nav__asof-extra"> · pricing verified</span>';
  setText('#footAsof', asof);
  setText('#allCount', `all ${state.data.models.length} models`);   // never hand-count the roster again
  renderSourcingNotes();

  wire();
  initReveal();
  renderFilters();
  if ($('#cmpBoard')) seedCompare();  // newest GA model from three labs until the user chooses
  if ($('#chart')) renderChart();
  renderEffort();            // published effort ladders; guarded no-op on table.html
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
