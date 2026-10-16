// The three site pages (Build, Models, Teams): one nav, every local file they load exists, every
// module they import resolves, and the pages kept out of the nav stay reachable from the footer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const PAGES = ['index.html', 'models.html', 'teams.html'];
const isLocal = (u) => u && !/^(https?:|mailto:|data:|#|\/\/)/.test(u);

test('every page has the same nav: Build, Models, Teams, and GitHub on the right', () => {
  for (const page of PAGES) {
    const html = read(page);
    const nav = (/<nav class="nav-links"[^>]*>([\s\S]*?)<\/nav>/.exec(html) || [])[1] || '';
    const links = [...nav.matchAll(/<a [^>]*href="([^"]+)"[^>]*>([^<]*)<\/a>/g)].map((m) => [m[1], m[2]]);
    assert.deepEqual(links, [['index.html', 'Build'], ['models.html', 'Models'], ['teams.html', 'Teams']], `${page} nav`);
    assert.equal((html.match(/aria-current="page"/g) || []).length, 1, `${page} marks one current page`);
    assert.match(html, /class="nav-right"[\s\S]*?github\.com\/[^"]+modelproof"/, `${page} links GitHub on the right`);
  }
});

test('the table and the sourcing page stay out of the nav and are linked from every footer', () => {
  for (const page of PAGES) {
    const html = read(page);
    const foot = html.slice(html.indexOf('<footer'));
    assert.match(foot, /href="table\.html"/, `${page} footer links the full table`);
    assert.match(foot, /href="how-we-pick\.html"/, `${page} footer links the sourcing page`);
    const head = html.slice(0, html.indexOf('<main'));
    assert.doesNotMatch(head, /href="(table|board|how-we-pick)\.html"/, `${page} nav leaves those pages out`);
  }
  assert.match(read('models.html'), /href="table\.html"/, 'Models links the full table');
  for (const f of ['table.html', 'board.html', 'how-we-pick.html']) assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} is kept`);
});

test('every local stylesheet, script and link on the pages exists', () => {
  for (const page of PAGES) {
    const html = read(page);
    for (const m of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
      const url = m[1];
      if (!isLocal(url)) continue;
      const file = url.split(/[?#]/)[0];
      assert.ok(fs.existsSync(path.join(ROOT, file)), `${page} points at ${url}, which does not exist`);
    }
  }
});

test('every relative import in assets/ resolves to a file', () => {
  const dir = path.join(ROOT, 'assets');
  for (const name of fs.readdirSync(dir).filter((n) => /\.(js|mjs)$/.test(n))) {
    const src = fs.readFileSync(path.join(dir, name), 'utf8');
    for (const m of src.matchAll(/(?:\bfrom\s+|\bimport\(\s*)['"](\.{1,2}\/[^'"?]+)/g)) {
      assert.ok(fs.existsSync(path.resolve(dir, m[1])), `assets/${name} imports ${m[1]}, which does not exist`);
    }
  }
});

test('the Build page installs from the prompt file the installer ships, and data comes from data/', () => {
  const taps = read('assets/taps.mjs');
  assert.match(taps, /new URL\('install-prompt\.txt', import\.meta\.url\)/);
  assert.match(taps, /new URL\('\.\.\/data\/', import\.meta\.url\)/);
  assert.match(taps, /from '\.\/instructions\.mjs'/, 'the 3-tap adapter uses the shipped generator');
});
