// Shared: facts, state in the URL, formatting, small helpers. No UI here except nav links and footer dates.
import { TOOLS, WORK, ROLE_INFO, ROLE_ORDER, loadFacts, setupFromTaps, modelsForTool, GENERATOR_VERSION } from './taps.mjs';

export { TOOLS, WORK, ROLE_INFO, ROLE_ORDER, setupFromTaps, modelsForTool, GENERATOR_VERSION };

export const REPO = 'https://github.com/lucascashwell3-ai/modelproof';
export const DEFAULT_PLAN = { 'claude-code': 'Max 5x', codex: 'Plus', cursor: 'Pro', copilot: 'Pro', antigravity: 'Google AI Pro' };
export const DEFAULT_TAPS = { tool: 'claude-code', plan: 'Max 5x', work: 'parallel' };

export const getFacts = () => loadFacts();

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const ico = (name, cls = '') => `<i class="ph-fill ph-${name} ${cls}" aria-hidden="true"></i>`;
export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** '2026-10-03' -> '3 Oct 2026'; '2026-07' -> 'Jul 2026'. */
export function fmtDate(iso, { noYear = false } = {}) {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(String(iso || ''));
  if (!m) return iso ? String(iso) : '';
  const [, y, mo, d] = m;
  const mon = MONTHS[+mo - 1];
  return d ? `${+d} ${mon}${noYear ? '' : ' ' + y}` : `${mon}${noYear ? '' : ' ' + y}`;
}
export const fmtPrice = (n) => (n == null ? '' : Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`);
export function fmtContext(n) {
  if (n == null) return '';
  if (n >= 1e6) return `${+(n / 1e6).toFixed(2)}M`;
  return `${Math.round(n / 1000)}K`;
}
export const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
export const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

/* ---------- state in the URL: ?tool=codex&plan=Plus&work=short&big=1&example=1&roles=scout:claude-haiku-5-5 ---------- */
export function readState(facts) {
  const q = new URLSearchParams(location.search);
  const tool = TOOLS.some((t) => t.id === q.get('tool')) ? q.get('tool') : DEFAULT_TAPS.tool;
  const T = TOOLS.find((t) => t.id === tool);
  const plan = T.plans.includes(q.get('plan')) ? q.get('plan') : DEFAULT_PLAN[tool] || T.plans[0];
  const work = WORK.some((w) => w.id === q.get('work')) ? q.get('work') : DEFAULT_TAPS.work;
  const big = q.get('big') === '1' ? true : q.get('big') === '0' ? false : null;
  const ex = (facts.guidance.examples || [])[0];
  const example = q.get('example') && ex ? ex.id : null;
  const roles = {};
  for (const part of (q.get('roles') || '').split(',')) {
    const [k, id] = part.split(':');
    if (k && id && ROLE_ORDER.includes(k) && facts.models.models.some((m) => m.id === id)) roles[k] = id;
  }
  return { tool, plan, work, big, example, roles };
}
export function stateQuery(s, { withRoles = true } = {}) {
  const q = new URLSearchParams();
  q.set('tool', s.tool); q.set('plan', s.plan); q.set('work', s.work);
  if (s.big !== null && s.big !== undefined) q.set('big', s.big ? '1' : '0');
  if (s.example) q.set('example', '1');
  const r = Object.entries(s.roles || {}).map(([k, v]) => `${k}:${v}`).join(',');
  if (withRoles && r) q.set('roles', r);
  return q.toString();
}
export function writeState(s) {
  const url = new URL(location.href);
  const keep = new URLSearchParams(url.search);
  for (const k of ['tool', 'plan', 'work', 'big', 'example', 'roles']) keep.delete(k);
  const merged = new URLSearchParams(stateQuery(s));
  for (const [k, v] of keep) merged.set(k, v);
  history.replaceState(null, '', `${url.pathname}?${merged.toString()}${url.hash}`);
  wireNav(s);
}
/** Nav and footer links carry the setup between pages. */
export function wireNav(s) {
  const qs = stateQuery(s);
  for (const a of $$('a[data-carry]')) {
    const base = a.getAttribute('data-carry');
    a.setAttribute('href', `${base}?${qs}${a.dataset.hash ? '#' + a.dataset.hash : ''}`);
  }
}

/** Fills every [data-fresh] slot (the footer's, and each Models section's) with the dated stamp for its data file.
 *  The freshness module loads on its own, so a page whose module fails still shows every fact. */
let freshMod = null;
export async function fillStamps(facts, { ladder = null } = {}) {
  try {
    freshMod = freshMod || (await Promise.all([import('./freshness.mjs'), import('./stamps.mjs')]));
    const [F, S] = freshMod;
    S.renderStamps($$('[data-fresh]'), { F, models: facts.models, ladder });
  } catch { /* no stamp is better than a broken one */ }
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
  const ta = document.createElement('textarea');
  ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
  document.body.appendChild(ta); ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

export const X_SVG = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg>`;
export const MARK_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><g stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none" opacity=".75"><path d="M12 7.5C12 11 6 11.5 6 16.5"/><path d="M12 7.5C12 11 18 11.5 18 16.5"/></g><rect x="8.6" y="2.6" width="6.8" height="6.2" rx="2" fill="currentColor"/><rect x="2.8" y="15" width="6.4" height="6.2" rx="2" fill="currentColor"/><rect x="14.8" y="15" width="6.4" height="6.2" rx="2" fill="currentColor"/></svg>`;

/** Nav and footer are written in each page; this just fills the mark and highlights nothing else. */
export function initShell() {
  for (const el of $$('[data-mark]')) el.innerHTML = MARK_SVG;
}
