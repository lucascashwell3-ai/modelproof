#!/usr/bin/env node
/* Anti-fabrication gate for judged task-fit claims (data/models.json's task_fit_judged[*].claims)
   and the instruction package's sourced facts (data/guidance.json's claims[], when the file exists).
   scripts/validate-data.mjs checks SHAPE — every claim has a url, tier, date, and a quote under
   25 words, and no relative phrasing. This script checks the one thing that gate can't: whether
   the quote is actually on the page it cites. It fetches every claim's source_url (read-only,
   follows redirects, caches the fetched page for the run so N claims sharing one URL only cost
   one request), normalizes both the page text and the quote (strip tags, collapse whitespace,
   lowercase), and confirms the quote appears verbatim. A claim whose quote can't be found —
   including one whose source_url can't even be fetched — is an ERROR. This is the gate that
   stops a fabricated or misquoted citation from ever publishing; scripts/apply-judgment.mjs runs
   it automatically after any judged-fit write (scoped with --only to the records that run wrote),
   and it's wired into the refresh workflow (see .github/workflows/auto-refresh.yml and
   scripts/refresh-judge.md).

   Also checks every data/plans.json row that carries a `quote` (collectPlanClaims): the quote must
   be on the row's `quote_url` (when the price and the quoted words live on different vendor pages)
   or else on its `source_url`.

   Matching is substring after normalization, with one boundary rule (quoteFoundIn): a quote that
   starts or ends with a digit must not run into a longer number on the page — "Sonnet 5" does not
   pass on "Sonnet 5.5", "20 per month" does not pass on "120 per month". Trailing zero cents are
   the same number ("$40" passes on "$40.00").

   Every result carries a `kind` (see classifyFailure):
     ok         the quote is on the page.
     not_found  the page was fetched and the quote is not on it (or the claim has no source_url).
     gone       the page answered HTTP 404 or 410 — it no longer exists.
     blocked    the page could not be read from here: any other HTTP error (403/429/5xx...), a
                timeout, a network error, or a near-empty body. Says nothing about the quote.
   A claim that carries `superseded_by` (a newer claim replaced it) is never collected or checked.

   Usage:
     node scripts/check-sources.mjs [--data <dir>] [--only <key>[,<key>...]] [--fresh]
                                    [--blocked-ok] [--skip-ids <key>[,<key>...]] [--json-out <file>]
       --data        read models.json / guidance.json / plans.json from <dir> (default: data/)
       --only        check only these claims. Keys: "<modelId>/<taskId>" (judged-fit claims),
                     "guidance/<claimId>", "plan/<vendor>/<plan>"; a key also selects everything
                     under it ("<modelId>" = all of that model's claims). A key that selects nothing
                     is an error, so a scoped run can never pass by checking zero claims.
       --fresh       ignore the page cache and fetch every page again (env CHECK_SOURCES_FRESH=1
                     does the same). Without it a cached page is reused for at most 12 hours.
       --blocked-ok  full sweeps only: a `blocked` claim is printed as a warning and does not fail
                     the run; `not_found` and `gone` still do. Refused together with --only: a
                     write-time gate (apply-judgment.mjs, a new claim) must have read the page.
       --skip-ids    leave these claims out (same key forms as --only, or a bare guidance claim
                     id), e.g. quotes an open data PR is about to replace. Listed as skipped.
       --json-out    also write {results, skipped} to <file> as JSON (each result with its kind),
                     for scripts/report-claim-rot.mjs --results.
     Exit: 0 when every checked claim passed (with --blocked-ok: when none is not_found/gone);
           1 otherwise. Default mode is unchanged: ANY failure, blocked included, exits 1.
     CHECK_SOURCES_PAGES=<file.json>  (tests only) a {url: page html} map used instead of the
               network; a url missing from the map is an HTTP 404, a number value is that HTTP
               status (e.g. 403).
   As a module: collectClaims(data), collectGuidanceClaims(guidance), collectPlanClaims(plans),
   collectAllClaims({models, guidance, plans}), selectClaims(claims, keys), skipClaims(claims, ids),
   checkClaims(claims, {fetchImpl}), classifyFailure(error), runFailed(results, {blockedOk}),
   fetchNormalizedPage(url, {fresh}) — unit-tested with a fake fetchImpl in
   scripts/test-check-sources.mjs (no real network calls in the unit tests). */
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = new URL('../', import.meta.url);
const CACHE_DIR = join(tmpdir(), 'modelproof-check-sources-cache');
const FETCH_TIMEOUT_MS = 20000;

/** Strip tags/scripts/styles, decode the common entities, collapse whitespace, lowercase. Same
 * normalization on both sides of the comparison (the page and the quote) is what makes this
 * robust to HTML noise without needing a real HTML parser. */
export function normalizeText(raw) {
  const noScripts = String(raw || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ');
  const noTags = noScripts.replace(/<[^>]+>/g, ' ');
  const namedDecoded = noTags
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&mdash;/gi, '-').replace(/&ndash;/gi, '-')
    .replace(/&rsquo;|&lsquo;/gi, "'").replace(/&rdquo;|&ldquo;/gi, '"');
  // Numeric entities (&#8217; / &#x2019; etc.) are how most CMSes (WordPress included) actually
  // encode curly quotes/dashes/ellipses — without this, a real quote copied from a rendered page
  // (which shows a curly quote) would never match the raw HTML's literal "&#8217;" text.
  const numericDecoded = namedDecoded
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
  return numericDecoded
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** A quote is normalized the same way as a fetched page, so "the page says X" and "the quote is
 * X" are compared on equal footing regardless of curly quotes, line wraps, or nbsp noise. */
export const normalizeQuote = (q) => normalizeText(q);

const isDigit = (ch) => ch !== undefined && ch >= '0' && ch <= '9';

/** True when the text just before index `i` does not continue a number into the match:
 * "20 per month" must not pass inside "120 per month" or "1.20 per month". */
function startBoundaryOk(page, i) {
  const prev = page[i - 1];
  if (isDigit(prev)) return false;
  if (prev === '.' && isDigit(page[i - 2])) return false;
  return true;
}

/** True when the text from index `j` on does not continue the number the quote ends with:
 * "Sonnet 5" must not pass on "Sonnet 5.5" or "Sonnet 50". Zero-only decimals are the same
 * number, so "$40" passes on "$40.00". */
function endBoundaryOk(page, j) {
  const next = page[j];
  if (isDigit(next)) return false;
  if (next === '.' && isDigit(page[j + 1])) {
    let k = j + 1;
    while (isDigit(page[k])) { if (page[k] !== '0') return false; k += 1; }
    if (page[k] === '.' && isDigit(page[k + 1])) return false; // "5.0.1" is a version, not 5
  }
  return true;
}

export function quoteFoundIn(quote, normalizedPageText) {
  const q = normalizeQuote(quote);
  if (!q) return false;
  const page = String(normalizedPageText || '');
  const checkStart = isDigit(q[0]);
  const checkEnd = isDigit(q[q.length - 1]);
  for (let i = page.indexOf(q); i !== -1; i = page.indexOf(q, i + 1)) {
    if ((!checkStart || startBoundaryOk(page, i)) && (!checkEnd || endBoundaryOk(page, i + q.length))) return true;
  }
  return false;
}

/** Every claim across every model's task_fit_judged, flattened for checking. Pure — no I/O. */
export function collectClaims(data) {
  const out = [];
  for (const m of data.models || []) {
    const tfj = m.task_fit_judged;
    if (!tfj || typeof tfj !== 'object') continue;
    for (const taskId of Object.keys(tfj)) {
      const rec = tfj[taskId];
      if (!rec || !Array.isArray(rec.claims)) continue;
      rec.claims.forEach((c, index) => {
        if (!c || c.superseded_by) return; // replaced by a newer claim — never checked again
        out.push({
          modelId: m.id, modelName: m.name, taskId, index,
          source_url: c.source_url, quote: c.quote, tier: c.tier,
          key: `${m.id}/${taskId}`,
        });
      });
    }
  }
  return out;
}

/** Every claim in data/guidance.json, in the same record shape as collectClaims (so checkClaims
 * and the report treat both files alike). A claim with `superseded_by` is left out: its page
 * changed, a newer claim carries the new quote, and the old one stays only as history. modelId is null — a guidance claim is about a tool or a
 * lab, not one model; modelName carries the subject name, taskId the topic, claimId the claim's
 * own id. Pure — no I/O. */
export function collectGuidanceClaims(g) {
  const out = [];
  if (!g || !Array.isArray(g.claims)) return out;
  g.claims.forEach((c, index) => {
    if (!c || c.superseded_by) return; // replaced by a newer claim — never checked again
    out.push({
      modelId: null, modelName: c.subject && c.subject.name, taskId: c.topic, index,
      source_url: c.source_url, quote: c.quote, tier: c.tier, claimId: c.id, file: 'guidance',
      key: `guidance/${c.id}`,
    });
  });
  return out;
}

/** Every data/plans.json row that carries a `quote`, in the same record shape. The quote is
 * checked on `quote_url` when the row has one (the price page and the quoted words can be two
 * pages of the same vendor), else on `source_url`. Rows without a quote are not collected —
 * scripts/validate-data.mjs decides which rows must carry one. Pure — no I/O. */
export function collectPlanClaims(plans) {
  const out = [];
  if (!plans || !Array.isArray(plans.plans)) return out;
  plans.plans.forEach((p, index) => {
    if (!p || typeof p.quote !== 'string' || !p.quote.trim()) return;
    out.push({
      modelId: null, modelName: `${p.vendor} / ${p.plan}`, taskId: 'plan', index,
      source_url: p.quote_url || p.source_url, quote: p.quote, tier: 'plan', file: 'plans',
      key: `plan/${p.vendor}/${p.plan}`,
    });
  });
  return out;
}

/** All three collectors in one list (models.json judged fit, guidance.json, plans.json). */
export function collectAllClaims({ models = null, guidance = null, plans = null } = {}) {
  return [
    ...(models ? collectClaims(models) : []),
    ...collectGuidanceClaims(guidance),
    ...collectPlanClaims(plans),
  ];
}

/** The claims a scoped run checks. `keys` as in --only. Returns {claims, unmatched}: unmatched
 * lists keys that selected nothing (the CLI treats that as an error). */
export function selectClaims(claims, keys) {
  if (!keys || !keys.length) return { claims, unmatched: [] };
  const hit = new Set();
  const picked = claims.filter((c) => {
    const k = c.key || `${c.modelId}/${c.taskId}`;
    const m = keys.find((want) => k === want || k.startsWith(`${want}/`));
    if (m) hit.add(m);
    return !!m;
  });
  return { claims: picked, unmatched: keys.filter((k) => !hit.has(k)) };
}

/** Leave out the claims named in `ids` (same key forms as selectClaims, plus a bare guidance claim
 * id). Returns {claims, skipped}. Used for quotes an open data PR is about to replace, so the
 * weekly sweep reports them as pending instead of red. */
export function skipClaims(claims, ids) {
  if (!ids || !ids.length) return { claims, skipped: [] };
  const hits = (c) => ids.some((id) => c.key === id || (c.key || '').startsWith(`${id}/`) || (c.claimId != null && c.claimId === id));
  return { claims: claims.filter((c) => !hits(c)), skipped: claims.filter(hits) };
}

const cacheKey = (url) => createHash('sha1').update(url).digest('hex');

/** How long a cached page may be reused. A local run must never trust week-old pages: the cache
 * lives in the OS temp dir and used to have no expiry at all. */
export const CACHE_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/** An Error for a failed fetch that carries the HTTP status (when there is one), so
 * classifyFailure never has to parse prose. */
function fetchError(message, status = null) {
  const e = new Error(message);
  if (status != null) e.status = status;
  return e;
}

/** Which kind of failure a fetch error is: 'gone' (HTTP 404/410 — the page no longer exists) or
 * 'blocked' (anything else: 403/429/5xx, timeout, network error, near-empty body — the page could
 * not be read from here, which says nothing about the quote). Accepts an Error (uses `.status`
 * when set), or a message string ("HTTP 404 ..."). A quote missing from a page that WAS fetched
 * is 'not_found' — checkClaims sets that itself; it never reaches this function. */
export function classifyFailure(error) {
  let status = error && typeof error === 'object' ? error.status : null;
  if (status == null) {
    const msg = typeof error === 'string' ? error : String((error && error.message) || '');
    const m = msg.match(/\bHTTP (\d{3})\b/);
    status = m ? Number(m[1]) : null;
  }
  if (status === 404 || status === 410) return 'gone';
  return 'blocked';
}

/** Fetch a URL and return its normalized text. Pages are cached in a temp dir keyed by URL so
 * many claims sharing one page (or a re-run) cost one request; a cached copy older than
 * CACHE_MAX_AGE_MS is fetched again, and `fresh: true` (or CHECK_SOURCES_FRESH=1) skips the
 * cache entirely. Read-only: GET only, no state changed on the far end. Follows redirects. */
export async function fetchNormalizedPage(url, { fresh = process.env.CHECK_SOURCES_FRESH === '1', now = Date.now() } = {}) {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  const file = join(CACHE_DIR, `${cacheKey(url)}.txt`);
  if (!fresh && existsSync(file) && now - statSync(file).mtimeMs <= CACHE_MAX_AGE_MS) return readFileSync(file, 'utf8');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    let res;
    try {
      res = await fetch(url, {
        signal: ctrl.signal,
        redirect: 'follow',
        // A plain "ModelproofCheckSources/1.0" bot UA gets a flat 403 from at least one real
        // source (MarkTechPost, confirmed 2026-09-06) that otherwise serves the page to any
        // browser. This is a read-only GET on a page already public — the same thing a link
        // preview or an RSS reader does — so a standard browser UA is the honest way to reach the
        // same content everyone else sees, not a way around anything. Accept-Language pins the
        // page to English: at least one source (ai.google.dev) content-negotiates by locale and
        // served Portuguese by default during testing, which would make an honest English quote
        // fail to match through no fault of the citation.
        headers: {
          'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
          'accept-language': 'en-US,en;q=0.9',
        },
      });
    } catch (e) {
      throw fetchError(e && e.name === 'AbortError' ? `timed out after ${FETCH_TIMEOUT_MS / 1000}s` : `network error (${e && e.message})`);
    }
    if (!res.ok) throw fetchError(`HTTP ${res.status}`, res.status);
    const text = await res.text();
    const norm = normalizeText(text);
    // A 200 with a near-empty body is almost always a transient block/CDN glitch, not real
    // content (confirmed against a live source, 2026-09-06) — never cache it, or one flaky
    // response would fail every future run against a source that's actually fine.
    if (norm.length < 200) throw fetchError(`page body too short after fetch (${norm.length} chars) — likely a blocked/failed fetch, not real content`);
    writeFileSync(file, norm);
    return norm;
  } finally {
    clearTimeout(t);
  }
}

/** Check every claim, sharing one fetch per distinct source_url. `fetchImpl` is injectable so
 * unit tests never touch the network. A fetch failure is a FAILED claim, not a skip — "couldn't
 * verify" and "verified false" are both reasons not to publish. Each result carries `ok`,
 * `kind` ('ok' | 'not_found' | 'gone' | 'blocked') and `reason` (null when ok). */
export async function checkClaims(claims, { fetchImpl = fetchNormalizedPage } = {}) {
  const pageCache = new Map();
  const results = [];
  for (const c of claims) {
    if (!c.source_url) { results.push({ ...c, ok: false, kind: 'not_found', reason: 'no source_url on this claim' }); continue; }
    let pageText;
    try {
      if (!pageCache.has(c.source_url)) {
        // Remember a failed fetch too, so N claims on one blocked page cost one request.
        try { pageCache.set(c.source_url, { text: await fetchImpl(c.source_url) }); } catch (e) { pageCache.set(c.source_url, { error: e }); }
      }
      const hit = pageCache.get(c.source_url);
      if (hit.error) throw hit.error;
      pageText = hit.text;
    } catch (e) {
      results.push({ ...c, ok: false, kind: classifyFailure(e), reason: `could not fetch source_url (${e.message}) — cannot verify, so it cannot publish` });
      continue;
    }
    const ok = quoteFoundIn(c.quote, pageText);
    results.push({ ...c, ok, kind: ok ? 'ok' : 'not_found', reason: ok ? null : 'quote text was not found on the cited page' });
  }
  return results;
}

/** True when these results must fail the run. Default: any failure. `blockedOk`: only
 * `not_found` and `gone` fail — a page this machine could not read is a warning. */
export function runFailed(results, { blockedOk = false } = {}) {
  return results.some((r) => !r.ok && !(blockedOk && r.kind === 'blocked'));
}

/** A fetchImpl that serves pages from a {url: html} JSON file instead of the network (tests).
 * A url missing from the map is an HTTP 404; a number value is that HTTP status. */
export function fixturePageFetcher(file) {
  const pages = JSON.parse(readFileSync(file, 'utf8'));
  return async (url) => {
    if (!Object.prototype.hasOwnProperty.call(pages, url)) throw fetchError(`HTTP 404 (not in ${file})`, 404);
    if (typeof pages[url] === 'number') throw fetchError(`HTTP ${pages[url]} (from ${file})`, pages[url]);
    return normalizeText(pages[url]);
  };
}

const USAGE = 'usage: check-sources.mjs [--data <dir>] [--only <key>[,<key>...]] [--fresh] [--blocked-ok] [--skip-ids <key>[,<key>...]] [--json-out <file>]';

export function parseArgs(argv) {
  const out = { dataDir: null, only: [], fresh: false, blockedOk: false, skipIds: [], jsonOut: null };
  const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--data') out.dataDir = argv[++i];
    else if (a.startsWith('--data=')) out.dataDir = a.slice(7);
    else if (a === '--only') out.only.push(...list(argv[++i]));
    else if (a.startsWith('--only=')) out.only.push(...list(a.slice(7)));
    else if (a === '--fresh') out.fresh = true;
    else if (a === '--blocked-ok') out.blockedOk = true;
    else if (a === '--skip-ids') out.skipIds.push(...list(argv[++i]));
    else if (a.startsWith('--skip-ids=')) out.skipIds.push(...list(a.slice(11)));
    else if (a === '--json-out') out.jsonOut = argv[++i];
    else if (a.startsWith('--json-out=')) out.jsonOut = a.slice(11);
    else throw new Error(`unknown argument "${a}" (${USAGE})`);
  }
  if (out.blockedOk && out.only.length) {
    throw new Error('--blocked-ok cannot be combined with --only: a scoped (write-time) check must read every page it cites');
  }
  return out;
}

const SYMBOL = { ok: '✓', not_found: '✗', gone: '✗', blocked: '✗' };

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (e) { console.error(`✗ ${e.message}`); process.exitCode = 1; return; }
  const dir = args.dataDir ? pathToFileURL(resolve(args.dataDir) + '/') : new URL('data/', ROOT);
  const readOptional = (name) => {
    const u = new URL(name, dir);
    return existsSync(u) ? JSON.parse(readFileSync(u, 'utf8')) : null;
  };
  const data = JSON.parse(readFileSync(new URL('models.json', dir), 'utf8'));
  // guidance.json and plans.json are optional (a throwaway copy of scripts+data may not carry
  // them); when they exist, every claim in them is checked exactly like a judged task-fit claim.
  const guidance = readOptional('guidance.json');
  const plans = readOptional('plans.json');
  const all = collectAllClaims({ models: data, guidance, plans });
  const { claims: selected, unmatched } = selectClaims(all, args.only);
  if (unmatched.length) {
    console.error(`✗ --only selected no claims for: ${unmatched.join(', ')} — a scoped check that checks nothing cannot pass.`);
    process.exitCode = 1;
    return;
  }
  const { claims, skipped } = skipClaims(selected, args.skipIds);
  if (!claims.length) {
    console.log(`check-sources: no claims in models.json, guidance.json or plans.json to verify${skipped.length ? ` (${skipped.length} skipped by --skip-ids)` : ''}.`);
    if (args.jsonOut) writeFileSync(args.jsonOut, JSON.stringify({ results: [], skipped: skipped.map((c) => c.key) }, null, 2) + '\n');
    return;
  }
  const count = (f) => claims.filter(f).length;
  console.log(`check-sources: verifying ${claims.length} claim(s) (${count((c) => !c.file)} in models.json, ${count((c) => c.file === 'guidance')} in guidance.json, ${count((c) => c.file === 'plans')} in plans.json)${args.only.length ? ` scoped to ${args.only.join(', ')}` : ''} against their cited source_url${args.fresh ? ' (fresh fetch, cache ignored)' : ''}...`);
  const fetchImpl = process.env.CHECK_SOURCES_PAGES
    ? fixturePageFetcher(process.env.CHECK_SOURCES_PAGES)
    : (url) => fetchNormalizedPage(url, { fresh: args.fresh || process.env.CHECK_SOURCES_FRESH === '1' });
  const results = await checkClaims(claims, { fetchImpl });
  for (const r of results) {
    const what = r.claimId ? `${r.modelName} / ${r.taskId} (${r.claimId})` : `${r.modelName} / ${r.taskId}`;
    const mark = args.blockedOk && r.kind === 'blocked' ? '⚠' : SYMBOL[r.kind];
    console.log(`  ${mark} ${what} [${r.tier}] ${r.source_url}${r.ok ? '' : ` — ${r.kind}: ${r.reason}`}`);
  }
  for (const c of skipped) console.log(`  - ${c.key} skipped (--skip-ids)`);
  if (args.jsonOut) {
    writeFileSync(args.jsonOut, JSON.stringify({ results, skipped: skipped.map((c) => c.key) }, null, 2) + '\n');
  }
  const by = (k) => results.filter((r) => r.kind === k).length;
  const failedCount = results.filter((r) => !r.ok).length;
  console.log(`\ncheck-sources: ${results.length - failedCount}/${results.length} claim(s) verified (not_found ${by('not_found')}, gone ${by('gone')}, blocked ${by('blocked')}${skipped.length ? `, skipped ${skipped.length}` : ''}).`);
  if (runFailed(results, { blockedOk: args.blockedOk })) {
    const n = args.blockedOk ? by('not_found') + by('gone') : failedCount;
    console.error(`✗ ${n} claim(s) FAILED — the anti-fabrication gate blocks publish until every quote is confirmed on its cited page.`);
    process.exitCode = 1;
  } else if (by('blocked')) {
    console.log(`⚠ ${by('blocked')} claim(s) could not be read from here (blocked) — listed as warnings, not failures (--blocked-ok). Every page that could be read still carries its quote.`);
  } else {
    console.log('✓ all claims verified — every quote appears on its cited source page.');
  }
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try { return fileURLToPath(import.meta.url) === realpathSync(resolve(process.argv[1])); }
  catch { return fileURLToPath(import.meta.url) === process.argv[1]; }
})();
if (isMain) {
  main().catch((e) => { console.error(e); process.exitCode = 1; });
}
