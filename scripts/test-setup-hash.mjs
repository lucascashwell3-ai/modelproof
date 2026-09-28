// Tests for scripts/setup-hash.mjs, the independent roundtrip checker. Run as a CLI, the way the
// installer tests and the stranger test use it. Everything happens in fresh temp folders.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HASH = path.join(ROOT, 'scripts', 'setup-hash.mjs');
const temps = [];
after(() => { for (const t of temps) fs.rmSync(t, { recursive: true, force: true }); });

function tmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-hash-')); temps.push(d); return d; }
function run(...args) {
  const r = spawnSync(process.execPath, [HASH, ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
}
function put(root, rel, text) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
}
function tree() {
  const root = tmp();
  put(root, 'home/.claude/CLAUDE.md', '# notes\n');
  put(root, 'home/.claude/agents/a.md', '---\nname: a\n---\nbody\n');
  put(root, 'project/AGENTS.md', 'hello\n');
  fs.mkdirSync(path.join(root, 'project', 'empty'));
  fs.symlinkSync('AGENTS.md', path.join(root, 'project', 'LINK.md'));
  return root;
}
function snap(root) {
  const out = path.join(tmp(), 'snap.json');
  assert.equal(run('snapshot', root, '--out', out).code, 0);
  return out;
}
const agent = (name, owned) => `---\nname: ${name}\ndescription: x\n---\n${owned ? '<!-- modelproof:owned v1 sha=0123456789abcdef -->\n' : ''}body\n`;

test('setup-hash does not import the installer or read its install record', () => {
  const src = fs.readFileSync(HASH, 'utf8');
  assert.doesNotMatch(src, /install\.mjs|instructions\.mjs|manifest/);
  assert.doesNotMatch(src, /^import .*from '\.\.?\//m);
});

test('compare: an untouched tree is identical (exit 0)', () => {
  const root = tree();
  const s = snap(root);
  const r = run('compare', root, s);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /identical/);
});

test('compare: changed bytes, a changed mode, an added file and an added folder each fail (exit 1)', () => {
  const cases = [
    (root) => fs.appendFileSync(path.join(root, 'project', 'AGENTS.md'), 'more\n'),
    (root) => fs.chmodSync(path.join(root, 'project', 'AGENTS.md'), 0o600),
    (root) => put(root, 'home/.claude/new.md', 'x\n'),
    (root) => fs.mkdirSync(path.join(root, 'home', 'newdir')),
    (root) => fs.rmdirSync(path.join(root, 'project', 'empty')),
  ];
  for (const change of cases) {
    const root = tree();
    const s = snap(root);
    change(root);
    const r = run('compare', root, s);
    assert.equal(r.code, 1, `expected a difference after ${change}`);
  }
});

test('symbolic links are recorded as links and never followed', () => {
  const outside = tmp();
  const target = put(outside, 'secret.md', 'one\n');
  const root = tree();
  fs.symlinkSync(target, path.join(root, 'home', 'outside.md'));
  const s = snap(root);
  const entries = JSON.parse(fs.readFileSync(s, 'utf8')).entries;
  const link = entries.find((e) => e.path === 'home/outside.md');
  assert.deepEqual(link, { path: 'home/outside.md', type: 'link', target });
  // The linked file changing outside the tree is not a change to the tree.
  fs.writeFileSync(target, 'two\n');
  assert.equal(run('compare', root, s).code, 0);
  // Re-pointing the link is.
  fs.unlinkSync(path.join(root, 'project', 'LINK.md'));
  fs.symlinkSync('empty', path.join(root, 'project', 'LINK.md'));
  const r = run('compare', root, s);
  assert.equal(r.code, 1);
  assert.match(r.out, /link +project\/LINK\.md/);
});

test('compare --ignore skips exactly the named path and prints every ignore', () => {
  const root = tree();
  const s = snap(root);
  put(root, '.modelproof/installs/x/manifest.json', '{}\n');
  let r = run('compare', root, s);
  assert.equal(r.code, 1);
  r = run('compare', root, s, '--ignore', '.modelproof');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /ignoring: \.modelproof/);
  put(root, 'home/other.md', 'x\n');
  r = run('compare', root, s, '--ignore', '.modelproof');
  assert.equal(r.code, 1);
});

test('dupes: a clean tree passes', () => {
  const root = tree();
  put(root, 'project/.claude/agents/modelproof-scout.md', agent('modelproof-scout', true));
  put(root, 'project/.cursor/agents/modelproof-scout.md', agent('modelproof-scout', true));
  put(root, 'home/.claude/agents/modelproof-scout.md', agent('modelproof-scout', true));
  put(root, 'project/AGENTS.md', 'x\n\n<!-- modelproof:begin v1 sha=0123456789abcdef -->\nbody\n<!-- modelproof:end -->\n');
  put(root, 'project/.claude/settings.json', '{\n  "a": {"x": 1, "x": 2},\n  "b": 1\n}\n');
  put(root, 'home/.codex/config.toml', 'model = "x"\n[projects."/home/alex/a"]\ntrust_level = "trusted"\n[[hooks]]\n[[hooks]]\n');
  const r = run('dupes', root);
  assert.equal(r.code, 0, r.out);
});

test('dupes: two begin markers in one file fail; a marker inside a code fence does not count', () => {
  const root = tree();
  const block = '<!-- modelproof:begin v1 sha=0123456789abcdef -->\nbody\n<!-- modelproof:end -->\n';
  put(root, 'project/AGENTS.md', '```\n' + block + '```\n' + block);
  assert.equal(run('dupes', root).code, 0);
  put(root, 'project/AGENTS.md', block + '\n' + block);
  const r = run('dupes', root);
  assert.equal(r.code, 1);
  assert.match(r.out, /project\/AGENTS\.md: 2 modelproof begin markers/);
});

test('dupes: the same helper name twice in one agents folder fails (subfolders and TOML included)', () => {
  let root = tree();
  put(root, 'home/.claude/agents/one.md', agent('helper', false));
  put(root, 'home/.claude/agents/team/two.md', agent('helper', false));
  assert.equal(run('dupes', root).code, 1);
  root = tree();
  put(root, 'project/.codex/agents/a.toml', 'name = "rel"\ndescription = "x"\n');
  put(root, 'project/.codex/agents/b.toml', 'name = "rel"\ndescription = "y"\n');
  const r = run('dupes', root);
  assert.equal(r.code, 1);
  assert.match(r.out, /helper name "rel"/);
});

test('dupes: a modelproof helper sharing a name with someone else\'s helper in the same tool fails', () => {
  const root = tree();
  put(root, 'home/.claude/agents/modelproof-scout.md', agent('modelproof-scout', true));
  put(root, 'project/.claude/agents/scout.md', agent('modelproof-scout', false));
  const r = run('dupes', root);
  assert.equal(r.code, 1);
  assert.match(r.out, /shares the name "modelproof-scout"/);
});

test('dupes: repeated top-level settings keys and repeated TOML table headers fail', () => {
  let root = tree();
  put(root, 'home/.claude/settings.json', '{\n  "model": "a",\n  "hooks": {},\n  "model": "b"\n}\n');
  let r = run('dupes', root);
  assert.equal(r.code, 1);
  assert.match(r.out, /repeated top-level key\(s\) model/);
  root = tree();
  put(root, 'home/.codex/config.toml', '[profile]\na = 1\n[profile]\nb = 2\n');
  r = run('dupes', root);
  assert.equal(r.code, 1);
  assert.match(r.out, /repeated table header/);
});

test('dupes: the .modelproof state folder is not searched, and says so', () => {
  const root = tree();
  const block = '<!-- modelproof:begin v1 sha=0123456789abcdef -->\nb\n<!-- modelproof:end -->\n';
  put(root, 'home/.modelproof/installs/x/removed/1/AGENTS.md', block + block);
  const r = run('dupes', root);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /not searched: \.modelproof/);
});

test('usage errors exit 2', () => {
  assert.equal(run('nope').code, 2);
  assert.equal(run('compare').code, 2);
});
