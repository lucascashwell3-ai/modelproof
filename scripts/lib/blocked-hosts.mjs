/* Hosts that refuse scripted reads. scripts/check-sources.mjs fetches every claim's source_url
   (a plain GET with a browser user agent) to confirm the quote is on the page; these sites answer
   that fetch with an HTTP 403 some or all of the time — from GitHub's runners especially — so a
   quote citing them can never stay verified, and the default (strict) check fails on them at
   random. scripts/apply-judgment.mjs's normalizeJudgment holds any new judged-fit judgment with a
   claim citing one of these hosts (with its reason), instead of failing the whole batch at the
   write-time quote check. Cite the vendor's own page, its model card, or another outlet instead.

   Each entry: { host, reason }. `host` matches the URL's hostname or any subdomain of it. Keep
   the list short and add a host only after a real, repeated 403 — a single flaky fetch is not a
   reason. */

export const BLOCKED_HOSTS = Object.freeze([
  { host: 'marktechpost.com', reason: 'answers scripted reads with HTTP 403 some of the time (seen from GitHub runners and locally, 2026-09)' },
  { host: 'felloai.com', reason: 'answers every scripted read from GitHub runners with HTTP 403 (2026-09)' },
].map((e) => Object.freeze(e)));

/** The BLOCKED_HOSTS entry a URL falls under, or null. A URL that does not parse is not blocked
 * (the schema check rejects it on its own). */
export function blockedHostFor(url, hosts = BLOCKED_HOSTS) {
  let name;
  try { name = new URL(String(url || '')).hostname.toLowerCase(); } catch { return null; }
  return hosts.find((e) => name === e.host || name.endsWith(`.${e.host}`)) || null;
}
