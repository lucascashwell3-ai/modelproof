// The sitemap lists every root-level page, once, by its full address, and every page carries
// exactly one canonical tag that matches that address.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSitemap, pageUrl } from './build-sitemap.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const pages = fs.readdirSync(ROOT).filter((f) => f.endsWith('.html')).sort();

test('buildSitemap is stable and lists each page once', () => {
  const a = buildSitemap(['models.html', 'index.html'], '2026-01-02');
  assert.equal(a, buildSitemap(['index.html', 'models.html'], '2026-01-02'));
  assert.match(a, /<loc>https:\/\/lucascashwell3-ai\.github\.io\/modelproof\/<\/loc>/);
  assert.match(a, /<lastmod>2026-01-02<\/lastmod>/);
  assert.throws(() => buildSitemap(['index.html'], 'nope'));
});

test('each page has exactly one canonical tag, equal to its sitemap address', () => {
  assert.ok(pages.length > 0);
  for (const f of pages) {
    const html = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const tags = html.match(/<link rel="canonical" href="[^"]+">/g) || [];
    assert.equal(tags.length, 1, `${f} has one canonical tag`);
    assert.equal(tags[0], `<link rel="canonical" href="${pageUrl(f)}">`, `${f} canonical`);
  }
});
