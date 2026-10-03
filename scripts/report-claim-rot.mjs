#!/usr/bin/env node
/* Claim-rot reporter — companion to scripts/check-sources.mjs's anti-fabrication gate (round 3,
   item 4). check-sources.mjs itself stays a real gate (non-zero exit on any failed claim; that
   exit code is what scripts/apply-judgment.mjs's hard gate and this repo's own test suite rely
   on, unchanged) — but a claim that verified fine when it was WRITTEN can go stale later purely
   because the third-party page it cites changed wording, with no fabrication involved. That's
   link rot, not a publish blocker: this repo's live-data rule is "gates are invariants only" (see
   scripts/check-live-data.mjs), and rot discovered after the fact is exactly the kind of thing a
   loud, async flag handles better than a red, blocking CI run forever. Fabrication itself is
   still blocked at apply time (scripts/apply-judgment.mjs runs check-sources.mjs synchronously
   right after every judged-fit write) — this script is purely about ROT surfacing on an
   already-published claim.

   This script re-runs the same check over the SAME claim list check-sources.mjs gates — every
   judged-fit quote in data/models.json, every claim in data/guidance.json and every quoted row in
   data/plans.json (collectAllClaims/checkClaims, both from check-sources.mjs) — names the file each
   failing claim lives in, and:
     - always prints a markdown summary to stdout (the workflow appends it to
       $GITHUB_STEP_SUMMARY);
     - on a LIVE run (DRY_RUN !== 'true') with a GH token available, opens or updates a single,
       idempotent GitHub issue titled "Judged claims no longer verifiable" listing every failing
       claim, and closes that issue once nothing is failing — same idempotent-by-title pattern as
       scripts/auto-refresh.mjs's own reportIssue() for held facts.
   Always exits 0 — this is a report, never a gate (see the file header above).

   Usage: node scripts/report-claim-rot.mjs
   Env: REPORT_DATA_DIR / CHECK_SOURCES_PAGES (tests only: a data dir, a {url: html} page file);
        GH_TOKEN/GITHUB_TOKEN + GITHUB_REPOSITORY (set by Actions) to write the issue; DRY_RUN
        (passed through by the workflow) skips issue-writing when 'true'. */
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectAllClaims, checkClaims, fetchNormalizedPage, fixturePageFetcher } from './check-sources.mjs';

const ROOT = new URL('../', import.meta.url);
const ISSUE_TITLE = 'Sourced claims no longer verifiable';
const LEGACY_TITLES = ['Judged claims no longer verifiable']; // title before guidance + plans were reported
const ISSUE_LABEL = 'claim-rot';

async function reportIssue(failed) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (process.env.DRY_RUN === 'true') { console.log('report-claim-rot: DRY_RUN — skipping issue (would only report on a live run).'); return; }
  if (!token || !repo) { console.log('report-claim-rot: no GH_TOKEN/GITHUB_REPOSITORY — skipping issue (local run).'); return; }
  const api = (path, opts = {}) => fetch(`https://api.github.com/repos/${repo}${path}`, {
    ...opts,
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', ...(opts.headers || {}) },
  });
  const list = await api(`/issues?state=open&labels=${ISSUE_LABEL}`).then((r) => r.json());
  const existing = Array.isArray(list) ? list.find((i) => i.title === ISSUE_TITLE || LEGACY_TITLES.includes(i.title)) : null;

  if (!failed.length) {
    if (existing) await api(`/issues/${existing.number}`, { method: 'PATCH', body: JSON.stringify({ state: 'closed' }) });
    console.log('report-claim-rot: no failing claims — issue closed/absent.');
    return;
  }
  const body = [
    'scripts/check-sources.mjs (the anti-fabrication gate) found one or more sourced claims',
    "whose cited page no longer contains the quoted text — link rot on an already-published claim,",
    'not a new fabrication (that stays blocked at write time by scripts/apply-judgment.mjs\'s own',
    'hard gate). This never blocks publish; it\'s a plain flag for a person to look at when convenient.',
    '',
    ...failed.slice(0, 50).map(failLine),
    ...(failed.length > 50 ? [`- …and ${failed.length - 50} more (see the run summary)`] : []),
  ].join('\n');
  if (existing) {
    await api(`/issues/${existing.number}`, { method: 'PATCH', body: JSON.stringify({ title: ISSUE_TITLE, body }) });
    console.log(`report-claim-rot: updated issue #${existing.number}`);
  } else {
    const created = await api('/issues', { method: 'POST', body: JSON.stringify({ title: ISSUE_TITLE, body, labels: [ISSUE_LABEL] }) }).then((r) => r.json());
    console.log(`report-claim-rot: opened issue #${created.number}`);
  }
}

const FILE_OF = { models: 'data/models.json', guidance: 'data/guidance.json', plans: 'data/plans.json' };

/** One report row, naming the data file the failing claim lives in. */
export function failLine(r) {
  const file = FILE_OF[r.file || 'models'];
  return `- \`${file}\` **${r.modelName}** / \`${r.taskId}\` [${r.tier}] ${r.source_url} — ${r.reason}`;
}

/** The claims this report checks: the same full list check-sources.mjs gates (models + guidance +
 * plans). Each record carries `file`. Reads `dataDir` (default: this repo's data/). */
export function loadReportClaims(dataDir = fileURLToPath(new URL('data/', ROOT))) {
  const read = (name) => {
    const path = `${dataDir.replace(/\/$/, '')}/${name}`;
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
  };
  return collectAllClaims({ models: read('models.json'), guidance: read('guidance.json'), plans: read('plans.json') })
    .map((c) => ({ ...c, file: c.file || 'models' }));
}

async function main() {
  // REPORT_DATA_DIR / CHECK_SOURCES_PAGES: test-only overrides (a data copy, a {url: html} file).
  const claims = loadReportClaims(process.env.REPORT_DATA_DIR || undefined);
  const lines = ['# Claim-rot report (informational — never blocks publish)', ''];
  if (!claims.length) {
    lines.push('No sourced claims in data/models.json, data/guidance.json or data/plans.json to check.');
    console.log(lines.join('\n'));
    return;
  }
  const fetchImpl = process.env.CHECK_SOURCES_PAGES ? fixturePageFetcher(process.env.CHECK_SOURCES_PAGES) : fetchNormalizedPage;
  const results = await checkClaims(claims, { fetchImpl });
  const failed = results.filter((r) => !r.ok);
  const byFile = (f) => `${results.filter((r) => r.file === f && r.ok).length}/${results.filter((r) => r.file === f).length} in ${FILE_OF[f]}`;
  lines.push(`**${results.length - failed.length}/${results.length} claim(s) verified** (${['models', 'guidance', 'plans'].map(byFile).join(', ')}).`, '');
  if (failed.length) {
    lines.push('## Failing claims (link rot, not fabrication — never a publish blocker)', '');
    for (const r of failed) lines.push(failLine(r));
  } else {
    lines.push('All claims verified — every quote still appears on its cited source page.');
  }
  console.log(lines.join('\n'));

  await reportIssue(failed);
  process.exitCode = 0;
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try { return fileURLToPath(import.meta.url) === realpathSync(resolve(process.argv[1])); }
  catch { return fileURLToPath(import.meta.url) === process.argv[1]; }
})();
if (isMain) {
  main().catch((e) => { console.error(e); process.exitCode = 0; }); // never fail the job — report only
}
