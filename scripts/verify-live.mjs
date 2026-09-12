#!/usr/bin/env node
/* Verify a data publish actually went live, without punishing a slow GitHub Pages deploy.
   Fixes the failure in run 34716811582: auto-refresh.yml polled the live data/models.json for a
   fixed 5 minutes, saw Pages was still queued (not broken), and reverted a good commit. This
   module tells the difference between "still deploying" and "actually broken" by checking the
   `pages-build-deployment` Actions run for the commit, not just a clock.

   Four outcomes (see automation/jobs/auto-refresh/README.md "Failure behavior"):
     0 verified          - live as_of now matches `want`.
     2 DEPLOY_FAILED      - the Pages build for `sha` completed with conclusion "failure".
     3 DEPLOY_WRONG        - the Pages build completed "success" but as_of still doesn't match
                            `grace-sec` after that success was first seen.
     4 TIMED_OUT           - `timeout-sec` elapsed with the deploy still pending (never reached
                            a terminal state) - the caller must NOT revert; the deploy may still land.

   Importable (verifyLive, with every I/O call injectable for tests - see test-verify-live.mjs)
   and runnable directly as a CLI. No dependencies; Node 20's built-in fetch is all it uses. */

import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

export const EXIT = {
  VERIFIED: 0,
  DEPLOY_FAILED: 2,
  DEPLOY_WRONG: 3,
  TIMED_OUT: 4,
};

const PAGES_RUN_NAME = 'pages-build-deployment';

/** Default live-data fetcher: GETs `url`, returns { as_of } (as_of may be undefined). */
export async function defaultFetchLive(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`fetch ${url} -> HTTP ${res.status}`);
  const json = await res.json();
  return { as_of: json && json.as_of };
}

/** Default Pages-build lookup: the `pages-build-deployment` run for `sha`, or null if none yet. */
export async function defaultFetchPagesRun({ repo, sha, token }) {
  const url = `https://api.github.com/repos/${repo}/actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=20`;
  const headers = { Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`fetch ${url} -> HTTP ${res.status}`);
  const body = await res.json();
  const run = (body.workflow_runs || []).find((r) => r.name === PAGES_RUN_NAME);
  if (!run) return null;
  return { status: run.status, conclusion: run.conclusion };
}

/**
 * Poll until the live site matches `want`, or the Pages build for `sha` proves it never will
 * (failed, or succeeded-but-wrong), or `timeoutSec` runs out with the deploy still pending.
 * `fetchLive`, `fetchPagesRun`, `now`, `sleep` and `log` are all injectable so tests run instantly
 * on a fake clock instead of a real 15-second poll loop.
 */
export async function verifyLive(opts) {
  const {
    want, sha, repo, url,
    timeoutSec = 1800, pollSec = 15, graceSec = 180,
    token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
    fetchLive = defaultFetchLive,
    fetchPagesRun = defaultFetchPagesRun,
    now = () => Date.now(),
    sleep = (ms) => new Promise((r) => { setTimeout(r, ms); }),
    log = (line) => { console.log(line); },
  } = opts;

  const startMs = now();
  const deadlineMs = startMs + timeoutSec * 1000;
  let successSeenAtMs = null; // first time we saw a completed/success Pages build for `sha`

  for (;;) {
    const elapsed = Math.round((now() - startMs) / 1000);

    let liveAsOf;
    try {
      const live = await fetchLive(url);
      liveAsOf = live ? live.as_of : undefined;
    } catch {
      liveAsOf = undefined; // network error: unknown, never crash, never treat as a match
    }

    const matched = liveAsOf !== undefined && liveAsOf === want;

    let pagesRun = null;
    let pagesLabel = 'matched';
    if (!matched) {
      try {
        pagesRun = await fetchPagesRun({ repo, sha, token });
        pagesLabel = pagesRun ? `${pagesRun.status}/${pagesRun.conclusion}` : 'pending';
      } catch {
        pagesLabel = 'unknown';
      }
    }

    log(`live=${liveAsOf ?? 'unknown'} want=${want} pages=${pagesLabel} elapsed=${elapsed}s`);

    if (matched) return EXIT.VERIFIED;

    if (pagesRun && pagesRun.status === 'completed') {
      if (pagesRun.conclusion === 'failure') return EXIT.DEPLOY_FAILED;
      if (pagesRun.conclusion === 'success') {
        if (successSeenAtMs === null) successSeenAtMs = now();
        if (now() - successSeenAtMs >= graceSec * 1000) return EXIT.DEPLOY_WRONG;
      }
      // "cancelled" (a newer commit's build superseded this one) or any other completed
      // conclusion: fall through and keep waiting for as_of - not a verdict either way.
    }

    if (now() >= deadlineMs) return EXIT.TIMED_OUT;

    await sleep(pollSec * 1000);
  }
}

function parseCliArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      want: { type: 'string' },
      sha: { type: 'string' },
      repo: { type: 'string' },
      url: { type: 'string' },
      'timeout-sec': { type: 'string' },
      'poll-sec': { type: 'string' },
      'grace-sec': { type: 'string' },
    },
  });
  return {
    want: values.want ?? process.env.VERIFY_LIVE_WANT,
    sha: values.sha ?? process.env.VERIFY_LIVE_SHA ?? process.env.GITHUB_SHA,
    repo: values.repo ?? process.env.VERIFY_LIVE_REPO ?? process.env.GITHUB_REPOSITORY,
    url: values.url ?? process.env.VERIFY_LIVE_URL,
    timeoutSec: values['timeout-sec'] ? Number(values['timeout-sec']) : undefined,
    pollSec: values['poll-sec'] ? Number(values['poll-sec']) : undefined,
    graceSec: values['grace-sec'] ? Number(values['grace-sec']) : undefined,
  };
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  for (const req of ['want', 'sha', 'repo', 'url']) {
    if (!args[req]) {
      console.error(`verify-live: missing required --${req} (or its env var)`);
      process.exit(1);
    }
  }
  const code = await verifyLive({
    want: args.want,
    sha: args.sha,
    repo: args.repo,
    url: args.url,
    ...(args.timeoutSec !== undefined ? { timeoutSec: args.timeoutSec } : {}),
    ...(args.pollSec !== undefined ? { pollSec: args.pollSec } : {}),
    ...(args.graceSec !== undefined ? { graceSec: args.graceSec } : {}),
  });
  process.exit(code);
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try { return fileURLToPath(import.meta.url) === realpathSync(resolve(process.argv[1])); }
  catch { return fileURLToPath(import.meta.url) === process.argv[1]; }
})();
if (isMain) main();
