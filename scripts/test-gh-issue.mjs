// scripts/lib/gh-issue.mjs: the one guarded way jobs write to GitHub. A fake GitHub (in-memory
// issues, every request recorded) stands in for the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedWrite, writeBlockReason, ghWrite, upsertIssue, closeIssue, findOpenIssue } from './lib/gh-issue.mjs';

const LIVE = { GH_TOKEN: 't', GITHUB_REPOSITORY: 'acme/site', GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'schedule' };

function fakeGitHub(issues = []) {
  const state = { issues: issues.map((i) => ({ ...i })), requests: [] };
  state.fetchImpl = async (url, init = {}) => {
    const method = init.method || 'GET';
    const u = new URL(url);
    const path = u.pathname.replace(/^\/repos\/acme\/site/, '');
    state.requests.push(`${method} ${path}${u.search}`);
    const body = init.body ? JSON.parse(init.body) : null;
    const json = (status, v) => ({ ok: status < 400, status, json: async () => v, text: async () => JSON.stringify(v) });
    if (method === 'GET' && path === '/issues') {
      const page = Number(u.searchParams.get('page') || 1);
      return json(200, page === 1 ? state.issues.filter((i) => i.state === 'open') : []);
    }
    if (method === 'POST' && path === '/issues') {
      const issue = { number: 100 + state.issues.length, state: 'open', ...body };
      state.issues.push(issue);
      return json(201, issue);
    }
    const m = path.match(/^\/issues\/(\d+)(\/comments)?$/);
    if (m) {
      const issue = state.issues.find((i) => i.number === Number(m[1]));
      if (m[2]) return json(201, { id: 1 });
      Object.assign(issue, body);
      return json(200, issue);
    }
    return json(404, { message: 'not found' });
  };
  return state;
}
const quiet = () => {};

test('isAllowedWrite: issues, labels, PRs, commit statuses and auto/ branch deletes only', () => {
  for (const [m, p] of [['POST', '/issues'], ['PATCH', '/issues/12'], ['POST', '/issues/12/comments'], ['POST', '/labels'],
    ['POST', '/pulls'], ['PATCH', '/pulls/7'], ['POST', `/statuses/${'a'.repeat(40)}`], ['DELETE', '/git/refs/heads/auto/defaults-watch']]) {
    assert.ok(isAllowedWrite(m, p), `${m} ${p}`);
  }
  for (const [m, p] of [
    ['POST', '/actions/workflows/x.yml/dispatches'], ['POST', '/dispatches'], ['PUT', '/actions/workflows/1/enable'],
    ['POST', '/hooks'], ['PUT', '/actions/secrets/X'], ['DELETE', '/git/refs/heads/main'], ['PATCH', '/git/refs/heads/auto/x'],
    ['DELETE', '/git/refs/heads/auto/../main'], ['PATCH', ''], ['DELETE', '/issues/3'], ['POST', '/merges'], ['PUT', '/pulls/7/merge'],
  ]) {
    assert.equal(isAllowedWrite(m, p), false, `${m} ${p}`);
  }
});

test('writeBlockReason: dry run, pull_request event, a branch ref, or no token all block every write', () => {
  assert.equal(writeBlockReason(LIVE), null);
  assert.match(writeBlockReason({ ...LIVE, DRY_RUN: 'true' }), /DRY_RUN/);
  assert.match(writeBlockReason({ ...LIVE, GITHUB_EVENT_NAME: 'pull_request' }), /pull_request/);
  assert.match(writeBlockReason({ ...LIVE, GITHUB_REF: 'refs/heads/c2/x' }), /not refs\/heads\/main/);
  assert.match(writeBlockReason({ GITHUB_REPOSITORY: 'acme/site' }), /local run/);
  assert.equal(writeBlockReason({ GH_TOKEN: 't', GITHUB_REPOSITORY: 'acme/site' }), null, 'a local run with a token may write (no ref set)');
});

test('ghWrite: refuses a non-allowlisted call even on a live run; sends nothing on a dry run', async () => {
  const gh = fakeGitHub();
  await assert.rejects(ghWrite({ method: 'POST', path: '/actions/workflows/x.yml/dispatches', body: {} }, { env: LIVE, fetchImpl: gh.fetchImpl, log: quiet }), /refused/);
  assert.equal(await ghWrite({ method: 'POST', path: '/issues', body: { title: 'x' } }, { env: { ...LIVE, DRY_RUN: 'true' }, fetchImpl: gh.fetchImpl, log: quiet }), null);
  assert.deepEqual(gh.requests, []);
});

test('upsertIssue: creates once, then updates in place, then sends no write for the same body', async () => {
  const gh = fakeGitHub([{ number: 5, state: 'open', title: 'Other', body: '' }]);
  const o = { env: LIVE, fetchImpl: gh.fetchImpl, log: quiet };
  assert.deepEqual(await upsertIssue({ title: 'Job failing', body: 'a', labels: ['x'] }, o), { action: 'created', number: 101 });
  assert.deepEqual(await upsertIssue({ title: 'Job failing', body: 'b', labels: ['x'] }, o), { action: 'updated', number: 101 });
  const before = gh.requests.length;
  assert.deepEqual(await upsertIssue({ title: 'Job failing', body: 'b', labels: ['x'] }, o), { action: 'unchanged', number: 101 });
  assert.ok(gh.requests.slice(before).every((r) => r.startsWith('GET')), 'no write for an unchanged body');
  assert.equal(gh.issues.filter((i) => i.title === 'Job failing').length, 1, 'exactly one issue by title');
});

test('upsertIssue: an older title counts as the same issue and is renamed', async () => {
  const gh = fakeGitHub([{ number: 35, state: 'open', title: 'Old name', body: 'x' }]);
  const r = await upsertIssue({ title: 'New name', body: 'y', matchTitles: ['Old name'] }, { env: LIVE, fetchImpl: gh.fetchImpl, log: quiet });
  assert.deepEqual(r, { action: 'updated', number: 35 });
  assert.equal(gh.issues[0].title, 'New name');
});

test('closeIssue: closes the open issue by title; absent is a no-op; a pull request with that title is ignored', async () => {
  const gh = fakeGitHub([{ number: 9, state: 'open', title: 'Job failing', body: '', pull_request: {} }, { number: 10, state: 'open', title: 'Job failing', body: '' }]);
  const o = { env: LIVE, fetchImpl: gh.fetchImpl, log: quiet };
  assert.equal((await findOpenIssue({ title: 'Job failing' }, o)).number, 10);
  assert.deepEqual(await closeIssue({ title: 'Job failing', comment: 'green again' }, o), { action: 'closed', number: 10 });
  assert.equal(gh.issues[1].state, 'closed');
  assert.deepEqual(await closeIssue({ title: 'Job failing' }, o), { action: 'absent', number: null });
});

test('upsertIssue / closeIssue on a dry run or a branch: reads only, never a write', async () => {
  const gh = fakeGitHub([{ number: 3, state: 'open', title: 'Job failing', body: 'old' }]);
  for (const env of [{ ...LIVE, DRY_RUN: 'true' }, { ...LIVE, GITHUB_REF: 'refs/heads/feature' }, { ...LIVE, GITHUB_EVENT_NAME: 'pull_request' }]) {
    const o = { env, fetchImpl: gh.fetchImpl, log: quiet };
    assert.equal((await upsertIssue({ title: 'Job failing', body: 'new' }, o)).action, 'skipped');
    assert.equal((await upsertIssue({ title: 'Brand new', body: 'x' }, o)).action, 'skipped');
    assert.equal((await closeIssue({ title: 'Job failing' }, o)).action, 'skipped');
  }
  assert.ok(gh.requests.every((r) => r.startsWith('GET')), gh.requests.join('\n'));
  assert.equal(gh.issues[0].body, 'old');
});
