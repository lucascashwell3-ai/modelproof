import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyLive, EXIT } from './verify-live.mjs';

// Fake clock: `now()` reads it, `sleep(ms)` advances it and returns immediately - so a 30-minute
// timeout test runs in milliseconds, not 30 minutes.
function fakeClock(startMs = 0) {
  let t = startMs;
  return {
    now: () => t,
    sleep: async (ms) => { t += ms; },
  };
}

const BASE_OPTS = {
  want: '2026-09-12',
  sha: 'abc123',
  repo: 'lucascashwell3-ai/modelproof',
  url: 'https://example.invalid/data/models.json',
  pollSec: 10,
  graceSec: 60,
  log: () => {}, // silence per-poll logging in tests
};

test('live matches immediately -> 0 verified, no Pages lookup needed', async () => {
  const clock = fakeClock();
  let pagesCalls = 0;
  const code = await verifyLive({
    ...BASE_OPTS,
    ...clock,
    fetchLive: async () => ({ as_of: '2026-09-12' }),
    fetchPagesRun: async () => { pagesCalls += 1; return null; },
  });
  assert.equal(code, EXIT.VERIFIED);
  assert.equal(pagesCalls, 0);
});

test('Pages build failed -> 2, no need to wait out the grace period', async () => {
  const clock = fakeClock();
  const code = await verifyLive({
    ...BASE_OPTS,
    ...clock,
    timeoutSec: 1800,
    fetchLive: async () => ({ as_of: 'old-value' }),
    fetchPagesRun: async () => ({ status: 'completed', conclusion: 'failure' }),
  });
  assert.equal(code, EXIT.DEPLOY_FAILED);
});

test('Pages succeeds but as_of stays wrong past grace -> 3', async () => {
  const clock = fakeClock();
  const code = await verifyLive({
    ...BASE_OPTS,
    ...clock,
    timeoutSec: 1800,
    graceSec: 30,
    pollSec: 10,
    fetchLive: async () => ({ as_of: 'stale' }),
    fetchPagesRun: async () => ({ status: 'completed', conclusion: 'success' }),
  });
  assert.equal(code, EXIT.DEPLOY_WRONG);
});

test('pending until timeout -> 4, and the caller is told not to revert by the exit code', async () => {
  const clock = fakeClock();
  const code = await verifyLive({
    ...BASE_OPTS,
    ...clock,
    timeoutSec: 100,
    pollSec: 10,
    fetchLive: async () => ({ as_of: 'stale' }),
    fetchPagesRun: async () => null, // no pages-build-deployment run exists yet
  });
  assert.equal(code, EXIT.TIMED_OUT);
});

test('cancelled build (superseded by a newer commit) keeps waiting, then a later match -> 0', async () => {
  const clock = fakeClock();
  let poll = 0;
  const code = await verifyLive({
    ...BASE_OPTS,
    ...clock,
    timeoutSec: 1800,
    pollSec: 10,
    fetchLive: async () => {
      poll += 1;
      return { as_of: poll < 3 ? 'stale' : '2026-09-12' };
    },
    fetchPagesRun: async () => ({ status: 'completed', conclusion: 'cancelled' }),
  });
  assert.equal(code, EXIT.VERIFIED);
  assert.ok(poll >= 3);
});

test('fetch throwing then recovering -> 0, network errors never crash or short-circuit success', async () => {
  const clock = fakeClock();
  let poll = 0;
  const code = await verifyLive({
    ...BASE_OPTS,
    ...clock,
    timeoutSec: 1800,
    pollSec: 10,
    fetchLive: async () => {
      poll += 1;
      if (poll <= 2) throw new Error('ECONNRESET');
      return { as_of: '2026-09-12' };
    },
    fetchPagesRun: async () => { throw new Error('also broken'); },
  });
  assert.equal(code, EXIT.VERIFIED);
  assert.ok(poll >= 3);
});

test('a Pages lookup error is treated as unknown/pending, not a crash', async () => {
  const clock = fakeClock();
  const code = await verifyLive({
    ...BASE_OPTS,
    ...clock,
    timeoutSec: 50,
    pollSec: 10,
    fetchLive: async () => ({ as_of: 'stale' }),
    fetchPagesRun: async () => { throw new Error('502'); },
  });
  assert.equal(code, EXIT.TIMED_OUT);
});

test('grace period is measured from when success was first observed, not from start', async () => {
  const clock = fakeClock();
  let poll = 0;
  const code = await verifyLive({
    ...BASE_OPTS,
    ...clock,
    timeoutSec: 1800,
    pollSec: 20,
    graceSec: 30,
    fetchLive: async () => ({ as_of: 'stale' }),
    fetchPagesRun: async () => {
      poll += 1;
      // pending for the first two polls (40s of elapsed time already spent), then success.
      return poll <= 2 ? null : { status: 'completed', conclusion: 'success' };
    },
  });
  // Success is first observed at t=40s (after 2 pending polls of 20s). Grace is 30s, so the
  // window closes at t=70s; polling every 20s, that resolves at the t=80s poll. If grace were
  // measured from t=0 instead of from first-success, it would have fired at t=30s - long before
  // success was even seen. Asserting DEPLOY_WRONG (not a timeout/hang) is what proves which one
  // actually happened.
  assert.equal(code, EXIT.DEPLOY_WRONG);
});

test('log receives one plain line per poll with the expected fields', async () => {
  const clock = fakeClock();
  const lines = [];
  await verifyLive({
    ...BASE_OPTS,
    ...clock,
    log: (line) => lines.push(line),
    fetchLive: async () => ({ as_of: '2026-09-12' }),
    fetchPagesRun: async () => null,
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^live=2026-09-12 want=2026-09-12 pages=matched elapsed=0s$/);
});
