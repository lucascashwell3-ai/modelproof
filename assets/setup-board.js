// The board: the setup drawn as a node graph. Three visible taps sit above it; click a box to change its model.
// Everything on it is computed by setupFromTaps(), so the picture and the files are what the installer would write.
import {
  TOOLS, ROLE_INFO, ROLE_ORDER, DEFAULT_PLAN, LAB_GROUPS,
  $, $$, clamp, esc, ico, fmtDate, host, reducedMotion, writeState,
} from './site-core.js';
import { boardSetup, pickList, optionLine, ROUTES, GROUP_LABEL, limitsText, isLimited, SPEND_LABEL } from './audiences.mjs';

const NS = 'http://www.w3.org/2000/svg';
const ICON = { lead: 'compass', scout: 'magnifying-glass', builder: 'hammer', reviewer: 'eye', checker: 'seal-check', bulk: 'stack' };
const SHORT = { lead: 'Plans the work', scout: 'Reads and searches', builder: 'Makes the change', reviewer: 'Reviews it', checker: 'Checks the result', bulk: 'Routine edits' };
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
  const S = { ...state, big: null, example: null, sel: null, limits: state.limits || { labs: [...LAB_GROUPS] }, spend: state.spend || 'balanced' };
  const listeners = [];
  let setup = null, rejected = [], layout = null, runId = 0, lastSig = '', layoutBig = false;
  const nodes = {};
  const id = root.id || 'board';

  /* ---------- DOM ---------- */
  const tapsEl = document.createElement('section');
  tapsEl.className = 'taps wrap';
  tapsEl.setAttribute('aria-label', 'Your three taps');
  tapsEl.innerHTML = [['tool', 'Your tool'], ['plan', 'Your plan'], ['spend', 'Your spend']].map(([k, label], i) => `
    <div class="tap" data-tap="${k}">
      <div class="tap-h" id="tap-${k}"><span class="tap-n" aria-hidden="true">${i + 1}</span><span class="tap-l">${label}</span></div>
      <div class="tap-opts" role="group" aria-labelledby="tap-${k}"></div>
    </div>`).join('');
  root.before(tapsEl);

  /* Limit models: one quiet control on the board's top edge. Closed by default; opens inline, never as a modal. */
  const limEl = document.createElement('section');
  limEl.className = 'lim wrap';
  limEl.setAttribute('aria-label', 'Limit models');
  limEl.innerHTML = `
    <div class="lim-bar">
      <span class="lim-right"><span class="lim-chip" hidden><span class="lim-chip-t"></span><button type="button" class="lim-clear" aria-label="Clear limits">${ico('x-circle')}</button></span>
      <button type="button" class="lim-toggle" aria-expanded="false" aria-controls="lim-panel" aria-label="Limit models">${ico('funnel')}<span>Limit models</span>${ico('caret-down', 'lim-c')}</button></span>
    </div>
    <div class="lim-panel" id="lim-panel" hidden>
      <div class="lim-g"><div class="tap-h" id="lim-labs">Lab based in</div>
        <div class="tap-opts" role="group" aria-labelledby="lim-labs" data-lim="labs">${LAB_GROUPS.map((g) => `<button type="button" class="opt" data-v="${g}">${esc(GROUP_LABEL[g])}</button>`).join('')}</div></div>
      <p class="lim-count" role="status" aria-live="polite"><b class="num"></b> <span></span></p>
    </div>`;
  root.before(limEl);
  const saveEl = document.createElement('p');
  saveEl.className = 'spend-note wrap'; saveEl.setAttribute('role', 'status'); saveEl.setAttribute('aria-live', 'polite');
  root.after(saveEl);
  const limToggle = $('.lim-toggle', limEl), limPanel = $('.lim-panel', limEl), limChip = $('.lim-chip', limEl);

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
    setup = boardSetup(S, facts);
    rejected = setup.rejected;
  }
  const roleOf = (k) => setup.roles.find((r) => r.key === k);

  function paintNodes() {
    const changed = [];
    for (const r of setup.roles) {
      const n = nodes[r.key]; if (!n) continue;
      const v = r.view;
      const sig = [v.model, v.src, v.meta, v.open, v.state].join('|');
      if (sig === n.sig) continue;
      n.sig = sig;
      n.el.dataset.state = v.state;
      n.card.innerHTML = `
        <span class="node-head">${ico(ICON[r.key])}<span class="node-name">${esc(ROLE_INFO[r.key].name)}</span><span class="node-job">${esc(SHORT[r.key])}</span></span>
        <span class="node-model${v.state === 'shared' || v.state === 'wait' ? ' shared' : ''}"><span>${esc(v.model)}</span>${ico('caret-down', 'node-c')}</span>
        ${v.state === 'pick' || v.state === 'outside' ? `<span class="node-src">${esc(v.src)}</span>` : ''}
        ${v.meta ? `<span class="node-meta"><span class="num">${esc(v.meta)}</span>${v.open ? '<span class="ow">Open weights</span>' : ''}</span>` : ''}`;
      n.el.setAttribute('aria-label', `${ROLE_INFO[r.key].name}, ${SHORT[r.key].toLowerCase()}. Model: ${v.model}. ${v.src}.${v.meta ? ' ' + v.meta + '.' : ''}${v.open ? ' Open weights.' : ''} Choose a model.`);
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
  // Plan names drop their note in brackets ("Team (Premium seat)" -> "Team") unless two plans would then read the same
  // ("Google AI Ultra (5x)" and "(20x)" stay told apart as "Google AI Ultra 5x" and "Google AI Ultra 20x").
  const planLabels = (plans) => plans.map((p) => {
    const short = p.replace(/\s*\(.*\)/, '');
    const clash = plans.filter((x) => x.replace(/\s*\(.*\)/, '') === short).length > 1;
    return [p, clash ? p.replace(/\s*\((.*)\)/, ' $1') : short];
  });
  const SPEND_TAP = {};
  const tapChoices = {
    tool: () => TOOLS.map((t) => [t.id, t.label, t.id === S.tool]),
    plan: () => (S.tool === 'any'
      ? ROUTES.map((r) => [r.id, r.label, r.id === S.plan])
      : planLabels(TOOLS.find((t) => t.id === S.tool).plans).map(([p, label]) => [p, label, p === S.plan])),
    spend: () => Object.keys(SPEND_LABEL).map((k) => [k, SPEND_TAP[k] || SPEND_LABEL[k], k === S.spend]),
  };
  function paintTaps() {
    for (const k of ['tool', 'plan', 'spend']) {
      $(`.tap[data-tap="${k}"] .tap-opts`, tapsEl).innerHTML = tapChoices[k]().map(([v, label, on]) => `<button type="button" class="opt" data-v="${esc(v)}" aria-pressed="${on}">${esc(label)}</button>`).join('');
    }
    $('.tap[data-tap="plan"] .tap-l', tapsEl).textContent = S.tool === 'any' ? 'Where your models run' : 'Your plan';
  }
  // A lead with no documented default opens as a picker: the visitor's own choice is the next step.
  function pickLeadIfOpen(delay = 60) {
    if (roleOf('lead').view.state !== 'pick') return;
    setTimeout(() => { if (roleOf('lead').view.state === 'pick' && pick.hidden) openPick('lead'); }, delay);
  }
  tapsEl.addEventListener('click', (e) => {
    const b = e.target.closest('.opt'); if (!b) return;
    const k = b.closest('.tap').dataset.tap, v = b.dataset.v;
    closePick();
    if (k === 'tool') { if (v === S.tool) return; S.tool = v; S.plan = DEFAULT_PLAN[v] || TOOLS.find((t) => t.id === v).plans[0]; S.roles = {}; }
    else if (k === 'plan') { if (v === S.plan) return; S.plan = v; }
    else { if (v === S.spend) return; S.spend = v; }
    update({ glide: true });
    const again = $(`.tap[data-tap="${k}"] .opt[data-v="${CSS.escape(v)}"]`, tapsEl); if (again) again.focus({ preventScroll: true });
    if (k !== 'spend') pickLeadIfOpen(reducedMotion() ? 60 : 420);
  });
  const arrowKeys = (scope) => (e) => {
    if (!['ArrowRight', 'ArrowLeft'].includes(e.key)) return;
    const list = $$('.opt', e.target.closest('.tap-opts') || scope); const i = list.indexOf(document.activeElement); if (i < 0) return;
    e.preventDefault(); list[(i + (e.key === 'ArrowRight' ? 1 : -1) + list.length) % list.length].focus();
  };
  tapsEl.addEventListener('keydown', arrowKeys(tapsEl));

  /* ---------- limits ---------- */
  function paintLimits() {
    for (const b of $$('[data-spend]', limEl)) b.setAttribute('aria-pressed', String(b.dataset.spend === S.spend));
    const L = S.limits;
    for (const b of $$('[data-lim="labs"] .opt', limEl)) b.setAttribute('aria-pressed', String(L.labs.includes(b.dataset.v)));
    const c = setup.count;
    $('.lim-count b', limEl).textContent = c.fit ? String(c.fit) : '';
    $('.lim-count span', limEl).textContent = c.fit ? `of ${c.total} models${S.tool === 'any' ? ' on this route' : setup.oneLab ? ` ${setup.toolLabel} runs` : ''}` : 'No model fits. Turn a lab back on.';
    const on = isLimited(L);
    limChip.hidden = !on;
    limEl.dataset.limited = String(on);
    if (on) $('.lim-chip-t', limEl).textContent = `Limited: ${limitsText(L)}`;
  }
  function setLimOpen(open) {
    limPanel.hidden = !open; limToggle.setAttribute('aria-expanded', String(open)); limEl.dataset.open = String(open);
    if (open && !reducedMotion()) play(limPanel, [{ opacity: 0, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'none' }], { duration: 180, easing: EASE_OUT });
  }
  limToggle.addEventListener('click', () => { closePick(); setLimOpen(limPanel.hidden); });
  limEl.addEventListener('click', (e) => {
    const sp = e.target.closest('[data-spend]');
    if (sp) {
      if (sp.dataset.spend === S.spend) return;
      closePick(); S.spend = sp.dataset.spend; update({ glide: false }); sp.focus({ preventScroll: true }); return;
    }
    if (e.target.closest('.lim-clear')) {
      S.limits = { labs: [...LAB_GROUPS] };
      update({ glide: false }); limToggle.focus({ preventScroll: true }); return;
    }
    const b = e.target.closest('.lim-panel .opt'); if (!b) return;
    const grp = b.closest('[data-lim]').dataset.lim, v = b.dataset.v;
    closePick();
    const has = S.limits.labs.includes(v);
    S.limits = { ...S.limits, labs: has ? S.limits.labs.filter((g) => g !== v) : LAB_GROUPS.filter((g) => g === v || S.limits.labs.includes(g)) };
    update({ glide: false });
    const again = $(`[data-lim="${grp}"] .opt[data-v="${v}"]`, limEl); if (again) again.focus({ preventScroll: true });
  });
  limEl.addEventListener('keydown', arrowKeys(limEl));

  /* ---------- the picker: click a box, choose its model ---------- */
  let showAll = false, srcOpen = false, pickNote = '';
  /** What "Default" means for a box: the same board without this box's own choice. Null when there is none. */
  function defaultFor(k) {
    const roles = { ...S.roles }; delete roles[k];
    const r = boardSetup({ ...S, roles }, facts).roles.find((x) => x.key === k);
    const v = r.view;
    if (v.state === 'pick') return null;
    if (v.state === 'shared') return `${v.model}, same as the lead`;
    if (v.state === 'wait') return "The lead's model";
    if (v.state === 'outside') return 'Outside your limits';
    if (r.rule === 'cost') return `${v.model} · ${r.priceWord}`;
    return `${v.model} · ${v.src}`;
  }
  function renderPick() {
    const k = S.sel; if (!k) return;
    const r = roleOf(k), cur = S.roles[k] || '';
    const any = S.tool === 'any';
    const all = pickList(facts, S);
    const LIMIT = 6;
    // Collapsed: six per group (local first on "Both"), plus the current choice.
    const groups = any && S.plan === 'both' ? [['On your computer', all.filter((e) => e.route === 'local')], ['On OpenRouter', all.filter((e) => e.route !== 'local')]] : [['', all]];
    const many = groups.some(([, g]) => g.length > LIMIT + 1);
    const multi = new Set(all.map((m) => m.vendor)).size > 1;
    const opt = (mid, name, sub, open = false) => `<button type="button" class="pk-opt" role="option" data-id="${esc(mid)}" aria-selected="${cur === mid}"><span class="pk-t">${esc(name)}${sub || open ? `<small>${esc(sub)}${open ? '<span class="ow">Open weights</span>' : ''}</small>` : ''}</span>${ico('check-fat')}</button>`;
    if (any && S.plan === 'ollama') groups[0][0] = 'On your computer';
    const body = groups.map(([title, g]) => {
      let list = g;
      if (!showAll && g.length > LIMIT + 1) { list = g.slice(0, LIMIT); const c = g.find((m) => m.id === cur); if (c && !list.includes(c)) list = [...list, c]; }
      const head = title === 'On your computer' ? `${title} (Ollama), all open weights` : title;
      return `${title && g.length ? `<p class="pk-g" role="presentation">${esc(head)}</p>` : ''}${list.map((e) => { const l = optionLine(e, { any, multi }); return opt(e.id, e.name, l.text, l.open); }).join('')}`;
    }).join('');
    const def = defaultFor(k);
    const lede = r.view.state === 'pick' ? r.view.src : r.view.state === 'outside' ? 'Its usual model is outside your limits. Pick one inside them.' : '';
    const other = setup.oneLab ? `<p class="pk-other">${esc(setup.toolLabel)} runs only ${esc(setup.oneLab)} models. For another lab's model, <button type="button" class="pk-any">use Any model ${ico('arrow-right')}</button></p>` : '';
    const limitNote = setup.limited ? `<p class="pk-note pk-lim">${ico('funnel')}${all.length ? `Only models inside your limits (${all.length}).` : `No ${esc(any ? 'model on this route' : setup.toolLabel + ' model')} fits your limits.`}</p>` : '';
    pick.setAttribute('aria-label', `Choose a model for the ${ROLE_INFO[k].name.toLowerCase()}`);
    pick.classList.toggle('pick-wide', any);
    pick.innerHTML = `
      <div class="pk-h"><span class="pk-title">${ico(ICON[k])}<b>${esc(ROLE_INFO[k].name)}</b><span>${esc(SHORT[k])}</span></span><button type="button" class="ibtn pk-x" aria-label="Close">${ico('x')}</button></div>
      ${lede ? `<p class="pk-lede">${esc(lede)}</p>` : ''}
      <div class="pk-list" role="listbox" aria-label="Models">
        ${k === 'lead' && S.tool !== 'any' && (r.view.state === 'pick' || r.view.state === 'tooldefault') ? opt('tool-default', `Not sure, use ${setup.toolLabel}'s default`, 'Helpers run on the same model') : def ? opt('', 'Default', def) : ''}
        ${body}
      </div>
      ${many ? `<button type="button" class="pk-more">${showAll ? 'Fewer models' : `All ${all.length} models`}</button>` : ''}
      ${pickNote ? `<p class="pk-note">${esc(pickNote)}</p>` : ''}
      ${limitNote}${other}
      <div class="pk-foot"><button type="button" class="pk-srcbtn" aria-expanded="${srcOpen}">Source ${ico('caret-down')}</button>
        ${srcOpen ? `<div class="pk-src">${esc(r.source)}${r.quote ? ` &middot; <a class="link" href="${esc(r.quote.url)}" target="_blank" rel="noopener">${esc(host(r.quote.url))} ${ico('arrow-up-right')}</a> &middot; ${esc(fmtDate(r.quote.date))}` : ''}</div>` : ''}</div>`;
  }
  /** "use Any model": same jobs, any lab. Keeps the models already on the board when the route has them. */
  function toAnyModel(k) {
    const keep = {};
    for (const r of setup.roles) if (r.entry && !r.outside && (r.key === 'lead' || r.rule === 'you') && r.entry.route === 'cloud') keep[r.key] = r.entry.id;
    closePick();
    S.tool = 'any'; S.plan = 'openrouter'; S.roles = keep;
    update({ glide: true });
    setTimeout(() => openPick(k), reducedMotion() ? 60 : 420);
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
    setTimeout(() => { if (!pick.hidden && S.sel === k) placePick(); }, 420); // after any glide settles
    pick.animate && play(pick, [{ opacity: 0, transform: 'translateY(6px) scale(0.98)' }, { opacity: 1, transform: 'none' }], { duration: 170, easing: EASE_OUT });
    const t = $('.pk-opt[aria-selected="true"]', pick) || $('.pk-opt', pick);
    if (t) { const lst = $('.pk-list', pick); if (t.offsetTop + t.offsetHeight > lst.clientHeight) lst.scrollTop = t.offsetTop - lst.clientHeight / 2; t.focus({ preventScroll: true }); }
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
    if (e.target.closest('.pk-any')) { toAnyModel(S.sel); return; }
    if (e.target.closest('.pk-more')) { showAll = !showAll; renderPick(); placePick(); $('.pk-more', pick).focus({ preventScroll: true }); return; }
    if (e.target.closest('.pk-srcbtn')) { srcOpen = !srcOpen; renderPick(); placePick(); $('.pk-srcbtn', pick).focus({ preventScroll: true }); return; }
    const o = e.target.closest('.pk-opt'); if (!o) return;
    const k = S.sel;
    if (o.dataset.id) S.roles[k] = o.dataset.id; else delete S.roles[k];
    compute();
    if (S.roles[k] && rejected.includes(k)) { delete S.roles[k]; pickNote = `Not available on ${S.plan}. Kept the default.`; renderPick(); placePick(); return; }
    update({ glide: false });
    closePick(true);
    if (matchMedia('(max-width: 720px)').matches) root.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
  });

  /* ---------- status, events ---------- */
  function announce() {
    const lead = roleOf('lead');
    const plan = S.tool === 'any' ? (ROUTES.find((r) => r.id === S.plan) || {}).label : S.plan;
    statusEl.textContent = `${setup.toolLabel}, ${plan}, ${SPEND_LABEL[S.spend]} spend. Lead: ${lead.view.state === 'pick' ? lead.view.src : lead.view.model}.${setup.limited ? ` Limited: ${limitsText(S.limits)}.` : ''} Click a box to change its model.`;
  }
  const emit = () => listeners.forEach((fn) => fn({ state: { ...S }, setup }));

  let firstRun = true, rt = 0, lastW = 0;
  async function update({ glide = true } = {}) {
    const prevKind = layout && (layout.kind + (layoutBig ? '+' : '-'));
    compute();
    const sig = `${S.tool}|${S.plan}|${S.work}|${setup.big_job}`;
    const changed = paintNodes();
    paintTaps(); paintLimits(); announce();
    const sv = setup.saving;
    saveEl.textContent = sv
      ? `About ${sv.pct}% cheaper than ${sv.lead} on every job, at list prices.${sv.lo != null ? ` The cheaper helpers score ${sv.lo === sv.hi ? `${sv.lo}%` : `${sv.lo} to ${sv.hi}%`} of ${sv.lead} on outside coding tests.` : ''}`
      : setup.sameModel ? `Nothing cheaper scores close enough to ${setup.sameModel}, so every job uses it.` : '';
    writeState({ tool: S.tool, plan: S.plan, work: S.work, big: null, example: null, roles: S.roles, limits: S.limits, spend: S.spend });
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
    openPick(k) { openPick(k); },
    openLimits() { setLimOpen(true); },
  };
}
