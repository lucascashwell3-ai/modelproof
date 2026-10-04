// scripts/defaults-watch.mjs — the weekly defaults watch. Every test runs on the frozen copies in
// scripts/fixtures/watch/ (data, catalog slice, watch list, page excerpts), never on data/ or the
// network, and on an in-memory GitHub + git (memoryRemote).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  loadFixtures, evaluate, evaluateGated, inProcessGate, runJob, memoryRemote, prBody, prTitle, fingerprint,
  declinedFrom, assertAllowedPaths, assertAsOfOnly, restampText, BRANCH_PATHS, MAIN_PATHS, ISSUE_TITLE,
  RECEIPT_PATH, json, runDrill, drillPages, getPath, latestClaim, fillPlaceholders, spanQuote, swapForms, nextClaimId,
  BOT_BRANCH,
} from './defaults-watch.mjs';
import { quoteFoundIn, normalizeText, collectGuidanceClaims } from './check-sources.mjs';
import { validateGuidance, validateWatchList } from './validate-data.mjs';

const fx = loadFixtures();
const TODAY = '2026-10-04';
const MC = 'https://code.claude.com/docs/en/model-config';
const gate = inProcessGate(fx.models);
const input = (over = {}) => ({ watch: fx.watch, data: fx.data, models: fx.models, aliases: fx.aliases, pages: fx.pages, today: TODAY, ...over });
function swap(url, from, to, pages = fx.pages) {
  assert.ok(pages[url].includes(from), `fixture page ${url} lacks "${from}"`);
  return { ...pages, [url]: pages[url].replace(from, to) };
}
const by = (res, id) => res.outcomes.find((o) => o.rule === id);
const kinds = (res) => res.outcomes.filter((o) => o.outcome !== 'ok').map((o) => `${o.rule}:${o.outcome}`);
const job = (over = {}) => runJob({ ...input(), gate, nowIso: `${TODAY}T01:23:00.000Z`, log: () => {}, ...over });
const freshRemote = (state = {}) => memoryRemote({ main: { 'data/guidance.json': json(fx.data.guidance) }, ...state });
const LEAD_SWAP = () => swap(MC, 'anthropic api : defaults to opus 5.5', 'anthropic api : defaults to sonnet 5.5');

test('frozen pages, frozen data: every rule ok and nothing written', () => {
  const res = evaluate(input());
  assert.deepEqual(kinds(res), []);
  assert.equal(res.outcomes.length, fx.watch.rules.length);
  assert.deepEqual(res.data, fx.data);
});

test('a swapped lead model: exactly one change, the data write, a new claim on the page, old claim superseded', () => {
  const pages = LEAD_SWAP();
  const res = evaluateGated(input({ pages }), gate);
  const changes = res.outcomes.filter((o) => o.outcome === 'change');
  assert.deepEqual(changes.map((o) => o.rule), ['cc-default-model']);
  assert.deepEqual(kinds(res), ['cc-default-model:change']);
  const g = res.data.guidance;
  assert.equal(getPath(res.data, 'guidance.tool_plans[tool=claude-code].lead.model_id'), 'claude-sonnet-5-5');
  const fresh = g.claims.find((c) => c.id === 'cc-default-model-sonnet-5-5');
  assert.ok(fresh, 'new claim id carries the new version');
  assert.equal(fresh.date, TODAY);
  assert.ok(quoteFoundIn(fresh.quote, normalizeText(pages[MC])), 'new quote is on the swapped page');
  assert.ok(!quoteFoundIn(fresh.quote, normalizeText(fx.pages[MC])), 'and not on the old page');
  assert.match(fresh.sentence, /Sonnet 5\.5/);
  const old = g.claims.find((c) => c.id === 'cc-default-model-opus-5-5');
  assert.equal(old.superseded_by, 'cc-default-model-sonnet-5-5');
  assert.equal(old.quote, fx.data.guidance.claims.find((c) => c.id === old.id).quote, 'old quote never edited');
  assert.ok(g.tool_plans[0].lead.basis.includes('cc-default-model-sonnet-5-5'));
  assert.ok(!JSON.stringify(g.tool_plans).includes('"cc-default-model-opus-5-5"'), 'no basis names the old claim');
  assert.ok(!collectGuidanceClaims(g).some((c) => c.claimId === old.id), 'check-sources skips the superseded claim');
  assert.deepEqual(validateGuidance(g, fx.models).errors, []);
  assert.deepEqual(res.data.plans, fx.data.plans, 'plans untouched');
});

test('after the lead model changes, a rule keyed to the lead reads the new lead\'s row (placeholders follow the data)', () => {
  let pages = LEAD_SWAP();
  pages = swap(MC, 'except that opus 5.5 and sonnet 5.5 default to medium', 'except that opus 5.5 defaults to medium and sonnet 5.5 defaults to low', pages);
  const res = evaluateGated(input({ pages }), gate);
  assert.deepEqual(kinds(res), ['cc-default-model:change', 'cc-effort-opus-5-5:change']);
  assert.equal(by(res, 'cc-effort-opus-5-5').captured, 'low');
  assert.equal(getPath(res.data, 'guidance.tool_plans[tool=claude-code].lead.effort'), 'low');
  const effortClaim = latestClaim(res.data.guidance, 'cc-effort-5-5-default-medium');
  assert.equal(effortClaim.id, 'cc-effort-5-5-default-low');
  assert.ok(quoteFoundIn(effortClaim.quote, normalizeText(pages[MC])));
  assert.match(effortClaim.sentence, /low as the default effort for Sonnet 5\.5/);
  // the same rule on the old data still reads Opus's row
  const filled = fillPlaceholders('{short:claude-code.lead}', { data: fx.data, byId: new Map(fx.models.map((m) => [m.id, m])) }, 'anchor');
  assert.equal(filled.text, 'opus 5.5');
});

test('a plan price change rewrites its plans.json row in place (price, quote, as_of)', () => {
  const pages = swap('https://devin.ai/pricing', 'pro $20/month', 'pro $25/month');
  const res = evaluateGated(input({ pages }), gate);
  assert.deepEqual(kinds(res), ['plan.devin.pro:change']);
  const row = res.data.plans.plans.find((p) => p.vendor === 'Devin' && p.plan === 'Pro');
  assert.equal(row.price_usd_month, 25);
  assert.equal(row.as_of, TODAY);
  assert.equal(row.quote, 'Pro $25/month');
  assert.ok(quoteFoundIn(row.quote, pages['https://devin.ai/pricing']));
  assert.equal(row.quote_url, undefined);
  const others = (plans) => plans.plans.filter((p) => !(p.vendor === 'Devin' && p.plan === 'Pro'));
  assert.deepEqual(others(res.data.plans), others(fx.data.plans));
  assert.deepEqual(res.data.guidance, fx.data.guidance);
  assert.deepEqual(by(res, 'plan.devin.pro').pending, ['plan/Devin/Pro']);
});

test('a model the catalog does not have: waiting:catalog, no write', () => {
  const res = evaluateGated(input({ pages: swap(MC, 'anthropic api : defaults to opus 5.5', 'anthropic api : defaults to opus 9.9') }), gate);
  assert.deepEqual(kinds(res), ['cc-default-model:waiting:catalog']);
  assert.deepEqual(res.data, fx.data);
  assert.deepEqual(by(res, 'cc-default-model').pending, ['cc-default-model-opus-5-5']);
});

test('a model the catalog lists as preview: waiting:not-ga, no write', () => {
  const models = fx.models.map((m) => (m.id === 'claude-sonnet-5-5' ? { ...m, status: 'preview' } : m));
  const res = evaluate(input({ pages: LEAD_SWAP(), models }));
  assert.equal(by(res, 'cc-default-model').outcome, 'waiting:not-ga');
  assert.deepEqual(res.data, fx.data);
});

test('anchor removed: broken:missing and the run is red', async () => {
  const pages = swap(MC, 'the behavior of default depends on your account type', 'something else entirely');
  const res = evaluate(input({ pages }));
  assert.equal(by(res, 'cc-default-model').outcome, 'broken:missing');
  const run = await job({ pages, remote: freshRemote() });
  assert.ok(run.red.some((r) => r.startsWith('cc-default-model: broken:missing')));
  assert.match(run.issue, /cc-default-model/);
});

test('a pattern that finds two different values: broken:ambiguous, never "first one wins"', () => {
  const url = 'https://docs.github.com/en/copilot/how-tos/use-ai-models/change-the-chat-model';
  const res = evaluate(input({ pages: swap(url, 'of your choice. note', 'of gpt-6.1 sol. note') }));
  assert.equal(by(res, 'copilot.lead.picker').outcome, 'broken:ambiguous');
});

test('a page that answers 404: broken:missing; 403: blocked (warning), red after 3 runs in a row', async () => {
  const url = 'https://devin.ai/pricing';
  const gone = evaluate(input({ pages: { ...fx.pages, [url]: { error: 'HTTP 404', kind: 'gone' } } }));
  assert.equal(by(gone, 'plan.devin.pro').outcome, 'broken:missing');
  const pages = { ...fx.pages, [url]: { error: 'HTTP 403', kind: 'blocked' } };
  const first = await job({ pages, remote: freshRemote() });
  assert.equal(by(first, 'plan.devin.pro').outcome, 'blocked');
  assert.deepEqual(first.red, []);
  assert.equal(first.receipt.blocked_runs[url], 1);
  assert.match(first.issue, /devin\.ai\/pricing — 1 run/);
  const third = await job({ pages, remote: freshRemote(), receipt: { blocked_runs: { [url]: 2 } } });
  assert.ok(third.red.some((r) => r.includes('blocked 3 runs')));
  const back = await job({ remote: freshRemote(), receipt: { blocked_runs: { [url]: 2 } } });
  assert.deepEqual(back.receipt.blocked_runs, {}, 'a page read again resets its count');
});

test('a flag rule whose page changed: needs-review in the issue with its question, not red, nothing written', async () => {
  const pages = swap('https://cursor.com/help/models-and-usage/available-models.md', '**[grok 4.7]', '**[grok 4.9]');
  const remote = freshRemote();
  const run = await job({ pages, remote });
  assert.equal(by(run, 'cursor-flagship').outcome, 'needs-review');
  assert.deepEqual(run.red, []);
  assert.match(run.issue, /cursor-flagship/);
  assert.match(run.issue, /Question: Cursor names a different flagship model/);
  assert.equal(run.prAction, 'none');
  assert.deepEqual(remote.actions.map((a) => a.kind), ['push-main', 'open-issue']);
  assert.deepEqual(remote.actions[0].files, [RECEIPT_PATH], 'not clean: receipt only, no re-stamp');
});

test('a second run on the same input does nothing new', async () => {
  const remote = freshRemote();
  const pages = LEAD_SWAP();
  const one = await job({ pages, remote });
  assert.equal(one.prAction, 'created');
  const first = remote.actions.splice(0);
  assert.deepEqual(first.map((a) => a.kind), ['push-branch', 'create-pr', 'status', 'push-main']);
  assert.deepEqual(first[0].files, ['data/guidance.json']);
  const two = await job({ pages, remote });
  assert.equal(two.prAction, 'unchanged');
  assert.deepEqual(remote.actions, []);
});

test('a new value while the PR is open updates that PR; no change left closes it and deletes the branch', async () => {
  const remote = freshRemote();
  await job({ pages: LEAD_SWAP(), remote });
  remote.actions.splice(0);
  const more = swap('https://devin.ai/pricing', 'pro $20/month', 'pro $25/month', LEAD_SWAP());
  const upd = await job({ pages: more, remote });
  assert.equal(upd.prAction, 'updated');
  assert.deepEqual(remote.actions.map((a) => a.kind), ['push-branch', 'edit-pr', 'status', 'push-main']);
  remote.actions.splice(0);
  const done = await job({ remote });
  assert.equal(done.prAction, 'closed');
  assert.deepEqual(remote.actions.map((a) => a.kind), ['close-pr', 'delete-branch', 'push-main']);
  assert.match(remote.state.pulls[0].body, /defaults-watch:closed-by-bot/);
  assert.equal(remote.state.pulls.length, 1, 'one PR number for the whole story');
});

test('declined: a bot PR closed without merging is not reopened until the page value changes again', async () => {
  const pages = LEAD_SWAP();
  const shown = evaluateGated(input({ pages }), gate);
  const closed = { number: 7, state: 'closed', merged_at: null, title: prTitle(shown.outcomes), body: prBody(shown.outcomes, { today: TODAY }) };
  assert.deepEqual([...declinedFrom([closed])], ['cc-default-model\tclaude-sonnet-5-5']);
  const remote = freshRemote({ pulls: [closed] });
  const run = await job({ pages, remote });
  assert.equal(by(run, 'cc-default-model').outcome, 'declined');
  assert.equal(run.prAction, 'none');
  assert.deepEqual(run.red, []);
  assert.ok(!remote.actions.some((a) => a.kind === 'create-pr'));
  const again = await job({ pages: swap(MC, 'anthropic api : defaults to opus 5.5', 'anthropic api : defaults to fable 5.1'), remote });
  assert.equal(again.prAction, 'created', 'a different value is a new change');
  // a PR the job closed itself is not a decline
  const botClosed = { ...closed, body: `${closed.body}\n<!-- defaults-watch:closed-by-bot -->` };
  assert.equal(declinedFrom([botClosed]).size, 0);
  assert.equal(declinedFrom([{ ...closed, merged_at: '2026-10-05T00:00:00Z' }]).size, 0);
});

test('the PR text is deterministic and carries the markers', () => {
  const a = evaluateGated(input({ pages: LEAD_SWAP() }), gate);
  const b = evaluateGated(input({ pages: LEAD_SWAP() }), gate);
  assert.equal(prBody(a.outcomes, { today: TODAY }), prBody(b.outcomes, { today: TODAY }));
  assert.equal(prTitle(a.outcomes), 'Defaults watch: 1 data change from vendor pages');
  const body = prBody(a.outcomes, { today: TODAY });
  assert.match(body, /<!-- defaults-watch:fingerprint=[0-9a-f]{16} -->/);
  assert.match(body, /<!-- defaults-watch:declined rule=cc-default-model value=claude-sonnet-5-5 -->/);
  assert.match(body, /claude-opus-5-5 → \*\*claude-sonnet-5-5\*\*/);
  const c = evaluateGated(input({ pages: swap(MC, 'anthropic api : defaults to opus 5.5', 'anthropic api : defaults to fable 5.1') }), gate);
  assert.notEqual(fingerprint(a.outcomes), fingerprint(c.outcomes));
});

test('allowed paths: the bot branch takes data only; main takes the receipt and an as_of-only guidance stamp', () => {
  assert.throws(() => assertAllowedPaths(['data/guidance.json', 'scripts/defaults-watch.mjs'], BRANCH_PATHS), /refusing to push scripts\/defaults-watch\.mjs/);
  assert.throws(() => assertAllowedPaths(['.github/workflows/defaults-watch.yml'], MAIN_PATHS), /refusing/);
  assert.throws(() => assertAllowedPaths(['data/plans.json'], MAIN_PATHS), /refusing/);
  assert.doesNotThrow(() => assertAllowedPaths(['data/guidance.json', 'data/plans.json'], BRANCH_PATHS));
  const text = json(fx.data.guidance);
  const stamped = restampText(text, '2026-12-01');
  assert.notEqual(stamped, text);
  assert.doesNotThrow(() => assertAsOfOnly(text, stamped));
  assert.throws(() => assertAsOfOnly(text, stamped.replace('"tool": "codex"', '"tool": "codex2"')), /more than the as_of line/);
});

test('re-stamp only on a clean run: never with an open change PR, a waiting rule, or a failed sweep', async () => {
  const clean = freshRemote();
  const run = await job({ remote: clean, sweepFn: async () => ({ failed: [] }) });
  assert.equal(run.clean, true);
  const push = clean.actions.find((a) => a.kind === 'push-main');
  assert.deepEqual(push.files.sort(), ['data/guidance.json', RECEIPT_PATH].sort());
  assert.equal(JSON.parse(clean.state.main['data/guidance.json']).as_of, TODAY);
  assertAsOfOnly(json(fx.data.guidance), clean.state.main['data/guidance.json']);

  const withPr = freshRemote();
  await job({ pages: LEAD_SWAP(), remote: withPr });
  assert.deepEqual(withPr.actions.find((a) => a.kind === 'push-main').files, [RECEIPT_PATH]);

  const waiting = freshRemote();
  await job({ pages: swap(MC, 'anthropic api : defaults to opus 5.5', 'anthropic api : defaults to opus 9.9'), remote: waiting });
  assert.deepEqual(waiting.actions.find((a) => a.kind === 'push-main').files, [RECEIPT_PATH]);

  const rot = freshRemote();
  let skipped = null;
  const r = await job({ remote: rot, sweepFn: async (ids) => { skipped = ids; return { failed: [{ key: 'guidance/x', source_url: 'https://example.com', kind: 'not_found' }] }; } });
  assert.deepEqual(skipped, []);
  assert.equal(r.clean, false);
  assert.ok(r.red.some((x) => x.startsWith('source sweep')));
  assert.deepEqual(rot.actions.find((a) => a.kind === 'push-main').files, [RECEIPT_PATH]);
});

test('the sweep skips the quotes a pending change replaces', async () => {
  let skipped = null;
  await job({ pages: LEAD_SWAP(), remote: freshRemote(), sweepFn: async (ids) => { skipped = ids; return { failed: [] }; } });
  assert.deepEqual(skipped, ['cc-default-model-opus-5-5']);
});

test('each change is gated alone: a change that breaks the data is reported (red), the others still ship', async () => {
  let pages = swap('https://code.claude.com/docs/en/settings-reference', 'one of "low" , "medium" , "high"', 'one of "low" , "high"');
  pages = swap('https://devin.ai/pricing', 'pro $20/month', 'pro $25/month', pages);
  const res = evaluateGated(input({ pages }), gate);
  assert.equal(by(res, 'cc-effort-levels').outcome, 'gate-failed');
  assert.match(by(res, 'cc-effort-levels').reason, /effort/);
  assert.equal(by(res, 'plan.devin.pro').outcome, 'change');
  assert.deepEqual(getPath(res.data, 'guidance.tool_plans[tool=claude-code].effort_levels.values'), ['low', 'medium', 'high', 'xhigh', 'max']);
  const run = await job({ pages, remote: freshRemote() });
  assert.ok(run.red.some((r) => r.startsWith('cc-effort-levels: gate-failed')));
  assert.equal(run.prAction, 'created');
});

test('problems main already has never block a change', () => {
  const stale = () => ['plans: an old problem on main'];
  const res = evaluateGated(input({ pages: LEAD_SWAP() }), stale);
  assert.equal(by(res, 'cc-default-model').outcome, 'change');
});

test('a new Codex helper model also gets a model_refs row for the string the page uses', () => {
  const url = 'https://developers.openai.com/codex/subagents';
  const pages = swap(url, 'use gpt-6-luna when you want a faster', 'use gpt-6-luna-pro when you want a faster');
  const res = evaluateGated(input({ pages }), gate);
  assert.equal(by(res, 'codex-subagent-lighter').outcome, 'change');
  const g = res.data.guidance;
  const row = g.model_refs.find((r) => r.tool === 'codex' && r.ref === 'gpt-6-luna-pro');
  assert.ok(row);
  assert.equal(row.model_id, 'gpt-6-luna-pro');
  assert.equal(getPath(res.data, 'guidance.tool_plans[tool=codex].bulk.model_id'), 'gpt-6-luna-pro');
  const fresh = latestClaim(g, 'codex-luna-lighter-subagent-work');
  assert.deepEqual(row.basis, [fresh.id]);
  assert.ok(quoteFoundIn(fresh.quote, pages[url]));
  assert.deepEqual(validateGuidance(g, fx.models).errors, []);
});

test('quote helpers: a long match is cut to 25 whole words ending with the value; swaps keep case and number edges', () => {
  const page = `${Array.from({ length: 40 }, (_, i) => `w${i}`).join(' ')} value here`;
  const ms = 0;
  const cs = page.indexOf('value');
  const q = spanQuote(page, [ms, page.length], [cs, cs + 5]);
  assert.equal(q.split(' ').length, 25);
  assert.ok(q.endsWith('value'));
  assert.equal(swapForms('Defaults to Opus 5.5 today', [['opus 5.5', 'sonnet 5.7']]), 'Defaults to Sonnet 5.7 today');
  assert.equal(swapForms('$20 and $200', [['$20', '$25']]), '$25 and $200');
  assert.equal(nextClaimId('codex-6-1-sol-default-catalog', [['gpt-6-1-sol', 'gpt-6-2-sol'], ['6-1-sol', '6-2-sol']], new Set(), TODAY), 'codex-6-2-sol-default-catalog');
  assert.equal(nextClaimId('anthropic-model-ids', [], new Set(), TODAY), 'anthropic-model-ids-20261004');
});

test('the drill: pass 2 opens exactly one PR, pass 3 writes nothing', async () => {
  const d = await runDrill(() => {});
  assert.equal(d.ok, true);
  const prs = d.pass2.filter((a) => a.kind === 'create-pr');
  assert.equal(prs.length, 1);
  assert.deepEqual(d.pass3, []);
  assert.ok(drillPages(fx)[fx.drill.url].includes(fx.drill.to));
});

test('the watch list schema: the frozen list passes; stored expectations, double baselines, bad paths and bad patterns fail', () => {
  assert.deepEqual(validateWatchList(fx.watch, fx.data), { errors: [], warnings: [] });
  const rules = fx.watch.rules;
  const one = (r) => validateWatchList({ ...fx.watch, rules: [r] }, fx.data).errors;
  const warns = (r) => validateWatchList({ ...fx.watch, rules: [r] }, fx.data).warnings;
  const field = rules.find((r) => r.id === 'cc-default-model');
  const flag = rules.find((r) => r.id === 'cursor-flagship');
  assert.match(one({ ...field, expected: 'opus 5.5' }).join('\n'), /never stores the value it expects/);
  assert.match(one({ ...flag, maps_to: 'guidance.tool_plans[tool=cursor].helpers.model' }).join('\n'), /exactly one of maps_to/);
  // data-dependent findings are warnings: the honesty gate never blocks a data write over the watch list
  assert.match(warns({ ...field, maps_to: 'guidance.tool_plans[tool=nope].lead.model_id' }).join('\n'), /does not resolve/);
  assert.deepEqual(one({ ...field, maps_to: 'guidance.tool_plans[tool=nope].lead.model_id' }), []);
  assert.match(one({ ...field, maps_to: 'models.whatever' }).join('\n'), /must start with guidance\. or plans\./);
  assert.match(one({ ...field, pattern: 'no group here' }).join('\n'), /capture group/);
  assert.match(one({ ...field, pattern: '(unclosed' }).join('\n'), /does not compile/);
  assert.match(warns({ ...field, also: ['guidance.tool_plans[tool=claude-code].bulk.model_id'] }).join('\n'), /different value than maps_to/);
  assert.match(one({ ...field, sentence: undefined }).join('\n'), /sentence is required/);
  assert.match(warns({ ...field, claim_ids: ['no-such-claim'] }).join('\n'), /not a claim id/);
  assert.match(one({ ...flag, claim_ids: ['cc-default-model-opus-5-5'] }).join('\n'), /a flag rule writes nothing/);
  assert.match(one({ ...field, anchor: '{short:claude-code.nowhere}' }).join('\n'), /names no slot/);
  assert.match(validateWatchList({ ...fx.watch, rules: [field, field] }, fx.data).errors.join('\n'), /used twice/);
});

test('a superseded guidance claim: validate-data accepts it, needs a real target, and no basis may name it', () => {
  const g = JSON.parse(JSON.stringify(fx.data.guidance));
  const c = g.claims.find((x) => x.id === 'cc-alias-fable-resolves');
  c.superseded_by = 'cc-default-model-opus-5-5';
  const errs = validateGuidance(g, fx.models).errors.join('\n');
  assert.match(errs, /names "cc-alias-fable-resolves", which is superseded/);
  c.superseded_by = 'no-such-claim';
  assert.match(validateGuidance(g, fx.models).errors.join('\n'), /superseded_by "no-such-claim" must be the id of another claim/);
});

test('never re-arms: the workflow and the script create no trigger, schedule or dispatch; every remote write is guarded', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const yml = readFileSync(`${root}.github/workflows/defaults-watch.yml`, 'utf8');
  const src = readFileSync(`${root}scripts/defaults-watch.mjs`, 'utf8');
  for (const [name, text] of [['workflow', yml], ['script', src]]) {
    for (const bad of [/gh\s+workflow/, /\/dispatches/, /repository_dispatch/, /workflow_run/, /\/actions\/workflows/, /crontab/, /gh\s+api/, /anthropic\.com\/v1|api\.openai\.com/]) {
      assert.ok(!bad.test(text), `${name} contains ${bad}`);
    }
  }
  // the script writes to GitHub only through gh-issue.mjs's ghWrite, and pushes only the allowed paths
  assert.ok(!/fetch\(\s*['"`]https:\/\/api\.github\.com/.test(src), 'no direct GitHub API writes');
  assert.ok(/assertAllowedPaths\(Object\.keys\(files\), BRANCH_PATHS\)/.test(src) && /assertAllowedPaths\(Object\.keys\(files\), MAIN_PATHS\)/.test(src));
  // one schedule entry, and the live step carries the full guard
  assert.equal((yml.match(/- cron:/g) || []).length, 1);
  const steps = yml.split(/\n\s+- name: /).slice(1);
  const tokenSteps = steps.filter((s) => /GH_TOKEN|GITHUB_TOKEN|--live/.test(s));
  assert.ok(tokenSteps.length >= 1);
  for (const s of tokenSteps) {
    assert.match(s, /if: env\.DRY_RUN != 'true' && github\.ref == 'refs\/heads\/main' && github\.event_name != 'pull_request'/, `unguarded step: ${s.split('\n')[0]}`);
  }
  // the pull_request job runs on a read-only token
  const prJob = yml.slice(yml.indexOf('  dry-run:'));
  assert.match(prJob, /permissions:\n\s+contents: read/);
  assert.ok(!/: write/.test(prJob), 'the pull_request dry run has no write permission');
  assert.ok(!/GH_TOKEN|--live/.test(prJob), 'and no token or live step');
});

test(`the bot branch and the issue title are fixed (${BOT_BRANCH}, "${ISSUE_TITLE}")`, () => {
  assert.equal(BOT_BRANCH, 'auto/defaults-watch');
  assert.ok(ISSUE_TITLE.length > 10);
});
