#!/usr/bin/env node
/* Anti-fabrication gate for judged task-fit claims (data/models.json's task_fit_judged[*].claims).
   scripts/validate-data.mjs checks SHAPE — every claim has a url, tier, date, and a quote under
   25 words, and no relative phrasing. This script checks the one thing that gate can't: whether
   the quote is actually on the page it cites. It fetches every claim's source_url (read-only,
   follows redirects, caches the fetched page for the run so N claims sharing one URL only cost
   one request), normalizes both the page text and the quote (strip tags, collapse whitespace,
   lowercase), and confirms the quote appears verbatim. A claim whose quote can't be found —
   including one whose source_url can't even be fetched — is an ERROR. This is the gate that
   stops a fabricated or misquoted citation from ever publishing; scripts/apply-judgment.mjs runs
   it automatically after any judged-fit write, and it's wired into the refresh workflow and the
   test run (see .github/workflows/auto-refresh.yml and scripts/refresh-judge.md).

   Usage:
     node scripts/check-sources.mjs
   As a module: collectClaims(data), checkClaims(claims, {fetchImpl}) — unit-tested with a fake
   fetchImpl in scripts/test-check-sources.mjs (no real network calls in the unit tests). */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = new URL('../', import.meta.url);
const dataUrl = new URL('data/models.json', ROOT);
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

export function quoteFoundIn(quote, normalizedPageText) {
  const q = normalizeQuote(quote);
  if (!q) return false;
  return normalizedPageText.includes(q);
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
        });
      });
    }
  }
  return out;
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

async function main() {
  const data = JSON.parse(readFileSync(dataUrl, 'utf8'));
  const claims = collectClaims(data);
  if (!claims.length) {
    console.log('check-sources: no task_fit_judged claims in data/models.json to verify.');
    return;
  }
  console.log(`check-sources: verifying ${claims.length} claim(s) against their cited source_url...`);
  const results = await checkClaims(claims);
  for (const r of results) {
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.modelName} / ${r.taskId} [${r.tier}] ${r.source_url}${r.ok ? '' : ` — ${r.reason}`}`);
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
