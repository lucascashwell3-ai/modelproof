// Models page: compare, the effort ladder (SVG, log x), and what changed. Same dark system as the board.
import { getFacts, readState, wireNav, fillStamps, initShell, $, $$, esc, ico, fmtDate, fmtPrice, fmtContext, host, clamp, reducedMotion } from './site-core.js';
import { timelineHtml } from './timeline.mjs';

initShell();
let facts;
try { facts = await getFacts(); }
catch (err) {
  for (const id of ['cmp-root', 'lad-root']) $('#' + id).innerHTML = `<p class="muted">The model data did not load (${esc(err.message)}). Reload the page to try again.</p>`;
  throw err;
}
wireNav(readState(facts));
const M = facts.models;
const byId = new Map(M.models.map((m) => [m.id, m]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EASE_OUT = 'cubic-bezier(0.25, 1, 0.5, 1)';
function play(el, frames, opts = {}) { // finishes on a timer even if the animation clock is frozen
  const a = el.animate(frames, opts);
  setTimeout(() => { try { if (a.playState !== 'finished') a.finish(); } catch { /* gone */ } }, (opts.delay || 0) + (opts.duration || 0) + 40);
  return a;
}
function setParam(k, v) {
  const u = new URL(location.href);
  if (v === null || v === '') u.searchParams.delete(k); else u.searchParams.set(k, v);
  history.replaceState(null, '', u.pathname + (u.search || '') + u.hash);
}
const na = (t = 'Not published') => `<span class="na">${esc(t)}</span>`;

/* =============================== compare =============================== */
const DEAD = ['deprecated', 'retired', 'shutdown', 'removed'];
const live = M.models.filter((m) => !DEAD.includes(String(m.status || '').toLowerCase()));
const newest = (list) => list.slice().sort((a, b) => String(b.released).localeCompare(String(a.released)) || (b.price_output || 0) - (a.price_output || 0))[0];
// default: the newest model per lab that has a coding score, so no row of dashes. The three labs
// with the most scored models on file; every name comes from the data.
const scored = live.filter((m) => m.released && m.coding_score != null);
const labsByScored = [...new Set(scored.map((m) => m.vendor))].map((v) => [v, scored.filter((m) => m.vendor === v).length]).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
const scoredNewest = labsByScored.slice(0, 3).map(([v]) => newest(scored.filter((m) => m.vendor === v))).filter(Boolean).map((m) => m.id);
const q = new URLSearchParams(location.search).get('compare');
let cmp = (q ? q.split(',').filter((id) => byId.has(id)) : []).slice(0, 3);
// Open on the three most-used models on OpenRouter that outside testers have measured, one per lab: the same rule as
// the effort chart. Usage is a published fact; nothing is ranked.
const rankOf = (m) => (m.usage && m.usage.openrouter && m.usage.openrouter.rank) || 1e9;
const cbOf = (m) => (((m.standings || {}).coding || {}).measured || []).find((x) => /^CursorBench/.test(x.benchmark || ''));
const mostUsed = []; for (const m of live.filter(cbOf).sort((a, b) => rankOf(a) - rankOf(b))) { if (rankOf(m) < 1e9 && !mostUsed.some((x) => x.vendor === m.vendor)) mostUsed.push(m); if (mostUsed.length === 3) break; }
if (!cmp.length) cmp = mostUsed.length === 3 ? mostUsed.map((m) => m.id) : scoredNewest.slice();
while (cmp.length < 3) cmp.push('');

const vendors = [...new Set(M.models.map((m) => m.vendor))].sort((a, b) => a.localeCompare(b));
const optionsHtml = (cur) => `<option value=""${cur ? '' : ' selected'}>Pick a model</option>` + vendors.map((v) => `<optgroup label="${esc(v)}">${M.models.filter((m) => m.vendor === v).sort((a, b) => String(b.released || '').localeCompare(String(a.released || '')) || a.name.localeCompare(b.name)).map((m) => `<option value="${esc(m.id)}"${m.id === cur ? ' selected' : ''}>${esc(m.name)}</option>`).join('')}</optgroup>`).join('');

const ROWS = [
  ['Price in', (m) => (m.price_input != null ? `<span class="big">${esc(fmtPrice(m.price_input))}</span><small>per 1M</small>` : na())],
  ['Price out', (m) => (m.price_output != null ? `<span class="big">${esc(fmtPrice(m.price_output))}</span><small>per 1M</small>` : na())],
  ['Context', (m) => (m.context_window ? `<span class="big" title="${m.context_window.toLocaleString('en-US')} tokens">${esc(fmtContext(m.context_window))}</span>` : na())],
  ['Coding test', (m) => {
    const cb = (((m.standings || {}).coding || {}).measured || []).find((x) => /^CursorBench/.test(x.benchmark || ''));
    return cb ? `<span class="big">${(cb.score * 100).toFixed(1)}%</span><small>CursorBench, best effort</small>` : na();
  }],
  ['Released', (m) => (m.released ? `<span class="big" style="font-size:var(--fs-17)">${esc(fmtDate(m.released))}</span>` : na())],
  ['Source', (m) => {
    const pc = m.price_checked, first = pc ? pc.url : (m.sources || [])[0];
    const link = first ? `<a class="link" href="${esc(first)}" target="_blank" rel="noopener">${esc(host(first))} ${ico('arrow-up-right')}</a>` : na();
    const basis = m.coding_basis ? `<details class="details"><summary>Score basis ${ico('caret-down')}</summary><ul><li>${esc(m.coding_basis)}</li></ul></details>` : '';
    return `${link}<span class="sub">${esc(fmtDate(pc ? pc.date : M.as_of))}</span>${basis}`;
  }],
];
function renderCompare() {
  const recs = cmp.map((id) => byId.get(id) || null);
  const head = (m, i, p) => `<label class="sr-only" for="${p}-${i}">Model ${i + 1}</label><select class="select" id="${p}-${i}" data-col="${i}">${optionsHtml(cmp[i])}</select>`;
  const table = `<div class="cmp-scroll"><table class="cmp"><caption class="sr-only">Models side by side</caption>
    <thead><tr><th scope="col"><span class="sr-only">Measure</span></th>${recs.map((m, i) => `<th scope="col">${head(m, i, 'cmp-t')}</th>`).join('')}</tr></thead>
    <tbody>${ROWS.map(([k, f]) => `<tr><th scope="row">${esc(k)}</th>${recs.map((m) => `<td>${m ? f(m) : na('—')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  const cards = `<div class="mcards">${recs.map((m, i) => `<article class="mcard"><div class="mc-head">${head(m, i, 'cmp-c')}</div>${m ? `<dl>${ROWS.map(([k, f]) => `<div><dt>${esc(k)}</dt><dd>${f(m)}</dd></div>`).join('')}</dl>` : ''}</article>`).join('')}</div>`;
  $('#cmp-root').innerHTML = `<div class="cmp-wrap">${table}${cards}</div>`;
}
$('#cmp-root').addEventListener('change', (e) => {
  const s = e.target.closest('select[data-col]'); if (!s) return;
  cmp[+s.dataset.col] = s.value;
  setParam('compare', cmp.filter(Boolean).join(',') || null);
  const id = s.id; renderCompare(); const again = document.getElementById(id) || document.getElementById(id.replace(/-(t|c)-/, (m, g) => (g === 't' ? '-c-' : '-t-'))); if (again && again.offsetParent) again.focus({ preventScroll: true });
});
renderCompare();

/* =============================== effort ladder =============================== */
const LAD = M.effort_ladders;
const TONES = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)'];
const SHAPES = ['circle', 'square', 'diamond', 'triangle', 'ring'];
const L = { id: new URLSearchParams(location.search).get('ladder'), sel: 0, view: 'chart', hover: null, cursor: null, extra: [] };
if (!LAD.some((l) => l.id === L.id)) L.id = LAD[0].id;
// A ladder with default_count opens on that many models (most used first); the rest wait under "More models".
const ladder = () => {
  const lad = LAD.find((l) => l.id === L.id);
  if (!lad.default_count) return lad;
  const first = lad.series.slice(0, lad.default_count);
  const added = L.extra.map((id) => lad.series.find((x) => x.model_id === id)).filter((x) => x && !first.includes(x));
  const shown = [...first, ...added];
  return { ...lad, series: shown, hidden: lad.series.filter((x) => !shown.includes(x)) };
};
const money = (n) => `$${n.toFixed(2)}`;
const pct = (n) => `${Math.round(n)}%`;

function markerHtml(shape, x, y, tone) {
  const t = `translate(${x} ${y})`;
  const st = `style="fill:${tone}"`;
  switch (shape) {
    case 'square': return `<g class="s-mark" transform="${t}"><rect class="shape" x="-4" y="-4" width="8" height="8" rx="1.6" ${st}/></g>`;
    case 'diamond': return `<g class="s-mark" transform="${t}"><path class="shape" d="M0 -5.8 L5.8 0 L0 5.8 L-5.8 0Z" ${st}/></g>`;
    case 'triangle': return `<g class="s-mark" transform="${t}"><path class="shape" d="M0 -5.6 L5.4 4.2 L-5.4 4.2Z" ${st}/></g>`;
    case 'ring': return `<g class="s-mark" transform="${t}"><circle class="s-ring" r="4" style="fill:var(--r1);stroke:${tone};stroke-width:2"/></g>`;
    default: return `<g class="s-mark" transform="${t}"><circle class="shape" r="4.6" ${st}/></g>`;
  }
}
function legendKey(i) {
  const tone = TONES[i % 5];
  return `<svg viewBox="0 0 22 12" width="22" height="12" aria-hidden="true"><path d="M0 6H22" style="stroke:${tone};stroke-width:2;stroke-linecap:round"/>${markerHtml(SHAPES[i % 5], 11, 6, tone)}</svg>`;
}
function geometry(W, lad) {
  const narrow = W < 640;
  const m = { l: 46, r: narrow ? 16 : 128, t: 20, b: 52 };
  const H = Math.round(clamp(W * (narrow ? 0.9 : 0.46), 300, 440));
  const costs = lad.series.flatMap((s) => s.points.map((p) => p.cost)), scores = lad.series.flatMap((s) => s.points.map((p) => p.score));
  const xmin = Math.min(...costs) * 0.8, xmax = Math.max(...costs) * 1.12;
  const ymin = Math.max(0, Math.floor((Math.min(...scores) - 4) / 10) * 10), ymax = Math.ceil((Math.max(...scores) + 3) / 10) * 10;
  const lx = Math.log(xmin), lx2 = Math.log(xmax);
  const X = (c) => m.l + ((Math.log(c) - lx) / (lx2 - lx)) * (W - m.l - m.r);
  const Y = (s) => m.t + (1 - (s - ymin) / (ymax - ymin)) * (H - m.t - m.b);
  const xt = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100].filter((v) => v >= xmin && v <= xmax);
  const step = ymax - ymin > 60 ? 20 : 10;
  const yt = []; for (let v = ymin; v <= ymax; v += step) yt.push(v);
  return { W, H, m, X, Y, xt, yt, narrow, ymin, ymax };
}

function renderLadder({ animate = false } = {}) {
  const lad = ladder();
  const root = $('#lad-root');
  const chartEl = $('.chart', root);
  const W = chartEl ? Math.max(280, Math.round(chartEl.clientWidth)) : Math.max(280, Math.round(root.clientWidth - 36));
  if (!chartEl) {
    root.innerHTML = `<div class="lad">
      <div class="lad-top">
        <div class="seg" role="tablist" aria-label="Which benchmark">${LAD.map((l) => `<button type="button" role="tab" id="lt-${l.id}" aria-selected="${l.id === L.id}" data-lad="${esc(l.id)}">${esc(l.suite)}</button>`).join('')}</div>
        <div class="seg" aria-label="View"><button type="button" data-view="chart" aria-pressed="true">${ico('chart-line-up')}Chart</button><button type="button" data-view="table" aria-pressed="false">${ico('table')}Table</button></div>
      </div>
      <div class="lad-body">
        <div class="legend" id="legend" role="group" aria-label="Models in this chart. Choose one to highlight it."></div>
        <div class="chart" id="chart" tabindex="0" role="group" aria-label="Effort ladder chart. Arrow keys move between points."></div>
        <div id="table-view" hidden></div>
        <div class="readout" id="readout" aria-live="polite"></div>
      </div>
      <div class="lad-foot" id="lad-foot"></div>
    </div>`;
    bindLadder();
    return renderLadder({ animate: true });
  }
  for (const b of $$('[data-lad]', root)) b.setAttribute('aria-selected', String(b.dataset.lad === L.id));
  for (const b of $$('[data-view]', root)) b.setAttribute('aria-pressed', String(b.dataset.view === L.view));
  const hid = lad.hidden || [];
  $('#legend', root).innerHTML = lad.series.map((s, i) => `<button type="button" class="lg" data-s="${i}" aria-pressed="${i === L.sel}">${legendKey(i)}${esc(s.label)}</button>`).join('')
    + (hid.length ? `<label class="lg-more"><span class="sr-only">Add a model to the chart</span><select data-more><option value="">${hid.length} more models</option>${hid.map((s) => `<option value="${esc(s.model_id)}">${esc(s.label)}</option>`).join('')}</select></label>` : '');
  $('#chart', root).hidden = L.view !== 'chart';
  $('#table-view', root).hidden = L.view !== 'table';
  $('#legend', root).hidden = false;
  drawChart(W, lad, animate);
  drawTable(lad);
  drawReadout(lad);
  drawFoot(lad);
}

function drawChart(W, lad, animate) {
  const el = $('#chart');
  const g = geometry(W, lad);
  const { H, m, X, Y } = g;
  const surf = 'var(--r1)';
  let svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(`${lad.suite}, ${lad.task}. Score against ${lad.x_label.toLowerCase()} for ${lad.series.length} models at up to five effort settings. The table view lists every value.`)}">`;
  svg += `<rect class="plot-focus" x="${m.l - 6}" y="${m.t - 8}" width="${W - m.l - m.r + 12}" height="${H - m.t - m.b + 16}" rx="8"/>`;
  for (const v of g.yt) svg += `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${m.l - 10}" y="${Y(v) + 4}" text-anchor="end">${v}</text>`;
  for (const v of g.xt) svg += `<line class="grid v" x1="${X(v)}" x2="${X(v)}" y1="${m.t}" y2="${H - m.b}"/><text x="${X(v)}" y="${H - m.b + 20}" text-anchor="middle">$${v}</text>`;
  svg += `<line class="axis" x1="${m.l}" x2="${W - m.r}" y1="${H - m.b}" y2="${H - m.b}"/>`;
  svg += `<text x="${m.l}" y="${m.t - 6}" text-anchor="start" style="font-size:12px">${esc(lad.y_label)}</text>`;
  svg += `<text x="${(m.l + W - m.r) / 2}" y="${H - 8}" text-anchor="middle">${esc(lad.x_label)}</text>`;
  // lines first, then markers, so a dot never hides under a neighbour's line
  lad.series.forEach((s, i) => {
    const tone = TONES[i % 5];
    const d = s.points.map((p, j) => `${j ? 'L' : 'M'}${X(p.cost).toFixed(1)} ${Y(p.score).toFixed(1)}`).join('');
    svg += `<g class="s" data-s="${i}"><path class="s-line" d="${d}" style="stroke:${tone}"/></g>`;
  });
  lad.series.forEach((s, i) => {
    const tone = TONES[i % 5];
    svg += `<g class="s-m" data-s="${i}">${s.points.map((p) => markerHtml(SHAPES[i % 5], X(p.cost).toFixed(1), Y(p.score).toFixed(1), tone)).join('')}</g>`;
  });
  svg += `<g class="labels" data-labels></g></svg>`;
  el.innerHTML = svg + `<div class="tip" id="tip" role="presentation"></div>`;
  g.svg = el.querySelector('svg');
  chartGeo = g;
  paintSelection();
  if (animate && !reducedMotion()) {
    $$('.s-line', el).forEach((p, i) => { const len = p.getTotalLength(); p.style.strokeDasharray = `${len}`; const a = play(p, [{ strokeDashoffset: len }, { strokeDashoffset: 0 }], { duration: 800, delay: i * 90, easing: EASE_OUT, fill: 'backwards' }); a.finished.then(() => { p.style.strokeDasharray = ''; }).catch(() => {}); });
    $$('.s-m', el).forEach((n, i) => play(n, [{ opacity: 0 }, { opacity: 1 }], { duration: 420, delay: 360 + i * 90, easing: EASE_OUT, fill: 'backwards' }));
  }
}
let chartGeo = null;

/** which series is highlighted, which is hovered, and the direct labels */
function paintSelection() {
  const el = $('#chart'); if (!el || !chartGeo) return;
  const lad = ladder(); const g = chartGeo;
  const focusSeries = L.hover ? L.hover.s : null;
  $$('g.s, g.s-m', el).forEach((n) => {
    const i = +n.dataset.s;
    n.dataset.sel = String(i === L.sel);
    n.dataset.dim = String(focusSeries !== null ? i !== focusSeries && i !== L.sel : false);
    n.dataset.hover = String(i === focusSeries && i !== L.sel);
  });
  // selected line paints last so it sits on top
  const lines = $$('g.s', el); const top = lines.find((n) => +n.dataset.s === L.sel); if (top) top.parentNode.insertBefore(top, $('g.s-m', el));
  const gl = $('[data-labels]', el); gl.innerHTML = '';
  const placed = [];
  const order = [L.sel, ...lad.series.map((_, i) => i).filter((i) => i !== L.sel)];
  const put = (x, y, text, cls, anchor = 'start') => {
    const w = text.length * 6.5 + 6, h = 14;
    const bx = anchor === 'start' ? x : x - w;
    const box = { x: bx, y: y - 11, w, h };
    if (bx + w > g.W - 2 || bx < 2) return false;
    if (placed.some((p) => !(box.x > p.x + p.w + 3 || box.x + box.w < p.x - 3 || box.y > p.y + p.h + 2 || box.y + box.h < p.y - 2))) return false;
    placed.push(box);
    gl.insertAdjacentHTML('beforeend', `<text class="${cls}" x="${x}" y="${y}" text-anchor="${anchor}">${esc(text)}</text>`);
    return true;
  };
  for (const i of order) {
    const s = lad.series[i], last = s.points[s.points.length - 1];
    put(g.X(last.cost) + 11, g.Y(last.score) + 4, s.label, `end-label${i === L.sel ? ' sel' : ''}`);
  }
  // a ring around the highest point of the highlighted line
  { const s = lad.series[L.sel]; const pk = s.points.reduce((b, p, i) => (p.score > s.points[b].score ? i : b), 0); const p = s.points[pk];
    gl.insertAdjacentHTML('beforeend', `<circle class="peak" cx="${g.X(p.cost)}" cy="${g.Y(p.score)}" r="9.5"/>`); }
  // effort names on the highlighted line (wide screens only)
  if (!g.narrow) { const s = lad.series[L.sel]; s.points.forEach((p) => put(g.X(p.cost) + 9, g.Y(p.score) + 17, p.effort, 'step-label')); }
}

function drawReadout(lad) {
  const s = lad.series[L.sel]; const pts = s.points;
  const pk = pts.reduce((b, p, i) => (p.score > pts[b].score ? i : b), 0);
  $('#readout').innerHTML = `<span><b>${esc(s.label)}</b> tops out at <b>${pts[pk].score}%</b> on <b>${esc(pts[pk].effort)}</b>, ${money(pts[pk].cost)} per attempt.</span>`;
}
function drawTable(lad) {
  const rows = lad.series.flatMap((s) => s.points.map((p) => `<tr><td>${esc(s.label)}</td><td>${esc(p.effort)}</td><td class="n">${money(p.cost)}</td><td class="n">${p.score}%</td></tr>`)).join('');
  $('#table-view').innerHTML = `<table class="lad-table"><caption class="sr-only">${esc(lad.suite)}, ${esc(lad.task)}: every plotted value</caption><thead><tr><th scope="col">Model</th><th scope="col">Effort</th><th scope="col" class="n">${esc(lad.x_label.replace(/ \(.*/, ''))}</th><th scope="col" class="n">Score</th></tr></thead><tbody>${rows}</tbody></table>`;
}
function drawFoot(lad) {
  $('#lad-foot').innerHTML = `<div class="src"><span>${esc(lad.publisher)}</span><a class="link" href="${esc(lad.source)}" target="_blank" rel="noopener">Source ${ico('arrow-up-right')}</a></div>
    <details class="details"><summary>About this chart ${ico('caret-down')}</summary><ul><li>${esc(lad.caveat)}</li></ul></details>`;
}

function bindLadder() {
  const root = $('#lad-root');
  root.addEventListener('change', (e) => {
    const m = e.target.closest('[data-more]'); if (!m || !m.value) return;
    L.extra.push(m.value); L.sel = ladder().series.findIndex((x) => x.model_id === m.value); L.hover = null;
    renderLadder({ animate: true });
  });
  root.addEventListener('click', (e) => {
    const t = e.target.closest('[data-lad]');
    if (t) { L.id = t.dataset.lad; L.sel = 0; L.hover = null; L.extra = []; setParam('ladder', L.id === LAD[0].id ? null : L.id); renderLadder({ animate: true }); fillStamps(facts, { ladder: ladder() }); return; }
    const v = e.target.closest('[data-view]'); if (v) { L.view = v.dataset.view; renderLadder(); return; }
    const lg = e.target.closest('.lg'); if (lg) { L.sel = +lg.dataset.s; L.hover = null; paintSelection(); drawReadout(ladder()); for (const b of $$('.lg', root)) b.setAttribute('aria-pressed', String(+b.dataset.s === L.sel)); }
  });
  root.addEventListener('pointerover', (e) => {
    const lg = e.target.closest('.lg'); if (lg && e.pointerType !== 'touch') { L.hover = { s: +lg.dataset.s }; paintSelection(); }
  });
  root.addEventListener('pointerout', (e) => { if (e.target.closest('.lg') && !e.relatedTarget?.closest?.('.lg')) { L.hover = null; paintSelection(); } });
  const chart = $('#chart', root);
  const near = (e) => {
    const r = chartGeo.svg.getBoundingClientRect(); const k = chartGeo.W / r.width;
    const px = (e.clientX - r.left) * k, py = (e.clientY - r.top) * k; let best = null;
    ladder().series.forEach((s, si) => s.points.forEach((p, pi) => { const d = Math.hypot(chartGeo.X(p.cost) - px, chartGeo.Y(p.score) - py); if (d < 30 && (!best || d < best.d)) best = { s: si, i: pi, d }; }));
    return best;
  };
  chart.addEventListener('pointermove', (e) => { const b = near(e); if (!b) { if (L.hover) { L.hover = null; hideTip(); paintSelection(); } return; } if (!L.hover || L.hover.s !== b.s || L.hover.i !== b.i) { L.hover = b; paintSelection(); showTip(b); } });
  chart.addEventListener('pointerleave', () => { L.hover = null; hideTip(); paintSelection(); });
  chart.addEventListener('click', (e) => { const b = near(e); if (b) { L.sel = b.s; paintSelection(); drawReadout(ladder()); for (const x of $$('.lg', root)) x.setAttribute('aria-pressed', String(+x.dataset.s === L.sel)); } });
  chart.addEventListener('focus', () => { L.cursor = L.cursor || { s: L.sel, i: 0 }; L.hover = L.cursor; paintSelection(); showTip(L.cursor); });
  chart.addEventListener('blur', () => { L.hover = null; hideTip(); paintSelection(); });
  chart.addEventListener('keydown', (e) => {
    const lad = ladder(); let c = L.cursor || { s: L.sel, i: 0 };
    const n = lad.series[c.s].points.length;
    if (e.key === 'ArrowRight') c = { s: c.s, i: Math.min(n - 1, c.i + 1) };
    else if (e.key === 'ArrowLeft') c = { s: c.s, i: Math.max(0, c.i - 1) };
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { const ns = clamp(c.s + (e.key === 'ArrowDown' ? 1 : -1), 0, lad.series.length - 1); c = { s: ns, i: Math.min(c.i, lad.series[ns].points.length - 1) }; }
    else if (e.key === 'Enter' || e.key === ' ') { L.sel = c.s; paintSelection(); drawReadout(lad); for (const x of $$('.lg', root)) x.setAttribute('aria-pressed', String(+x.dataset.s === L.sel)); e.preventDefault(); return; }
    else return;
    e.preventDefault(); L.cursor = c; L.hover = c; paintSelection(); showTip(c);
  });
  new ResizeObserver(() => { clearTimeout(bindLadder.t); bindLadder.t = setTimeout(() => { const w = Math.round($('#chart').clientWidth); if (chartGeo && Math.abs(w - chartGeo.W) > 2 && L.view === 'chart') drawChart(w, ladder(), false); }, 90); }).observe(chart);
}
function showTip(b) {
  const lad = ladder(); const s = lad.series[b.s], p = s.points[b.i], prev = s.points[b.i - 1];
  const tip = $('#tip'); const g = chartGeo;
  const delta = prev ? `From ${esc(prev.effort)}: ${p.score - prev.score >= 0 ? '+' : '−'}${Math.abs(p.score - prev.score).toFixed(1)} points for ${p.cost >= prev.cost ? '+' : '−'}${Math.abs(Math.round((p.cost / prev.cost - 1) * 100))}% cost` : 'The lowest effort setting in this run';
  tip.innerHTML = `<div class="t-n">${legendKey(b.s)}<span>${esc(s.label)}</span></div><div class="t-v">${p.score}%</div><div class="t-r"><span>Effort</span><span>${esc(p.effort)}</span></div><div class="t-r"><span>Cost per attempt</span><span>${money(p.cost)}</span></div><div class="t-d">${delta}</div>`;
  const x = g.X(p.cost), y = g.Y(p.score);
  const w = tip.offsetWidth || 220, h = tip.offsetHeight || 120;
  let left = x + 16; if (left + w > g.W - 4) left = x - w - 16; left = Math.max(4, left);
  tip.style.left = `${left}px`; tip.style.top = `${clamp(y - h / 2, 2, g.H - h - 2)}px`; tip.dataset.show = 'true';
}
function hideTip() { const t = $('#tip'); if (t) t.dataset.show = 'false'; }

renderLadder();

/* =============================== release timeline: a horizontal track, one lane per lab =============================== */
let tlSel = null;
const renderTimeline = () => { $('#tl-root').innerHTML = timelineHtml(M, tlSel); };
$('#tl-root').addEventListener('click', (e) => { const d = e.target.closest('.dot'); if (!d) return; tlSel = +d.dataset.i; renderTimeline(); const again = $(`.dot[data-i="${tlSel}"]`); if (again) again.focus({ preventScroll: true }); });
renderTimeline();
fillStamps(facts, { ladder: ladder() });
