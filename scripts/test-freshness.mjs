// The freshness stamps and stale notices (assets/freshness.mjs) and where the pages put them.
//
//   node --test scripts/test-freshness.mjs
//
// Every date here is a frozen fixture or computed from a frozen clock: nothing reads data/, so a
// quiet week in the live data can never turn this red. The stale drill on a full copy of the data
// lives in test-new-release-drill.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as FR from '../assets/freshness.mjs';
import * as BD from '../assets/board-data.mjs';
import { FEEDS } from './validate-data.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const NOW = Date.parse('2026-10-04T12:00:00Z');
const back = (n, now = NOW) => new Date(Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate()) - n * 86_400_000).toISOString().slice(0, 10);

test('every limit and alias names a FEEDS id; aliases point at a feed with a limit', () => {
  const ids = new Set(FEEDS.map((f) => f.id));
  for (const id of Object.keys(FR.FEED_FRESHNESS)) assert.ok(ids.has(id), `${id} is not a FEEDS id`);
  for (const [alias, to] of Object.entries(FR.FEED_ALIASES)) {
    assert.ok(ids.has(alias), `alias ${alias} is not a FEEDS id`);
    assert.ok(FR.FEED_FRESHNESS[to], `alias ${alias} points at ${to}, which has no limit`);
  }
  for (const [id, lim] of Object.entries(FR.FEED_FRESHNESS)) {
    assert.ok(Number.isInteger(lim.maxDays) && lim.maxDays > 0, `${id} maxDays`);
    assert.ok(typeof lim.cadence === 'string' && lim.cadence.length > 0, `${id} cadence`);
  }
});

test('boundary: exactly the limit is fresh, one day past it is stale, for every feed and alias', () => {
  const feeds = [...Object.keys(FR.FEED_FRESHNESS), ...Object.keys(FR.FEED_ALIASES)];
  for (const feed of feeds) {
    const max = FR.feedLimits(feed).maxDays;
    assert.equal(FR.isStale(feed, back(max), NOW), false, `${feed} at ${max} days`);
    assert.equal(FR.staleText(feed, back(max), NOW), '', `${feed} at ${max} days has no notice`);
    assert.equal(FR.isStale(feed, back(max + 1), NOW), true, `${feed} at ${max + 1} days`);
    assert.match(FR.staleText(feed, back(max + 1), NOW), new RegExp(`^Not updated in ${max + 1} days\\. Usually updated ${FR.feedLimits(feed).cadence}\\. Check the source before relying on it\\.$`));
  }
});

test('ageDays counts whole UTC days, clamps the future to 0, and gives null for a non-date', () => {
  assert.equal(FR.ageDays('2026-10-03', Date.parse('2026-10-03T00:00:00Z')), 0);
  assert.equal(FR.ageDays('2026-10-03', Date.parse('2026-10-03T23:59:59Z')), 0);
  assert.equal(FR.ageDays('2026-10-03', Date.parse('2026-10-04T00:00:00Z')), 1);
  assert.equal(FR.ageDays('2026-10-03', new Date('2026-10-10T08:00:00Z')), 7, 'a Date works as well as a timestamp');
  assert.equal(FR.ageDays('2026-12-31', Date.parse('2027-01-01T00:00:01Z')), 1, 'across a year end');
  assert.equal(FR.ageDays('2026-10-05', NOW), 0, 'a future date (viewer clock behind UTC) counts as 0');
  assert.equal(FR.isStale('models', '2026-10-05', NOW), false, 'and is fresh');
  for (const junk of [undefined, null, '', 'soon', '2026-10', '2026-13-01', '2026-02-30', '03/10/2026']) {
    assert.equal(FR.ageDays(junk, NOW), null, `ageDays(${JSON.stringify(junk)})`);
  }
  assert.equal(FR.ageDays('2026-10-03', NaN), null, 'a broken clock is no age');
});

test('a missing or broken date is stale and says so; a feed with no limit never is', () => {
  for (const asOf of [undefined, null, '', 'not a date', '2026-02-30']) {
    assert.equal(FR.isStale('models', asOf, NOW), true, JSON.stringify(asOf));
    assert.equal(FR.stampText(asOf), 'Date not on file');
    assert.equal(FR.stampText(asOf, { label: 'Plan prices' }), 'Plan prices: date not on file');
    assert.match(FR.staleText('plans', asOf, NOW), /^No date on file\. Usually updated about every two weeks\. Check the source/);
    assert.match(FR.staleText('plans', asOf, NOW, { label: 'Plan prices' }), /^Plan prices: no date on file\./);
  }
  for (const feed of ['tasks', 'usage-presets', 'board-samples', 'no-such-feed']) {
    assert.equal(FR.isStale(feed, undefined, NOW), false, feed);
    assert.equal(FR.staleText(feed, back(999), NOW), '', feed);
  }
});

test('stampText formats the data\'s own date; a label leads it', () => {
  assert.equal(FR.stampText('2026-10-03'), 'As of 3 Oct 2026');
  assert.equal(FR.stampText('2026-01-09', { label: 'Model prices' }), 'Model prices as of 9 Jan 2026');
  assert.equal(FR.staleText('vendors', back(91), NOW, { label: 'Vendor countries' }),
    'Vendor countries not updated in 91 days. Usually updated by hand. Check the source before relying on it.');
  assert.match(FR.staleText('models', back(1), NOW + 7 * 86_400_000), /^Not updated in 8 days/);
});

test('the shared markup: a <time> with the data date, the notice only when stale, labels escaped', () => {
  const fresh = FR.freshHtml('models', '2026-10-03', { now: NOW });
  assert.equal(fresh, '<span class="mp-fresh"><time class="mp-asof" datetime="2026-10-03">As of 3 Oct 2026</time></span>');
  const stale = FR.freshHtml('plans', back(31), { now: NOW, label: 'Plan prices' });
  assert.match(stale, new RegExp(`<time class="mp-asof mp-asof--stale" datetime="${back(31)}">Plan prices as of `));
  assert.match(stale, /<span class="mp-stale" role="note"><span>Plan prices not updated in 31 days\./);
  assert.equal(FR.staleHtml('plans', back(30), { now: NOW }), '', 'no notice at the limit');
  assert.match(FR.staleHtml('plans', back(31), { now: NOW, icon: '<svg class="ico"></svg>' }), /role="note"><svg class="ico"><\/svg><span>/);
  assert.equal(FR.stampHtml('models', undefined, { now: NOW }), '<span class="mp-asof mp-asof--stale">Date not on file</span>');
  assert.match(FR.stampHtml('models', '2026-10-03', { now: NOW, label: '<b>"x"</b>' }), /&lt;b&gt;&quot;x&quot;&lt;\/b&gt; as of/);
  assert.doesNotMatch(FR.stampHtml('models', '2026-10-03"><script>', { now: NOW }), /<script>/, 'a junk date is never markup');
});

test('freshness() returns the whole picture in one object', () => {
  assert.deepEqual(FR.freshness('releases', back(8), NOW), {
    feed: 'releases', asOf: back(8), day: FR.dayLabel(back(8)), age: 8, stale: true, maxDays: 7, cadence: 'daily',
    stamp: `As of ${FR.dayLabel(back(8))}`, notice: 'Not updated in 8 days. Usually updated daily. Check the source before relying on it.',
  });
});

test('dayLabel moved here; board-data re-exports the same function', () => {
  assert.equal(BD.dayLabel, FR.dayLabel);
  assert.equal(FR.dayLabel('2026-09-14'), '14 Sep 2026');
  assert.equal(FR.dayLabel('2026-Q3'), '2026-Q3', 'anything else comes back as given');
  assert.equal(FR.dayLabel(''), null);
});

/* ---------- where the pages put them ---------- */

const slots = (html) => [...html.matchAll(/data-fresh="([^"]+)"/g)].map((m) => m[1]);

test('index and table: every panel section and the demo carry a stamp slot for a feed with a limit', () => {
  for (const page of ['index.html', 'table.html']) {
    const html = read(page);
    const sections = html.split(/<section class="panel"/).slice(1).map((s) => s.split('</section>')[0]);
    assert.ok(sections.length >= 1, `${page} has panel sections`);
    for (const s of sections) {
      const id = (/id="([^"]+)"/.exec(s) || [])[1];
      assert.equal(slots(s).length, 1, `${page} #${id} has one freshness slot`);
    }
    for (const f of slots(html)) assert.ok(FR.feedLimits(f), `${page}: slot feed ${f} has a limit`);
    assert.match(html, /<script src="assets\/app\.js\?v=[^"]+"><\/script>/, `${page} loads app.js with a cache key`);
  }
  const index = read('index.html');
  assert.match(index, /<div class="term-col">[\s\S]*?data-fresh="models"[\s\S]*?<\/div>\s*<\/div>\s*<\/section>/, 'the demo terminal has a slot');
  assert.ok(slots(index).length >= 5, 'compare, map, effort, releases and the demo');
});

test('app.js loads the module from its own URL and fills every slot, the nav badge and the footer', () => {
  const app = read('assets/app.js');
  assert.match(app, /new URL\('freshness\.mjs' \+ new URL\(src\)\.search, src\)/, 'built from document.currentScript.src');
  assert.match(app, /import\(FRESH_URL\)/, 'a dynamic import (app.js is a classic script)');
  assert.match(app, /querySelectorAll\('\[data-fresh\]'\)/);
  assert.match(app, /F\.freshHtml\(/);
  assert.doesNotMatch(app, /^\s*import\s/m, 'no static import in a classic script');
});

test('board: summary (both modes), pickers, selected-model facts and install pane carry the stamps', () => {
  const board = read('board.html');
  assert.match(board, /import \* as FR from "\.\/assets\/freshness\.mjs"/);
  assert.equal((board.match(/bpFreshHtml\(\) \+/g) || []).length, 2, 'org and personal summaries');
  assert.match(board, /freshStamp\("models", DATA\.as_of, "Model prices"\) \+ freshStamp\("plans", DATA\.plans_as_of, "Plan prices"\)/);
  assert.match(board, /freshNote\("per-request", DATA\.perRequest\.as_of/);
  assert.match(board, /<div class="mpFresh">' \+ freshStamp\("models"/, 'model picker');
  assert.match(board, /<div class="mpFresh">' \+ freshStamp\("plans"/, 'plan picker');
  assert.match(board, /<div class="pkgFresh">' \+ freshStamp\("tool-defaults", DATA\.guidance && DATA\.guidance\.as_of/, 'install pane');
  assert.match(board, /f\.push\('<span class="mp-fresh">' \+ freshStamp\("models"/, 'selected model facts');
  for (const cls of ['.mp-asof{', '.mp-asof--stale{', '.mp-stale{']) assert.ok(board.includes(cls), `board styles ${cls}`);
});

test('how-we-pick: the vendor list carries its stamp', () => {
  const how = read('how-we-pick.html');
  assert.match(how, /import\("\.\/assets\/freshness\.mjs"\)/);
  assert.match(how, /F\.freshHtml\("vendors", d\.as_of/);
});

test('the dark stylesheet styles the shared classes, and the board footer stays hidden on phones', () => {
  const css = read('assets/styles.css');
  for (const cls of ['.mp-asof {', '.mp-asof--stale {', '.mp-stale {', '.panel__fresh {']) assert.ok(css.includes(cls), cls);
  // the reason the summary carries the stamps: phones never see the board footer
  assert.match(read('board.html'), /@media \(max-width: 768px\)\{[\s\S]*?footer\.foot\{ display:none; \}/);
});
