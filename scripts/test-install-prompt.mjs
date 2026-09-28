// Tests for the paste-in install prompt: pinned hashes, every marked copy in sync, and the
// wording rules the prompt and the skill must pass. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ROOT, DEFAULT_BASE, PROMPT_FILE, SKILL_DIR, DATA_FILES, MARKER,
  sha256, pinnedFiles, buildPrompt, markerBlocks, decodeCopy, encodeCopy, syncText, findMarkedFiles, syncAll,
} from './build-install-prompt.mjs';

const BEGIN = `${MARKER}begin`;
const END = `${MARKER}end`;
const promptText = () => fs.readFileSync(path.join(ROOT, PROMPT_FILE), 'utf8');

// "<64 hex>  <path>" lines, as shasum -c reads them.
function pinLines(prompt) {
  return prompt.split('\n').map((l) => /^([0-9a-f]{64}) {2}(\S+)$/.exec(l)).filter(Boolean).map((m) => ({ hash: m[1], rel: m[2] }));
}
// Problems with a prompt against the files under root.
function hashProblems(root, prompt) {
  const out = [];
  for (const { hash, rel } of pinLines(prompt)) {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) { out.push(`${rel}: missing`); continue; }
    if (sha256(fs.readFileSync(abs)) !== hash) out.push(`${rel}: hash differs`);
  }
  return out;
}

/* ------------------------------------------------------------------ word rules */

// Spec list A + list B (no-winner), plus the wider ranking words the skill must never use.
const LIST_A = ['start here', 'start_here', "we'd pick", 'we’d pick', 'best model', 'recommend_model', 'confidence'];
const LIST_B = ['names one model', 'our pick', 'first pick', 'named pick', 'we pick', 'recommend(', 'best available',
  'optimize for', 'verdict', 'best for', 'default pick', '.best_for', '.verdict', '.confidence', 'coding_confidence'];
const RANKING = /\b(best|better|top|winner|pick\w*|recommend\w*|suggest\w*|verdict|confidence|stance)\b|optimi[sz]e for|best_for/i;
// Same patterns as the public-repo pre-push lint. Each word is split so this file passes that lint.
const PUBLIC_LINT = new RegExp(['rec' + 'ruit', 'hiring ' + 'manager', 'job.?' + 'search', 'job.?' + 'hunt', '\\bcar' + 'eer\\b',
  'proti' + 'viti', '\\bemplo' + 'yer', 'moon' + 'light', 'inter' + 'view', 'r\u00e9sum\u00e9|res' + 'ume\\b', 'needs ' + 'lucas',
  'lucas ' + 'said', "lucas's (call|verdict|dictation|review|voice)", 'per ' + 'lucas', 'approval from ' + 'lucas',
  'claude-' + 'universe', 'HAND' + 'OFF\\.md', 'sta' + 'tus/[a-z-]+\\.md', '/Users/'].join('|'), 'i');

function wordProblems(text, label) {
  const out = [];
  const low = text.toLowerCase();
  for (const t of [...LIST_A, ...LIST_B]) if (low.includes(t.toLowerCase())) out.push(`${label}: "${t}"`);
  text.split('\n').forEach((line, i) => {
    const r = RANKING.exec(line);
    if (r) out.push(`${label}:${i + 1}: ranking word "${r[0]}"`);
    const p = PUBLIC_LINT.exec(line);
    if (p) out.push(`${label}:${i + 1}: public-lint "${p[0]}"`);
  });
  return out;
}

function skillFiles() {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs);
      else out.push(path.relative(ROOT, abs));
    }
  };
  walk(path.join(ROOT, 'skills'));
  return out.sort();
}

/* ------------------------------------------------------------------ the prompt */

test('every pinned file exists, and the prompt pins exactly the skill, its references and the two scripts', () => {
  const pinned = pinnedFiles();
  for (const rel of pinned) assert.ok(fs.existsSync(path.join(ROOT, rel)), `${rel} missing`);
  const refs = fs.readdirSync(path.join(ROOT, SKILL_DIR, 'references')).filter((f) => f.endsWith('.md'));
  assert.equal(refs.length, pinned.length - 3, 'every reference is pinned');
  assert.ok(pinned.includes('assets/install.mjs') && pinned.includes('assets/instructions.mjs'));
  assert.deepEqual(pinLines(promptText()).map((x) => x.rel), pinned);
});

test('every hash in the prompt matches the file it names', () => {
  assert.deepEqual(hashProblems(ROOT, promptText()), []);
});

test('assets/install-prompt.txt is exactly what the build script makes', () => {
  assert.equal(promptText(), buildPrompt(), 'stale: run node scripts/build-install-prompt.mjs');
});

test('the prompt: at most 25 lines, BASE on its own line, no pipe-to-shell, data fetched unpinned', () => {
  const p = promptText();
  const lines = p.replace(/\n$/, '').split('\n');
  assert.ok(lines.length <= 25, `${lines.length} lines`);
  assert.ok(lines.includes(DEFAULT_BASE), 'default BASE alone on a line');
  assert.equal(lines.filter((l) => /^https?:\/\//.test(l)).length, 1, 'exactly one BASE line');
  assert.match(p, /Never pipe a download into a shell/);
  assert.match(p, /stop and tell me which file/);
  assert.match(p, /Do not copy anything into my skills folder/);
  for (const d of DATA_FILES) assert.ok(p.includes(d), `${d} fetched`);
  for (const d of DATA_FILES) assert.ok(!pinLines(p).some((x) => x.rel === d), `${d} is data, not pinned`);
  // Safe to drop unchanged into HTML, a JS string or Markdown.
  assert.doesNotMatch(p, /[<>&`]|\$\{/);
  assert.doesNotMatch(p, /\|\s*(sh|bash|zsh|node|python)\b/);
});

test('the prompt with another BASE changes only the BASE line', () => {
  const other = buildPrompt(ROOT, { base: 'http://127.0.0.1:8000/' });
  const a = buildPrompt().split('\n');
  const b = other.split('\n');
  assert.equal(a.length, b.length);
  assert.deepEqual(a.map((l, i) => (l === b[i] ? null : i)).filter((x) => x !== null), [a.indexOf(DEFAULT_BASE)]);
  assert.throws(() => buildPrompt(ROOT, { base: 'http://x/ | sh' }));
  assert.throws(() => buildPrompt(ROOT, { base: 'http://127.0.0.1:8000' }), /ending in \//);
});

test('every file in the repo with install-prompt markers holds the identical prompt', () => {
  const files = findMarkedFiles();
  assert.ok(files.includes('skills/README.md'), 'skills/README.md carries a copy');
  const want = promptText().replace(/\n$/, '');
  for (const rel of files) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const blocks = markerBlocks(text, rel);
    assert.ok(blocks.length >= 1, rel);
    for (const b of blocks) assert.equal(decodeCopy(rel, b.inner), want, `${rel}:${b.begin + 1} is stale: run node scripts/build-install-prompt.mjs`);
  }
});

test('the prompt and every skill file pass the no-winner and public-lint word rules', () => {
  const problems = wordProblems(promptText(), PROMPT_FILE);
  for (const rel of skillFiles()) problems.push(...wordProblems(fs.readFileSync(path.join(ROOT, rel), 'utf8'), rel));
  assert.deepEqual(problems, []);
});

/* ------------------------------------------------------------------ the checks catch what they should */

test('word rules catch each banned term', () => {
  for (const t of [...LIST_A, ...LIST_B]) assert.ok(wordProblems(`x ${t} y`, 'bad').length, t);
  for (const t of ['the better model', 'our top choice', 'we recommend', 'suggested model', 'picks one', 'hit the inter' + 'view',
    'continue, res' + 'ume later', 'car' + 'eer move', 'my emplo' + 'yer', 'see /Users/someone/x', 'HAND' + 'OFF.md',
    'sta' + 'tus/modelproof.md']) {
    assert.ok(wordProblems(t, 'bad').length, t);
  }
  assert.deepEqual(wordProblems('Plan 11a5d7f5 · helpers load next session · stop on a mismatch', 'ok'), []);
});

test('a changed pinned file fails the hash check; a missing one is named', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-prompt-'));
  try {
    for (const rel of pinnedFiles()) {
      fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
      fs.copyFileSync(path.join(ROOT, rel), path.join(tmp, rel));
    }
    const p = buildPrompt(tmp);
    assert.deepEqual(hashProblems(tmp, p), []);
    fs.appendFileSync(path.join(tmp, 'assets/install.mjs'), '\n');
    assert.deepEqual(hashProblems(tmp, p), ['assets/install.mjs: hash differs']);
    fs.renameSync(path.join(tmp, SKILL_DIR, 'references/data.md'), path.join(tmp, 'moved.md'));
    assert.ok(hashProblems(tmp, p).includes(`${SKILL_DIR}/references/data.md: missing`));
    // A new reference is pinned automatically.
    fs.renameSync(path.join(tmp, 'moved.md'), path.join(tmp, SKILL_DIR, 'references/data.md'));
    fs.writeFileSync(path.join(tmp, SKILL_DIR, 'references/zz-new.md'), 'new\n');
    assert.ok(buildPrompt(tmp).includes(`${SKILL_DIR}/references/zz-new.md`));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('markers: md, html and js copies round-trip; broken markers throw', () => {
  const p = buildPrompt();
  const want = p.replace(/\n$/, '');
  const md = syncText('a.md', `# t\n<!-- ${BEGIN} -->\nold\n<!-- ${END} -->\nafter\n`, p);
  assert.equal(decodeCopy('a.md', markerBlocks(md)[0].inner), want);
  assert.match(md, /\n```text\n/);
  assert.ok(md.endsWith('\nafter\n'));
  const html = syncText('a.html', `<pre>\n<!-- ${BEGIN} -->\nold & <b>\n<!-- ${END} -->\n</pre>`, p);
  assert.equal(decodeCopy('a.html', markerBlocks(html)[0].inner), want);
  const js = syncText('a.js', `x();\n// ${BEGIN}\nconst INSTALL_PROMPT = "old";\n// ${END}\n`, p);
  assert.equal(decodeCopy('a.js', markerBlocks(js)[0].inner), want);
  assert.match(js, /^const INSTALL_PROMPT = ".*";$/m);
  assert.throws(() => encodeCopy('a.js', p, ['no literal here']));
  const crlf = syncText('a.md', `a\r\n<!-- ${BEGIN} -->\r\n<!-- ${END} -->\r\n`, p);
  assert.ok(!/[^\r]\n/.test(crlf), 'CRLF kept');
  assert.throws(() => markerBlocks(`<!-- ${BEGIN} -->\nx\n`), /without an end/);
  assert.throws(() => markerBlocks(`<!-- ${END} -->\n`), /without a begin/);
  assert.throws(() => markerBlocks(`<!-- ${BEGIN} -->\n<!-- ${BEGIN} -->\n<!-- ${END} -->\n`), /second/);
  // A line that only mentions the marker is not a marker.
  assert.equal(markerBlocks(`see ${BEGIN} in the docs\n`).length, 0);
});

test('--check finds a stale copy; a sync fixes it and a second sync changes nothing', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-sync-'));
  try {
    for (const rel of pinnedFiles()) {
      fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
      fs.copyFileSync(path.join(ROOT, rel), path.join(tmp, rel));
    }
    fs.writeFileSync(path.join(tmp, PROMPT_FILE), 'old\n');
    fs.writeFileSync(path.join(tmp, 'page.html'), `<pre>\n<!-- ${BEGIN} -->\nold\n<!-- ${END} -->\n</pre>\n`);
    fs.mkdirSync(path.join(tmp, 'archive'));
    fs.writeFileSync(path.join(tmp, 'archive/old.md'), `<!-- ${BEGIN} -->\nold\n<!-- ${END} -->\n`);
    const before = syncAll(tmp, { check: true });
    assert.deepEqual(before.stale.sort(), [PROMPT_FILE, 'page.html'].sort());
    assert.equal(fs.readFileSync(path.join(tmp, PROMPT_FILE), 'utf8'), 'old\n', '--check writes nothing');
    syncAll(tmp);
    assert.deepEqual(syncAll(tmp, { check: true }).stale, []);
    assert.equal(fs.readFileSync(path.join(tmp, 'archive/old.md'), 'utf8'), `<!-- ${BEGIN} -->\nold\n<!-- ${END} -->\n`, 'archive/ is left alone');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
