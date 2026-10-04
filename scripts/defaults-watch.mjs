#!/usr/bin/env node
/* Defaults watch — the weekly job that keeps data/guidance.json and data/plans.json in step with
   what the coding tools, model labs and plan pages say today. Deterministic: regex rules on page
   text, no model calls.

   The watch list is data/defaults-watch.json (schema: scripts/validate-data.mjs validateWatchList).
   Each rule names a page, an anchor that must be on it, and a pattern whose capture group 1 is the
   value. No rule stores the value it expects: a rule compares the page with the data.

   Outcomes, one per rule:
     ok                same value as the data.
     change            a "field" rule whose page value differs and resolves (for a model, to a GA
                       catalog id): written to `maps_to` (+ `also`), its claims rewritten, and sent
                       as ONE bot pull request (branch auto/defaults-watch). Never pushed to main.
     waiting:catalog   a model name the catalog does not have yet: no write; listed.
     waiting:not-ga    a model the catalog lists as preview or deprecated: no write; listed.
     needs-review      a "flag" rule's page value differs (or a field change could not be written
                       honestly, e.g. no quote fits): no write; listed in the issue for the Judge.
     declined          a change whose value sits in a bot PR that was closed without merging:
                       skipped until the page says something else.
     gate-failed       a change that makes validate-data or check-live-data --group plans report a
                       problem main does not have: not written; red.
     blocked           the page could not be read (403/429/5xx/timeout/short body): a warning; red
                       once the same page has been blocked 3 runs in a row (count in the receipt).
     broken:missing    the anchor or the pattern is gone, or the page is gone (404/410): red.
     broken:ambiguous  the pattern finds two different values: red, never "first one wins".

   A change writes: the value at maps_to and every `also` path; a NEW claim for each claim in
   claim_ids (quote copied from the page — the old quote with the old value swapped, or else the
   matched span — confirmed on the page with check-sources' quoteFoundIn; sentence from the rule's
   template; date today); the old claim gets superseded_by (check-sources then skips it) and every
   basis[] that named it names the new one. A plan price rewrites its plans.json row in place
   (price, quote, quote_url, as_of). A model with ref_row also gets a model_refs row for the string
   the page uses. Each change is gated alone on main + that change (only problems main does not
   already have count), then all passing changes together.

   After the rules: the full source sweep (check-sources --blocked-ok --fresh, skipping the quotes
   a pending change replaces) and its claim-rot report, plus check-live-data --group plans on main.
   A run where every rule is ok, no change PR is open, and the sweep and plans gate pass re-stamps
   guidance.json's as_of (that one line) with today. Every live run on main pushes its receipt
   (data/refresh/receipt-defaults-watch.json) straight to main. One issue ("Defaults watch: rules
   need attention") lists everything that is not ok, and closes itself on the next run with none.

   Remote writes — branch push, pull request, commit status, issue, main push — happen only in a
   live run: not DRY_RUN, on refs/heads/main, not a pull_request event, with a token. PR, status,
   issue and branch delete go through scripts/lib/gh-issue.mjs's guarded ghWrite; the two git
   pushes check the same guard plus an allowed-path list (bot branch: guidance.json + plans.json;
   main: the receipt + guidance.json, whose diff must be the as_of line only). Nothing here creates
   or changes a workflow, a schedule or a dispatch.

   Usage:
     node scripts/defaults-watch.mjs --dry-run      live pages, real data/, prints what it would do
     node scripts/defaults-watch.mjs --live         the scheduled run (writes; see guard above)
     node scripts/defaults-watch.mjs --drill        pass 2 + 3 on frozen fixtures: one value swapped
                                                    -> exactly one PR; same input again -> nothing new
       --sweep / --no-sweep   force the source sweep on or off (default: on for --live only)
     Exit: 0 green (warnings allowed), 1 red, 2 bad arguments.
   Env: MODELPROOF_NOW=<iso> frozen clock (tests, drills). */
import { readFileSync, writeFileSync, mkdtempSync, cpSync, existsSync, rmSync, realpathSync, appendFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchNormalizedPage, quoteFoundIn, normalizeText, classifyFailure } from './check-sources.mjs';
import { matchAlias } from './auto-refresh.mjs';
import { ghRead, ghWrite, upsertIssue, closeIssue, writeBlockReason } from './lib/gh-issue.mjs';
import { validateGuidance, wordCount, getPath, setPath, planRow, PLACEHOLDER_RE } from './validate-data.mjs';
import { runChecks } from './check-live-data.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const BOT_BRANCH = 'auto/defaults-watch';
export const RECEIPT_PATH = 'data/refresh/receipt-defaults-watch.json';
export const BRANCH_PATHS = ['data/guidance.json', 'data/plans.json'];
export const MAIN_PATHS = ['data/guidance.json', RECEIPT_PATH];
export const ISSUE_TITLE = 'Defaults watch: rules need attention';
export const LABEL = 'defaults-watch';
export const STATUS_CONTEXT = 'defaults-watch/gates';
export const BLOCKED_RED_RUNS = 3;
export const BOT_NAME = 'modelproof-defaults-watch';
export const BOT_EMAIL = 'actions@users.noreply.github.com';
const MARK = 'defaults-watch';
const MAX_QUOTE_WORDS = 25;

/* ------------------------------------------------------------------ paths ------------------ */

export { parsePath, getPath, setPath, planRow, PLACEHOLDER_RE } from './validate-data.mjs';

/* ------------------------------------------------------------------ models ----------------- */

const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();

function catalog(models) {
  const list = Array.isArray(models) ? models : (models && models.models) || [];
  return new Map(list.map((m) => [m.id, m]));
}

/** The forms a model is written in: id, catalog name, short (name minus its first word), slug
 * (name lowercased, spaces -> '-'), and the tool's model_refs string. */
export function modelForms(id, ctx, tool = null) {
  const m = ctx.byId.get(id);
  const name = m ? String(m.name).replace(/\s*\((?:preview|beta)\)\s*$/i, '') : id;
  const words = name.split(/\s+/);
  const ref = tool ? ((ctx.data.guidance.model_refs || []).find((r) => r && r.tool === tool && r.model_id === id) || {}).ref : undefined;
  return { id, name, short: words.length > 1 ? words.slice(1).join(' ') : name, slug: name.toLowerCase().replace(/\s+/g, '-'), ref };
}

const SLOT_PATHS = {
  lead: (t) => `guidance.tool_plans[tool=${t}].lead.model_id`,
  push_down: (t) => `guidance.tool_plans[tool=${t}].helpers.push_down.model_id`,
  bulk: (t) => `guidance.tool_plans[tool=${t}].bulk.model_id`,
};

/** "{form:tool.slot}" -> the model id it names in the working data, or null. */
function placeholderModel(spec, ctx) {
  const [tool, ...slot] = spec.split('.');
  let path;
  if (slot.length === 1 && SLOT_PATHS[slot[0]]) path = SLOT_PATHS[slot[0]](tool);
  else if (slot[0] === 'ref' && slot.length === 2) path = `guidance.model_refs[tool=${tool}][ref=${slot[1]}].model_id`;
  else if (slot[0] === 'role' && slot.length === 2) path = `guidance.role_defaults[tool=${tool}][role=${slot[1]}].model_id`;
  else return { error: `unknown placeholder slot "${spec}"` };
  const id = getPath(ctx.data, path);
  if (typeof id !== 'string') return { error: `placeholder ${spec}: ${path} names no model` };
  return { id, tool };
}

/** Fill `{form:tool.slot}` from the working data. mode 'regex' escapes and lowercases (patterns
 * run on lowercased page text), 'anchor' lowercases, 'text' keeps the catalog case. Returns
 * {text} or {error}. `{value}` / `{value:list}` are filled from `value` when given. */
export function fillPlaceholders(text, ctx, mode = 'text', value = undefined) {
  let error = null;
  let out = String(text).replace(PLACEHOLDER_RE, (all, form, spec) => {
    const r = placeholderModel(spec, ctx);
    if (r.error) { error = r.error; return all; }
    const f = modelForms(r.id, ctx, r.tool)[form];
    if (!f) { error = `placeholder ${all}: no ${form} for ${r.id}`; return all; }
    if (mode === 'regex') return escRe(f.toLowerCase());
    if (mode === 'anchor') return f.toLowerCase();
    return f;
  });
  if (value !== undefined) {
    out = out.replace(/\{value:list\}/g, () => listText(value)).replace(/\{value\}/g, () => String(Array.isArray(value) ? value.join(', ') : value));
  }
  if (/\{(value|name|short|slug|ref|id)[:}]/.test(out)) error = error || `unfilled placeholder in "${text}"`;
  return error ? { error } : { text: out };
}

function listText(v) {
  const a = Array.isArray(v) ? v : String(v).split(/\s+/).filter(Boolean);
  if (a.length <= 1) return a.join('');
  return `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`;
}

/* ------------------------------------------------------------------ values ----------------- */

const LIST_STOP = new Set(['or', 'and']);
const cleanRaw = (raw) => String(raw).replace(/[`*]/g, '').replace(/\s+/g, ' ').trim();

/** The page value in the data's terms. For a model: {key: id|null, id, raw}. */
export function comparable(rule, raw, ctx) {
  const r = cleanRaw(raw);
  switch (rule.value) {
    case 'model': {
      let id = null;
      const how = rule.value_to_id || 'direct';
      if (how === 'claude') id = matchAlias(`claude ${r}`, ctx.modelList, ctx.aliases);
      else if (how === 'direct') id = matchAlias(r, ctx.modelList, ctx.aliases);
      else if (how.startsWith('ref:')) {
        const tool = how.slice(4);
        const row = (ctx.data.guidance.model_refs || []).find((x) => x && x.tool === tool && norm(x.ref) === norm(r));
        id = row ? row.model_id : null;
      }
      return { key: id, id, raw: r };
    }
    case 'word': return { key: r.toLowerCase(), raw: r };
    case 'last-word': { const w = r.toLowerCase().split(/\s+/); return { key: w[w.length - 1], raw: r }; }
    case 'list': { const a = (r.toLowerCase().match(/[a-z]+/g) || []).filter((w) => !LIST_STOP.has(w)); return { key: a, raw: r }; }
    case 'price': { const n = Number(r.replace(/[$,\s]/g, '')); return { key: Number.isFinite(n) ? n : null, raw: r }; }
    default: return { key: norm(r), raw: r };
  }
}

const sameKey = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const valueKey = (k) => (Array.isArray(k) ? k.join(',') : String(k));

/** True when `needle` is in `text` as whole tokens (normalized, case-insensitive). */
export function containsToken(text, needle) {
  const t = normalizeText(text);
  const n = normalizeText(needle);
  if (!n) return false;
  for (let i = t.indexOf(n); i !== -1; i = t.indexOf(n, i + 1)) {
    const before = t[i - 1];
    const after = t[i + n.length];
    if ((before === undefined || !/[a-z0-9]/.test(before) || !/[a-z0-9]/.test(n[0]))
      && (after === undefined || !/[a-z0-9]/.test(after) || !/[a-z0-9]/.test(n[n.length - 1]))) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ matching --------------- */

/** Run one rule on one page. {status:'ok', raw, match:[s,e], cap:[s,e]} | {status:'missing'|'ambiguous', reason}. */
export function captureRule(rule, page, ctx) {
  const anchor = fillPlaceholders(rule.anchor, ctx, 'anchor');
  if (anchor.error) return { status: 'missing', reason: anchor.error };
  const pat = fillPlaceholders(rule.pattern, ctx, 'regex');
  if (pat.error) return { status: 'missing', reason: pat.error };
  if (!page.includes(anchor.text)) return { status: 'missing', reason: `anchor "${anchor.text}" is not on the page` };
  let re;
  try { re = new RegExp(pat.text, 'gd'); } catch (e) { return { status: 'missing', reason: `pattern does not compile: ${e.message}` }; }
  const all = [...page.matchAll(re)].filter((m) => m[1] !== undefined);
  if (!all.length) return { status: 'missing', reason: 'pattern finds nothing on the page' };
  const distinct = [...new Set(all.map((m) => norm(cleanRaw(m[1]))))];
  if (distinct.length > 1 && !rule.first_match) return { status: 'ambiguous', reason: `pattern finds ${distinct.length} different values: ${distinct.map((d) => `"${d}"`).join(', ')}` };
  const m = all[0];
  return { status: 'ok', raw: m[1], match: m.indices[0], cap: m.indices[1] };
}

/* ------------------------------------------------------------------ quotes + claims -------- */

/** A ≤25-word quote of the matched span that contains the capture: the whole match when short
 * enough, else the 25 whole words ending with the capture. */
export function spanQuote(page, match, cap) {
  const [ms, me] = match;
  const span = page.slice(ms, me).trim();
  if (wordCount(span) <= MAX_QUOTE_WORDS) return span;
  // word boundaries inside the match
  const starts = [];
  for (let i = ms; i < me; i += 1) if (page[i] !== ' ' && (i === ms || page[i - 1] === ' ')) starts.push(i);
  let endTok = starts.length - 1;
  while (endTok > 0 && starts[endTok] >= cap[1]) endTok -= 1;
  let end = cap[1];
  while (end < me && page[end] !== ' ') end += 1;
  const startTok = Math.max(0, endTok - (MAX_QUOTE_WORDS - 1));
  if (starts[startTok] > cap[0]) return null;
  return page.slice(starts[startTok], end).trim();
}

const caseLike = (found, repl) => {
  if (found === found.toLowerCase()) return repl.toLowerCase();
  if (found === found.toUpperCase() && /[A-Z]/.test(found)) return repl.toUpperCase();
  if (/^[A-Z]/.test(found)) return repl[0].toUpperCase() + repl.slice(1);
  return repl;
};

/** Swap every old form for its new form in one pass (longest first, whole tokens, the found
 * text's case kept). `pairs` = [[old, new], ...]. */
export function swapForms(text, pairs) {
  const seen = new Set();
  const ps = pairs.filter(([o, n]) => o && n != null && String(o) !== String(n)).map(([o, n]) => [String(o), String(n)])
    .filter(([o]) => !seen.has(o.toLowerCase()) && seen.add(o.toLowerCase()))
    .sort((a, b) => b[0].length - a[0].length);
  if (!ps.length) return text;
  const re = new RegExp(`(?<![A-Za-z0-9$.])(${ps.map(([o]) => escRe(o)).join('|')})(?![A-Za-z0-9]|\\.[0-9])`, 'gi');
  return String(text).replace(re, (found) => {
    const hit = ps.find(([o]) => o.toLowerCase() === found.toLowerCase());
    return hit ? caseLike(found, hit[1]) : found;
  });
}

/** A new quote: the old quote with the old value swapped (when the result is on the page), else
 * the matched span. Null when neither is on the page within 25 words. */
export function rewriteQuote(oldQuote, pairs, page, cap) {
  const cand = swapForms(oldQuote || '', pairs);
  if (cand && wordCount(cand) <= MAX_QUOTE_WORDS && quoteFoundIn(cand, page)) return cand;
  const span = cap.match ? spanQuote(page, cap.match, cap.cap) : null;
  if (span && wordCount(span) <= MAX_QUOTE_WORDS && quoteFoundIn(span, page)) return span;
  return null;
}

const compactDate = (d) => d.replace(/-/g, '');

/** The id for a claim that replaces `oldId`: the old value's slug swapped for the new one where
 * the id carries it, else the id plus today's date; always unused. */
export function nextClaimId(oldId, segPairs, taken, today) {
  let id = null;
  for (const [o, n] of segPairs) {
    if (!o || !n || o === n) continue;
    const re = new RegExp(`(^|-)${escRe(o)}(?=-|$)`);
    if (re.test(oldId)) { id = oldId.replace(re, (all, lead) => `${lead}${n}`); break; }
  }
  if (!id || id === oldId || taken.has(id)) id = `${oldId}-${compactDate(today)}`;
  let k = 2;
  const base = id;
  while (taken.has(id)) { id = `${base}-${k}`; k += 1; }
  return id;
}

const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** Claim-id segment pairs for a model change: whole id, slug of the short name, then shorter id
 * suffixes ("6-1-sol" -> "6-2-sol"). */
function modelSegPairs(oldF, newF) {
  const out = [[oldF.id, newF.id], [slugify(oldF.short), slugify(newF.short)], [slugify(oldF.name), slugify(newF.name)]];
  const o = oldF.id.split('-');
  const n = newF.id.split('-');
  for (let k = 1; k < Math.min(o.length, n.length); k += 1) out.push([o.slice(k).join('-'), n.slice(k).join('-')]);
  return out;
}

const urlKey = (u) => String(u || '').replace(/^https?:\/\//, '').replace(/\.md$/, '').replace(/\/+$/, '');

/** The newest claim in a superseded_by chain. */
export function latestClaim(guidance, id) {
  const byId = new Map((guidance.claims || []).map((c) => [c.id, c]));
  let c = byId.get(id);
  const seen = new Set();
  while (c && c.superseded_by && !seen.has(c.id)) {
    seen.add(c.id);
    const next = byId.get(c.superseded_by);
    if (!next) break;
    c = next;
  }
  return c || null;
}

function swapBasis(node, from, to) {
  if (Array.isArray(node)) { node.forEach((x) => swapBasis(x, from, to)); return; }
  if (!node || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    if (k === 'basis' && Array.isArray(v)) node[k] = [...new Set(v.map((id) => (id === from ? to : id)))];
    else if (k !== 'claims' && v && typeof v === 'object') swapBasis(v, from, to);
  }
}

/* ------------------------------------------------------------------ evaluation ------------- */

const clone = (o) => JSON.parse(JSON.stringify(o));

/** Evaluate every rule against `pages` ({url: text} or {url: {error, kind}}) and a working copy
 * of `data` ({guidance, plans}). Field rules run first, in file order (a rule listed after a
 * change reads the changed data: placeholders follow the new lead), then flags against the final
 * copy. `onlyWrite`: rule ids allowed to write (gate one change alone); `skipWrite`: ids never to
 * write (failed their gate); `declined`: Set of "rule\tvalue" keys. Pure — no I/O. */
export function evaluate({ watch, data, models, aliases = {}, pages, today, declined = new Set(), onlyWrite = null, skipWrite = new Set() }) {
  const work = clone(data);
  const modelList = Array.isArray(models) ? models : models.models;
  const ctx = { data: work, byId: catalog(modelList), modelList, aliases };
  const created = new Set();
  const outcomes = [];
  const rules = watch.rules || [];
  const order = [...rules.filter((r) => r.write === 'field'), ...rules.filter((r) => r.write !== 'field')];
  for (const rule of order) {
    const o = { rule: rule.id, tool: rule.tool, url: rule.url, write: rule.write };
    outcomes.push(o);
    const page = pages[rule.url];
    if (page == null || typeof page !== 'string') {
      const kind = page && page.kind ? page.kind : 'blocked';
      if (kind === 'gone') { o.outcome = 'broken:missing'; o.reason = `page is gone (${(page && page.error) || 'HTTP 404'})`; }
      else { o.outcome = 'blocked'; o.reason = (page && page.error) || 'page not read'; }
      continue;
    }
    const cap = captureRule(rule, page, ctx);
    if (cap.status !== 'ok') { o.outcome = cap.status === 'ambiguous' ? 'broken:ambiguous' : 'broken:missing'; o.reason = cap.reason; continue; }
    const now = comparable(rule, cap.raw, ctx);
    o.captured = cleanRaw(cap.raw);
    if (rule.write === 'field') evaluateField(rule, o, now, cap, page, { ctx, work, created, today, declined, onlyWrite, skipWrite });
    else evaluateFlag(rule, o, now, ctx);
  }
  // report in file order
  const pos = new Map(rules.map((r, i) => [r.id, i]));
  outcomes.sort((a, b) => pos.get(a.rule) - pos.get(b.rule));
  return { outcomes, data: work };
}

function claimText(ctx, id, which = 'quote') {
  const c = latestClaim(ctx.data.guidance, id);
  return c ? { claim: c, text: c[which] || '' } : null;
}

function evaluateFlag(rule, o, now, ctx) {
  let same;
  let held;
  if (rule.maps_to) {
    held = getPath(ctx.data, rule.maps_to);
    same = rule.value === 'model' ? now.id != null && now.id === held : sameKey(now.key, rule.value === 'text' ? norm(held) : held);
    if (rule.value === 'model' && now.id == null) o.note = `"${now.raw}" is not in the catalog`;
  } else if (rule.baseline && rule.baseline.claim) {
    const ct = claimText(ctx, rule.baseline.claim, rule.baseline.in || 'quote');
    held = ct ? `claim ${ct.claim.id} ${rule.baseline.in || 'quote'}` : `missing claim ${rule.baseline.claim}`;
    same = !!ct && containsToken(ct.text, now.raw);
  } else if (rule.baseline && rule.baseline.sentinel != null) {
    held = rule.baseline.sentinel;
    same = norm(now.raw) === norm(rule.baseline.sentinel);
  }
  o.held = typeof held === 'string' ? held : JSON.stringify(held);
  if (same) { o.outcome = 'ok'; return; }
  o.outcome = 'needs-review';
  o.reason = `page says "${now.raw}"; data holds ${o.held}`;
  if (rule.judge) o.judge = rule.judge;
}

function evaluateField(rule, o, now, cap, page, env) {
  const { ctx, work, created, today, declined, onlyWrite, skipWrite } = env;
  const claimOnly = !rule.maps_to;
  let held;
  let same;
  if (claimOnly) {
    const texts = (rule.claim_ids || []).map((id) => claimText(ctx, id));
    held = texts.map((t) => (t ? t.claim.id : 'missing')).join(', ');
    same = texts.length > 0 && texts.every((t) => t && containsToken(t.text, now.raw));
  } else {
    held = getPath(work, rule.maps_to);
    if (held === undefined) { o.outcome = 'broken:missing'; o.reason = `maps_to ${rule.maps_to} does not resolve in the data`; return; }
    same = rule.value === 'model' ? now.id === held : sameKey(now.key, held);
  }
  o.old = held;
  o.new = rule.value === 'model' ? (now.id || now.raw) : now.key;
  if (same) { o.outcome = 'ok'; return; }
  if (rule.value === 'model') {
    if (!now.id) { o.outcome = 'waiting:catalog'; o.reason = `"${now.raw}" is not a catalog model yet`; o.pending = pendingKeys(rule, ctx); return; }
    const st = (ctx.byId.get(now.id) || {}).status;
    if (st !== 'ga') { o.outcome = 'waiting:not-ga'; o.reason = `${now.id} is ${st || 'not ga'} in the catalog`; o.pending = pendingKeys(rule, ctx); return; }
  }
  if (rule.value === 'price' && now.key == null) { o.outcome = 'broken:missing'; o.reason = `"${now.raw}" is not a price`; return; }
  const dKey = `${rule.id}\t${valueKey(o.new)}`;
  if (declined.has(dKey)) { o.outcome = 'declined'; o.reason = `a closed, unmerged bot PR declined ${valueKey(o.new)}`; o.pending = pendingKeys(rule, ctx); return; }
  if (skipWrite.has(rule.id)) { o.outcome = 'gate-failed'; o.pending = pendingKeys(rule, ctx); return; }
  if (onlyWrite && !onlyWrite.has(rule.id)) { o.outcome = 'change'; o.unwritten = true; return; }
  // write on a scratch copy; keep it only if every piece could be written honestly
  const trial = clone(work);
  const tctx = { ...ctx, data: trial };
  const res = applyChange(rule, now, held, cap, page, { ctx: tctx, created: new Set(created), today });
  if (res.error) { o.outcome = 'needs-review'; o.reason = `page says "${now.raw}" but the change cannot be written: ${res.error}`; o.pending = pendingKeys(rule, ctx); return; }
  work.guidance = trial.guidance;
  work.plans = trial.plans;
  for (const id of res.created) created.add(id);
  o.outcome = 'change';
  o.writes = res.writes;
  o.claims = res.claims;
  o.rows = res.rows;
  o.pending = res.pending;
}

/** check-sources keys a pending change would replace (so the main sweep can skip them). */
function pendingKeys(rule, ctx) {
  const keys = [];
  for (const id of rule.claim_ids || []) { const c = latestClaim(ctx.data.guidance, id); if (c) keys.push(c.id); }
  if (rule.maps_to && rule.maps_to.startsWith('plans.')) { const row = planRow(ctx.data, rule.maps_to); if (row) keys.push(`plan/${row.vendor}/${row.plan}`); }
  return keys;
}

function applyChange(rule, now, held, cap, page, { ctx, created, today }) {
  const g = ctx.data.guidance;
  const writes = [];
  const claims = [];
  const rows = [];
  const pending = [];
  const newCreated = [];
  let pairs = [];
  let segPairs = [];
  if (rule.value === 'model') {
    const oldF = modelForms(held, ctx, rule.tool);
    const newF = modelForms(now.id, ctx, rule.tool);
    // the string the page uses first, then the catalog forms; one new form per old form
    pairs = [...(oldF.ref ? [[oldF.ref, cleanRaw(now.raw)]] : []), [oldF.id, newF.id], [oldF.name, newF.name], [oldF.short, newF.short], [oldF.slug, newF.slug]];
    segPairs = modelSegPairs(oldF, newF);
  } else if (rule.value === 'word' || rule.value === 'last-word') {
    pairs = [[String(held), String(now.key)]];
    segPairs = [[slugify(held), slugify(now.key)]];
  } else if (rule.value === 'price') {
    pairs = [[`$${held}`, `$${now.key}`]];
  }
  const newValue = rule.value === 'model' ? now.id : now.key;
  // 1. data paths
  if (rule.maps_to) {
    for (const p of [rule.maps_to, ...(rule.also || [])]) {
      const before = getPath(ctx.data, p);
      if (before === undefined) return { error: `${p} does not resolve` };
      setPath(ctx.data, p, clone(newValue));
      writes.push({ path: p, old: before, new: newValue });
    }
  }
  // 2. a model_refs row for the string the page uses
  if (rule.ref_row && rule.value === 'model') {
    const ref = cleanRaw(now.raw);
    const existing = (g.model_refs || []).find((r) => r && r.tool === rule.tool && r.ref === ref);
    if (existing && existing.model_id !== now.id) return { error: `model_refs ${rule.tool}/${ref} already names ${existing.model_id}` };
    if (!existing) {
      const row = { tool: rule.tool, ref, model_id: now.id, basis: [] };
      const lastIdx = g.model_refs.map((r) => r.tool).lastIndexOf(rule.tool);
      g.model_refs.splice(lastIdx + 1, 0, row);
      writes.push({ path: `guidance.model_refs[tool=${rule.tool}][ref=${ref}]`, old: null, new: now.id });
      ctx.newRefRow = row;
    }
  }
  // 3. claims
  const taken = new Set((g.claims || []).map((c) => c.id));
  for (const cid of rule.claim_ids || []) {
    const old = latestClaim(g, cid);
    if (!old) return { error: `claim ${cid} is not in guidance.json` };
    if (urlKey(old.source_url) !== urlKey(rule.url)) return { error: `claim ${old.id} cites ${old.source_url}, not this rule's page` };
    const quote = rewriteQuote(old.quote, pairs, page, cap);
    if (!quote) return { error: `no quote of ≤${MAX_QUOTE_WORDS} words for claim ${old.id} is on the page` };
    const sent = fillPlaceholders(rule.sentence || '', ctx, 'text', rule.value === 'list' ? now.key : cleanRaw(now.raw));
    if (sent.error || !rule.sentence) return { error: `sentence for ${old.id}: ${sent.error || 'the rule has no sentence template'}` };
    if (created.has(old.id)) {
      Object.assign(old, { quote, sentence: sent.text, date: today, source_url: rule.url });
      claims.push({ old: old.id, new: old.id, quote });
      continue;
    }
    const id = nextClaimId(old.id, segPairs, taken, today);
    taken.add(id);
    const fresh = { ...clone(old), id, sentence: sent.text, source_url: rule.url, date: today, quote };
    delete fresh.superseded_by;
    old.superseded_by = id;
    g.claims.splice(g.claims.indexOf(old) + 1, 0, fresh);
    swapBasis(g, old.id, id);
    created.add(id);
    newCreated.push(id);
    pending.push(old.id);
    claims.push({ old: old.id, new: id, quote });
  }
  if (ctx.newRefRow) ctx.newRefRow.basis = claims.length ? claims.map((c) => c.new) : [...new Set((rule.claim_ids || []).map((id) => (latestClaim(g, id) || {}).id).filter(Boolean))];
  // 4. a plan row: rewrite in place
  if (rule.maps_to && rule.maps_to.startsWith('plans.')) {
    const row = planRow(ctx.data, rule.maps_to);
    if (!row) return { error: `${rule.maps_to}: no single plans row` };
    const quote = rewriteQuote(row.quote, pairs, page, cap);
    if (!quote) return { error: `no quote of ≤${MAX_QUOTE_WORDS} words for ${row.vendor} / ${row.plan} is on the page` };
    const oldKey = `plan/${row.vendor}/${row.plan}`;
    row.quote = quote;
    if (urlKey(rule.url) === urlKey(row.source_url)) delete row.quote_url;
    else row.quote_url = rule.url;
    row.as_of = today;
    rows.push({ row: `${row.vendor} / ${row.plan}`, quote });
    pending.push(oldKey);
  }
  return { writes, claims, rows, pending, created: newCreated };
}

/* ------------------------------------------------------------------ gates ------------------ */

const diffProblems = (after, before) => { const b = new Set(before); return after.filter((p) => !b.has(p)); };

/** In-process gate (fixtures, drills): the guidance honesty checks, the plans-group invariants and
 * the plan-row quote rules. */
export function inProcessGate(models) {
  return (state) => {
    const out = [...validateGuidance(state.guidance, models).errors];
    out.push(...runChecks({ models: { models: Array.isArray(models) ? models : models.models }, guidance: state.guidance, samples: null }, { group: 'plans' }));
    for (const p of state.plans.plans || []) {
      if (p.quote != null && wordCount(p.quote) > MAX_QUOTE_WORDS) out.push(`plan ${p.vendor} / ${p.plan}: quote over ${MAX_QUOTE_WORDS} words`);
      if (p.price_usd_month !== null && !(typeof p.price_usd_month === 'number' && p.price_usd_month >= 0)) out.push(`plan ${p.vendor} / ${p.plan}: bad price`);
    }
    return out;
  };
}

/** The real gates on a temp copy of data/: validate-data --data + check-live-data --group plans
 * --data. Returns the problem lines. */
export function subprocessGate(dataDir = join(ROOT, 'data')) {
  return (state) => {
    const dir = mkdtempSync(join(tmpdir(), 'defaults-watch-gate-'));
    try {
      cpSync(dataDir, dir, { recursive: true });
      writeFileSync(join(dir, 'guidance.json'), JSON.stringify(state.guidance, null, 2) + '\n');
      writeFileSync(join(dir, 'plans.json'), JSON.stringify(state.plans, null, 2) + '\n');
      const out = [];
      const v = spawnSync(process.execPath, [join(ROOT, 'scripts/validate-data.mjs'), '--data', dir], { encoding: 'utf8' });
      if (v.status !== 0) {
        const lines = (v.stderr || '').split('\n').filter((l) => /^\s+- /.test(l)).map((l) => `validate-data: ${l.replace(/^\s+- /, '')}`);
        out.push(...(lines.length ? lines : [`validate-data exited ${v.status}`]));
      }
      const c = spawnSync(process.execPath, [join(ROOT, 'scripts/check-live-data.mjs'), '--group', 'plans', '--data', dir], { encoding: 'utf8' });
      if (c.status !== 0) out.push(...(c.stderr || '').split('\n').filter(Boolean).map((l) => `check-live-data: ${l}`));
      return out;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

/** Evaluate, gate every change alone and then together, and re-evaluate without the failures. */
export function evaluateGated(input, gate) {
  const base = gate(input.data);
  const first = evaluate(input);
  const failed = new Map();
  for (const o of first.outcomes.filter((x) => x.outcome === 'change')) {
    const alone = evaluate({ ...input, onlyWrite: new Set([o.rule]) });
    const probs = diffProblems(gate(alone.data), base);
    if (probs.length) failed.set(o.rule, probs);
  }
  let final = failed.size ? evaluate({ ...input, skipWrite: new Set(failed.keys()) }) : first;
  if (final.outcomes.some((x) => x.outcome === 'change')) {
    const probs = diffProblems(gate(final.data), base);
    if (probs.length) {
      for (const o of final.outcomes.filter((x) => x.outcome === 'change')) failed.set(o.rule, [`together with the other changes: ${probs.join('; ')}`]);
      final = evaluate({ ...input, skipWrite: new Set(failed.keys()) });
    }
  }
  for (const o of final.outcomes) if (o.outcome === 'gate-failed') o.reason = (failed.get(o.rule) || []).join('; ');
  return { ...final, baseProblems: base };
}

/* ------------------------------------------------------------------ PR text ---------------- */

const show = (v) => (Array.isArray(v) ? v.join(', ') : v === null ? 'null' : String(v));

/** Fingerprint of a change set: rule ids and new values. */
export function fingerprint(outcomes) {
  const ch = outcomes.filter((o) => o.outcome === 'change').map((o) => `${o.rule}=${valueKey(o.new)}`).sort();
  return createHash('sha1').update(ch.join('\n')).digest('hex').slice(0, 16);
}

export function prTitle(outcomes) {
  const ch = outcomes.filter((o) => o.outcome === 'change');
  return `Defaults watch: ${ch.length} data change${ch.length === 1 ? '' : 's'} from vendor pages`;
}

/** The PR body. Deterministic: same outcomes -> same text. */
export function prBody(outcomes, { today }) {
  const ch = outcomes.filter((o) => o.outcome === 'change');
  const L = [];
  L.push(`The weekly defaults watch (\`scripts/defaults-watch.mjs\`, no model calls) read the vendor pages on ${today}: ${ch.length} value${ch.length === 1 ? ' differs' : 's differ'} from \`data/\`.`);
  L.push('Each change below passed `validate-data` and `check-live-data --group plans` on main plus that change alone, and all of them together. Every new quote was confirmed on its page.', '');
  L.push('| rule | data | old → new | page |', '|---|---|---|---|');
  for (const o of ch) {
    const paths = (o.writes || []).map((w) => `\`${w.path}\``).join('<br>') || (o.claims || []).map((c) => `claim \`${c.old}\``).join('<br>');
    L.push(`| \`${o.rule}\` | ${paths} | ${show(o.old)} → **${show(o.new)}** | ${o.url} |`);
  }
  const claims = ch.flatMap((o) => (o.claims || []).map((c) => ({ ...c, rule: o.rule })));
  if (claims.length) {
    L.push('', '### Claims', '');
    for (const c of claims) L.push(c.old === c.new ? `- \`${c.new}\` updated (${c.rule}): "${c.quote}"` : `- \`${c.new}\` replaces \`${c.old}\` (${c.rule}; the old claim keeps its quote and gets \`superseded_by\`): "${c.quote}"`);
  }
  const rows = ch.flatMap((o) => (o.rows || []).map((r) => ({ ...r, rule: o.rule })));
  if (rows.length) {
    L.push('', '### Plan rows rewritten in place', '');
    for (const r of rows) L.push(`- ${r.row} (${r.rule}): "${r.quote}"`);
  }
  const files = changedFiles(outcomes);
  L.push('', '### Files', '', ...files.map((f) => `- \`${f}\``));
  const other = outcomes.filter((o) => ['waiting:catalog', 'waiting:not-ga', 'needs-review', 'gate-failed', 'declined'].includes(o.outcome));
  if (other.length) {
    L.push('', '### Seen but not written', '');
    for (const o of other) L.push(`- \`${o.rule}\` — ${o.outcome}: ${o.reason || ''}`);
  }
  L.push('', 'Closing this pull request without merging declines these values: the watch skips them until the page says something else.', '');
  L.push(`<!-- ${MARK}:fingerprint=${fingerprint(outcomes)} -->`);
  for (const o of ch) L.push(`<!-- ${MARK}:declined rule=${o.rule} value=${encodeURIComponent(valueKey(o.new))} -->`);
  return L.join('\n');
}

export function changedFiles(outcomes) {
  const ch = outcomes.filter((o) => o.outcome === 'change');
  const files = new Set();
  for (const o of ch) {
    if ((o.claims || []).length || (o.writes || []).some((w) => w.path.startsWith('guidance.'))) files.add('data/guidance.json');
    if ((o.rows || []).length || (o.writes || []).some((w) => w.path.startsWith('plans.'))) files.add('data/plans.json');
  }
  return [...files].sort();
}

/** {rule\tvalue} keys from closed, unmerged bot PRs the job did not close itself. */
export function declinedFrom(closedPrs) {
  const out = new Set();
  for (const pr of closedPrs || []) {
    if (pr.merged_at || !pr.body || pr.body.includes(`<!-- ${MARK}:closed-by-bot -->`)) continue;
    for (const m of pr.body.matchAll(new RegExp(`<!-- ${MARK}:declined rule=(\\S+) value=(\\S*) -->`, 'g'))) out.add(`${m[1]}\t${decodeURIComponent(m[2])}`);
  }
  return out;
}

const fpOf = (body) => ((String(body || '').match(new RegExp(`<!-- ${MARK}:fingerprint=([0-9a-f]+) -->`)) || [])[1] || null);

/* ------------------------------------------------------------------ files + guards ---------- */

export const json = (o) => JSON.stringify(o, null, 2) + '\n';

/** Throws unless every path is on the allowed list. */
export function assertAllowedPaths(paths, allowed) {
  const bad = paths.filter((p) => !allowed.includes(p));
  if (bad.length) throw new Error(`refusing to push ${bad.join(', ')}: only ${allowed.join(', ')} may be written here`);
}

/** Throws unless the only line that differs between two guidance.json texts is the top-level as_of. */
export function assertAsOfOnly(before, after) {
  const a = String(before).split('\n');
  const b = String(after).split('\n');
  if (a.length !== b.length) throw new Error('guidance.json re-stamp changed more than the as_of line');
  const diff = a.map((l, i) => (l === b[i] ? null : i)).filter((i) => i !== null);
  if (diff.length > 1 || (diff.length === 1 && !/^ {2}"as_of": "\d{4}-\d{2}-\d{2}",?$/.test(b[diff[0]]))) {
    throw new Error('guidance.json re-stamp changed more than the as_of line');
  }
}

/** guidance.json text with the top-level as_of set to `today` (that line only). */
export function restampText(text, today) {
  return String(text).replace(/^( {2}"as_of": ")\d{4}-\d{2}-\d{2}(",?)$/m, `$1${today}$2`);
}

/* ------------------------------------------------------------------ remotes ---------------- */

/** In-memory GitHub + git, for drills and tests. `state` is mutated; `actions` records writes. */
export function memoryRemote(state = {}) {
  state.pulls = state.pulls || [];
  state.issues = state.issues || [];
  state.main = state.main || {};
  state.branch = state.branch || null;
  state.statuses = state.statuses || [];
  const actions = [];
  let n = 1 + state.pulls.length;
  return {
    actions, state,
    async openPr() { return state.pulls.find((p) => p.state === 'open') || null; },
    async closedPrs() { return state.pulls.filter((p) => p.state === 'closed'); },
    async branchHead() { return state.branch ? { sha: state.branch.sha, author: state.branch.author || BOT_NAME } : null; },
    async pushBranch({ files, message }) {
      const sha = createHash('sha1').update(JSON.stringify(files) + message).digest('hex');
      state.branch = { sha, files, author: BOT_NAME };
      actions.push({ kind: 'push-branch', branch: BOT_BRANCH, files: Object.keys(files), message });
      return sha;
    },
    async createPr({ title, body }) { const pr = { number: n++, state: 'open', title, body, merged_at: null }; state.pulls.push(pr); actions.push({ kind: 'create-pr', number: pr.number, title, body }); return pr.number; },
    async editPr(num, { title, body }) { const pr = state.pulls.find((p) => p.number === num); Object.assign(pr, { title, body }); actions.push({ kind: 'edit-pr', number: num, title, body }); },
    async closePr(num, { body }) { const pr = state.pulls.find((p) => p.number === num); Object.assign(pr, { state: 'closed', body }); actions.push({ kind: 'close-pr', number: num }); },
    async deleteBranch() { state.branch = null; actions.push({ kind: 'delete-branch', branch: BOT_BRANCH }); },
    async postStatus(sha, s) { state.statuses.push({ sha, ...s }); actions.push({ kind: 'status', sha, ...s }); },
    async pushMain({ files, message }) {
      const changed = Object.keys(files).filter((p) => state.main[p] !== files[p]);
      if (!changed.length) return null;
      for (const p of changed) state.main[p] = files[p];
      actions.push({ kind: 'push-main', files: changed, message });
      return 'main';
    },
    async mainFile(p) { return state.main[p]; },
    async upsertIssue({ title, body }) {
      const open = state.issues.find((i) => i.title === title && i.state === 'open');
      if (open && open.body === body) return { action: 'unchanged', number: open.number };
      if (open) { open.body = body; actions.push({ kind: 'update-issue', title }); return { action: 'updated', number: open.number }; }
      const issue = { number: 900 + state.issues.length, title, body, state: 'open' };
      state.issues.push(issue);
      actions.push({ kind: 'open-issue', title, body });
      return { action: 'created', number: issue.number };
    },
    async closeIssue({ title }) {
      const open = state.issues.find((i) => i.title === title && i.state === 'open');
      if (!open) return { action: 'absent' };
      open.state = 'closed';
      actions.push({ kind: 'close-issue', title });
      return { action: 'closed', number: open.number };
    },
  };
}

/** Reads from GitHub when a token is there (allowed in dry runs); every write is printed, never sent. */
export function dryRemote({ env = process.env, log = console.log } = {}) {
  const live = liveReads(env);
  const actions = [];
  const say = (a, line) => { actions.push(a); log(`[dry run] would ${line}`); };
  return {
    actions,
    openPr: live.openPr, closedPrs: live.closedPrs, branchHead: async () => null,
    async pushBranch({ files, message }) { say({ kind: 'push-branch', files: Object.keys(files), message }, `force-push ${BOT_BRANCH} (from main) with ${Object.keys(files).join(', ')}: "${message}"`); return '0'.repeat(40); },
    async createPr({ title, body }) { say({ kind: 'create-pr', title, body }, `open a pull request\n  branch: ${BOT_BRANCH} -> main\n  title:  ${title}\n  body:\n${body.split('\n').map((l) => `    ${l}`).join('\n')}`); return 0; },
    async editPr(num, { title, body }) { say({ kind: 'edit-pr', number: num, title, body }, `update pull request #${num}: ${title}`); },
    async closePr(num) { say({ kind: 'close-pr', number: num }, `close pull request #${num} (no change left)`); },
    async deleteBranch() { say({ kind: 'delete-branch' }, `delete branch ${BOT_BRANCH}`); },
    async postStatus(sha, s) { say({ kind: 'status', ...s }, `post commit status ${STATUS_CONTEXT}=${s.state} (${s.description})`); },
    async pushMain({ files, message }) { say({ kind: 'push-main', files: Object.keys(files), message }, `push to main: ${Object.keys(files).join(', ')} ("${message}")`); return null; },
    async mainFile(p) { return readFileSync(join(ROOT, p), 'utf8'); },
    async upsertIssue({ title, body }) { say({ kind: 'upsert-issue', title }, `open/update issue "${title}":\n${body.split('\n').map((l) => `    ${l}`).join('\n')}`); return { action: 'skipped' }; },
    async closeIssue({ title }) { say({ kind: 'close-issue', title }, `close issue "${title}" if open`); return { action: 'skipped' }; },
  };
}

function liveReads(env) {
  const opts = { env, log: () => {} };
  const owner = String(env.GITHUB_REPOSITORY || '').split('/')[0];
  const head = encodeURIComponent(`${owner}:${BOT_BRANCH}`);
  return {
    async openPr() {
      const l = await ghRead(`/pulls?state=open&head=${head}&per_page=10`, opts);
      return Array.isArray(l) && l.length ? l[0] : null;
    },
    async closedPrs() {
      const l = await ghRead(`/pulls?state=closed&head=${head}&per_page=100`, opts);
      return Array.isArray(l) ? l : [];
    },
  };
}

function git(args, { input = null, env = {} } = {}) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', input, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

/** A commit of `files` on top of `parent`, built with git plumbing (the working tree is never touched). */
function commitFiles(parent, files, message) {
  const index = join(mkdtempSync(join(tmpdir(), 'defaults-watch-index-')), 'index');
  const env = { GIT_INDEX_FILE: index, GIT_AUTHOR_NAME: BOT_NAME, GIT_AUTHOR_EMAIL: BOT_EMAIL, GIT_COMMITTER_NAME: BOT_NAME, GIT_COMMITTER_EMAIL: BOT_EMAIL };
  git(['read-tree', parent], { env });
  for (const [p, content] of Object.entries(files)) {
    const blob = git(['hash-object', '-w', '--stdin'], { input: content });
    git(['update-index', '--add', '--cacheinfo', `100644,${blob},${p}`], { env });
  }
  const tree = git(['write-tree'], { env });
  if (tree === git(['rev-parse', `${parent}^{tree}`])) return null;
  return git(['commit-tree', tree, '-p', parent, '-m', message], { env });
}

/** The real thing: git pushes (guarded here) + GitHub writes through gh-issue.mjs's ghWrite. */
export function liveRemote({ env = process.env, log = console.log } = {}) {
  const opts = { env, log };
  const reads = liveReads(env);
  const guard = () => { const why = writeBlockReason(env); if (why) throw new Error(`remote write refused: ${why}`); };
  return {
    actions: [],
    ...reads,
    async branchHead() {
      try { git(['fetch', '--quiet', 'origin', `+refs/heads/${BOT_BRANCH}:refs/remotes/origin/${BOT_BRANCH}`]); } catch { return null; }
      return { sha: git(['rev-parse', `refs/remotes/origin/${BOT_BRANCH}`]), author: git(['log', '-1', '--format=%an', `refs/remotes/origin/${BOT_BRANCH}`]) };
    },
    async pushBranch({ files, message }) {
      guard();
      assertAllowedPaths(Object.keys(files), BRANCH_PATHS);
      git(['fetch', '--quiet', 'origin', 'main']);
      const sha = commitFiles('FETCH_HEAD', files, message);
      if (!sha) throw new Error('bot branch commit would be empty');
      let lease = '';
      try { lease = git(['rev-parse', `refs/remotes/origin/${BOT_BRANCH}`]); } catch { lease = ''; }
      git(['push', `--force-with-lease=refs/heads/${BOT_BRANCH}:${lease}`, 'origin', `${sha}:refs/heads/${BOT_BRANCH}`]);
      log(`pushed ${BOT_BRANCH} ${sha.slice(0, 7)}`);
      return sha;
    },
    async createPr({ title, body }) {
      const pr = await ghWrite({ method: 'POST', path: '/pulls', body: { title, body, head: BOT_BRANCH, base: 'main' } }, opts);
      if (!pr) return null;
      try { await ghWrite({ method: 'POST', path: '/labels', body: { name: LABEL, color: 'c5def5', description: 'Weekly defaults watch' } }, opts); } catch (e) { if (e.status !== 422) throw e; }
      await ghWrite({ method: 'POST', path: `/issues/${pr.number}/labels`, body: { labels: [LABEL] } }, opts);
      log(`opened pull request #${pr.number}`);
      return pr.number;
    },
    async editPr(num, { title, body }) { await ghWrite({ method: 'PATCH', path: `/pulls/${num}`, body: { title, body } }, opts); log(`updated pull request #${num}`); },
    async closePr(num, { body }) { await ghWrite({ method: 'PATCH', path: `/pulls/${num}`, body: { state: 'closed', body } }, opts); log(`closed pull request #${num}`); },
    async deleteBranch() { try { await ghWrite({ method: 'DELETE', path: `/git/refs/heads/${BOT_BRANCH}` }, opts); } catch (e) { if (e.status !== 422 && e.status !== 404) throw e; } },
    async postStatus(sha, s) { await ghWrite({ method: 'POST', path: `/statuses/${sha}`, body: { state: s.state, context: STATUS_CONTEXT, description: s.description.slice(0, 140) } }, opts); },
    async pushMain({ files, message }) {
      guard();
      assertAllowedPaths(Object.keys(files), MAIN_PATHS);
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        git(['fetch', '--quiet', 'origin', 'main']);
        const parent = git(['rev-parse', 'FETCH_HEAD']);
        const out = {};
        for (const [p, content] of Object.entries(files)) {
          if (p === 'data/guidance.json') {
            // re-apply the one-line stamp to main as it is now
            const cur = git(['show', `${parent}:${p}`]) + '\n';
            const stamped = restampText(cur, JSON.parse(content).as_of);
            assertAsOfOnly(cur, stamped);
            out[p] = stamped;
          } else out[p] = content;
        }
        const sha = commitFiles(parent, out, message);
        if (!sha) { log('main already has these files — nothing to push'); return null; }
        try { git(['push', 'origin', `${sha}:refs/heads/main`]); log(`pushed main ${sha.slice(0, 7)}`); return sha; } catch (e) { log(`main push attempt ${attempt} rejected: ${e.message.split('\n')[0]}`); }
      }
      throw new Error('main push rejected 3 times');
    },
    async mainFile(p) { return readFileSync(join(ROOT, p), 'utf8'); },
    async upsertIssue({ title, body }) { return upsertIssue({ title, body, labels: [LABEL] }, opts); },
    async closeIssue({ title }) { return closeIssue({ title, comment: 'The defaults watch ran green: every rule matched, nothing is waiting.' }, opts); },
  };
}

/* ------------------------------------------------------------------ the run ---------------- */

/** Fetch every rule page once (fresh: never a cached copy). {url: text | {error, kind}}. */
export async function fetchPages(urls, { fetchImpl = (u) => fetchNormalizedPage(u, { fresh: true }), limit = 6 } = {}) {
  const out = {};
  const queue = [...new Set(urls)];
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const u = queue.shift();
      try { out[u] = await fetchImpl(u); } catch (e) { out[u] = { error: e.message, kind: classifyFailure(e) }; }
    }
  }));
  return out;
}

const ISSUE_KINDS = ['broken:missing', 'broken:ambiguous', 'gate-failed', 'needs-review', 'waiting:catalog', 'waiting:not-ga', 'blocked'];

/** The issue body, or null when nothing needs attention. */
export function issueBody({ outcomes, blockedRuns = {}, sweep = null, plansProblems = [], today }) {
  const pick = (k) => outcomes.filter((o) => o.outcome === k);
  const L = [];
  const section = (title, list, fmt) => { if (list.length) { L.push(`### ${title}`, '', ...list.map(fmt), ''); } };
  section('Rule broken (red): the anchor or pattern is gone, the page is gone, or the pattern is ambiguous', [...pick('broken:missing'), ...pick('broken:ambiguous')],
    (o) => `- \`${o.rule}\` — ${o.outcome}: ${o.reason} (${o.url}). Fix the rule in data/defaults-watch.json or re-source the fact; never guess.`);
  section('Change failed its gate (red): not written', pick('gate-failed'), (o) => `- \`${o.rule}\`: ${show(o.old)} → ${show(o.new)} — ${o.reason}`);
  section('Needs review: the page changed and there is nothing safe to write', pick('needs-review'),
    (o) => `- \`${o.rule}\` (${o.url}): ${o.reason}${o.judge ? `\n  - Question: ${o.judge}` : ''}`);
  section('Waiting: the page names a model the catalog cannot take yet', [...pick('waiting:catalog'), ...pick('waiting:not-ga')], (o) => `- \`${o.rule}\` — ${o.outcome}: ${o.reason}`);
  const blocked = [...new Set(pick('blocked').map((o) => o.url))];
  section('Could not read the page (warning; red after 3 runs in a row)', blocked, (u) => `- ${u} — ${blockedRuns[u] || 1} run(s) in a row`);
  if (sweep && sweep.failed.length) section('Source sweep: quotes gone from their pages (red)', sweep.failed, (r) => `- \`${r.key}\` ${r.source_url} — ${r.kind}`);
  section('Plan lines (check-live-data --group plans) on main (red)', plansProblems, (p) => `- ${p}`);
  if (!L.length) return null;
  return [`The weekly defaults watch (${today}) found rules that need a person or the Judge. Nothing below was written to data/.`, '', ...L].join('\n').trim();
}

function summarize(outcomes) {
  const counts = {};
  for (const o of outcomes) counts[o.outcome] = (counts[o.outcome] || 0) + 1;
  return counts;
}

/** One full run. All I/O is injected so tests and drills use frozen pages and an in-memory remote. */
export async function runJob({
  watch, data, models, aliases, pages, today, nowIso = new Date().toISOString(), remote, gate,
  receipt = null, sweepFn = null, plansGateFn = null, log = console.log, dryRun = false,
}) {
  const closed = await remote.closedPrs();
  const declined = declinedFrom(closed);
  const res = evaluateGated({ watch, data, models, aliases, pages, today, declined }, gate);
  const { outcomes } = res;
  for (const o of outcomes) log(`  ${o.outcome.padEnd(17)} ${o.rule}${o.captured !== undefined ? ` = "${o.captured}"` : ''}${o.reason ? ` — ${o.reason}` : ''}`);

  // blocked pages: count runs in a row per url
  const prevBlocked = (receipt && receipt.blocked_runs) || {};
  const blockedRuns = {};
  for (const u of new Set(outcomes.filter((o) => o.outcome === 'blocked').map((o) => o.url))) blockedRuns[u] = (prevBlocked[u] || 0) + 1;
  const blockedRed = Object.entries(blockedRuns).filter(([, n]) => n >= BLOCKED_RED_RUNS).map(([u]) => u);

  // the pull request
  const changes = outcomes.filter((o) => o.outcome === 'change');
  const open = await remote.openPr();
  const red = [];
  let prNumber = open ? open.number : null;
  let prAction = 'none';
  if (changes.length) {
    const body = prBody(outcomes, { today });
    const title = prTitle(outcomes);
    if (open && fpOf(open.body) === fingerprint(outcomes)) {
      prAction = 'unchanged';
      log(`pull request #${open.number} already carries these ${changes.length} change(s) — nothing new`);
    } else {
      const head = await remote.branchHead();
      if (head && head.author !== BOT_NAME) {
        red.push(`${BOT_BRANCH} has a commit by ${head.author}; not force-pushing over it`);
      } else {
        const files = {};
        for (const f of changedFiles(outcomes)) files[f] = json(f === 'data/guidance.json' ? res.data.guidance : res.data.plans);
        assertAllowedPaths(Object.keys(files), BRANCH_PATHS);
        const sha = await remote.pushBranch({ files, message: `defaults watch ${today}: ${changes.length} data change${changes.length === 1 ? '' : 's'}` });
        if (open) { await remote.editPr(open.number, { title, body }); prAction = 'updated'; } else { prNumber = await remote.createPr({ title, body }); prAction = 'created'; }
        if (sha) await remote.postStatus(sha, { state: 'success', description: `validate-data + check-live-data --group plans passed for ${changes.length} change(s)` });
      }
    }
  } else if (open) {
    await remote.closePr(open.number, { body: `${open.body || ''}\n\n<!-- ${MARK}:closed-by-bot -->\nClosed by the defaults watch: the pages no longer differ from data/.` });
    await remote.deleteBranch();
    prAction = 'closed';
    prNumber = null;
  }
  const prOpen = changes.length > 0 && !red.length;

  // the source sweep (skipping quotes a pending change replaces) + the plans gate on main
  const pending = [...new Set(outcomes.flatMap((o) => o.pending || []))].sort();
  const sweep = sweepFn ? await sweepFn(pending) : null;
  const plansProblems = plansGateFn ? await plansGateFn() : [];

  // red?
  for (const o of outcomes) if (o.outcome.startsWith('broken:') || o.outcome === 'gate-failed') red.push(`${o.rule}: ${o.outcome}`);
  for (const u of blockedRed) red.push(`${u}: blocked ${blockedRuns[u]} runs in a row`);
  if (sweep && sweep.failed.length) red.push(`source sweep: ${sweep.failed.length} quote(s) gone`);
  if (sweep && sweep.error) red.push(`source sweep: ${sweep.error}`);
  for (const p of plansProblems) red.push(`plans gate: ${p}`);

  // re-stamp + receipt -> main
  const allOk = outcomes.every((o) => o.outcome === 'ok');
  const clean = allOk && !prOpen && !red.length && (!sweep || !sweep.failed.length) && !plansProblems.length;
  const files = {};
  const newReceipt = {
    job: 'defaults-watch', ran_at: nowIso, ok: !red.length, rules: outcomes.length, outcomes: summarize(outcomes),
    changes: changes.map((o) => ({ rule: o.rule, old: o.old, new: o.new })), pr: prOpen ? prNumber : null,
    restamped: clean, blocked_runs: blockedRuns,
  };
  files[RECEIPT_PATH] = json(newReceipt);
  if (clean) {
    const cur = await remote.mainFile('data/guidance.json');
    const stamped = cur == null ? cur : restampText(cur, today);
    if (stamped !== cur) { assertAsOfOnly(cur, stamped); files['data/guidance.json'] = stamped; }
  }
  assertAllowedPaths(Object.keys(files), MAIN_PATHS);
  await remote.pushMain({ files, message: `defaults watch ${today}${clean ? ' (re-stamp)' : ''}` });

  // the issue
  const body = issueBody({ outcomes, blockedRuns, sweep, plansProblems, today });
  if (body) await remote.upsertIssue({ title: ISSUE_TITLE, body });
  else await remote.closeIssue({ title: ISSUE_TITLE });

  log(`\ndefaults watch: ${Object.entries(summarize(outcomes)).map(([k, v]) => `${k} ${v}`).join(', ')}; pull request: ${prAction}${prNumber ? ` #${prNumber}` : ''}; ${clean ? 're-stamped guidance as_of' : 'no re-stamp'}${dryRun ? ' (dry run)' : ''}`);
  if (red.length) log(`RED:\n${red.map((r) => `  - ${r}`).join('\n')}`);
  return { outcomes, red, clean, prAction, prNumber, receipt: newReceipt, data: res.data, issue: body };
}

/* ------------------------------------------------------------------ CLI -------------------- */

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
export const FIXTURE_DIR = join(ROOT, 'scripts/fixtures/watch');

/** The frozen fixture set: data copies, page excerpts, and the drill's one swap. */
export function loadFixtures(dir = FIXTURE_DIR) {
  return {
    watch: readJson(join(dir, 'watch.json')),
    data: { guidance: readJson(join(dir, 'guidance.json')), plans: readJson(join(dir, 'plans.json')) },
    models: readJson(join(dir, 'models.json')).models,
    aliases: readJson(join(dir, 'aliases.json')),
    pages: readJson(join(dir, 'pages.json')),
    drill: readJson(join(dir, 'drill.json')),
  };
}

/** The drill's pages: the frozen excerpts with one value swapped. */
export function drillPages(fx) {
  const pages = { ...fx.pages };
  const { url, from, to } = fx.drill;
  if (!pages[url] || !pages[url].includes(from)) throw new Error(`drill: "${from}" is not on the frozen page ${url}`);
  pages[url] = pages[url].replace(from, to);
  return pages;
}

/** Drill passes 2 + 3 on the frozen fixtures. Returns {ok, pass2, pass3} (the writes each pass made). */
export async function runDrill(log = console.log) {
  const fx = loadFixtures();
  const remote = memoryRemote({ main: { 'data/guidance.json': json(fx.data.guidance) } });
  const common = { watch: fx.watch, data: fx.data, models: fx.models, aliases: fx.aliases, pages: drillPages(fx), today: fx.drill.today, nowIso: `${fx.drill.today}T01:23:00.000Z`, remote, gate: inProcessGate(fx.models), log: () => {} };
  log(`DRILL pass 2 — frozen pages with "${fx.drill.from}" -> "${fx.drill.to}" on ${fx.drill.url}`);
  await runJob(common);
  const pass2 = remote.actions.splice(0);
  for (const a of pass2) printAction(a, log);
  const prs = pass2.filter((a) => a.kind === 'create-pr');
  log(`\nDRILL pass 3 — the same input again`);
  await runJob(common);
  const pass3 = remote.actions.splice(0);
  for (const a of pass3) printAction(a, log);
  if (!pass3.length) log('  nothing new: no push, no pull request edit, no status, no issue write');
  const ok = prs.length === 1 && pass3.length === 0;
  log(`\nDRILL ${ok ? 'PASSED' : 'FAILED'}: pass 2 opened ${prs.length} pull request(s); pass 3 made ${pass3.length} write(s)`);
  return { ok, pass2, pass3 };
}

function printAction(a, log) {
  if (a.kind === 'create-pr') {
    log(`  would open a pull request\n    branch: ${BOT_BRANCH} -> main\n    title:  ${a.title}\n    body:\n${a.body.split('\n').map((l) => `      ${l}`).join('\n')}`);
  } else if (a.kind === 'push-branch') log(`  would force-push ${BOT_BRANCH}: ${a.files.join(', ')} ("${a.message}")`);
  else if (a.kind === 'push-main') log(`  would push to main: ${a.files.join(', ')} ("${a.message}")`);
  else if (a.kind === 'status') log(`  would post commit status ${STATUS_CONTEXT}=${a.state}: ${a.description}`);
  else log(`  would ${a.kind}${a.number ? ` #${a.number}` : ''}${a.title ? `: ${a.title}` : ''}`);
}

/** check-sources full sweep on main, then the claim-rot report. */
function realSweep(log) {
  return async (skipIds) => {
    const out = join(mkdtempSync(join(tmpdir(), 'defaults-watch-sweep-')), 'results.json');
    const args = [join(ROOT, 'scripts/check-sources.mjs'), '--blocked-ok', '--fresh', '--json-out', out];
    if (skipIds.length) args.push('--skip-ids', skipIds.join(','));
    log(`source sweep: check-sources ${args.slice(1).map((a) => (a.startsWith('/') ? a.split('/').pop() : a)).join(' ')}`);
    const r = spawnSync(process.execPath, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const tail = (r.stdout || '').trim().split('\n').slice(-3).join('\n');
    log(tail);
    if (!existsSync(out)) return { failed: [], error: `check-sources wrote no results (exit ${r.status})` };
    const results = readJson(out).results || [];
    const rot = spawnSync(process.execPath, [join(ROOT, 'scripts/report-claim-rot.mjs'), '--results', out], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
    if (process.env.GITHUB_STEP_SUMMARY && rot.stdout) appendFileSync(process.env.GITHUB_STEP_SUMMARY, rot.stdout + '\n');
    return { failed: results.filter((x) => !x.ok && (x.kind === 'not_found' || x.kind === 'gone')), blocked: results.filter((x) => x.kind === 'blocked').length };
  };
}

function realPlansGate() {
  return async () => {
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts/check-live-data.mjs'), '--group', 'plans'], { encoding: 'utf8' });
    return r.status === 0 ? [] : (r.stderr || '').split('\n').filter(Boolean);
  };
}

export function parseArgs(argv) {
  const out = { mode: null, sweep: null };
  for (const a of argv) {
    if (a === '--dry-run') out.mode = 'dry';
    else if (a === '--live') out.mode = 'live';
    else if (a === '--drill') out.mode = 'drill';
    else if (a === '--sweep') out.sweep = true;
    else if (a === '--no-sweep') out.sweep = false;
    else throw new Error(`unknown argument "${a}" (usage: defaults-watch.mjs --dry-run | --live | --drill [--sweep|--no-sweep])`);
  }
  if (!out.mode) throw new Error('say --dry-run, --live or --drill');
  return out;
}

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  const log = (l) => console.log(l);
  if (args.mode === 'drill') { process.exit((await runDrill(log)).ok ? 0 : 1); }
  const env = process.env;
  const dryRun = args.mode === 'dry' || env.DRY_RUN === 'true';
  if (!dryRun) {
    const why = writeBlockReason(env);
    if (why) { console.error(`--live refused: ${why}. Use --dry-run.`); process.exit(2); }
  }
  const now = env.MODELPROOF_NOW ? new Date(env.MODELPROOF_NOW) : new Date();
  const today = now.toISOString().slice(0, 10);
  const watch = readJson(join(ROOT, 'data/defaults-watch.json'));
  const data = { guidance: readJson(join(ROOT, 'data/guidance.json')), plans: readJson(join(ROOT, 'data/plans.json')) };
  const models = readJson(join(ROOT, 'data/models.json')).models;
  const aliases = readJson(join(ROOT, 'scripts/model-aliases.json'));
  const receipt = existsSync(join(ROOT, RECEIPT_PATH)) ? readJson(join(ROOT, RECEIPT_PATH)) : null;
  log(`defaults watch ${today}${dryRun ? ' (dry run — nothing is written)' : ''}: ${watch.rules.length} rules, fetching ${new Set(watch.rules.map((r) => r.url)).size} pages fresh`);
  const pages = await fetchPages(watch.rules.map((r) => r.url));
  const sweepOn = args.sweep == null ? !dryRun : args.sweep;
  const result = await runJob({
    watch, data, models, aliases, pages, today, nowIso: now.toISOString(), receipt, log, dryRun,
    remote: dryRun ? dryRemote({ env, log }) : liveRemote({ env, log }),
    gate: subprocessGate(),
    sweepFn: sweepOn ? realSweep(log) : null,
    plansGateFn: realPlansGate(),
  });
  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(env.GITHUB_STEP_SUMMARY, [`### Defaults watch ${today}${dryRun ? ' (dry run)' : ''}`, '', '| outcome | rules |', '|---|---|',
      ...Object.entries(result.receipt.outcomes).map(([k, v]) => `| ${k} | ${v} |`), '', ...result.red.map((r) => `- RED: ${r}`), ''].join('\n'));
  }
  process.exit(result.red.length ? 1 : 0);
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try { return fileURLToPath(import.meta.url) === realpathSync(resolve(process.argv[1])); } catch { return false; }
})();
if (isMain) main().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exit(1); });
