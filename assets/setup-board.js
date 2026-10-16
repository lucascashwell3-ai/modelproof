// The board: the setup drawn as a node graph. Three visible taps sit above it; click a box to change its model.
// Everything on it is computed by setupFromTaps(), so the picture and the files are what the installer would write.
import {
  TOOLS, WORK, ROLE_INFO, ROLE_ORDER, setupFromTaps, modelsForTool, DEFAULT_PLAN,
  $, $$, clamp, esc, ico, fmtDate, host, reducedMotion, writeState,
} from './site-core.js';

const NS = 'http://www.w3.org/2000/svg';
const ICON = { lead: 'compass', scout: 'magnifying-glass', builder: 'hammer', reviewer: 'eye', checker: 'seal-check', bulk: 'stack' };
const SHORT = { lead: 'Plans the work', scout: 'Reads and searches', builder: 'Makes the change', reviewer: 'Reviews it', checker: 'Checks the result', bulk: 'Routine edits' };
const WORK_LABEL = { short: 'Quick tasks', long: 'One long job', parallel: 'Several jobs' };
const HELPERS = ['scout', 'builder', 'reviewer', 'checker'];
const WIDE_MIN = 820; // board width below which the board stacks into one column
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const svgEl = (tag, attrs = {}) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
const EASE_OUT = 'cubic-bezier(0.25, 1, 0.5, 1)';
/** el.animate() plus a timer that finishes it. Hidden tabs and headless renderers freeze the animation clock;
 *  the end state must still arrive, so nothing here may depend on an animation actually running. */
function play(el, frames, opts = {}) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) frames = frames.map(({ transform, strokeDashoffset, ...keep }) => keep);
  const a = el.animate(frames, opts);
  setTimeout(() => { try { if (a.playState !== 'finished') a.finish(); } catch { /* element gone */ } }, (opts.delay || 0) + (opts.duration || 0) + 40);
  return a;
}

/* ---------- path helpers (all in stage pixels) ---------- */
const vC = (x1, y1, x2, y2) => { const dy = Math.max(26, (y2 - y1) * 0.55); return `M${x1} ${y1} C${x1} ${y1 + dy} ${x2} ${y2 - dy} ${x2} ${y2}`; };
const hC = (x1, y1, x2, y2) => { const dx = Math.max(26, (x2 - x1) * 0.55); return `M${x1} ${y1} C${x1 + dx} ${y1} ${x2 - dx} ${y2} ${x2} ${y2}`; };
const side = (p, s, dx = 0) => ({ t: { x: p.x + p.w / 2 + dx, y: p.y }, b: { x: p.x + p.w / 2 + dx, y: p.y + p.h }, l: { x: p.x, y: p.y + p.h / 2 }, r: { x: p.x + p.w, y: p.y + p.h / 2 } }[s]);

function chainDims(W) {
  const wA = Math.min(W, 560 + 36), ox = Math.max(0, Math.round((W - wA) / 2));
  const pad = ox + 14, indent = 34, rail = 28;
  return { wA, ox, pad, indent, rail, lw: wA - 28 - rail, hw: wA - 28 - indent - rail };
}
function sizesFor(W) {
  const s = clamp((W - 820) / 420, 0, 1);
  return { nw: Math.round(184 + 52 * s), lw: Math.round(296 + 72 * s), gw: Math.round(20 + 22 * s), glb: Math.round(34 + 16 * s) };
}

/** Where every box goes, and which lines join them. kind: 'loop' (big-job), 'compact' (quick tasks), 'chain' (narrow). */
function computeLayout(kind, W, hs, sz, needH, big = false) {
  const pos = {}; const edges = []; const labels = []; const ports = [];
  const P = (p) => ports.push(p);
  if (kind === 'chain') {
    // One column. In big-job mode the bulk helper joins the workers and the checker closes the chain:
    // pieces flow into the checker on an inner rail, its result returns to the lead on the outer rail.
    const D = chainDims(W);
    const order = big ? ['scout', 'builder', 'reviewer', 'bulk', 'checker'] : ['scout', 'builder', 'reviewer', 'checker', 'bulk'];
    let y = 16;
    pos.lead = { x: D.pad, y, w: D.lw, h: hs.lead }; y += hs.lead + 22;
    for (const k of order) {
      if ((big && k === 'checker') || (!big && k === 'bulk')) y += 20;
      pos[k] = { x: D.pad + D.indent, y, w: D.hw, h: hs[k] }; y += hs[k] + 14;
    }
    y += 12;
    const sx = D.pad + 14, sy = pos.lead.y + pos.lead.h;
    for (const k of (big ? ['scout', 'builder', 'reviewer', 'bulk'] : order)) {
      const l = side(pos[k], 'l'), r = 14;
      edges.push({ id: `lead>${k}`, from: 'lead', to: k, cls: 'out', order: 0, d: `M${sx} ${sy} V${l.y - r} Q${sx} ${l.y} ${sx + r} ${l.y} H${l.x}` });
      P(l);
    }
    P({ x: sx, y: sy });
    if (big) {
      const rx = D.ox + D.wA - 9, ix = rx - 15, c = 9;
      const ckIn = { x: pos.checker.x + pos.checker.w, y: pos.checker.y + Math.round(pos.checker.h * 0.34) };
      const ckOut = { x: pos.checker.x + pos.checker.w, y: pos.checker.y + Math.round(pos.checker.h * 0.7) };
      const ld = side(pos.lead, 'r');
      for (const k of ['scout', 'builder', 'reviewer', 'bulk']) {
        const p = side(pos[k], 'r');
        edges.push({ id: `${k}>checker`, from: k, to: 'checker', cls: 'in', order: 1, d: `M${p.x} ${p.y} H${ix - c} Q${ix} ${p.y} ${ix} ${p.y + c} V${ckIn.y - c} Q${ix} ${ckIn.y} ${ix - c} ${ckIn.y} H${ckIn.x}` });
        P(p);
      }
      edges.push({ id: 'checker>lead', from: 'checker', to: 'lead', cls: 'back', order: 2, d: `M${ckOut.x} ${ckOut.y} H${rx - 12} Q${rx} ${ckOut.y} ${rx} ${ckOut.y - 12} V${ld.y + 12} Q${rx} ${ld.y} ${rx - 12} ${ld.y} H${ld.x}` });
      P(ckIn); P(ckOut); P(ld);
    }
    return { kind, pos, edges, labels, ports, height: y, chainH: y };
  }
  const { nw, lw, gw, glb } = sz;
  const topPad = 26;
  const hl = hs.lead;
  const rowBH = Math.max(hs.scout, hs.builder, hs.reviewer);
  const total3 = 3 * nw + 2 * gw;
  // loop geometry (always computed: it sets the board height for both modes)
  const leftNeed = total3 / 2 + 56, rightNeed = Math.max(total3 / 2 + 56, lw / 2 + glb + nw + 66);
  const cxL = clamp(W / 2, leftNeed, Math.max(leftNeed, W - rightNeed));
  const rowBY = topPad + hl + 52;
  const rowCY = rowBY + rowBH + 40;
  const loopH = rowCY + hs.checker + 20;
  if (kind === 'loop') {
    const cx = cxL, leadX = cx - lw / 2, x0 = cx - total3 / 2;
    pos.lead = { x: leadX, y: topPad, w: lw, h: hl };
    pos.scout = { x: x0, y: rowBY, w: nw, h: hs.scout };
    pos.builder = { x: x0 + nw + gw, y: rowBY, w: nw, h: hs.builder };
    pos.reviewer = { x: x0 + 2 * (nw + gw), y: rowBY, w: nw, h: hs.reviewer };
    pos.checker = { x: cx - nw / 2, y: rowCY, w: nw, h: hs.checker };
    pos.bulk = { x: leadX + lw + glb, y: topPad + (hl - hs.bulk) / 2, w: nw, h: hs.bulk };
    const lb = side(pos.lead, 'b');
    for (const k of ['scout', 'builder', 'reviewer']) { const t = side(pos[k], 't'); edges.push({ id: `lead>${k}`, from: 'lead', to: k, cls: 'out', order: 0, d: vC(lb.x, lb.y, t.x, t.y) }); P(t); }
    const lr = side(pos.lead, 'r'), bl = side(pos.bulk, 'l');
    edges.push({ id: 'lead>bulk', from: 'lead', to: 'bulk', cls: 'out', order: 0, d: hC(lr.x, lr.y, bl.x, bl.y) }); P(lr); P(bl); P(lb);
    const off = { scout: -42, builder: 0, reviewer: 42 };
    for (const k of ['scout', 'builder', 'reviewer']) { const b = side(pos[k], 'b'), t = side(pos.checker, 't', off[k]); edges.push({ id: `${k}>checker`, from: k, to: 'checker', cls: 'in', order: 1, d: vC(b.x, b.y, t.x, t.y) }); P(b); P(t); }
    const br = side(pos.bulk, 'r'), cr = side(pos.checker, 'r'), bulge = 70;
    edges.push({ id: 'bulk>checker', from: 'bulk', to: 'checker', cls: 'in', order: 1, d: `M${br.x} ${br.y} C${br.x + bulge} ${br.y} ${br.x + bulge} ${cr.y} ${cr.x} ${cr.y}` }); P(br); P(cr);
    const cl = side(pos.checker, 'l'), ll = side(pos.lead, 'l'), rx = x0 - 42, r = 24;
    edges.push({ id: 'checker>lead', from: 'checker', to: 'lead', cls: 'back', order: 2, d: `M${cl.x} ${cl.y} H${rx + r} Q${rx} ${cl.y} ${rx} ${cl.y - r} V${ll.y + r} Q${rx} ${ll.y} ${rx + r} ${ll.y} H${ll.x}` }); P(cl); P(ll);
    return { kind, pos, edges, labels, ports, height: loopH };
  }
  // compact: one row of helpers, bulk beside the lead
  const gap = 16, total4 = 4 * nw + 3 * gap;
  const cx = clamp(W / 2, total4 / 2 + 12, Math.max(total4 / 2 + 12, W - total4 / 2 - 12));
  const cxb = clamp(cx, lw / 2 + 12, Math.max(lw / 2 + 12, W - (lw / 2 + glb + nw + 12)));
  const rowH = Math.max(hs.scout, hs.builder, hs.reviewer, hs.checker);
  const gapAB = 64;
  const totalH = hl + gapAB + rowH;
  const y0 = Math.max(topPad, Math.round((needH - totalH) / 2 + 28));
  const leadX = cxb - lw / 2;
  pos.lead = { x: leadX, y: y0, w: lw, h: hl };
  const x0 = cx - total4 / 2;
  HELPERS.forEach((k, i) => { pos[k] = { x: x0 + i * (nw + gap), y: y0 + hl + gapAB, w: nw, h: hs[k] }; });
  pos.bulk = { x: leadX + lw + glb, y: y0 + (hl - hs.bulk) / 2, w: nw, h: hs.bulk };
  const lb = side(pos.lead, 'b');
  for (const k of HELPERS) { const t = side(pos[k], 't'); edges.push({ id: `lead>${k}`, from: 'lead', to: k, cls: 'out', order: 0, d: vC(lb.x, lb.y, t.x, t.y) }); P(t); }
  const lr = side(pos.lead, 'r'), bl = side(pos.bulk, 'l');
  edges.push({ id: 'lead>bulk', from: 'lead', to: 'bulk', cls: 'out', order: 0, d: hC(lr.x, lr.y, bl.x, bl.y) }); P(lr); P(bl); P(lb);
  return { kind, pos, edges, labels, ports, height: loopH };
}

/* ======================================================================================================== */

export function createBoard(root, { facts, state }) {
  const S = { ...state, big: null, example: null, sel: null };
  const listeners = [];
  let setup = null, rejected = [], layout = null, runId = 0, lastSig = '', layoutBig = false;
  const nodes = {};
  const id = root.id || 'board';

  /* ---------- DOM ---------- */
  const tapsEl = document.createElement('section');
  tapsEl.className = 'taps wrap';
  tapsEl.setAttribute('aria-label', 'Your three taps');
  tapsEl.innerHTML = [['tool', 'Your tool'], ['plan', 'Your plan'], ['work', 'How you work']].map(([k, label], i) => `
    <div class="tap" data-tap="${k}">
      <div class="tap-h" id="tap-${k}"><span class="tap-n" aria-hidden="true">${i + 1}</span>${label}</div>
      <div class="tap-opts" role="group" aria-labelledby="tap-${k}"></div>
    </div>`).join('');
  root.before(tapsEl);

  root.classList.add('board');
  root.innerHTML = `
    <div class="field" aria-hidden="true"></div>
    <div class="stage">
      <svg class="edges" aria-hidden="true" focusable="false"><g class="g-edges"></g><g class="g-pulse"></g></svg>
      <div class="nodes" role="group" aria-label="Your setup. Click a box to change its model."></div>
      <svg class="ports" aria-hidden="true" focusable="false"><g class="g-ports"></g></svg>
    </div>
    <p class="sr-only" role="status" aria-live="polite" data-status></p>`;
  const stage = $('.stage', root), nodesEl = $('.nodes', root), gEdges = $('.g-edges', root), gPorts = $('.g-ports', root), gPulse = $('.g-pulse', root);
  const statusEl = $('[data-status]', root);

  const pick = document.createElement('div');
  pick.className = 'pick'; pick.hidden = true; pick.setAttribute('role', 'dialog');
  document.body.appendChild(pick);
  const scrim = document.createElement('div'); scrim.className = 'pick-scrim'; scrim.hidden = true; document.body.appendChild(scrim);

  for (const k of ROLE_ORDER) {
    const el = document.createElement('button');
    el.type = 'button'; el.className = 'node'; el.dataset.role = k;
    el.setAttribute('aria-haspopup', 'dialog'); el.setAttribute('aria-expanded', 'false');
    el.innerHTML = `<span class="node-card"></span>`;
    nodesEl.appendChild(el);
    nodes[k] = { el, card: $('.node-card', el), sig: '' };
    el.addEventListener('click', () => (S.sel === k && !pick.hidden ? closePick(true) : openPick(k)));
  }

  /* ---------- state -> setup ---------- */
  function compute() {
    setup = setupFromTaps({ tool: S.tool, plan: S.plan, work: S.work }, facts, { roles: S.roles });
    rejected = Object.keys(S.roles).filter((k) => { const r = setup.roles.find((x) => x.key === k); return !r || r.model_id !== S.roles[k]; });
  }
  const roleOf = (k) => setup.roles.find((r) => r.key === k);
  const modelRec = (mid) => facts.models.models.find((m) => m.id === mid);

  function viewOf(r) {
    const lead = roleOf('lead');
    const named = !!r.model_name;
    const model = named ? r.model_name : r.key === 'lead' ? 'Your choice' : lead.model_name || 'Your choice';
    return { model, shared: !named && r.key !== 'lead', mine: r.from === 'you' };
  }
  function paintNodes() {
    const changed = [];
    for (const r of setup.roles) {
      const n = nodes[r.key]; if (!n) continue;
      const v = viewOf(r);
      const sig = [v.model, v.shared, v.mine].join('|');
      if (sig === n.sig) continue;
      n.sig = sig;
      n.card.innerHTML = `
        <span class="node-head">${ico(ICON[r.key])}<span class="node-name">${esc(ROLE_INFO[r.key].name)}</span><span class="node-job">${esc(SHORT[r.key])}</span></span>
        <span class="node-model${v.shared ? ' shared' : ''}"><span>${esc(v.model)}</span>${ico('caret-down', 'node-c')}</span>`;
      n.el.setAttribute('aria-label', `${ROLE_INFO[r.key].name}, ${SHORT[r.key].toLowerCase()}. Model: ${v.model}. Choose a model.`);
      changed.push(r.key);
    }
    return changed;
  }

  /* ---------- layout + animation ---------- */
  function widthsFor(chain, W) {
    if (chain) { const D = chainDims(W); return { lw: D.lw, nw: D.hw }; }
    const s = sizesFor(W); return { lw: s.lw, nw: s.nw };
  }
  function measure(chain, W) {
    const w = widthsFor(chain, W);
    for (const k of ROLE_ORDER) nodes[k].el.style.width = `${k === 'lead' ? w.lw : w.nw}px`;
    const hs = {}; for (const k of ROLE_ORDER) hs[k] = nodes[k].el.offsetHeight;
    return hs;
  }
  function currentLayout() {
    const chain = root.clientWidth < WIDE_MIN;
    root.dataset.layout = chain ? 'chain' : 'wide';
    const W = stage.clientWidth;
    const hs = measure(chain, W);
    const k = chain ? 'chain' : setup.big_job ? 'loop' : 'compact';
    const sz = sizesFor(W);
    const loopOnly = chain ? null : computeLayout('loop', W, hs, sz, 0, true);
    const L = computeLayout(k, W, hs, sz, loopOnly ? loopOnly.height : 0, setup.big_job);
    if (chain) { root.style.height = ''; stage.style.setProperty('--chain-h', `${L.chainH + 8}px`); }
    else { root.style.height = `${Math.max(400, loopOnly.height + 4)}px`; stage.style.removeProperty('--chain-h'); }
    return L;
  }
  function applyPositions(L, glide) {
    const lead = L.pos.lead;
    ROLE_ORDER.forEach((k) => {
      const n = nodes[k], p = L.pos[k];
      const dist = Math.hypot(p.x - lead.x, p.y - lead.y);
      n.el.style.setProperty('--glide', glide ? '600ms' : '0ms');
      n.el.style.setProperty('--glide-delay', glide ? `${k === 'lead' ? 0 : Math.round(clamp(dist / 12, 0, 110))}ms` : '0ms');
      n.el.style.transform = `translate3d(${Math.round(p.x)}px, ${Math.round(p.y)}px, 0)`;
    });
  }
  function drawEdges(L, animate) {
    gEdges.replaceChildren(); gPorts.replaceChildren();
    const quiet = !setup.big_job;
    const made = [];
    L.edges.forEach((e, i) => {
      const p = svgEl('path', { d: e.d, class: `edge ${e.cls}${quiet ? ' quiet' : ''}` });
      p.dataset.from = e.from; p.dataset.to = e.to;
      gEdges.appendChild(p); e.el = p; made.push([p, e, i]);
    });
    const seen = new Set();
    for (const pt of L.ports) {
      const key = `${Math.round(pt.x)}:${Math.round(pt.y)}`; if (seen.has(key)) continue; seen.add(key);
      gPorts.appendChild(svgEl('circle', { cx: pt.x, cy: pt.y, r: 3.5, class: 'port' }));
    }
    markSelection();
    if (!animate) return Promise.resolve();
    const anims = [];
    for (const [p, e, i] of made) {
      if (reducedMotion()) { anims.push(play(p, [{ opacity: 0 }, { opacity: 1 }], { duration: 180, fill: 'backwards' }).finished); continue; }
      const len = p.getTotalLength();
      p.style.strokeDasharray = `${len}`;
      const a = play(p, [{ strokeDashoffset: len }, { strokeDashoffset: 0 }], { duration: 520, delay: e.order * 210 + i * 24, easing: EASE_OUT, fill: 'backwards' });
      a.finished.then(() => { p.style.strokeDasharray = ''; }).catch(() => {});
      anims.push(a.finished);
    }
    for (const el of gPorts.children) play(el, [{ opacity: 0 }, { opacity: 1 }], { duration: 240, delay: reducedMotion() ? 0 : 260, fill: 'backwards' });
    return Promise.allSettled(anims);
  }
  function markSelection() {
    for (const p of $$('.edge', gEdges)) p.classList.toggle('sel', !pick.hidden && !!S.sel && (p.dataset.from === S.sel || p.dataset.to === S.sel));
  }
  function ping(k) {
    const el = nodes[k] && nodes[k].el; if (!el) return;
    el.classList.add('ping'); setTimeout(() => el.classList.remove('ping'), 460);
  }
  function travel(e, ms, rid) {
    return new Promise((res) => {
      const path = e.el; const len = path.getTotalLength();
      const g = svgEl('g'); const ring = svgEl('circle', { class: 'pulse-ring', r: 10 });
      const trail = [0, 1, 2].map((i) => svgEl('circle', { class: 'pulse-dot', r: 3.4 - i * 0.9, opacity: 0.55 - i * 0.17 }));
      const dot = svgEl('circle', { class: 'pulse-dot', r: 4.6 });
      g.append(ring, ...trail, dot); gPulse.appendChild(g);
      const t0 = performance.now();
      setTimeout(() => { g.remove(); res(); }, ms + 120);
      const at = (u) => path.getPointAtLength(easeInOut(clamp(u, 0, 1)) * len);
      const step = (now) => {
        if (rid !== runId) { g.remove(); return res(); }
        const u = (now - t0) / ms;
        const p = at(u); dot.setAttribute('cx', p.x); dot.setAttribute('cy', p.y); ring.setAttribute('cx', p.x); ring.setAttribute('cy', p.y);
        trail.forEach((c, i) => { const q = at(u - 0.05 * (i + 1)); c.setAttribute('cx', q.x); c.setAttribute('cy', q.y); });
        if (u >= 1) { g.remove(); return res(); }
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  }
  async function runPulse(rid) {
    if (!layout || layout.kind === 'compact' || !setup.big_job || reducedMotion()) return;
    const edges = layout.edges.filter((e) => e.el && e.el.isConnected);
    const legs = [edges.filter((e) => e.cls === 'out'), edges.filter((e) => e.cls === 'in'), edges.filter((e) => e.cls === 'back')];
    for (const leg of legs) {
      if (rid !== runId) return;
      await Promise.all(leg.map((e) => travel(e, 540, rid)));
      if (rid !== runId) return;
      for (const to of new Set(leg.map((e) => e.to))) ping(to);
      await sleep(80);
    }
  }
  async function choreograph({ glide, draw, pulse }) {
    const rid = ++runId;
    layout = currentLayout(); layoutBig = setup.big_job;
    root.dataset.kind = layout.kind;
    gPulse.replaceChildren();
    if (glide && !reducedMotion()) {
      for (const p of $$('.edge', gEdges)) p.style.opacity = '0';
      for (const el of gPorts.children) el.style.opacity = '0';
      applyPositions(layout, true);
      await sleep(360);
    } else applyPositions(layout, false);
    if (rid !== runId) return;
    await drawEdges(layout, draw);
    if (rid !== runId) return;
    if (pulse) { await sleep(draw && !reducedMotion() ? 160 : 0); if (rid === runId) await runPulse(rid); }
  }

  /* ---------- the three taps: always visible ---------- */
  const tapChoices = {
    tool: () => TOOLS.map((t) => [t.id, t.label, t.id === S.tool]),
    plan: () => TOOLS.find((t) => t.id === S.tool).plans.map((p) => [p, p.replace(/\s*\(.*\)/, ''), p === S.plan]),
    work: () => WORK.map((w) => [w.id, WORK_LABEL[w.id] || w.label, w.id === S.work]),
  };
  function paintTaps() {
    for (const k of ['tool', 'plan', 'work']) {
      $(`.tap[data-tap="${k}"] .tap-opts`, tapsEl).innerHTML = tapChoices[k]().map(([v, label, on]) => `<button type="button" class="opt" data-v="${esc(v)}" aria-pressed="${on}">${esc(label)}</button>`).join('');
    }
  }
  tapsEl.addEventListener('click', (e) => {
    const b = e.target.closest('.opt'); if (!b) return;
    const k = b.closest('.tap').dataset.tap, v = b.dataset.v;
    closePick();
    if (k === 'tool') { if (v === S.tool) return; S.tool = v; S.plan = DEFAULT_PLAN[v] || TOOLS.find((t) => t.id === v).plans[0]; S.roles = {}; }
    else if (k === 'plan') { if (v === S.plan) return; S.plan = v; }
    else { if (v === S.work) return; S.work = v; }
    update({ glide: true });
    const again = $(`.tap[data-tap="${k}"] .opt[data-v="${CSS.escape(v)}"]`, tapsEl); if (again) again.focus({ preventScroll: true });
  });
  tapsEl.addEventListener('keydown', (e) => {
    if (!['ArrowRight', 'ArrowLeft'].includes(e.key)) return;
    const list = $$('.opt', e.target.closest('.tap-opts') || tapsEl); const i = list.indexOf(document.activeElement); if (i < 0) return;
    e.preventDefault(); list[(i + (e.key === 'ArrowRight' ? 1 : -1) + list.length) % list.length].focus();
  });

  /* ---------- the picker: click a box, choose its model ---------- */
  let showAll = false, srcOpen = false, pickNote = '';
  const listFor = () => modelsForTool(facts, S.tool).slice().sort((a, b) => String(b.released || '').localeCompare(String(a.released || '')) || a.name.localeCompare(b.name));
  function defaultNameFor(k) {
    const roles = { ...S.roles }; delete roles[k];
    const s = setupFromTaps({ tool: S.tool, plan: S.plan, work: S.work }, facts, { roles });
    const r = s.roles.find((x) => x.key === k);
    if (r.model_name) return r.model_name;
    if (k === 'lead') return `set in ${setup.toolLabel}`;
    const lead = s.roles.find((x) => x.key === 'lead');
    return lead.model_name || "the lead's model";
  }
  function renderPick() {
    const k = S.sel; if (!k) return;
    const r = roleOf(k), cur = S.roles[k] || '';
    const all = listFor();
    const LIMIT = 6;
    let list = all;
    if (!showAll && all.length > LIMIT + 1) { list = all.slice(0, LIMIT); const c = all.find((m) => m.id === cur); if (c && !list.includes(c)) list = [...list, c]; }
    const multi = new Set(all.map((m) => m.vendor)).size > 1;
    const opt = (mid, name, sub) => `<button type="button" class="pk-opt" role="option" data-id="${esc(mid)}" aria-selected="${cur === mid}"><span class="pk-t">${esc(name)}${sub ? `<small>${esc(sub)}</small>` : ''}</span>${ico('check-fat')}</button>`;
    pick.setAttribute('aria-label', `Choose a model for the ${ROLE_INFO[k].name.toLowerCase()}`);
    pick.innerHTML = `
      <div class="pk-h"><span class="pk-title">${ico(ICON[k])}<b>${esc(ROLE_INFO[k].name)}</b><span>${esc(SHORT[k])}</span></span><button type="button" class="ibtn pk-x" aria-label="Close">${ico('x')}</button></div>
      <div class="pk-list" role="listbox" aria-label="Models">
        ${opt('', 'Default', defaultNameFor(k))}
        ${list.map((m) => opt(m.id, m.name, multi ? m.vendor : '')).join('')}
      </div>
      ${all.length > LIMIT + 1 ? `<button type="button" class="pk-more">${showAll ? 'Fewer models' : `All ${all.length} models`}</button>` : ''}
      ${pickNote ? `<p class="pk-note">${esc(pickNote)}</p>` : ''}
      <div class="pk-foot"><button type="button" class="pk-srcbtn" aria-expanded="${srcOpen}">Source ${ico('caret-down')}</button>
        ${srcOpen ? `<div class="pk-src">${esc(r.source)}${r.quote ? ` &middot; <a class="link" href="${esc(r.quote.url)}" target="_blank" rel="noopener">${esc(host(r.quote.url))} ${ico('arrow-up-right')}</a> &middot; ${esc(fmtDate(r.quote.date))}` : ''}</div>` : ''}</div>`;
  }
  function placePick() {
    const n = nodes[S.sel] && nodes[S.sel].el; if (!n) return;
    if (matchMedia('(max-width: 720px)').matches) { pick.style.left = pick.style.top = ''; return; }
    const r = n.getBoundingClientRect(), w = pick.offsetWidth, h = pick.offsetHeight;
    let left = r.left + r.width / 2 - w / 2; left = clamp(left, 12, innerWidth - w - 12);
    let top = r.bottom + 8; if (top + h > innerHeight - 8 && r.top - h - 8 > 8) top = r.top - h - 8;
    pick.style.left = `${Math.round(left + scrollX)}px`; pick.style.top = `${Math.round(top + scrollY)}px`;
  }
  function openPick(k) {
    S.sel = k; showAll = false; srcOpen = false; pickNote = '';
    for (const key of ROLE_ORDER) nodes[key].el.setAttribute('aria-expanded', String(key === k));
    renderPick(); pick.hidden = false; scrim.hidden = false; placePick(); markSelection();
    pick.animate && play(pick, [{ opacity: 0, transform: 'translateY(6px) scale(0.98)' }, { opacity: 1, transform: 'none' }], { duration: 170, easing: EASE_OUT });
    const t = $('.pk-opt[aria-selected="true"]', pick) || $('.pk-opt', pick); t && t.focus({ preventScroll: true });
  }
  function closePick(refocus = false) {
    if (pick.hidden) return;
    pick.hidden = true; scrim.hidden = true;
    const k = S.sel;
    for (const key of ROLE_ORDER) nodes[key].el.setAttribute('aria-expanded', 'false');
    markSelection();
    if (refocus && k && nodes[k]) nodes[k].el.focus({ preventScroll: true });
  }
  scrim.addEventListener('click', () => closePick());
  document.addEventListener('pointerdown', (e) => { if (!pick.hidden && !pick.contains(e.target) && !root.contains(e.target)) closePick(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !pick.hidden) { e.preventDefault(); closePick(true); } });
  addEventListener('resize', () => { if (!pick.hidden) placePick(); });
  pick.addEventListener('keydown', (e) => {
    if (!['ArrowDown', 'ArrowUp'].includes(e.key)) return;
    const list = $$('.pk-opt', pick); const i = list.indexOf(document.activeElement); if (i < 0) return;
    e.preventDefault(); list[(i + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length].focus();
  });
  pick.addEventListener('click', (e) => {
    if (e.target.closest('.pk-x')) { closePick(true); return; }
    if (e.target.closest('.pk-more')) { showAll = !showAll; renderPick(); placePick(); $('.pk-more', pick).focus({ preventScroll: true }); return; }
    if (e.target.closest('.pk-srcbtn')) { srcOpen = !srcOpen; renderPick(); placePick(); $('.pk-srcbtn', pick).focus({ preventScroll: true }); return; }
    const o = e.target.closest('.pk-opt'); if (!o) return;
    const k = S.sel;
    if (o.dataset.id) S.roles[k] = o.dataset.id; else delete S.roles[k];
    compute();
    if (S.roles[k] && rejected.includes(k)) { delete S.roles[k]; pickNote = `Not available on ${S.plan}. Kept the default.`; renderPick(); placePick(); return; }
    update({ glide: false });
    closePick(true);
  });

  /* ---------- status, events ---------- */
  function announce() {
    const lead = roleOf('lead');
    statusEl.textContent = `${setup.toolLabel}, ${S.plan}, ${WORK_LABEL[S.work] || S.work}. Lead: ${lead.model_name || 'you pick it in ' + setup.toolLabel}. Click a box to change its model.`;
  }
  const emit = () => listeners.forEach((fn) => fn({ state: { ...S }, setup }));

  let firstRun = true, rt = 0, lastW = 0;
  async function update({ glide = true } = {}) {
    const prevKind = layout && (layout.kind + (layoutBig ? '+' : '-'));
    compute();
    const sig = `${S.tool}|${S.plan}|${S.work}|${setup.big_job}`;
    const changed = paintNodes();
    paintTaps(); announce();
    writeState({ tool: S.tool, plan: S.plan, work: S.work, big: null, example: null, roles: S.roles });
    const newKind = (root.clientWidth < WIDE_MIN ? 'chain' : setup.big_job ? 'loop' : 'compact') + (setup.big_job ? '+' : '-');
    const tapChanged = sig !== lastSig; lastSig = sig;
    if (!firstRun && !tapChanged && !changed.length) { emit(); return; }
    if (!firstRun && !tapChanged) { // a model changed inside a box: settle that box, keep the lines
      for (const k of changed) play(nodes[k].card, [{ opacity: 0.35, transform: 'translateY(3px)' }, { opacity: 1, transform: 'none' }], { duration: 240, easing: EASE_OUT });
      layout = currentLayout(); applyPositions(layout, false); drawEdges(layout, false);
      emit(); return;
    }
    if (!firstRun) for (const k of changed) play(nodes[k].card, [{ opacity: 0.3 }, { opacity: 1 }], { duration: 320, delay: 80, easing: EASE_OUT, fill: 'backwards' });
    choreograph({ glide: !firstRun && glide && prevKind !== newKind, draw: true, pulse: true });
    if (firstRun) {
      firstRun = false; lastW = root.clientWidth;
      if (!reducedMotion()) ROLE_ORDER.forEach((k, i) => play(nodes[k].el, [{ opacity: 0 }, { opacity: 1 }], { duration: 320, delay: i * 55, easing: EASE_OUT, fill: 'backwards' }));
    }
    emit();
  }

  const ro = new ResizeObserver(() => {
    const w = root.clientWidth; if (w === lastW || !setup || firstRun) { if (!firstRun) lastW = w; return; } lastW = w;
    clearTimeout(rt); rt = setTimeout(() => {
      layout = currentLayout(); root.dataset.kind = layout.kind;
      applyPositions(layout, false); drawEdges(layout, false);
    }, 80);
  });
  ro.observe(root);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (!setup || firstRun) return; layout = currentLayout(); applyPositions(layout, false); drawEdges(layout, false); });

  /* ---------- go ---------- */
  compute();
  paintTaps();
  (async () => {
    if (document.fonts && document.fonts.ready) { try { await Promise.race([document.fonts.ready, sleep(1200)]); } catch { /* ignore */ } }
    update({ glide: false });
  })();

  return {
    get state() { return { ...S }; },
    get setup() { return setup; },
    on(fn) { listeners.push(fn); if (setup) fn({ state: { ...S }, setup }); },
    resetAll() { S.roles = {}; update({ glide: true }); },
  };
}
