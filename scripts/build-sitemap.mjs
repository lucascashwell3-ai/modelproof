// Writes sitemap.xml at the site root: one <url> per public page, each with a <lastmod>.
// Pages are the root-level *.html files, so a new page is listed without a hand edit. lastmod is
// the date of the shared data (data/models.json "as_of"), so a rerun with no data change writes
// the same bytes. The home page is listed as the site root, matching its canonical tag.
// Run: node scripts/build-sitemap.mjs   (the collect workflow runs it after each refresh)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SITE = 'https://lucascashwell3-ai.github.io/modelproof/';

export function pageUrl(file) {
  return file === 'index.html' ? SITE : SITE + file;
}

export function buildSitemap(files, lastmod) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(lastmod)) throw new Error(`lastmod must be YYYY-MM-DD, got ${lastmod}`);
  const urls = [...files].sort().map((f) => `  <url>\n    <loc>${pageUrl(f)}</loc>\n    <lastmod>${lastmod}</lastmod>\n  </url>\n`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('')}</urlset>\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const files = fs.readdirSync(root).filter((f) => f.endsWith('.html'));
  const asOf = JSON.parse(fs.readFileSync(path.join(root, 'data/models.json'), 'utf8')).as_of;
  fs.writeFileSync(path.join(root, 'sitemap.xml'), buildSitemap(files, String(asOf).slice(0, 10)));
  console.log(`sitemap.xml: ${files.length} pages, lastmod ${String(asOf).slice(0, 10)}`);
}
