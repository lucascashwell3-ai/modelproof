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

   This script re-runs the same check (collectClaims/checkClaims, both from check-sources.mjs) and:
     - always prints a markdown summary to stdout (the workflow appends it to
       $GITHUB_STEP_SUMMARY);
     - on a LIVE run (DRY_RUN !== 'true') with a GH token available, opens or updates a single,
       idempotent GitHub issue titled "Judged claims no longer verifiable" listing every failing
       claim, and closes that issue once nothing is failing — same idempotent-by-title pattern as
       scripts/auto-refresh.mjs's own reportIssue() for held facts.
   Always exits 0 — this is a report, never a gate (see the file header above).

   Usage: node scripts/report-claim-rot.mjs
   Env: GH_TOKEN/GITHUB_TOKEN + GITHUB_REPOSITORY (set by Actions) to write the issue; DRY_RUN
        (passed through by the workflow) skips issue-writing when 'true'. */
import { readFileSync } from 'node:fs';
import { collectClaims, checkClaims } from './check-sources.mjs';

const ROOT = new URL('../', import.meta.url);
const ISSUE_TITLE = 'Judged claims no longer verifiable';
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
  const existing = Array.isArray(list) ? list.find((i) => i.title === ISSUE_TITLE) : null;

  if (!failed.length) {
    if (existing) await api(`/issues/${existing.number}`, { method: 'PATCH', body: JSON.stringify({ state: 'closed' }) });
    console.log('report-claim-rot: no failing claims — issue closed/absent.');
    return;
  }
  const body = [
    'scripts/check-sources.mjs (the anti-fabrication gate) found one or more judged-fit claims',
    "whose cited page no longer contains the quoted text — link rot on an already-published claim,",
    'not a new fabrication (that stays blocked at write time by scripts/apply-judgment.mjs\'s own',
    'hard gate). This never blocks publish; it\'s a plain flag for a person to look at when convenient.',
    '',
    ...failed.slice(0, 50).map((r) => `- **${r.modelName}** / \`${r.taskId}\` [${r.tier}] ${r.source_url} — ${r.reason}`),
  ].join('\n');
  if (existing) {
    await api(`/issues/${existing.number}`, { method: 'PATCH', body: JSON.stringify({ body }) });
    console.log(`report-claim-rot: updated issue #${existing.number}`);
  } else {
    const created = await api('/issues', { method: 'POST', body: JSON.stringify({ title: ISSUE_TITLE, body, labels: [ISSUE_LABEL] }) }).then((r) => r.json());
    console.log(`report-claim-rot: opened issue #${created.number}`);
  }
}

async function main() {
  const data = JSON.parse(readFileSync(new URL('data/models.json', ROOT), 'utf8'));
  const claims = collectClaims(data);
  const lines = ['# Claim-rot report (informational — never blocks publish)', ''];
  if (!claims.length) {
    lines.push('No task_fit_judged claims in data/models.json to check.');
    console.log(lines.join('\n'));
    return;
  }
  const results = await checkClaims(claims);
  const failed = results.filter((r) => !r.ok);
  lines.push(`**${results.length - failed.length}/${results.length} claim(s) verified.**`, '');
  if (failed.length) {
    lines.push('## Failing claims (link rot, not fabrication — never a publish blocker)', '');
    for (const r of failed) lines.push(`- **${r.modelName}** / \`${r.taskId}\` [${r.tier}] ${r.source_url} — ${r.reason}`);
  } else {
    lines.push('All claims verified — every quote still appears on its cited source page.');
  }
  console.log(lines.join('\n'));

  await reportIssue(failed);
  process.exitCode = 0;
}

main().catch((e) => { console.error(e); process.exitCode = 0; }); // never fail the job — report only
