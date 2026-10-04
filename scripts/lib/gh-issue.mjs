/* The one way a job in this repo writes to GitHub (issues, PRs, commit statuses, bot-branch
   deletes). Every write goes through ghWrite(), which:
     1. refuses — throws — any request that is not on the allowlist below: an issue, a label, a PR,
        a commit status, or deleting an `auto/...` branch, always on this repo
        (GITHUB_REPOSITORY). No workflow, dispatch, schedule, secret, hook or settings call can
        get through, so no job can create a trigger or re-arm itself through this module;
     2. skips — logs and returns null — every write when the run must not write at all:
        DRY_RUN=true, a pull_request event, a ref other than refs/heads/main, or no token/repo
        (a local run).
   Reads (ghRead) need a token and repo but are allowed in dry runs, so a dry run can print what
   it would do.

   Issues are idempotent by exact title: upsertIssue({title, body, labels}) creates the issue,
   or updates the open one with that title (no request at all when the body is unchanged);
   closeIssue({title}) closes it if it is open. `matchTitles` lists older titles that count as
   the same issue (renamed in place on the next update).

   Every function takes an optional last argument {env, fetchImpl, log} so tests never touch
   the network or the real environment. */

const API = 'https://api.github.com';

/** [method, repo-relative path pattern] pairs ghWrite lets through. Nothing else. */
export const WRITE_ALLOWLIST = [
  ['POST', /^\/issues$/],
  ['PATCH', /^\/issues\/\d+$/],
  ['POST', /^\/issues\/\d+\/comments$/],
  ['POST', /^\/issues\/\d+\/labels$/],
  ['POST', /^\/labels$/],
  ['POST', /^\/pulls$/],
  ['PATCH', /^\/pulls\/\d+$/],
  ['POST', /^\/statuses\/[0-9a-f]{40}$/],
  ['DELETE', /^\/git\/refs\/heads\/auto\/[A-Za-z0-9._\/-]+$/],
];

export function isAllowedWrite(method, path) {
  const m = String(method || '').toUpperCase();
  const p = String(path || '');
  if (p.includes('..')) return false;
  return WRITE_ALLOWLIST.some(([am, re]) => am === m && re.test(p));
}

/** Why this run must not write to GitHub at all, or null when it may. */
export function writeBlockReason(env = process.env) {
  if (env.DRY_RUN === 'true') return 'DRY_RUN=true';
  if (env.GITHUB_EVENT_NAME === 'pull_request' || env.GITHUB_EVENT_NAME === 'pull_request_target') return `${env.GITHUB_EVENT_NAME} event`;
  if (env.GITHUB_REF && env.GITHUB_REF !== 'refs/heads/main') return `ref ${env.GITHUB_REF} is not refs/heads/main`;
  if (!(env.GH_TOKEN || env.GITHUB_TOKEN) || !env.GITHUB_REPOSITORY) return 'no GH_TOKEN/GITHUB_REPOSITORY (local run)';
  return null;
}

function ctx(opts = {}) {
  const env = opts.env || process.env;
  return {
    env,
    token: env.GH_TOKEN || env.GITHUB_TOKEN,
    repo: env.GITHUB_REPOSITORY,
    fetchImpl: opts.fetchImpl || globalThis.fetch,
    log: opts.log || ((line) => console.log(line)),
  };
}

async function call(c, method, path, body) {
  const res = await c.fetchImpl(`${API}/repos/${c.repo}${path}`, {
    method,
    headers: { authorization: `Bearer ${c.token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const e = new Error(`GitHub ${method} ${path} -> HTTP ${res.status} ${text.slice(0, 200)}`);
    e.status = res.status;
    throw e;
  }
  return res.status === 204 ? null : res.json();
}

/** A guarded write. `path` is relative to /repos/<this repo> (e.g. "/issues/12"). Throws on a
 * request outside WRITE_ALLOWLIST (a bug, never data); returns null without sending anything
 * when writeBlockReason() says this run must not write; else the parsed response. */
export async function ghWrite({ method, path, body }, opts = {}) {
  if (!isAllowedWrite(method, path)) {
    throw new Error(`ghWrite refused: ${method} ${path} is not an issue, label, PR, commit status or auto/ branch delete`);
  }
  const c = ctx(opts);
  const blocked = writeBlockReason(c.env);
  if (blocked) { c.log(`gh: skipped ${method} ${path} (${blocked})`); return null; }
  return call(c, String(method).toUpperCase(), path, body);
}

/** A read (GET) on this repo. Returns null when there is no token/repo (local run). */
export async function ghRead(path, opts = {}) {
  const c = ctx(opts);
  if (!c.token || !c.repo) { c.log(`gh: skipped GET ${path} (no GH_TOKEN/GITHUB_REPOSITORY)`); return null; }
  return call(c, 'GET', path);
}

/** The open issue (never a PR) whose title is `title` or one of `matchTitles`, or null. */
export async function findOpenIssue({ title, matchTitles = [] }, opts = {}) {
  const want = new Set([title, ...matchTitles]);
  for (let page = 1; page <= 10; page += 1) {
    const list = await ghRead(`/issues?state=open&per_page=100&page=${page}`, opts);
    if (!Array.isArray(list)) return null;
    const hit = list.find((i) => !i.pull_request && want.has(i.title));
    if (hit) return hit;
    if (list.length < 100) return null;
  }
  return null;
}

/** Create the issue, or update the open one with this title. Idempotent: the same body twice
 * sends no write. Returns {action: 'created'|'updated'|'unchanged'|'skipped', number}. */
export async function upsertIssue({ title, body, labels = [], matchTitles = [] }, opts = {}) {
  const c = ctx(opts);
  const existing = await findOpenIssue({ title, matchTitles }, opts);
  if (existing) {
    if (existing.title === title && (existing.body || '') === body) {
      c.log(`gh: issue #${existing.number} "${title}" unchanged`);
      return { action: 'unchanged', number: existing.number };
    }
    const r = await ghWrite({ method: 'PATCH', path: `/issues/${existing.number}`, body: { title, body } }, opts);
    if (r === null) return { action: 'skipped', number: existing.number };
    c.log(`gh: updated issue #${existing.number} "${title}"`);
    return { action: 'updated', number: existing.number };
  }
  const created = await ghWrite({ method: 'POST', path: '/issues', body: { title, body, labels } }, opts);
  if (created === null) return { action: 'skipped', number: null };
  c.log(`gh: opened issue #${created.number} "${title}"`);
  return { action: 'created', number: created.number };
}

/** Close the open issue with this title, if there is one. Optional closing comment.
 * Returns {action: 'closed'|'absent'|'skipped', number}. */
export async function closeIssue({ title, matchTitles = [], comment = null }, opts = {}) {
  const c = ctx(opts);
  const existing = await findOpenIssue({ title, matchTitles }, opts);
  if (!existing) return { action: 'absent', number: null };
  if (comment) {
    const r = await ghWrite({ method: 'POST', path: `/issues/${existing.number}/comments`, body: { body: comment } }, opts);
    if (r === null) return { action: 'skipped', number: existing.number };
  }
  const r = await ghWrite({ method: 'PATCH', path: `/issues/${existing.number}`, body: { state: 'closed' } }, opts);
  if (r === null) return { action: 'skipped', number: existing.number };
  c.log(`gh: closed issue #${existing.number} "${existing.title}"`);
  return { action: 'closed', number: existing.number };
}
