#!/usr/bin/env node
/* Files/updates the one "Needs Lucas — modelproof data refresh" GitHub issue from the Judge's
   held items. Idempotent by title (same pattern as auto-refresh.mjs's reportIssue). Closes the
   issue automatically when there's nothing held.

   Usage: node scripts/needs-lucas-issue.mjs <judgments.json>
   Env:   GH_TOKEN / GITHUB_TOKEN, GITHUB_REPOSITORY ("owner/repo") — set by Actions/the routine;
          without them this prints and exits without touching GitHub (safe for local runs).
*/
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export async function reportHeldIssue(held, { token, repo, fetchImpl = fetch } = {}) {
  if (!token || !repo) { console.log('needs-lucas-issue: no GH_TOKEN/GITHUB_REPOSITORY — skipping (local run).'); return; }
  const title = 'Needs Lucas — modelproof data refresh';
  const api = (path, opts = {}) => fetchImpl(`https://api.github.com/repos/${repo}${path}`, {
    ...opts,
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', ...(opts.headers || {}) },
  });
  const list = await api('/issues?state=open&labels=data-refresh').then((r) => r.json());
  const existing = Array.isArray(list) ? list.find((i) => i.title === title) : null;

  if (!held.length) {
    if (existing) await api(`/issues/${existing.number}`, { method: 'PATCH', body: JSON.stringify({ state: 'closed' }) });
    console.log('needs-lucas-issue: no held items — issue closed/absent.');
    return;
  }
  const body = ['The Judge held these items for human review — evidence was missing, thin, or ' +
    'contradictory. Nothing here was invented or guessed.', '',
    ...held.slice(0, 50).map((h) => `- **${h.id}**: ${h.reason}`)].join('\n');
  if (existing) {
    await api(`/issues/${existing.number}`, { method: 'PATCH', body: JSON.stringify({ body }) });
    console.log(`needs-lucas-issue: updated issue #${existing.number}`);
  } else {
    const created = await api('/issues', { method: 'POST', body: JSON.stringify({ title, body, labels: ['data-refresh'] }) }).then((r) => r.json());
    console.log(`needs-lucas-issue: opened issue #${created.number}`);
  }
}

async function main() {
  const file = process.argv[2];
  if (!file) { console.error('usage: node scripts/needs-lucas-issue.mjs <judgments.json>'); process.exitCode = 1; return; }
  const judgments = JSON.parse(readFileSync(file, 'utf8'));
  const held = judgments.filter((j) => j.hold);
  await reportHeldIssue(held, {
    token: process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
    repo: process.env.GITHUB_REPOSITORY,
  });
}

import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
const isMain = (() => {
  if (!process.argv[1]) return false;
  try { return fileURLToPath(import.meta.url) === realpathSync(resolve(process.argv[1])); }
  catch { return fileURLToPath(import.meta.url) === process.argv[1]; }
})();
if (isMain) {
  main().catch((e) => { console.error(e); process.exitCode = 1; });
}
