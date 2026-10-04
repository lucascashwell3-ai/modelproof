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
                       not proposed again until the page says something else; listed in the issue,
                       and its old quote stays in the source sweep (which turns red once that
                       quote is gone from the page).
     gate-failed       a change that makes validate-data or check-live-data --group plans report a
                       problem main does not have: not written; red.
     blocked           the page could not be read (403/429/5xx/timeout/short body): a warning; red
                       once the same page has been blocked 3 runs in a row (count in the receipt).
     broken:missing    the anchor or the pattern is gone, or the page is gone (404/410): red.
     broken:ambiguous  the pattern finds two different values: red, never "first one wins".

   A change writes: the value at maps_to and every `also` path; a NEW claim for each claim in
   claim_ids (quote copied from the page — the old quote with the old value swapped, or else the
   matched span cut from the page's case-kept text; no case-kept text, no span: needs-review —
   confirmed on the page with check-sources' quoteFoundIn; sentence from the rule's
   template; date today); the old claim gets superseded_by (check-sources then skips it) and every
   basis[] that named it names the new one. A plan price rewrites its plans.json row in place
   (price, quote, quote_url, as_of). A model with ref_row also gets a model_refs row for the string
   the page uses. Each change is gated alone on main + that change (only problems main does not
   already have count), then all passing changes together.

   The PR's fingerprint covers its changes and main's copy of each file it changes (the date lines
   this job stamps left out), so an open PR is rebuilt when main has since changed one of them. The
   branch is always built on main as it is at push time: the changes are applied again to main's
   files (never the checkout's copies), and gated again when main moved. A commit by anyone else on
   the branch stops the force-push only while it is not in main and its PR is open. The PR's commit
   status is checked every run and posted again when it is missing.

   After the rules: the full source sweep (check-sources --blocked-ok --fresh, skipping the quotes
   a pending change replaces) and its claim-rot report, plus check-live-data --group plans on main.
   A sweep page that could not be read is a warning, red once it has been unreadable 3 runs in a
   row (count in the receipt). Each tool is dated on its own: tool_plans[].as_of gets today when
   every rule that feeds that tool is ok (or declined), none of its values waits in the bot PR, and
   the sweep read and found every guidance quote that tool rests on (a fact no single tool rests on,
   such as a lab page, feeds every tool). The top-level as_of is the oldest tool date. guidance.json
   or plans.json whose as_of is within 7 days of the pages' stale notice turns the run red; every
   other hand-kept file (cadence "by hand" in assets/freshness.mjs) is listed in the issue within 7
   days of its limit and turns the run red once past it. Every live run on main pushes its receipt
   (data/refresh/receipt-defaults-watch.json) straight to main, rebuilt on a fresh main up to 5
   times with a growing wait. One issue ("Defaults watch: rules need attention") lists everything
   that is not ok and every red reason (no run date, so a week with nothing new edits nothing), and
   closes itself only on a run with nothing to list and nothing red; a run that throws writes the
   error to it.

   Remote writes — branch push, pull request, commit status, issue, main push — happen only in a
   live run: not DRY_RUN, on refs/heads/main, not a pull_request event, with a token. PR, status,
   issue and branch delete go through scripts/lib/gh-issue.mjs's guarded ghWrite; the two git
   pushes check the same guard plus an allowed-path list (bot branch: guidance.json + plans.json;
   main: the receipt + guidance.json, whose diff must be its as_of lines only). Nothing here creates
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
import { quoteFoundIn, normalizeText, classifyFailure } from './check-sources.mjs';
import { matchAlias } from './auto-refresh.mjs';
import { ghRead, ghWrite, upsertIssue, closeIssue, writeBlockReason } from './lib/gh-issue.mjs';
import { validateGuidance, wordCount, getPath, setPath, planRow, PLACEHOLDER_RE, FEEDS } from './validate-data.mjs';
import { runChecks } from './check-live-data.mjs';
import { FEED_FRESHNESS, ageDays } from '../assets/freshness.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const BOT_BRANCH = 'auto/defaults-watch';
export const RECEIPT_PATH = 'data/refresh/receipt-defaults-watch.json';
export const BRANCH_PATHS = ['data/guidance.json', 'data/plans.json'];
export const MAIN_PATHS = ['data/guidance.json', RECEIPT_PATH];
export const ISSUE_TITLE = 'Defaults watch: rules need attention';
export const LABEL = 'defaults-watch';
export const STATUS_CONTEXT = 'defaults-watch/gates';
export const BLOCKED_RED_RUNS = 3;
export const MAIN_PUSH_TRIES = 5;
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

/** True when `cased` is the page text in its own case: same length, and lowercased it is `page`
 * (so a match's offsets on the lowercased page are the same offsets in it). */
export const casedFits = (cased, page) => typeof cased === 'string' && cased.length === page.length && cased.toLowerCase() === page;

/** A new quote: the old quote with the old value swapped (when the result is on the page), else
 * the matched span, cut from the page's case-kept text (never from the lowercased one, which would
 * print a lower-case "verbatim" quote). Null when neither is on the page within 25 words, or the
 * span is needed and no case-kept text fits the page. */
export function rewriteQuote(oldQuote, pairs, page, cap, cased = null) {
  const cand = swapForms(oldQuote || '', pairs);
  if (cand && wordCount(cand) <= MAX_QUOTE_WORDS && quoteFoundIn(cand, page)) return cand;
  const span = cap.match && casedFits(cased, page) ? spanQuote(cased, cap.match, cap.cap) : null;
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
export function evaluate({ watch, data, models, aliases = {}, pages, cased = {}, today, declined = new Set(), onlyWrite = null, skipWrite = new Set() }) {
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
    if (rule.write === 'field') evaluateField(rule, o, now, cap, page, { ctx, work, created, today, declined, onlyWrite, skipWrite, cased: cased[rule.url] });
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
  const { ctx, work, created, today, declined, onlyWrite, skipWrite, cased } = env;
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
  // no pending keys: nothing will replace the old quotes, so the sweep must keep checking them
  if (declined.has(dKey)) { o.outcome = 'declined'; o.reason = `a closed, unmerged bot PR declined ${valueKey(o.new)}; the data still says ${show(held)}`; return; }
  if (skipWrite.has(rule.id)) { o.outcome = 'gate-failed'; o.pending = pendingKeys(rule, ctx); return; }
  if (onlyWrite && !onlyWrite.has(rule.id)) { o.outcome = 'change'; o.unwritten = true; return; }
  // write on a scratch copy; keep it only if every piece could be written honestly
  const trial = clone(work);
  const tctx = { ...ctx, data: trial };
  const res = applyChange(rule, now, held, cap, page, { ctx: tctx, created: new Set(created), today, cased });
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

function applyChange(rule, now, held, cap, page, { ctx, created, today, cased }) {
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
    const quote = rewriteQuote(old.quote, pairs, page, cap, cased);
    if (!quote) return { error: `no quote of ≤${MAX_QUOTE_WORDS} words for claim ${old.id} is on the page${noCase(cased, page)}` };
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
    const quote = rewriteQuote(row.quote, pairs, page, cap, cased);
    if (!quote) return { error: `no quote of ≤${MAX_QUOTE_WORDS} words for ${row.vendor} / ${row.plan} is on the page${noCase(cased, page)}` };
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

const noCase = (cased, page) => (casedFits(cased, page) ? '' : ' (the old quote does not fit, and there is no case-kept copy of the page to cut one from)');

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

/** Fingerprint of a change set: rule ids and new values, plus `base` ({path: mainKey}) — main's
 * copy of each file the PR changes when its branch was built. Main moving under an open PR changes
 * the fingerprint, so the PR is rebuilt instead of going stale or conflicted. */
export function fingerprint(outcomes, base = {}) {
  const ch = outcomes.filter((o) => o.outcome === 'change').map((o) => `${o.rule}=${valueKey(o.new)}`).sort();
  const b = Object.keys(base).sort().map((p) => `${p}@${base[p]}`);
  return createHash('sha1').update([...ch, ...b].join('\n')).digest('hex').slice(0, 16);
}

/** A file on main as the fingerprint sees it: a hash of its text, with guidance.json's date lines
 * (the top-level as_of and tool_plans[].as_of, which this job stamps on main every week and which
 * never touch a PR's lines) left out. Any other edit on main changes it. */
export function mainKey(path, text) {
  if (typeof text !== 'string') return 'none';
  let t = text;
  if (path === 'data/guidance.json') {
    try { t = json(withoutStamps(JSON.parse(text))); } catch { t = text; }
  }
  return createHash('sha1').update(t).digest('hex').slice(0, 12);
}

/** {path: mainKey} for the given {path: text}. */
export const mainKeys = (texts) => Object.fromEntries(Object.entries(texts).map(([p, t]) => [p, mainKey(p, t)]));

export function prTitle(outcomes) {
  const ch = outcomes.filter((o) => o.outcome === 'change');
  return `Defaults watch: ${ch.length} data change${ch.length === 1 ? '' : 's'} from vendor pages`;
}

/** The PR body. Deterministic: same outcomes -> same text. */
export function prBody(outcomes, { today, base = {} }) {
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
  L.push('', 'Closing this pull request without merging declines every value in it: the watch skips them until the page says something else.', '');
  L.push(`<!-- ${MARK}:fingerprint=${fingerprint(outcomes, base)} -->`);
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

const STAMP_LINE = /^ *"as_of": "\d{4}-\d{2}-\d{2}",?$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A copy of guidance without the dates this job stamps (top-level as_of, tool_plans[].as_of). */
function withoutStamps(g) {
  const c = clone(g);
  delete c.as_of;
  for (const tp of c.tool_plans || []) if (tp && typeof tp === 'object') delete tp.as_of;
  return c;
}

/** Throws unless two guidance.json texts differ only in date lines: the top-level as_of and the
 * tool_plans[].as_of lines (same lines, and the same data once those dates are left out). */
export function assertAsOfOnly(before, after) {
  const a = String(before).split('\n');
  const b = String(after).split('\n');
  const bad = () => new Error('guidance.json re-stamp changed more than the as_of lines');
  if (a.length !== b.length) throw bad();
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i] && !(STAMP_LINE.test(a[i]) && STAMP_LINE.test(b[i]))) throw bad();
  let same = false;
  try { same = json(withoutStamps(JSON.parse(before))) === json(withoutStamps(JSON.parse(after))); } catch { same = false; }
  if (!same) throw bad();
}

/** guidance.json text with tool_plans[].as_of set to `date` for each tool in `tools` (a date is
 * never moved back, and a plan with no as_of gets none), and the top-level as_of set to the oldest
 * tool date. Throws when the result would change anything but those lines. */
export function stampToolsText(text, tools, date) {
  const g = JSON.parse(text);
  const want = new Set(tools);
  for (const tp of g.tool_plans || []) {
    if (tp && want.has(tp.tool) && Object.prototype.hasOwnProperty.call(tp, 'as_of') && !(typeof tp.as_of === 'string' && tp.as_of >= date)) tp.as_of = date;
  }
  const dates = (g.tool_plans || []).map((tp) => tp && tp.as_of).filter((d) => typeof d === 'string' && DAY_RE.test(d)).sort();
  if (dates.length && Object.prototype.hasOwnProperty.call(g, 'as_of')) g.as_of = dates[0];
  const out = json(g);
  if (out !== text) assertAsOfOnly(text, out);
  return out;
}

/* ------------------------------------------------------------------ remotes ---------------- */

/** In-memory GitHub + git, for drills and tests. `state` is mutated; `actions` records writes.
 * `state.main` is {path: text}; the bot branch is built on it and the receipt and stamps land on it. */
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
    // `inMain`: the tip is already in main (a merged branch).
    async branchHead() {
      if (!state.branch) return null;
      const b = state.branch;
      return { sha: b.sha, author: b.author || BOT_NAME, inMain: !!b.inMain };
    },
    async mainTexts(paths) { return Object.fromEntries(paths.map((p) => [p, state.main[p] == null ? null : state.main[p]])); },
    async pushBranch({ build, message }) {
      const texts = Object.fromEntries(BRANCH_PATHS.map((p) => [p, state.main[p] == null ? null : state.main[p]]));
      const files = build(texts);
      assertAllowedPaths(Object.keys(files), BRANCH_PATHS);
      const sha = createHash('sha1').update(JSON.stringify(files) + message).digest('hex');
      state.branch = { sha, files, author: BOT_NAME };
      actions.push({ kind: 'push-branch', branch: BOT_BRANCH, files: Object.keys(files), message });
      return { sha, texts };
    },
    async createPr({ title, body }) { const pr = { number: n++, state: 'open', title, body, merged_at: null }; state.pulls.push(pr); actions.push({ kind: 'create-pr', number: pr.number, title, body }); return pr.number; },
    async editPr(num, { title, body }) { const pr = state.pulls.find((p) => p.number === num); Object.assign(pr, { title, body }); actions.push({ kind: 'edit-pr', number: num, title, body }); },
    async closePr(num, { body }) { const pr = state.pulls.find((p) => p.number === num); Object.assign(pr, { state: 'closed', body }); actions.push({ kind: 'close-pr', number: num }); },
    async deleteBranch() { state.branch = null; actions.push({ kind: 'delete-branch', branch: BOT_BRANCH }); },
    async statusOf(sha) { const l = state.statuses.filter((x) => x.sha === sha); return l.length ? l[l.length - 1] : null; },
    async postStatus(sha, s) { state.statuses.push({ sha, ...s }); actions.push({ kind: 'status', sha, ...s }); },
    async pushMain({ files, stamp = null, message }) {
      const out = { ...files };
      const cur = state.main['data/guidance.json'];
      if (stamp && typeof cur === 'string') { const t = stampToolsText(cur, stamp.tools, stamp.date); if (t !== cur) out['data/guidance.json'] = t; }
      assertAllowedPaths(Object.keys(out), MAIN_PATHS);
      const changed = Object.keys(out).filter((p) => state.main[p] !== out[p]);
      if (!changed.length) return null;
      for (const p of changed) state.main[p] = out[p];
      actions.push({ kind: 'push-main', files: changed, message });
      return 'main';
    },
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
  const checkout = (p) => (existsSync(join(ROOT, p)) ? readFileSync(join(ROOT, p), 'utf8') : null);
  return {
    actions,
    openPr: live.openPr, closedPrs: live.closedPrs,
    // a dry run never reads the bot branch: it is taken as the job's own, built on main as it is
    branchHead: async () => ({ sha: null, author: BOT_NAME, inMain: false }),
    async mainTexts(paths) { return Object.fromEntries(paths.map((p) => [p, checkout(p)])); },
    async pushBranch({ build, message }) {
      const texts = Object.fromEntries(BRANCH_PATHS.map((p) => [p, checkout(p)]));
      const files = build(texts);
      say({ kind: 'push-branch', files: Object.keys(files), message }, `force-push ${BOT_BRANCH} (from main) with ${Object.keys(files).join(', ')}: "${message}"`);
      return { sha: '0'.repeat(40), texts };
    },
    async createPr({ title, body }) { say({ kind: 'create-pr', title, body }, `open a pull request\n  branch: ${BOT_BRANCH} -> main\n  title:  ${title}\n  body:\n${body.split('\n').map((l) => `    ${l}`).join('\n')}`); return 0; },
    async editPr(num, { title, body }) { say({ kind: 'edit-pr', number: num, title, body }, `update pull request #${num}: ${title}`); },
    async closePr(num) { say({ kind: 'close-pr', number: num }, `close pull request #${num} (no change left)`); },
    async deleteBranch() { say({ kind: 'delete-branch' }, `delete branch ${BOT_BRANCH}`); },
    async statusOf() { return null; },
    async postStatus(sha, s) { say({ kind: 'status', ...s }, `post commit status ${STATUS_CONTEXT}=${s.state} (${s.description})`); },
    async pushMain({ files, stamp = null, message }) {
      const t = stamp ? ` + the tool dates of ${stamp.tools.length ? stamp.tools.join(', ') : 'no tool'} (top-level as_of = the oldest)` : '';
      say({ kind: 'push-main', files: Object.keys(files), stamp, message }, `push to main: ${Object.keys(files).join(', ')}${t} ("${message}")`);
      return null;
    },
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
    // the newest status this job posted on `sha` (the list comes newest first), or null
    async statusOf(sha) {
      if (!/^[0-9a-f]{40}$/.test(String(sha || ''))) return null;
      const l = await ghRead(`/commits/${sha}/statuses?per_page=100`, opts);
      const s = Array.isArray(l) ? l.find((x) => x && x.context === STATUS_CONTEXT) : null;
      return s ? { state: s.state, description: s.description } : null;
    },
  };
}

/** git in `cwd`. Output is trimmed unless `raw` (file contents keep their last newline). */
function gitAt(cwd) {
  return (args, { input = null, env = {}, raw = false } = {}) => {
    const out = execFileSync('git', args, { cwd, encoding: 'utf8', input, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
    return raw ? out : out.trim();
  };
}

/** A commit of `files` on top of `parent`, built with git plumbing (the working tree is never touched). */
function commitFiles(git, parent, files, message) {
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

const MAIN_REF = 'refs/remotes/origin/main';
const sleepMs = (ms) => new Promise((r) => { setTimeout(r, ms); });

/** The real thing: git pushes (guarded here) + GitHub writes through gh-issue.mjs's ghWrite.
 * `cwd` (the checkout), `sleep` and `tries` are there for tests. */
export function liveRemote({ env = process.env, log = console.log, cwd = ROOT, sleep = sleepMs, tries = MAIN_PUSH_TRIES } = {}) {
  const opts = { env, log };
  const reads = liveReads(env);
  const git = gitAt(cwd);
  const guard = () => { const why = writeBlockReason(env); if (why) throw new Error(`remote write refused: ${why}`); };
  const fetchMain = () => { git(['fetch', '--quiet', 'origin', `+refs/heads/main:${MAIN_REF}`]); return git(['rev-parse', MAIN_REF]); };
  const show = (rev, p) => { try { return git(['show', `${rev}:${p}`], { raw: true }); } catch { return null; } };
  return {
    actions: [],
    ...reads,
    async branchHead() {
      const B = `refs/remotes/origin/${BOT_BRANCH}`;
      try { git(['fetch', '--quiet', 'origin', `+refs/heads/${BOT_BRANCH}:${B}`]); } catch { return null; }
      fetchMain();
      const ok = (args) => { try { git(args); return true; } catch { return false; } };
      return { sha: git(['rev-parse', B]), author: git(['log', '-1', '--format=%an', B]), inMain: ok(['merge-base', '--is-ancestor', B, MAIN_REF]) };
    },
    async mainTexts(paths) {
      const parent = fetchMain();
      return Object.fromEntries(paths.map((p) => [p, show(parent, p)]));
    },
    // the branch is built on main as it is now: build() gets main's files and re-applies the changes
    async pushBranch({ build, message }) {
      guard();
      const parent = fetchMain();
      const texts = Object.fromEntries(BRANCH_PATHS.map((p) => [p, show(parent, p)]));
      const files = build(texts);
      assertAllowedPaths(Object.keys(files), BRANCH_PATHS);
      const sha = commitFiles(git, parent, files, message);
      if (!sha) throw new Error('bot branch commit would be empty');
      let lease = '';
      try { lease = git(['rev-parse', `refs/remotes/origin/${BOT_BRANCH}`]); } catch { lease = ''; }
      git(['push', `--force-with-lease=refs/heads/${BOT_BRANCH}:${lease}`, 'origin', `${sha}:refs/heads/${BOT_BRANCH}`]);
      log(`pushed ${BOT_BRANCH} ${sha.slice(0, 7)}`);
      return { sha, texts };
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
    // Each try fetches main and builds the commit again on top of it (a rebase: the receipt as it
    // is, the tool dates stamped again on main's guidance.json as it is now), then pushes. A
    // rejected push (another job pushed main first) waits 1, 2, 4, 8 s before the next try.
    async pushMain({ files, stamp = null, message }) {
      guard();
      assertAllowedPaths(Object.keys(files), MAIN_PATHS);
      let wait = 1000;
      for (let attempt = 1; attempt <= tries; attempt += 1) {
        const parent = fetchMain();
        const out = { ...files };
        const cur = stamp ? show(parent, 'data/guidance.json') : null;
        if (typeof cur === 'string') { const t = stampToolsText(cur, stamp.tools, stamp.date); if (t !== cur) out['data/guidance.json'] = t; }
        assertAllowedPaths(Object.keys(out), MAIN_PATHS);
        const sha = commitFiles(git, parent, out, message);
        if (!sha) { log('main already has these files — nothing to push'); return null; }
        try {
          git(['push', 'origin', `${sha}:refs/heads/main`]);
          log(`pushed main ${sha.slice(0, 7)}`);
          return sha;
        } catch (e) {
          log(`main push try ${attempt} of ${tries} rejected: ${String(e.message).split('\n')[0]}`);
          if (attempt < tries) { await sleep(wait); wait *= 2; }
        }
      }
      throw new Error(`main push rejected ${tries} times`);
    },
    async upsertIssue({ title, body }) { return upsertIssue({ title, body, labels: [LABEL] }, opts); },
    async closeIssue({ title }) { return closeIssue({ title, comment: 'The defaults watch ran green: every rule matched, nothing is waiting.' }, opts); },
  };
}

/* ------------------------------------------------------------------ the run ---------------- */

/** check-sources' normalizeText without its last step (the lowercasing): the page's text in its
 * own case, so a quote cut from it reads as the page wrote it. Lowercased, it is the text every
 * rule and quote check runs on; a copy that is not (casedFits) is never cut from. */
export function normalizeCased(raw) {
  const noScripts = String(raw || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ');
  return noScripts.replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&mdash;/gi, '-').replace(/&ndash;/gi, '-')
    .replace(/&rsquo;|&lsquo;/gi, "'").replace(/&rdquo;|&ldquo;/gi, '"')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

const FETCH_TIMEOUT_MS = 20000;

/** One rule page, fetched fresh (never a cached copy), the way check-sources fetches it (same
 * browser user agent and language, same short-body rule). {text: check-sources' normalized text,
 * cased: the same text in the page's own case, or null when it does not line up}. */
export async function fetchRulePage(url, { fetchImpl = globalThis.fetch } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  const fail = (message, status = null) => { const e = new Error(message); if (status != null) e.status = status; return e; };
  try {
    let res;
    try {
      res = await fetchImpl(url, {
        signal: ctrl.signal,
        redirect: 'follow',
        headers: {
          'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
          'accept-language': 'en-US,en;q=0.9',
        },
      });
    } catch (e) {
      throw fail(e && e.name === 'AbortError' ? `timed out after ${FETCH_TIMEOUT_MS / 1000}s` : `network error (${e && e.message})`);
    }
    if (!res.ok) throw fail(`HTTP ${res.status}`, res.status);
    const raw = await res.text();
    const text = normalizeText(raw);
    if (text.length < 200) throw fail(`page body too short after fetch (${text.length} chars) — likely a blocked/failed fetch, not real content`);
    const cased = normalizeCased(raw);
    return { text, cased: casedFits(cased, text) ? cased : null };
  } finally {
    clearTimeout(t);
  }
}

/** Fetch every rule page once. {pages: {url: text | {error, kind}}, cased: {url: text}}. A fetchImpl
 * may return the text alone (no case-kept copy) or {text, cased}. */
export async function fetchPages(urls, { fetchImpl = (u) => fetchRulePage(u), limit = 6 } = {}) {
  const pages = {};
  const cased = {};
  const queue = [...new Set(urls)];
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const u = queue.shift();
      try {
        const r = await fetchImpl(u);
        if (typeof r === 'string') pages[u] = r;
        else { pages[u] = r.text; if (r.cased) cased[u] = r.cased; }
      } catch (e) { pages[u] = { error: e.message, kind: classifyFailure(e) }; }
    }
  }));
  return { pages, cased };
}

/** Every outcome that is neither ok nor a change in the open PR gets a section in the issue. */
export const ISSUE_KINDS = ['broken:missing', 'broken:ambiguous', 'gate-failed', 'needs-review', 'waiting:catalog', 'waiting:not-ga', 'declined', 'blocked'];

/** The issue body, or null when nothing needs attention. `pr`: the open bot PR ({number, changes})
 * or null. `runProblems`: red reasons that are not a rule outcome (a foreign commit on the bot
 * branch, a sweep error, a stale stamp, sources blocked too long). `near`: hand-kept files close to
 * their stale notice. No run date: the same findings give the same text, so a week with nothing
 * new edits nothing (the receipt has the run time). */
export function issueBody({ outcomes, blockedRuns = {}, sweep = null, sweepBlockedRuns = {}, plansProblems = [], pr = null, runProblems = [], near = [] }) {
  const pick = (k) => outcomes.filter((o) => o.outcome === k);
  const L = [];
  const section = (title, list, fmt) => { if (list.length) { L.push(`### ${title}`, '', ...list.map(fmt), ''); } };
  section('Run problems (red)', runProblems, (p) => `- ${p}`);
  section('Rule broken (red): the anchor or pattern is gone, the page is gone, or the pattern is ambiguous', [...pick('broken:missing'), ...pick('broken:ambiguous')],
    (o) => `- \`${o.rule}\` — ${o.outcome}: ${o.reason} (${o.url}). Fix the rule in data/defaults-watch.json or re-source the fact; never guess.`);
  section('Change failed its gate (red): not written', pick('gate-failed'), (o) => `- \`${o.rule}\`: ${show(o.old)} → ${show(o.new)} — ${o.reason}`);
  section('Needs review: the page changed and there is nothing safe to write', pick('needs-review'),
    (o) => `- \`${o.rule}\` (${o.url}): ${o.reason}${o.judge ? `\n  - Question: ${o.judge}` : ''}`);
  section('Waiting: the page names a model the catalog cannot take yet', [...pick('waiting:catalog'), ...pick('waiting:not-ga')], (o) => `- \`${o.rule}\` — ${o.outcome}: ${o.reason}`);
  section('Declined: the data disagrees with the page (a bot pull request with this value was closed without merging)', pick('declined'),
    (o) => `- \`${o.rule}\` (${o.url}): page says ${show(o.new)}, data says ${show(o.old)}. Correct the data or the claim by hand; the old quote stays in the source sweep until then.`);
  if (pr) section('Waiting for review: the bot pull request', [pr], (x) => `- #${x.number} carries ${x.changes} change(s). Until it is merged or closed, the tools it changes keep their old date in guidance.json.`);
  const blocked = [...new Set(pick('blocked').map((o) => o.url))];
  section(`Could not read the rule page (warning; red after ${BLOCKED_RED_RUNS} runs in a row)`, blocked, (u) => `- ${u} — ${blockedRuns[u] || 1} run(s) in a row`);
  if (sweep && sweep.failed.length) section('Source sweep: quotes gone from their pages (red)', sweep.failed, (r) => `- \`${r.key}\` ${r.source_url} — ${r.kind}`);
  const sweepBlocked = Object.keys(sweepBlockedRuns).sort();
  section(`Source sweep: pages that could not be read (warning; red after ${BLOCKED_RED_RUNS} runs in a row)`, sweepBlocked,
    (u) => `- ${u} — ${sweepBlockedRuns[u]} run(s) in a row${sweep && sweep.blocked ? `: ${sweep.blocked.filter((r) => r.source_url === u).map((r) => `\`${r.key}\``).join(', ')}` : ''}`);
  section('Plan lines (check-live-data --group plans) on main (red)', plansProblems, (p) => `- ${p}`);
  section(`Hand-kept data close to its stale notice (warning; red once past it)`, near, (p) => `- ${p}`);
  if (!L.length) return null;
  return ['The weekly defaults watch found things that need a person or the Judge. Nothing below was written to data/.', '', ...L].join('\n').trim();
}

function summarize(outcomes) {
  const counts = {};
  for (const o of outcomes) counts[o.outcome] = (counts[o.outcome] || 0) + 1;
  return counts;
}

/** Days before a feed's freshness limit at which the watch speaks up: one weekly run ahead of the
 * pages' "not updated" notice. */
export const STAMP_RED_MARGIN_DAYS = 7;

/** The feeds kept by hand (cadence "by hand" in assets/freshness.mjs — the one list of limits). */
export const HAND_FEEDS = Object.keys(FEED_FRESHNESS).filter((id) => FEED_FRESHNESS[id].byHand === true);

/** The data file of a feed id (FEEDS in validate-data.mjs). */
export const feedFile = (id) => `data/${(FEEDS.find((f) => f.id === id) || { file: `${id}.json` }).file}`;

/** Red lines and warnings for files whose as_of is close to (or past) the pages' stale notice.
 * guidance.json (stamped by this job) and plans.json: red within 7 days of the limit. Every other
 * hand-kept feed in `feeds` ({id: as_of}; an absent file is left out): listed within 7 days of its
 * limit, red once past it. Returns {red, near}. */
export function stampProblems({ guidanceAsOf, plansAsOf, feeds = {}, today, why = [] }) {
  const now = Date.parse(`${today}T00:00:00Z`);
  const red = [];
  const near = [];
  const line = (file, asOf, lim) => {
    const age = ageDays(asOf, now);
    return { age, text: `${file} as_of is ${age === null ? 'missing' : `${age} days old (${asOf})`}; the pages call it stale after ${lim.maxDays} days.` };
  };
  const early = (feed, file, asOf, tail) => {
    const lim = FEED_FRESHNESS[feed];
    const { age, text } = line(file, asOf, lim);
    if (age === null || age >= lim.maxDays - STAMP_RED_MARGIN_DAYS) red.push(`${text} ${tail}`);
  };
  early('tool-defaults', 'data/guidance.json', guidanceAsOf, `This run did not re-stamp every tool: ${why.length ? why.join('; ') : 'see the sections below'}.`);
  early('plans', 'data/plans.json', plansAsOf, 'It is kept by hand: re-check the prices and its as_of (scripts/refresh-plans.md).');
  for (const id of HAND_FEEDS) {
    if (id === 'plans' || !Object.prototype.hasOwnProperty.call(feeds, id)) continue;
    const lim = FEED_FRESHNESS[id];
    const file = feedFile(id);
    const { age, text } = line(file, feeds[id], lim);
    if (age === null || age > lim.maxDays) red.push(`${text} It is kept by hand and the pages now show it as not updated: re-check it and its as_of.`);
    else if (age >= lim.maxDays - STAMP_RED_MARGIN_DAYS) near.push(`${text} It is kept by hand: re-check it and its as_of before then.`);
  }
  return { red, near };
}

/** Count runs in a row per url: urls seen this run get prev + 1, the rest drop out. */
function runsInARow(urls, prev = {}) {
  const out = {};
  for (const u of [...new Set(urls)].sort()) out[u] = (prev[u] || 0) + 1;
  return out;
}

/* ------------------------------------------------------------------ tool dates ------------- */

/** Claim subject names of the tools in tool_plans. */
const TOOL_SUBJECTS = { 'Claude Code': 'claude-code', 'Codex CLI': 'codex', Cursor: 'cursor', 'GitHub Copilot': 'copilot', Antigravity: 'antigravity', OpenRouter: 'openrouter' };

/** Which tools each claim feeds: a tool whose plan, role_defaults or model_refs basis names it, or
 * the tool the claim is about. {tools: the tool_plans tools, byClaim: Map id -> Set(tool)}. */
export function claimToolMap(guidance) {
  const tools = (guidance.tool_plans || []).map((t) => t && t.tool).filter((t) => typeof t === 'string');
  const byClaim = new Map();
  const add = (id, t) => { if (!tools.includes(t)) return; if (!byClaim.has(id)) byClaim.set(id, new Set()); byClaim.get(id).add(t); };
  const walk = (node, t) => {
    if (Array.isArray(node)) { node.forEach((x) => walk(x, t)); return; }
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (k === 'basis' && Array.isArray(v)) v.forEach((id) => add(id, t));
      else walk(v, t);
    }
  };
  for (const tp of guidance.tool_plans || []) if (tp) walk(tp, tp.tool);
  for (const r of [...(guidance.role_defaults || []), ...(guidance.model_refs || [])]) if (r) walk(r, r.tool);
  for (const c of guidance.claims || []) if (c && c.subject && c.subject.kind === 'tool' && TOOL_SUBJECTS[c.subject.name]) add(c.id, TOOL_SUBJECTS[c.subject.name]);
  return { tools, byClaim };
}

/** The tools a guidance claim feeds; every tool when it feeds none in particular (a shared fact). */
export function toolsOfClaim(id, cm) {
  const s = cm.byClaim.get(id);
  return s && s.size ? [...s] : [...cm.tools];
}

/** The tools a rule feeds: its own tool, a [tool=...] in its paths, the tools its claims feed. A
 * rule about plan prices only feeds none; any other rule that names no tool feeds every tool. */
export function toolsOfRule(rule, guidance, cm) {
  const out = new Set();
  if (cm.tools.includes(rule.tool)) out.add(rule.tool);
  for (const p of [rule.maps_to, ...(rule.also || [])].filter((x) => typeof x === 'string')) {
    for (const m of p.matchAll(/\[tool=([^\]]+)\]/g)) if (cm.tools.includes(m[1])) out.add(m[1]);
  }
  const ids = [...(rule.claim_ids || []), ...(rule.baseline && rule.baseline.claim ? [rule.baseline.claim] : [])];
  for (const id of ids) {
    const c = latestClaim(guidance, id);
    for (const t of cm.byClaim.get(c ? c.id : id) || []) out.add(t);
  }
  if (out.size) return [...out].sort();
  if (rule.tool === 'plans' || (typeof rule.maps_to === 'string' && rule.maps_to.startsWith('plans.'))) return [];
  return [...cm.tools];
}

/** One full run. All I/O is injected so tests and drills use frozen pages and an in-memory remote.
 * A run that throws still writes the issue (with the error) before the error goes on. */
export async function runJob(args) {
  try {
    return await runJobInner(args);
  } catch (e) {
    const msg = String((e && e.message) || e).split('\n').slice(0, 6).join('\n');
    const body = ['The weekly defaults watch stopped with an error before it finished. Nothing after the error was written.', '',
      '### Run problems (red)', '', '```', msg, '```'].join('\n');
    try { await args.remote.upsertIssue({ title: ISSUE_TITLE, body }); } catch (e2) { (args.log || console.log)(`could not write the issue either: ${e2.message}`); }
    throw e;
  }
}

const MAIN_MOVED = 'MAIN_MOVED';
const mainMoved = (msg) => Object.assign(new Error(msg), { code: MAIN_MOVED });

async function runJobInner({
  watch, data, models, aliases, pages, cased = {}, feeds = {}, today, nowIso = new Date().toISOString(), remote, gate,
  receipt = null, sweepFn = null, plansGateFn = null, log = console.log, dryRun = false,
}) {
  const closed = await remote.closedPrs();
  const declined = declinedFrom(closed);
  const input = { watch, data, models, aliases, pages, cased, today, declined };
  const res = evaluateGated(input, gate);
  const { outcomes } = res;
  for (const o of outcomes) log(`  ${o.outcome.padEnd(17)} ${o.rule}${o.captured !== undefined ? ` = "${o.captured}"` : ''}${o.reason ? ` — ${o.reason}` : ''}`);

  // blocked pages: count runs in a row per url
  const blockedRuns = runsInARow(outcomes.filter((o) => o.outcome === 'blocked').map((o) => o.url), (receipt && receipt.blocked_runs) || {});
  const blockedRed = Object.entries(blockedRuns).filter(([, n]) => n >= BLOCKED_RED_RUNS).map(([u]) => u);

  // the pull request
  const changes = outcomes.filter((o) => o.outcome === 'change');
  const open = await remote.openPr();
  const red = [];
  const runProblems = [];
  let prNumber = open ? open.number : null;
  let prAction = 'none';
  let foreign = false;
  if (changes.length) {
    const title = prTitle(outcomes);
    const files = changedFiles(outcomes);
    const head = await remote.branchHead();
    const base = mainKeys(await remote.mainTexts(files));
    let headSha = null;
    if (open && head && fpOf(open.body) === fingerprint(outcomes, base)) {
      prAction = 'unchanged';
      headSha = head.sha;
      log(`pull request #${open.number} already carries these ${changes.length} change(s) on main as it is — nothing new`);
    } else if (open && head && head.author !== BOT_NAME && !head.inMain) {
      // someone's own work on the open PR: never force-push over it
      foreign = true;
      runProblems.push(`${BOT_BRANCH} has a commit by ${head.author} that is not in main, on open pull request #${open.number}; not force-pushing over it. Merge or close #${open.number}.`);
    } else {
      const changeIds = new Set(changes.map((o) => o.rule));
      // The branch files: main's files as they are at push time with the changes applied again —
      // never the checkout's copies, which would undo anything main got during the run.
      const build = (texts) => {
        for (const p of BRANCH_PATHS) if (typeof texts[p] !== 'string') throw new Error(`main has no ${p}`);
        let out = res.data;
        if (texts['data/guidance.json'] !== json(data.guidance) || texts['data/plans.json'] !== json(data.plans)) {
          const onMain = { guidance: JSON.parse(texts['data/guidance.json']), plans: JSON.parse(texts['data/plans.json']) };
          const again = evaluate({ ...input, data: onMain, onlyWrite: changeIds });
          for (const o of changes) {
            const r = again.outcomes.find((x) => x.rule === o.rule);
            if (!r || r.outcome !== 'change' || r.unwritten || valueKey(r.new) !== valueKey(o.new)) {
              throw mainMoved(`main changed under this run: ${o.rule} is ${r ? r.outcome : 'missing'} on main as it is now, so ${BOT_BRANCH} was not rebuilt; the next run rebuilds it.`);
            }
          }
          const probs = diffProblems(gate(again.data), gate(onMain));
          if (probs.length) throw mainMoved(`main changed under this run: the changes fail their gate on main as it is now (${probs.join('; ')}), so ${BOT_BRANCH} was not rebuilt; the next run tries again.`);
          out = again.data;
        }
        return Object.fromEntries(files.map((f) => [f, json(f === 'data/guidance.json' ? out.guidance : out.plans)]));
      };
      try {
        const pushed = await remote.pushBranch({ build, message: `defaults watch ${today}: ${changes.length} data change${changes.length === 1 ? '' : 's'}` });
        const body = prBody(outcomes, { today, base: mainKeys(Object.fromEntries(files.map((f) => [f, pushed.texts[f]]))) });
        if (open) { await remote.editPr(open.number, { title, body }); prAction = 'updated'; } else { prNumber = await remote.createPr({ title, body }); prAction = 'created'; }
        headSha = pushed.sha;
      } catch (e) {
        if (e.code !== MAIN_MOVED) throw e;
        runProblems.push(e.message);
      }
    }
    // the commit status: checked every run, posted again when it is missing (a failed post is retried)
    if (prNumber && headSha) {
      const want = { state: 'success', description: `validate-data + check-live-data --group plans passed for ${changes.length} change(s)` };
      const have = await remote.statusOf(headSha);
      if (!have || have.state !== want.state || have.description !== want.description) await remote.postStatus(headSha, want);
    }
  } else if (open) {
    await remote.closePr(open.number, { body: `${open.body || ''}\n\n<!-- ${MARK}:closed-by-bot -->\nClosed by the defaults watch: the pages no longer differ from data/.` });
    await remote.deleteBranch();
    prAction = 'closed';
    prNumber = null;
  }

  // the source sweep (skipping quotes a pending change replaces) + the plans gate on main
  const pending = [...new Set(outcomes.flatMap((o) => o.pending || []))].sort();
  const sweep = sweepFn ? await sweepFn(pending) : null;
  const plansProblems = plansGateFn ? await plansGateFn() : [];
  const sweepBlocked = (sweep && sweep.blocked) || [];
  const sweepBlockedRuns = runsInARow(sweepBlocked.map((r) => r.source_url), (receipt && receipt.sweep_blocked_runs) || {});
  if (sweep && sweep.error) runProblems.push(`source sweep: ${sweep.error}`);
  for (const [u, n] of Object.entries(sweepBlockedRuns)) if (n >= BLOCKED_RED_RUNS) runProblems.push(`source sweep: ${u} could not be read ${n} runs in a row, so its quotes are unverified`);

  // the tool dates: a tool is stamped when every rule that feeds it is ok (a declined value is the
  // data kept on purpose), none of its values waits in the bot PR, and the sweep read and found
  // every guidance quote it rests on
  const cm = claimToolMap(data.guidance);
  const ruleById = new Map((watch.rules || []).map((r) => [r.id, r]));
  const blockers = new Map(cm.tools.map((t) => [t, []]));
  const block = (tools, why) => { for (const t of tools) if (blockers.has(t) && !blockers.get(t).includes(why)) blockers.get(t).push(why); };
  const okish = (o) => o.outcome === 'ok' || o.outcome === 'declined';
  for (const t of cm.tools) if (!(watch.rules || []).some((r) => r.tool === t)) block([t], 'no rule reads its pages');
  for (const o of outcomes) {
    if (okish(o)) continue;
    const why = o.outcome === 'change' ? `${o.rule} waits in ${prNumber ? `bot pull request #${prNumber}` : 'a bot pull request'}` : `${o.rule} ${o.outcome}`;
    block(toolsOfRule(ruleById.get(o.rule) || {}, data.guidance, cm), why);
  }
  const claimOf = (key) => (String(key || '').startsWith('guidance/') ? String(key).slice('guidance/'.length) : null);
  if (!sweep) block(cm.tools, 'no source sweep ran');
  else if (sweep.error) block(cm.tools, 'the source sweep failed');
  else {
    for (const r of sweep.failed) if (claimOf(r.key)) block(toolsOfClaim(claimOf(r.key), cm), `quote gone: ${r.key}`);
    for (const r of sweepBlocked) if (claimOf(r.key)) block(toolsOfClaim(claimOf(r.key), cm), `source page not read: ${r.source_url}`);
  }
  if (foreign) block(cm.tools, `${BOT_BRANCH} has a commit by someone else`);
  const stamped = cm.tools.filter((t) => !blockers.get(t).length);
  const why = cm.tools.filter((t) => blockers.get(t).length).map((t) => {
    const b = blockers.get(t);
    return `${t}: ${b.slice(0, 3).join(', ')}${b.length > 3 ? ` and ${b.length - 3} more` : ''}`;
  });
  const toolDates = (data.guidance.tool_plans || []).map((tp) => (stamped.includes(tp.tool) && !(tp.as_of >= today) ? today : tp.as_of)).filter((d) => typeof d === 'string' && DAY_RE.test(d)).sort();
  const topAsOf = toolDates.length ? toolDates[0] : data.guidance.as_of;

  // red?
  for (const o of outcomes) if (o.outcome.startsWith('broken:') || o.outcome === 'gate-failed') red.push(`${o.rule}: ${o.outcome}`);
  for (const u of blockedRed) red.push(`${u}: blocked ${blockedRuns[u]} runs in a row`);
  if (sweep && sweep.failed.length) red.push(`source sweep: ${sweep.failed.length} quote(s) gone`);
  for (const p of plansProblems) red.push(`plans gate: ${p}`);
  const fresh = stampProblems({ guidanceAsOf: topAsOf, plansAsOf: data.plans.as_of, feeds, today, why });
  runProblems.push(...fresh.red);
  red.push(...runProblems);
  const clean = stamped.length === cm.tools.length && !red.length;

  // receipt (+ the tool dates, stamped again on main as it is at push time) -> main
  const prOpen = !!prNumber;
  const newReceipt = {
    job: 'defaults-watch', ran_at: nowIso, ok: !red.length, rules: outcomes.length, outcomes: summarize(outcomes),
    changes: changes.map((o) => ({ rule: o.rule, old: o.old, new: o.new })), pr: prOpen ? prNumber : null,
    restamped: clean, stamped_tools: stamped, blocked_runs: blockedRuns, sweep_blocked_runs: sweepBlockedRuns,
  };
  const files = { [RECEIPT_PATH]: json(newReceipt) };
  assertAllowedPaths(Object.keys(files), MAIN_PATHS);
  await remote.pushMain({ files, stamp: { tools: stamped, date: today }, message: `defaults watch ${today}${stamped.length ? ` (dates: ${stamped.join(', ')})` : ''}` });

  // the issue: open (or updated) while anything needs attention; never closed while red
  let body = issueBody({ outcomes, blockedRuns, sweep, sweepBlockedRuns, plansProblems, pr: prOpen ? { number: prNumber, changes: changes.length } : null, runProblems, near: fresh.near });
  if (!body && red.length) body = issueBody({ outcomes: [], runProblems: red });
  if (body) await remote.upsertIssue({ title: ISSUE_TITLE, body });
  else await remote.closeIssue({ title: ISSUE_TITLE });

  log(`\ndefaults watch: ${Object.entries(summarize(outcomes)).map(([k, v]) => `${k} ${v}`).join(', ')}; pull request: ${prAction}${prNumber ? ` #${prNumber}` : ''}; tool dates stamped: ${stamped.length ? stamped.join(', ') : 'none'}${dryRun ? ' (dry run)' : ''}`);
  if (why.length) log(`not stamped:\n${why.map((w) => `  - ${w}`).join('\n')}`);
  if (red.length) log(`RED:\n${red.map((r) => `  - ${r}`).join('\n')}`);
  return { outcomes, red, clean, stamped, prAction, prNumber, receipt: newReceipt, data: res.data, issue: body };
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
  const remote = memoryRemote({ main: { 'data/guidance.json': json(fx.data.guidance), 'data/plans.json': json(fx.data.plans) } });
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
    return {
      failed: results.filter((x) => !x.ok && (x.kind === 'not_found' || x.kind === 'gone')),
      blocked: results.filter((x) => x.kind === 'blocked').map((x) => ({ key: x.key, source_url: x.source_url })),
    };
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
  const { pages, cased } = await fetchPages(watch.rules.map((r) => r.url));
  // the other hand-kept files: only their as_of (an absent optional file is left out)
  const feeds = {};
  for (const id of HAND_FEEDS) {
    const f = join(ROOT, feedFile(id));
    if (id !== 'plans' && existsSync(f)) feeds[id] = readJson(f).as_of ?? null;
  }
  const sweepOn = args.sweep == null ? !dryRun : args.sweep;
  const result = await runJob({
    watch, data, models, aliases, pages, cased, feeds, today, nowIso: now.toISOString(), receipt, log, dryRun,
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
