// Banned wording on shipped pages. Modelproof shows sourced facts and never ranks models or
// names one for a job, so the words that do that must not ship.
//
//   node --test scripts/test-banned-wording.mjs      the tests (fixtures + the real shipped files)
//   node scripts/test-banned-wording.mjs --scan      print every hit in the shipped files; exit 0 clean, 1 hits
//
// Matching is over the whole text, case-insensitive. Before matching, runs of whitespace fold to one
// space, the common HTML entities and JS escapes for quotes and spaces are decoded, and inline tags
// (<em>, <b>, <span …>, …) are dropped, so "best <em>for</em>" or "we&rsquo;d pick" split across a
// line still count.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// List A: no allowlist, ever.
export const LIST_A = ['start here', 'start_here', "we'd pick", 'we’d pick', 'best model', 'recommend_model', 'confidence'];

// List B: may carry an allowlisted exception below.
export const LIST_B = ['names one model', 'our pick', 'first pick', 'named pick', 'we pick', 'recommend(',
  'best available', 'optimize for', 'verdict', 'best for', 'default pick', '.best_for', '.verdict',
  '.confidence', 'coding_confidence'];

// Reviewed exceptions for list B only: { file (repo-relative), substring (must contain the term), reason }.
// Keep this tiny. A hit is allowed only when it sits inside an occurrence of `substring` in that file.
export const ALLOWLIST = [];

// Folders and files never scanned, and why. Nothing under these is served as product copy.
export const EXCLUDED = [
  { path: 'archive/', reason: 'retired ranking code, kept for history' },
  { path: 'data/', reason: 'data files; editorial fields are never rendered (checked by this list on the pages)' },
  { path: 'scripts/', reason: 'build and test tooling, including these fixtures' },
  { path: 'docs/', reason: 'generated reports' },
  { path: 'CHANGES.md', reason: 'history' },
  { path: 'design/', reason: 'design working files' },
  { path: 'PRODUCT.md', reason: 'local design brief, not in git and not served' },
];

const SKIP_DIRS = new Set(['node_modules', '.git']);
const SKIP_FILES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml']);
const ASSET_EXT = /\.(js|mjs|css|txt)$/i;

function walk(dir, out) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || SKIP_FILES.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

const rel = (root, p) => relative(root, p).split(sep).join('/');
const isExcluded = (r) => EXCLUDED.some((e) => (e.path.endsWith('/') ? r.startsWith(e.path) : r === e.path));

// The shipped files: root *.html, assets/* (js/mjs/css/txt), skills/**, mcp/** (no node_modules or
// lockfiles), README.md. Returns repo-relative paths, sorted.
export function shippedFiles(root = ROOT) {
  const files = [];
  for (const name of readdirSync(root)) if (/\.html$/i.test(name) && statSync(join(root, name)).isFile()) files.push(join(root, name));
  for (const p of walk(join(root, 'assets'), [])) if (ASSET_EXT.test(p)) files.push(p);
  walk(join(root, 'skills'), files);
  walk(join(root, 'mcp'), files);
  if (existsSync(join(root, 'README.md'))) files.push(join(root, 'README.md'));
  return [...new Set(files.map((p) => rel(root, p)))].filter((r) => !isExcluded(r)).sort();
}

const ENTITIES = { '&rsquo;': '’', '&lsquo;': '‘', '&#8217;': '’', '&#x2019;': '’', '&#39;': "'",
  '&#x27;': "'", '&apos;': "'", '&nbsp;': ' ', '&#160;': ' ', '&#xa0;': ' ', '&amp;': '&', '&period;': '.', '&lpar;': '(' };
const ESCAPES = { '\\u2019': '’', '\\u2018': '‘', "\\'": "'", '\\u00a0': ' ', '\\u0027': "'" };
const INLINE_TAG = /^<\/?(em|b|strong|i|u|span|a|code|mark|small|abbr)\b[^<>]*>/i;

// Fold text for matching; map[k] = index in the original text of normalized char k.
export function normalize(text, { stripTags = true } = {}) {
  let out = '';
  const map = [];
  let i = 0;
  const push = (ch, at) => { out += ch; map.push(at); };
  while (i < text.length) {
    const c = text[i];
    if (c === '&') {
      const m = /^&[#a-z0-9]{2,8};/i.exec(text.slice(i, i + 10));
      const rep = m ? ENTITIES[m[0].toLowerCase()] : undefined;
      if (rep !== undefined) { if (rep === ' ') { if (!out.endsWith(' ')) push(' ', i); } else push(rep, i); i += m[0].length; continue; }
    }
    if (c === '\\') {
      const key = Object.keys(ESCAPES).find((k) => text.slice(i, i + k.length).toLowerCase() === k);
      if (key) { const rep = ESCAPES[key]; if (rep === ' ') { if (!out.endsWith(' ')) push(' ', i); } else push(rep, i); i += key.length; continue; }
    }
    if (c === '<' && stripTags) {
      const m = INLINE_TAG.exec(text.slice(i, i + 200));
      if (m) { i += m[0].length; continue; }
    }
    if (/\s/.test(c)) { if (!out.endsWith(' ')) push(' ', i); i++; continue; }
    const low = c.toLowerCase();
    for (const ch of low) push(ch, i);
    i++;
  }
  return { text: out, map };
}

const lineAt = (text, idx) => { let n = 1; for (let k = 0; k < idx && k < text.length; k++) if (text[k] === '\n') n++; return n; };

// Every hit of both lists in one text. Allowlist applies to list B only.
export function scanText(text, file = '(text)', { allowlist = ALLOWLIST } = {}) {
  // Two passes: tags kept (catches words inside attributes) and inline tags dropped (catches words
  // split by <em> and friends). A hit found by both passes counts once.
  const seen = new Set();
  const hits = [];
  const lines = text.split('\n');
  for (const stripTags of [false, true]) {
    const { text: norm, map } = normalize(text, { stripTags });
    const allowed = [];   // normalized [start, end) ranges covered by an allowlisted substring for this file
    for (const a of allowlist) {
      if (a.file !== file) continue;
      const s = normalize(a.substring, { stripTags }).text;
      for (let at = norm.indexOf(s); at !== -1; at = norm.indexOf(s, at + 1)) allowed.push([at, at + s.length]);
    }
    for (const [list, terms] of [['A', LIST_A], ['B', LIST_B]]) {
      for (const term of terms) {
        const t = term.toLowerCase();
        for (let at = norm.indexOf(t); at !== -1; at = norm.indexOf(t, at + 1)) {
          if (list === 'B' && allowed.some(([s, e]) => at >= s && at + t.length <= e)) continue;
          const orig = map[at];
          const key = orig + '\u0000' + term;
          if (seen.has(key)) continue;
          seen.add(key);
          const lineNo = lineAt(text, orig);
          hits.push({ file, line: lineNo, term, list, text: (lines[lineNo - 1] || '').trim().slice(0, 160) });
        }
      }
    }
  }
  return hits.sort((x, y) => x.line - y.line || x.term.localeCompare(y.term));
}

// Scan every shipped file under root.
export function scan(root = ROOT, opts = {}) {
  const hits = [];
  for (const f of shippedFiles(root)) hits.push(...scanText(readFileSync(join(root, f), 'utf8'), f, opts));
  return hits;
}

export function formatHits(hits) {
  if (!hits.length) return 'banned wording: 0 hits';
  const byFile = new Map();
  for (const h of hits) { if (!byFile.has(h.file)) byFile.set(h.file, []); byFile.get(h.file).push(h); }
  const lines = [`banned wording: ${hits.length} hit(s) in ${byFile.size} file(s)`];
  for (const [f, hs] of byFile) {
    lines.push(`${f} (${hs.length})`);
    for (const h of hs) lines.push(`  ${h.line}: [${h.list}] "${h.term}"  ${h.text}`);
  }
  return lines.join('\n');
}

if (process.argv.includes('--scan')) {
  const hits = scan(ROOT);
  console.log(formatHits(hits));
  process.exitCode = hits.length ? 1 : 0;
} else {
  const { test } = await import('node:test');
  const assert = (await import('node:assert/strict')).default;
  const FIX = join(ROOT, 'scripts', 'fixtures', 'banned-wording');
  const fixture = (name) => scanText(readFileSync(join(FIX, name), 'utf8'), name, { allowlist: [] });

  test('every list A term is caught by the bad fixture', () => {
    const found = new Set(fixture('bad-list-a.html').map((h) => h.term));
    for (const t of LIST_A) assert.ok(found.has(t), `not caught: ${t}`);
  });

  test('every list B term is caught by the bad fixture', () => {
    const found = new Set(fixture('bad-list-b.js').map((h) => h.term));
    for (const t of LIST_B) assert.ok(found.has(t), `not caught: ${t}`);
  });

  test('split, entity-encoded and escaped forms are caught', () => {
    const found = new Set(fixture('bad-disguised.html').map((h) => h.term));
    for (const t of ['start here', 'we’d pick', "we'd pick", 'best for', 'optimize for', 'best model', 'our pick', 'names one model'])
      assert.ok(found.has(t), `not caught: ${t}`);
  });

  test('near-misses stay clean', () => {
    assert.deepEqual(fixture('clean.html'), []);
  });

  test('hits carry file, line and list', () => {
    const h = scanText('ok\nthe Verdict row\n', 'x.html', { allowlist: [] });
    assert.deepEqual(h.map(({ file, line, term, list }) => ({ file, line, term, list })), [{ file: 'x.html', line: 2, term: 'verdict', list: 'B' }]);
  });

  test('allowlist lifts list B only, and only inside its substring in its file', () => {
    const text = 'see the verdict field docs. A verdict here.\nconfidence';
    const allow = [{ file: 'a.md', substring: 'the verdict field', reason: 'fixture' }];
    const hits = scanText(text, 'a.md', { allowlist: allow });
    assert.equal(hits.filter((h) => h.term === 'verdict').length, 1, 'the second verdict is outside the substring');
    assert.equal(hits.filter((h) => h.term === 'confidence').length, 1, 'list A ignores the allowlist');
    assert.equal(scanText(text, 'b.md', { allowlist: allow }).filter((h) => h.term === 'verdict').length, 2, 'other files unaffected');
    const listA = scanText('confidence', 'a.md', { allowlist: [{ file: 'a.md', substring: 'confidence', reason: 'x' }] });
    assert.equal(listA.length, 1);
  });

  test('allowlist entries are reviewed: each names a list B term, a reason, and a file that exists', () => {
    assert.ok(ALLOWLIST.length <= 5, 'keep the allowlist tiny');
    for (const a of ALLOWLIST) {
      assert.ok(a.reason && a.reason.length > 8, `reason missing for ${a.file}`);
      assert.ok(LIST_B.some((t) => a.substring.toLowerCase().includes(t)), `substring holds no list B term: ${a.substring}`);
      assert.ok(!LIST_A.some((t) => a.substring.toLowerCase().includes(t)), `list A term in allowlist: ${a.substring}`);
      assert.ok(existsSync(join(ROOT, a.file)), `allowlisted file missing: ${a.file}`);
    }
  });

  test('excluded roots are never scanned, and the shipped set covers pages, assets, skills, mcp and README', () => {
    const files = shippedFiles(ROOT);
    for (const f of files) assert.ok(!isExcluded(f), `excluded file scanned: ${f}`);
    for (const f of files) assert.ok(!f.includes('node_modules/') && !SKIP_FILES.has(f.split('/').pop()), f);
    assert.ok(files.includes('index.html') && files.includes('README.md'));
    assert.ok(files.some((f) => f.startsWith('assets/')) && files.some((f) => f.startsWith('mcp/')) && files.some((f) => f.startsWith('skills/')));
  });

  test('the shipped files carry no banned wording', () => {
    const hits = scan(ROOT);
    assert.equal(hits.length, 0, '\n' + formatHits(hits));
  });
}
