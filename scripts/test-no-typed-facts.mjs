// No typed facts on shipped pages. A model name, a price or a date that a reader sees must come
// from data/ at runtime, never be written into a page or script — a typed fact goes stale the day
// the data moves, and nothing tells anyone.
//
//   node --test scripts/test-no-typed-facts.mjs      the tests (fixtures + the real shipped files)
//   node scripts/test-no-typed-facts.mjs --scan      print every hit; exit 0 clean, 1 hits
//
// What is scanned: root *.html, assets/*.js|mjs, assets/install-prompt.txt, mcp/**/*.js and
// skills/**. Markdown is scanned for prices and dates only (model names there are examples of
// what a user says, by design).
//
// What counts as a hit, after comments are removed (JS `//` and `/* */`, HTML `<!-- -->`, CSS
// `/* */`) and JS regex literals are blanked (a regex is code, not copy), and after HTML entities
// and JS space/quote escapes are decoded (so `Claude&nbsp;Opus` still reads as one name):
//   name     - a model id or name that carries a version digit. The default list is the frozen
//              fixture scripts/fixtures/instructions-models.json, so a new model arriving in data/
//              never turns this test red on its own; NO_TYPED_FACTS_DATA=<dir> reads <dir>/models.json
//              and <dir>/guidance.json instead (the live scan and the new-release drill use it).
//              Plus generic future-name patterns, each needing a version digit, so a lab or a tier
//              word ("flash", "pro", "auto") is never a hit.
//   price    - "$" followed by a digit, or an amount followed by "USD".
//   date     - YYYY-MM(-DD), YYYY-Qn, "Mon D, YYYY", "D Mon YYYY", "Mon YYYY".
//   version  - vN.N.N inside copy.
// Reviewed exceptions live in scripts/fixtures/no-typed-facts/allowlist.json (≤ 8 entries, each must
// still match a hit). GENERATOR_TODO below lists the typed facts still in assets/instructions.mjs;
// they are reported, not failed, until that file reads them from data — the list must end empty.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIX = join(ROOT, 'scripts', 'fixtures', 'no-typed-facts');
export const ALLOWLIST_FILE = join(FIX, 'allowlist.json');
export const ALLOWLIST_MAX = 8;

/* The typed facts still in the instruction generator. Each entry is reported instead of failing,
   and must still match a hit (so it is removed the moment its fact moves to data). Done when this
   list is empty. */
export const GENERATOR_TODO = [
  { file: 'assets/instructions.mjs', substring: 'v2.1.198', kind: 'version', reason: 'tool version in the Explore helper note; quote the sourced claim instead' },
  { file: 'assets/instructions.mjs', substring: "'claude-opus-5-5'", kind: 'name', reason: 'model id for the effort-key note; needs a sourced rule in guidance data' },
  { file: 'assets/instructions.mjs', substring: 'Opus 5.5 and later', kind: 'name', reason: 'unsourced effort-key sentence; source it or remove it' },
];

/* ---------- files ---------- */
const SKIP_DIRS = new Set(['node_modules', '.git']);
function walk(dir, out) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}
const rel = (root, p) => relative(root, p).split(sep).join('/');

export function scannedFiles(root = ROOT) {
  const files = [];
  for (const name of readdirSync(root)) if (/\.html$/i.test(name) && statSync(join(root, name)).isFile()) files.push(join(root, name));
  const assets = join(root, 'assets');
  if (existsSync(assets)) {
    for (const name of readdirSync(assets)) {
      if (/\.(js|mjs)$/i.test(name) || name === 'install-prompt.txt') files.push(join(assets, name));
    }
  }
  for (const p of walk(join(root, 'mcp'), [])) if (/\.(js|mjs)$/i.test(p)) files.push(p);
  walk(join(root, 'skills'), files);
  return [...new Set(files.map((p) => rel(root, p)))].sort();
}

/* ---------- blanking (line-preserving: blanked text becomes spaces, newlines stay) ---------- */
const KEYWORDS_BEFORE_REGEX = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await', 'instanceof']);

// Blanks JS comments and regex literal bodies. Strings and template text are kept (that is where
// copy lives); template `${…}` holes are scanned as code.
export function blankJs(src) {
  const out = src.split('');
  const n = src.length;
  const blank = (a, b) => { for (let k = a; k < b && k < n; k++) if (out[k] !== '\n') out[k] = ' '; };
  let prev = '';   // 'value' after something that ends an expression, else the last punctuator/keyword

  function scanString(i, q) {
    i++;
    while (i < n && src[i] !== q && src[i] !== '\n') i += src[i] === '\\' ? 2 : 1;
    return i + 1;
  }
  function scanTemplate(i) {
    i++;
    while (i < n) {
      const c = src[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '`') return i + 1;
      if (c === '$' && src[i + 1] === '{') { i = scanCode(i + 2, true); continue; }
      i++;
    }
    return i;
  }
  function scanRegex(i) {
    const start = i;
    i++;
    let cls = false;
    while (i < n && src[i] !== '\n') {
      const c = src[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '[') cls = true;
      else if (c === ']') cls = false;
      else if (c === '/' && !cls) { i++; break; }
      i++;
    }
    while (i < n && /[a-z]/i.test(src[i])) i++;
    blank(start, i);
    return i;
  }
  function regexAllowed() {
    if (prev === 'value') return false;
    return true;
  }
  function scanCode(i, stopAtBrace) {
    let depth = 0;
    while (i < n) {
      const c = src[i];
      if (c === '\n' || c === ' ' || c === '\t' || c === '\r') { i++; continue; }
      if (c === '/' && src[i + 1] === '/') { const e = src.indexOf('\n', i); const end = e === -1 ? n : e; blank(i, end); i = end; continue; }
      if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); const end = e === -1 ? n : e + 2; blank(i, end); i = end; continue; }
      if (c === '/') {
        if (regexAllowed()) { i = scanRegex(i); prev = 'value'; continue; }
        i++; prev = '/'; continue;
      }
      if (c === '"' || c === "'") { i = scanString(i, c); prev = 'value'; continue; }
      if (c === '`') { i = scanTemplate(i); prev = 'value'; continue; }
      if (c === '{') { depth++; i++; prev = '{'; continue; }
      if (c === '}') {
        if (stopAtBrace && depth === 0) { prev = 'value'; return i + 1; }
        depth--; i++; prev = '}'; continue;
      }
      if (/[A-Za-z0-9_$]/.test(c)) {
        const isNum = /[0-9]/.test(c);
        let j = i;
        while (j < n && (/[A-Za-z0-9_$]/.test(src[j]) || (isNum && src[j] === '.'))) j++;
        const word = src.slice(i, j);
        prev = KEYWORDS_BEFORE_REGEX.has(word) ? word : 'value';
        // An identifier (a variable or property name like `opus55`) is code, never copy a reader sees.
        if (!isNum) blank(i, j);
        i = j; continue;
      }
      if (c === ')' || c === ']') { prev = 'value'; i++; continue; }
      prev = c; i++;
    }
    return i;
  }
  scanCode(0, false);
  return out.join('');
}

export function blankCss(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

export function blankHtml(src) {
  let s = src.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
  s = s.replace(/(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi, (m, a, body, z) => a + blankJs(body) + z);
  s = s.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (m, a, body, z) => a + blankCss(body) + z);
  return s;
}

export function blankMd(src) {
  return src.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
}

/* ---------- decoding ---------- */
const NAMED = { nbsp: ' ', thinsp: ' ', ensp: ' ', emsp: ' ', hairsp: ' ', narrownbsp: ' ', amp: '&', rsquo: '’', lsquo: '‘',
  ldquo: '“', rdquo: '”', middot: '·', ndash: '–', mdash: '—', hellip: '…', times: '×', dollar: '$', quot: '"', apos: "'",
  lt: '<', gt: '>', period: '.', comma: ',', colon: ':', sol: '/', lpar: '(', rpar: ')' };
const SPACE_CODES = new Set([0xa0, 0x2009, 0x2002, 0x2003, 0x200a, 0x202f]);
const fromCode = (cp) => (SPACE_CODES.has(cp) ? ' ' : String.fromCodePoint(cp));
export function decodeLine(line) {
  return line
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') return fromCode(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
      const v = NAMED[e.toLowerCase()];
      return v === undefined ? m : v;
    })
    .replace(/\\u\{?([0-9a-f]{4,5})\}?/gi, (m, h) => fromCode(parseInt(h, 16)))
    .replace(/\\x([0-9a-f]{2})/gi, (m, h) => fromCode(parseInt(h, 16)));
}
const INLINE_TAGS = /<\/?(em|b|strong|i|u|span|a|code|mark|small|abbr|sup|sub)\b[^<>]*>/gi;

/* ---------- patterns ---------- */
const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Model terms: ids and names that carry a digit, ≥ 3 characters.
export function termsFrom({ models = [], guidance = null } = {}) {
  const terms = new Set();
  const add = (t) => { if (typeof t === 'string' && t.length >= 3 && /\d/.test(t)) terms.add(t.trim()); };
  for (const m of models) { add(m.id); add(m.name); }
  for (const r of (guidance && guidance.model_refs) || []) add(r.model_id);
  return [...terms].sort((a, b) => b.length - a.length);
}

function readJsonIf(p) { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } }

// The default list is the frozen fixture; NO_TYPED_FACTS_DATA=<dir> switches to that data dir.
export function defaultTerms(env = process.env) {
  const dir = env.NO_TYPED_FACTS_DATA;
  if (dir) {
    const base = dir.startsWith('/') ? dir : join(ROOT, dir);
    const models = readJsonIf(join(base, 'models.json'));
    if (!models) throw new Error(`NO_TYPED_FACTS_DATA: no models.json in ${base}`);
    return termsFrom({ models: models.models || [], guidance: readJsonIf(join(base, 'guidance.json')) });
  }
  const fx = readJsonIf(join(ROOT, 'scripts', 'fixtures', 'instructions-models.json'));
  return termsFrom({ models: (fx && fx.models) || [] });
}

// Names not yet in any data, each needing a version digit.
export const FUTURE_NAMES = [
  /claude[- ](opus|sonnet|haiku|fable)[- ]?\d/gi,
  /\b(opus|sonnet|haiku|fable)[- ]?\d/gi,
  /\bgpt-?\d/gi,
  /(?<![\w-])o[1-9](-mini|-pro)?(?!\w)/g,
  /\bgemini[- ]\d/gi,
  /\bgrok[- ]?\d/gi,
  /\bllama[- ]?\d/gi,
  /\bdeepseek[- ]?[vr]\d/gi,
  /\bqwen\d/gi,
  /\bkimi[- ]k\d/gi,
  /\bglm-?\d/gi,
  /\bmistral[- ](large|medium|small)[- ]?\d/gi,
  /\b(codestral|devstral|magistral)[- ]?\d/gi,
  /\bcomposer[- ]?\d/gi,
  /\bmuse[- ](spark|glimmer)[- ]?\d/gi,
  /\bnemotron[- ]?\d/gi,
];
const MON = '(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|January|February|March|April|June|July|August|September|October|November|December)';
export const PRICES = [/\$\s?\d/g, /\b\d+(\.\d+)?\s?USD\b/g];
export const DATES = [
  /\b20\d\d-(0[1-9]|1[0-2])(-\d\d)?\b/g,
  /\b20\d\d-Q[1-4]\b/g,
  new RegExp(`\\b${MON}\\.? \\d{1,2},? 20\\d\\d\\b`, 'g'),
  new RegExp(`\\b\\d{1,2} ${MON}\\.? 20\\d\\d\\b`, 'g'),
  new RegExp(`\\b${MON}\\.? 20\\d\\d\\b`, 'g'),
];
export const VERSIONS = [/\bv\d+\.\d+\.\d+\b/g];

function namePattern(terms) {
  if (!terms.length) return null;
  return new RegExp(`(?<![A-Za-z0-9-])(${terms.map(esc).join('|')})(?![A-Za-z0-9])`, 'gi');
}

/* ---------- scan ---------- */
function kindOfFile(file) {
  if (/\.html?$/i.test(file)) return 'html';
  if (/\.(js|mjs|cjs)$/i.test(file)) return 'js';
  if (/\.md$/i.test(file)) return 'md';
  if (/\.css$/i.test(file)) return 'css';
  return 'text';
}

export function scanText(text, file = '(text)', { terms = defaultTerms(), allowlist = [], todo = [] } = {}) {
  const kind = kindOfFile(file);
  const blanked = kind === 'html' ? blankHtml(text) : kind === 'js' ? blankJs(text) : kind === 'md' ? blankMd(text)
    : kind === 'css' ? blankCss(text) : text;
  const rawLines = text.split('\n');
  const names = kind === 'md' ? null : namePattern(terms);
  const groups = [];
  if (names) groups.push(['name', [names, ...FUTURE_NAMES]]);
  groups.push(['price', PRICES], ['date', DATES]);
  if (kind !== 'md') groups.push(['version', VERSIONS]);

  const hits = [];
  const seen = new Set();
  blanked.split('\n').forEach((line, idx) => {
    const decoded = decodeLine(line);
    const variants = [decoded, decoded.replace(INLINE_TAGS, '')];
    const raw = rawLines[idx] || '';
    for (const v of variants) {
      for (const [k, regs] of groups) {
        for (const re of regs) {
          re.lastIndex = 0;
          let m;
          while ((m = re.exec(v))) {
            const key = `${idx}\u0000${k}\u0000${m[0].toLowerCase()}`;
            if (!seen.has(key)) {
              seen.add(key);
              const h = { file, line: idx + 1, kind: k, match: m[0], text: raw.trim().slice(0, 160) };
              const inside = (e) => e.file === file && (e.kind === undefined || e.kind === k) && raw.includes(e.substring);
              if (allowlist.some(inside)) h.allowed = true;
              else if (todo.some(inside)) h.todo = true;
              hits.push(h);
            }
            if (m[0].length === 0) re.lastIndex++;
          }
        }
      }
    }
  });
  return hits.sort((a, b) => a.line - b.line || a.kind.localeCompare(b.kind));
}

export function loadAllowlist(file = ALLOWLIST_FILE) {
  const j = readJsonIf(file);
  return Array.isArray(j) ? j : (j && Array.isArray(j.entries) ? j.entries : []);
}

export function scan(root = ROOT, opts = {}) {
  const terms = opts.terms || defaultTerms();
  const allowlist = opts.allowlist || loadAllowlist();
  const todo = opts.todo || GENERATOR_TODO;
  const hits = [];
  for (const f of scannedFiles(root)) hits.push(...scanText(readFileSync(join(root, f), 'utf8'), f, { terms, allowlist, todo }));
  return hits;
}

export function formatHits(hits) {
  const live = hits.filter((h) => !h.allowed && !h.todo);
  const todo = hits.filter((h) => h.todo);
  const lines = [`typed facts: ${live.length} hit(s)` + (todo.length ? `, ${todo.length} on the generator todo list` : '')];
  for (const h of live) lines.push(`  ${h.file}:${h.line} [${h.kind}] "${h.match}"  ${h.text}`);
  for (const h of todo) lines.push(`  todo ${h.file}:${h.line} [${h.kind}] "${h.match}"`);
  return lines.join('\n');
}

if (process.argv.includes('--scan')) {
  const hits = scan(ROOT);
  console.log(formatHits(hits));
  process.exitCode = hits.some((h) => !h.allowed && !h.todo) ? 1 : 0;
} else {
  const { test } = await import('node:test');
  const assert = (await import('node:assert/strict')).default;
  const fixtureTerms = termsFrom({ models: [
    { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
    { id: 'gemini-3-6-flash', name: 'Gemini 3.6 Flash' },
    { id: 'inkling', name: 'Inkling' },
  ] });
  const fixture = (name) => scanText(readFileSync(join(FIX, name), 'utf8'), name, { terms: fixtureTerms });
  const kinds = (hits) => new Set(hits.map((h) => h.kind));

  test('a visible model name is caught', () => {
    const hits = fixture('bad-name.html');
    assert.ok(hits.some((h) => h.kind === 'name' && /opus 5\.5/i.test(h.match)), JSON.stringify(hits));
  });

  test('a price in a JS string is caught', () => {
    assert.ok(kinds(fixture('bad-price.js')).has('price'));
  });

  test('a date in a module string is caught', () => {
    assert.ok(kinds(fixture('bad-date.mjs')).has('date'));
  });

  test('entity-disguised and tag-split names and prices are caught', () => {
    const hits = fixture('bad-disguised.html');
    const nameLines = new Set(hits.filter((h) => h.kind === 'name').map((h) => h.line));
    assert.ok(nameLines.size >= 2, `want the &nbsp; name and the <b>-split name, got ${JSON.stringify(hits)}`);
    assert.ok(hits.some((h) => h.kind === 'price'), 'the &thinsp; price');
  });

  test('a model not in any data is caught by the future-name patterns', () => {
    const hits = fixture('bad-future.js');
    assert.ok(hits.some((h) => h.kind === 'name' && /gpt-7/i.test(h.match)), JSON.stringify(hits));
  });

  test('comments, regex literals, unit labels and template holes stay clean', () => {
    assert.deepEqual(fixture('clean.html'), []);
  });

  test('bare tier words and names with no version digit never hit', () => {
    const hits = scanText('const a = "flash pro auto opus sonnet haiku Inkling Gemini Mistral";', 'x.js', { terms: fixtureTerms });
    assert.deepEqual(hits, []);
  });

  test('markdown is scanned for prices and dates only', () => {
    const hits = scanText('Say "Claude Opus 5.5" to it.\nIt was $4 on 2026-09-27.\n', 'x.md', { terms: fixtureTerms });
    assert.deepEqual([...kinds(hits)].sort(), ['date', 'price']);
  });

  test('a hit is reported on the right line, and blanking keeps line numbers', () => {
    const src = '/* Claude Opus 5.5\n spans lines */\nconst x = "Claude Opus 5.5";\n';
    const hits = scanText(src, 'x.js', { terms: fixtureTerms });
    assert.deepEqual([...new Set(hits.map((h) => h.line))], [3]);
  });

  test('the default name list is the frozen fixture; NO_TYPED_FACTS_DATA switches it to a data dir', () => {
    const def = defaultTerms({});
    assert.ok(def.length > 20 && def.every((t) => /\d/.test(t)), 'fixture terms, each with a digit');
    const live = defaultTerms({ NO_TYPED_FACTS_DATA: 'data' });
    assert.ok(live.length > 20 && live.every((t) => /\d/.test(t)));
  });

  test('allowlist: at most 8 entries, each with a reason and kind, each still matching a hit', () => {
    const list = loadAllowlist();
    assert.ok(list.length <= ALLOWLIST_MAX, `allowlist has ${list.length} entries (max ${ALLOWLIST_MAX})`);
    const hits = scan(ROOT, { allowlist: [], todo: [] });
    for (const a of list) {
      assert.ok(a.file && a.substring && a.reason && a.reason.length > 8 && a.kind, `incomplete entry ${JSON.stringify(a)}`);
      assert.ok(['name', 'price', 'date', 'version'].includes(a.kind), `bad kind ${a.kind}`);
      assert.ok(hits.some((h) => h.file === a.file && h.kind === a.kind && h.text.length && readFileSync(join(ROOT, a.file), 'utf8').split('\n')[h.line - 1].includes(a.substring)),
        `allowlist entry no longer matches a hit: ${a.file} "${a.substring}"`);
    }
  });

  test('every generator todo entry still matches a hit (remove an entry once its fact reads from data)', () => {
    const hits = scan(ROOT, { allowlist: [], todo: GENERATOR_TODO });
    for (const t of GENERATOR_TODO) {
      assert.ok(hits.some((h) => h.todo && h.file === t.file && h.kind === t.kind && readFileSync(join(ROOT, t.file), 'utf8').split('\n')[h.line - 1].includes(t.substring)),
        `todo entry no longer matches: ${t.file} "${t.substring}" — remove it from GENERATOR_TODO`);
    }
  });

  test('the generator todo list is empty', { todo: GENERATOR_TODO.length ? `${GENERATOR_TODO.length} typed fact(s) left in the generator` : false }, () => {
    assert.equal(GENERATOR_TODO.length, 0);
  });

  test('the scanned set covers pages, assets, the install prompt, mcp and skills, and never data/ or scripts/', () => {
    const files = scannedFiles(ROOT);
    assert.ok(files.includes('board.html') && files.includes('index.html'));
    assert.ok(files.includes('assets/app.js') && files.includes('assets/board-data.mjs'));
    assert.ok(files.some((f) => f.startsWith('mcp/')) && files.some((f) => f.startsWith('skills/')));
    assert.ok(!files.some((f) => f.startsWith('data/') || f.startsWith('scripts/') || f.startsWith('archive/') || f.includes('node_modules/')));
  });

  test('the shipped files carry no typed facts', () => {
    const hits = scan(ROOT);
    assert.equal(hits.filter((h) => !h.allowed && !h.todo).length, 0, '\n' + formatHits(hits));
  });
}
