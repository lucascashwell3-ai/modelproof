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
    // a file kept by hand still says how often, in words ("by hand" alone tells the reader nothing)
    if (/by hand/.test(lim.cadence)) assert.match(lim.cadence, /^by hand, about (every|monthly|weekly)/, `${id} cadence says how often`);
    assert.doesNotMatch(lim.cadence, /\d{4}|\$/, `${id} cadence carries no date or price`);
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
    assert.match(FR.staleText('plans', asOf, NOW), /^No date on file\. Usually updated by hand, about every two weeks\. Check the source/);
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
    'Vendor countries not updated in 91 days. Usually updated by hand, about every two months. Check the source before relying on it.');
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

test('a stamp with no notice beside it says it is old in words, never by colour alone', () => {
  // alone (a picker menu, a second section for the same file): the stamp carries "N days old"
  assert.equal(FR.stampHtml('plans', back(31), { now: NOW, label: 'Plan prices' }),
    `<time class="mp-asof mp-asof--stale" datetime="${back(31)}">Plan prices as of ${FR.dayLabel(back(31))}<span class="mp-asof__flag"> · 31 days old</span></time>`);
  assert.equal(FR.freshHtml('models', back(9), { now: NOW, notice: false }),
    `<span class="mp-fresh"><time class="mp-asof mp-asof--stale" datetime="${back(9)}">As of ${FR.dayLabel(back(9))}<span class="mp-asof__flag"> · 9 days old</span></time></span>`);
  // beside its notice the age is said once, by the notice
  const both = FR.freshHtml('models', back(9), { now: NOW });
  assert.doesNotMatch(both, /mp-asof__flag/);
  assert.match(both, /Not updated in 9 days\./);
  assert.doesNotMatch(FR.stampHtml('models', back(9), { now: NOW, flag: false }), /days old/);
  // fresh: no word, no notice, in either form
  assert.equal(FR.stampHtml('models', back(7), { now: NOW }), `<time class="mp-asof" datetime="${back(7)}">As of ${FR.dayLabel(back(7))}</time>`);
  assert.equal(FR.staleFlag('models', back(7), NOW), '');
  assert.equal(FR.staleFlag('models', undefined, NOW), '', 'no date: the stamp already says "Date not on file"');
});

test('freshness() returns the whole picture in one object', () => {
  assert.deepEqual(FR.freshness('releases', back(8), NOW), {
    feed: 'releases', asOf: back(8), day: FR.dayLabel(back(8)), age: 8, stale: true, maxDays: 7, cadence: 'daily',
    stamp: `As of ${FR.dayLabel(back(8))}`, flag: '8 days old', notice: 'Not updated in 8 days. Usually updated daily. Check the source before relying on it.',
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

test('index and table: every panel section carries a stamp slot for a feed with a limit; the demo carries none', () => {
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
  // the hero terminal plays a scripted demo, not dated data: a stamp there would date the script
  const term = index.slice(index.indexOf('<div class="term-col">'), index.indexOf('</section>', index.indexOf('<div class="term-col">')));
  assert.ok(term.length > 0, 'index has the demo terminal');
  assert.equal(slots(term).length, 0, 'the demo terminal carries no stamp');
  assert.ok(slots(index).length >= 4, 'compare, map, effort and releases');
});

test('app.js: one notice per file per page; every later slot for that file says "N days old"', async () => {
  const vm = await import('node:vm');
  const html = read('index.html');
  const slots = [...html.matchAll(/data-fresh="([^"]+)"/g)].map((m) => ({ dataset: { fresh: m[1] }, innerHTML: '' }));
  const nav = { innerHTML: '', title: '', classList: { on: false, toggle(c, v) { this.on = v; } } };
  const noop = () => {};
  const document = {
    readyState: 'loading', addEventListener: noop,
    querySelector: (q) => ({ '#navAsof': nav }[q] || null),
    querySelectorAll: (q) => (q === '[data-fresh]' ? slots : []),
    documentElement: { classList: { contains: () => false } },
  };
  const ctx = vm.createContext({ document, addEventListener: noop, setTimeout: noop, setInterval: noop, clearInterval: noop, console });
  const app = vm.runInContext(`${read('assets/app.js')}\n;({ state, renderFreshness })`, ctx);
  const old = back(40);
  app.state.data = { as_of: old, models: [], effort_ladders: [{ as_of: back(200) }] };
  app.state.fresh = FR;
  app.state.now = NOW;
  app.renderFreshness();
  const byFile = {};
  for (const s of slots) (byFile[s.dataset.fresh === 'effort-ladders' ? 'ladders' : 'models'] ||= []).push(s.innerHTML);
  for (const [file, list] of Object.entries(byFile)) {
    assert.equal(list.filter((h) => /class="mp-stale"/.test(h)).length, 1, `${file}: the notice shows once`);
    assert.match(list[0], /class="mp-stale" role="note"/, `${file}: the first slot has the notice`);
    for (const h of list.slice(1)) assert.match(h, /mp-asof--stale[^>]*>[^<]*<span class="mp-asof__flag"> · \d+ days old<\/span>/, `${file}: later slots say how old in words`);
  }
  // the nav badge keeps the date in view and says it is old in words, also on a phone (where the
  // .nav__asof-extra spans drop: "● <day> · old"); the full notice is on the page, not only a tooltip
  assert.ok(nav.classList.on);
  assert.equal(nav.innerHTML, `● <span class="nav__asof-extra">As of </span>${FR.dayLabel(old)} · <span class="nav__asof-extra">40 days </span>old`);
  assert.equal(nav.innerHTML.replace(/<span class="nav__asof-extra">[^<]*<\/span>/g, ''), `● ${FR.dayLabel(old)} · old`);
  assert.equal(nav.title, FR.staleText('models', old, NOW));
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
  // the picker menus stand alone, so their stamps say "N days old" in words once stale
  assert.match(board, /<div class="mpFresh">' \+ menuStamp\("models"/, 'model picker');
  assert.match(board, /<div class="mpFresh">' \+ menuStamp\("plans"/, 'plan picker');
  assert.match(board, /function menuStamp\(feed, asOf, label\)\{ return FR\.stampHtml\(feed, asOf, \{ label: label \}\); \}/);
  assert.match(board, /function freshStamp\(feed, asOf, label\)\{ return FR\.stampHtml\(feed, asOf, \{ label: label, flag: false \}\); \}/);
  assert.match(board, /<div class="pkgFresh">' \+ freshStamp\("tool-defaults", DATA\.guidance && DATA\.guidance\.as_of/, 'install pane');
  assert.match(board, /f\.push\('<span class="mp-fresh">' \+ freshStamp\("models"/, 'selected model facts');
  for (const cls of ['.mp-asof{', '.mp-asof--stale{', '.mp-stale{']) assert.ok(board.includes(cls), `board styles ${cls}`);
});

test('how-we-pick: the vendor list carries its stamp', () => {
  const how = read('how-we-pick.html');
  assert.match(how, /import\("\.\/assets\/freshness\.mjs"\)/);
  assert.match(how, /F\.stampHtml\("vendors", d\.as_of/);
  assert.match(how, /F\.staleHtml\("vendors", d\.as_of, \{ label: "Vendor countries", icon: clock \}\)/, 'the board\'s notice, with its clock');
  // one warning at a time: the spot-check caveat gives way to the notice once the list is stale
  assert.match(how, /\(stale \? fact : caveat\)/);
});

test('shown dates near the stamps use the stamps\' format (board facts and quotes, index quotes and effort source)', () => {
  const board = read('board.html');
  assert.match(board, /'Released ' \+ escapeHtml\(FR\.dayLabel\(m\.released\)\)/);
  assert.match(board, /escapeHtml\(FR\.dayLabel\(u\.as_of\)\)/, 'OpenRouter share date');
  assert.equal((board.match(/' &middot; read ' \+ escapeHtml\(FR\.dayLabel\(/g) || []).length, 2, 'quote dates');
  assert.doesNotMatch(board, /escapeHtml\((m\.released|u\.as_of|c\.date|row\.claim\.date)\)/, 'a raw date is back');
  const app = read('assets/app.js');
  assert.match(app, /esc\(dayText\(c\.date\)\)/);
  assert.match(app, /\$\{esc\(dayText\(L\.as_of\)\)\}/);
});

test('the dark stylesheet styles the shared classes, and the board footer stays hidden on phones', () => {
  const css = read('assets/styles.css');
  for (const cls of ['.mp-asof {', '.mp-asof--stale {', '.mp-stale {', '.panel__fresh {']) assert.ok(css.includes(cls), cls);
  // the reason the summary carries the stamps: phones never see the board footer
  assert.match(read('board.html'), /@media \(max-width: 768px\)\{[\s\S]*?footer\.foot\{ display:none; \}/);
});
