#!/usr/bin/env node
/* Claim-rot reporter — the companion to scripts/check-sources.mjs's anti-fabrication gate.
   A claim that verified fine when it was WRITTEN can go stale later because the third-party page
   it cites changed wording or went away. This script turns one check-sources sweep into a plain
   report and ONE idempotent GitHub issue. Fabrication itself stays blocked at write time
   (scripts/apply-judgment.mjs runs check-sources --only synchronously after every judged write).

   It separates the result kinds check-sources gives every claim:
     rot      not_found (the page no longer carries the quote) and gone (HTTP 404/410).
     blocked  the page could not be read from this machine (403/429/5xx/timeout/short body) —
              listed apart, never counted as rot.
     skipped  claims the sweep left out on purpose (check-sources --skip-ids, e.g. quotes an open
              data PR replaces).
   The issue "Sourced claims no longer verifiable" (label claim-rot) is opened/updated while any
   claim has rotted and closed once none has — blocked pages alone never keep it open. All
   GitHub writes go through scripts/lib/gh-issue.mjs (refused on dry runs, PR events and
   branches).

   Usage:
     node scripts/report-claim-rot.mjs [--results <file>]
       --results  read the results of a check-sources run (its --json-out file) instead of
                  fetching every page again — the normal way, right after the sweep.
       (no flag)  run the same check itself: every judged-fit quote in data/models.json, every
                  claim in data/guidance.json and every quoted row in data/plans.json.
   Prints a markdown summary to stdout (a workflow appends it to $GITHUB_STEP_SUMMARY).
   Always exits 0 — a report, never a gate (check-sources' own exit code is the gate).
   Env: REPORT_DATA_DIR / CHECK_SOURCES_PAGES (tests only: a data dir, a {url: html} page file);
        GH_TOKEN/GITHUB_TOKEN + GITHUB_REPOSITORY to write the issue; DRY_RUN='true' skips it. */
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectAllClaims, checkClaims, fetchNormalizedPage, fixturePageFetcher } from './check-sources.mjs';
import { upsertIssue, closeIssue } from './lib/gh-issue.mjs';

const ROOT = new URL('../', import.meta.url);
export const ISSUE_TITLE = 'Sourced claims no longer verifiable';
const LEGACY_TITLES = ['Judged claims no longer verifiable']; // title before guidance + plans were reported
const ISSUE_LABEL = 'claim-rot';

const FILE_OF = { models: 'data/models.json', guidance: 'data/guidance.json', plans: 'data/plans.json' };

/** One report row, naming the data file the claim lives in. */
export function failLine(r) {
  const file = FILE_OF[r.file || 'models'];
  return `- \`${file}\` **${r.modelName}** / \`${r.taskId}\` [${r.tier}] ${r.source_url} — ${r.reason}`;
}

/** Split check-sources results into {verified, rot, blocked}. A result without a `kind` (an
 * older results file) counts as rot when it failed — never silently dropped. */
export function splitResults(results) {
  const out = { verified: [], rot: [], blocked: [] };
  for (const r of results) {
    if (r.ok) out.verified.push(r);
    else if (r.kind === 'blocked') out.blocked.push(r);
    else out.rot.push(r);
  }
  return out;
}

/** The markdown report (stdout + step summary). */
export function reportLines({ results, skipped = [] }) {
  const withFile = results.map((r) => ({ ...r, file: r.file || 'models' }));
  const { rot, blocked } = splitResults(withFile);
  const byFile = (f) => `${withFile.filter((r) => r.file === f && r.ok).length}/${withFile.filter((r) => r.file === f).length} in ${FILE_OF[f]}`;
  const lines = ['# Claim-rot report', ''];
  lines.push(`**${withFile.length - rot.length - blocked.length}/${withFile.length} claim(s) verified** (${['models', 'guidance', 'plans'].map(byFile).join(', ')}). Rotted: ${rot.length}. Could not read: ${blocked.length}.${skipped.length ? ` Skipped (pending): ${skipped.length}.` : ''}`, '');
  if (rot.length) {
    lines.push('## Rotted: the quote is gone from its page, or the page is gone', '');
    for (const r of rot) lines.push(failLine(r));
    lines.push('');
  }
  if (blocked.length) {
    lines.push('## Could not read from here (blocked, timeout or server error) — not rot', '');
    for (const r of blocked) lines.push(failLine(r));
    lines.push('');
  }
  if (skipped.length) {
    lines.push('## Skipped: an open data change replaces these quotes', '');
    for (const k of skipped) lines.push(`- \`${k}\``);
    lines.push('');
  }
  if (!rot.length && !blocked.length) lines.push('All claims verified — every quote still appears on its cited source page.');
  return lines;
}

/** Open/update the one issue while anything has rotted; close it when nothing has. */
export async function reportIssue({ rot, blocked }, opts = {}) {
  if (!rot.length) return closeIssue({ title: ISSUE_TITLE, matchTitles: LEGACY_TITLES }, opts);
  const body = [
    'scripts/check-sources.mjs found sourced claims whose cited page no longer carries the quoted',
    'text, or no longer exists. That is link rot on an already-published claim: re-source the claim',
    'or retire it. New fabrication stays blocked at write time (scripts/apply-judgment.mjs).',
    '',
    `## Rotted (${rot.length})`,
    ...rot.slice(0, 50).map(failLine),
    ...(rot.length > 50 ? [`- …and ${rot.length - 50} more (see the run summary)`] : []),
    ...(blocked.length ? ['', `## Could not read from the runner (${blocked.length}) — not rot, listed for reference`,
      ...blocked.slice(0, 20).map(failLine), ...(blocked.length > 20 ? [`- …and ${blocked.length - 20} more`] : [])] : []),
  ].join('\n');
  return upsertIssue({ title: ISSUE_TITLE, body, labels: [ISSUE_LABEL], matchTitles: LEGACY_TITLES }, opts);
}

/** The claims this report checks when it runs the check itself: the same full list
 * check-sources.mjs gates (models + guidance + plans). Each record carries `file`. */
export function loadReportClaims(dataDir = fileURLToPath(new URL('data/', ROOT))) {
  const read = (name) => {
    const path = `${dataDir.replace(/\/$/, '')}/${name}`;
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
  };
  return collectAllClaims({ models: read('models.json'), guidance: read('guidance.json'), plans: read('plans.json') })
    .map((c) => ({ ...c, file: c.file || 'models' }));
}

function parseArgs(argv) {
  const out = { results: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--results') out.results = argv[++i];
    else if (argv[i].startsWith('--results=')) out.results = argv[i].slice(10);
    else throw new Error(`unknown argument "${argv[i]}" (usage: report-claim-rot.mjs [--results <file>])`);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let results;
  let skipped = [];
  if (args.results) {
    const file = JSON.parse(readFileSync(args.results, 'utf8'));
    results = file.results || [];
    skipped = file.skipped || [];
  } else {
    // REPORT_DATA_DIR / CHECK_SOURCES_PAGES: test-only overrides (a data copy, a {url: html} file).
    const claims = loadReportClaims(process.env.REPORT_DATA_DIR || undefined);
    if (!claims.length) {
      console.log('# Claim-rot report\n\nNo sourced claims in data/models.json, data/guidance.json or data/plans.json to check.');
      return;
    }
    const fetchImpl = process.env.CHECK_SOURCES_PAGES ? fixturePageFetcher(process.env.CHECK_SOURCES_PAGES) : fetchNormalizedPage;
    results = await checkClaims(claims, { fetchImpl });
  }
  console.log(reportLines({ results, skipped }).join('\n'));
  const split = splitResults(results.map((r) => ({ ...r, file: r.file || 'models' })));
  // Log lines go to stderr so a `>> $GITHUB_STEP_SUMMARY` redirect keeps only the report.
  await reportIssue(split, { log: (line) => console.error(`report-claim-rot: ${line}`) });
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try { return fileURLToPath(import.meta.url) === realpathSync(resolve(process.argv[1])); }
  catch { return fileURLToPath(import.meta.url) === process.argv[1]; }
})();
if (isMain) {
  main().catch((e) => { console.error(e); process.exitCode = 0; }); // never fail the job — report only
}
