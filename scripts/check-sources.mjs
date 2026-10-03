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

   Usage:
     node scripts/check-sources.mjs [--data <dir>] [--only <key>[,<key>...]]
       --data  read models.json / guidance.json / plans.json from <dir> (default: data/)
       --only  check only these claims. Keys: "<modelId>/<taskId>" (judged-fit claims),
               "guidance/<claimId>", "plan/<vendor>/<plan>"; a key also selects everything under
               it ("<modelId>" = all of that model's claims). A key that selects nothing is an
               error, so a scoped run can never pass by checking zero claims.
     CHECK_SOURCES_PAGES=<file.json>  (tests only) a {url: page html} map used instead of the
               network; a url missing from the map is a failed fetch.
   As a module: collectClaims(data), collectGuidanceClaims(guidance), collectPlanClaims(plans),
   collectAllClaims({models, guidance, plans}), selectClaims(claims, keys),
   checkClaims(claims, {fetchImpl}) — unit-tested with a fake fetchImpl in
   scripts/test-check-sources.mjs (no real network calls in the unit tests). */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
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
        if (!c) return;
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
 * and the report treat both files alike). modelId is null — a guidance claim is about a tool or a
 * lab, not one model; modelName carries the subject name, taskId the topic, claimId the claim's
 * own id. Pure — no I/O. */
export function collectGuidanceClaims(g) {
  const out = [];
  if (!g || !Array.isArray(g.claims)) return out;
  g.claims.forEach((c, index) => {
    if (!c) return;
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

const cacheKey = (url) => createHash('sha1').update(url).digest('hex');

/** Fetch a URL and return its normalized text, caching to a temp dir keyed by URL so a re-run
 * (or many claims sharing one page) doesn't re-fetch. Read-only: GET only, no state changed on
 * the far end. Follows redirects (fetch's default). */
export async function fetchNormalizedPage(url) {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  const file = join(CACHE_DIR, `${cacheKey(url)}.txt`);
  if (existsSync(file)) return readFileSync(file, 'utf8');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
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
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const norm = normalizeText(text);
    // A 200 with a near-empty body is almost always a transient block/CDN glitch, not real
    // content (confirmed against a live source, 2026-09-06) — never cache it, or one flaky
    // response would fail every future run against a source that's actually fine.
    if (norm.length < 200) throw new Error(`page body too short after fetch (${norm.length} chars) — likely a blocked/failed fetch, not real content`);
    writeFileSync(file, norm);
    return norm;
  } finally {
    clearTimeout(t);
  }
}

/** Check every claim, sharing one fetch per distinct source_url. `fetchImpl` is injectable so
 * unit tests never touch the network. A fetch failure is a FAILED claim, not a skip — "couldn't
 * verify" and "verified false" are both reasons not to publish. */
export async function checkClaims(claims, { fetchImpl = fetchNormalizedPage } = {}) {
  const pageCache = new Map();
  const results = [];
  for (const c of claims) {
    if (!c.source_url) { results.push({ ...c, ok: false, reason: 'no source_url on this claim' }); continue; }
    let pageText;
    try {
      if (!pageCache.has(c.source_url)) pageCache.set(c.source_url, await fetchImpl(c.source_url));
      pageText = pageCache.get(c.source_url);
    } catch (e) {
      results.push({ ...c, ok: false, reason: `could not fetch source_url (${e.message}) — cannot verify, so it cannot publish` });
      continue;
    }
    const ok = quoteFoundIn(c.quote, pageText);
    results.push({ ...c, ok, reason: ok ? null : 'quote text was not found on the cited page' });
  }
  return results;
}

/** A fetchImpl that serves pages from a {url: html} JSON file instead of the network (tests). */
export function fixturePageFetcher(file) {
  const pages = JSON.parse(readFileSync(file, 'utf8'));
  return async (url) => {
    if (!Object.prototype.hasOwnProperty.call(pages, url)) throw new Error(`HTTP 404 (not in ${file})`);
    return normalizeText(pages[url]);
  };
}

export function parseArgs(argv) {
  const out = { dataDir: null, only: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--data') out.dataDir = argv[++i];
    else if (a.startsWith('--data=')) out.dataDir = a.slice(7);
    else if (a === '--only') out.only.push(...String(argv[++i] || '').split(',').filter(Boolean));
    else if (a.startsWith('--only=')) out.only.push(...a.slice(7).split(',').filter(Boolean));
    else throw new Error(`unknown argument "${a}" (usage: check-sources.mjs [--data <dir>] [--only <key>[,<key>...]])`);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
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
  const { claims, unmatched } = selectClaims(all, args.only);
  if (unmatched.length) {
    console.error(`✗ --only selected no claims for: ${unmatched.join(', ')} — a scoped check that checks nothing cannot pass.`);
    process.exitCode = 1;
    return;
  }
  if (!claims.length) {
    console.log('check-sources: no claims in models.json, guidance.json or plans.json to verify.');
    return;
  }
  const count = (f) => claims.filter(f).length;
  console.log(`check-sources: verifying ${claims.length} claim(s) (${count((c) => !c.file)} in models.json, ${count((c) => c.file === 'guidance')} in guidance.json, ${count((c) => c.file === 'plans')} in plans.json)${args.only.length ? ` scoped to ${args.only.join(', ')}` : ''} against their cited source_url...`);
  const fetchImpl = process.env.CHECK_SOURCES_PAGES ? fixturePageFetcher(process.env.CHECK_SOURCES_PAGES) : fetchNormalizedPage;
  const results = await checkClaims(claims, { fetchImpl });
  for (const r of results) {
    const what = r.claimId ? `${r.modelName} / ${r.taskId} (${r.claimId})` : `${r.modelName} / ${r.taskId}`;
    console.log(`  ${r.ok ? '✓' : '✗'} ${what} [${r.tier}] ${r.source_url}${r.ok ? '' : ` — ${r.reason}`}`);
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\ncheck-sources: ${results.length - failed.length}/${results.length} claim(s) verified.`);
  if (failed.length) {
    console.error(`✗ ${failed.length} claim(s) FAILED — the anti-fabrication gate blocks publish until every quote is confirmed on its cited page.`);
    process.exitCode = 1;
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
