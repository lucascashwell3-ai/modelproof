// Tests for assets/install.mjs. Every run copies a fixture setup from scripts/fixtures/setups/<name>/
// {home,project} into a fresh temp folder, keeps the install record (MODELPROOF_HOME) in a SEPARATE
// temp folder, and checks the result with scripts/setup-hash.mjs — which shares no code with the
// installer. Frozen inputs: scripts/fixtures/{guidance,instructions-models,instructions-plans}.json.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeContext, detect, readers } from '../assets/install.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALL = path.join(ROOT, 'assets', 'install.mjs');
const HASH = path.join(ROOT, 'scripts', 'setup-hash.mjs');
const FIX = path.join(ROOT, 'scripts', 'fixtures');
const PROFILES = path.join(FIX, 'profiles');
const temps = [];
after(() => {
  for (const t of temps) {
    try { fs.chmodSync(t, 0o700); } catch { /* gone */ }
    fs.rmSync(t, { recursive: true, force: true });
  }
});
const tmp = (tag) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `mp-${tag}-`)); temps.push(d); return d; };

// One frozen data folder for every run.
const DATA = tmp('data');
fs.copyFileSync(path.join(FIX, 'guidance.json'), path.join(DATA, 'guidance.json'));
fs.copyFileSync(path.join(FIX, 'instructions-models.json'), path.join(DATA, 'models.json'));
fs.copyFileSync(path.join(FIX, 'instructions-plans.json'), path.join(DATA, 'plans.json'));

// Copy a tree keeping links as links and file modes.
function copyTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name); const d = path.join(dest, name);
    const st = fs.lstatSync(s);
    if (st.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(s), d);
    else if (st.isDirectory()) copyTree(s, d);
    else { fs.copyFileSync(s, d); fs.chmodSync(d, st.mode & 0o7777); }
  }
}
function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE', 'MODELPROOF_HOME']) delete env[k];
  return { ...env, ...extra };
}
function setup(name) {
  const dir = tmp('setup');
  const src = path.join(FIX, 'setups', name);
  for (const part of ['home', 'project']) {
    if (fs.existsSync(path.join(src, part))) copyTree(path.join(src, part), path.join(dir, part));
    else fs.mkdirSync(path.join(dir, part));
  }
  const f = { dir, home: path.join(dir, 'home'), project: path.join(dir, 'project'), state: tmp('state'), work: tmp('work') };
  f.env = cleanEnv({ MODELPROOF_HOME: f.state });
  return f;
}
function node(script, args, env) {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env });
  return { code: r.status, out: r.stdout, err: r.stderr, all: r.stdout + r.stderr };
}
const inst = (f, ...args) => node(INSTALL, args, f.env);
const hash = (...args) => node(HASH, args, cleanEnv());
let planN = 0;
function plan(f, profile, { project = true, state } = {}) {
  const out = path.join(f.work, `plan-${++planN}.json`);
  const args = ['plan', '--profile', profile, '--data', DATA, '--home', f.home, ...(project ? ['--project', f.project] : []), '--out', out];
  const r = node(INSTALL, args, state ? cleanEnv({ MODELPROOF_HOME: state }) : f.env);
  const p = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null;
  return { ...r, plan: p, file: out };
}
function apply(f, p, { skip, expect, state } = {}) {
  const args = ['apply', '--plan', p.file, '--expect', expect || p.plan.hash, ...(skip ? ['--skip', skip] : [])];
  return node(INSTALL, args, state ? cleanEnv({ MODELPROOF_HOME: state }) : f.env);
}
const verify = (f, project = true) => inst(f, 'verify', '--home', f.home, ...(project ? ['--project', f.project] : []));
const undo = (f, id, state) => node(INSTALL, ['undo', id], state ? cleanEnv({ MODELPROOF_HOME: state }) : f.env);
function snapshot(f, label = 'snap') {
  const out = path.join(f.work, `${label}-${++planN}.json`);
  const r = hash('snapshot', f.dir, '--out', out);
  assert.equal(r.code, 0, r.all);
  return out;
}
const compare = (f, snap) => hash('compare', f.dir, snap);
const dupes = (f) => hash('dupes', f.dir);
const writeProfile = (f, base, over) => {
  const p = { ...JSON.parse(fs.readFileSync(base, 'utf8')), ...over };
  const out = path.join(f.work, `profile-${++planN}.json`);
  fs.writeFileSync(out, JSON.stringify(p));
  return out;
};
const read = (p) => fs.readFileSync(p, 'utf8');
const ok = (r, msg) => assert.equal(r.code, 0, `${msg || 'expected exit 0'}\n${r.all}`);

// The full roundtrip from spec §5: snapshot → plan → apply → verify → dupes → plan+apply again →
// dupes + same bytes → undo → compare 0.
function roundtrip(f, profile, { project = true } = {}) {
  const before = snapshot(f, 'before');
  const p1 = plan(f, profile, { project });
  ok(p1, 'plan');
  assert.ok(p1.plan.items.length > 0);
  assert.ok(p1.plan.items.every((x) => x.action !== 'conflict'), p1.out);
  ok(apply(f, p1), 'apply');
  ok(verify(f, project), 'verify');
  ok(dupes(f), 'dupes after first install');
  const first = snapshot(f, 'first');
  const p2 = plan(f, profile, { project });
  ok(p2, 'second plan');
  assert.deepEqual(p2.plan.items.map((x) => x.action), p2.plan.items.map(() => 'unchanged'), p2.out);
  ok(apply(f, p2), 'second apply');
  ok(dupes(f), 'dupes after second install');
  ok(compare(f, first), 'second install leaves the same bytes as the first');
  const u = undo(f, p1.plan.id);
  ok(u, 'undo');
  assert.match(u.out, /byte-identical/);
  ok(compare(f, before), 'undo restores the tree');
  return { before, p1 };
}

/* ------------------------------------------------------------------ the five setups + two more */

const MAIN = [
  ['cc-max5x', path.join(PROFILES, 'cc-max5x.json'), false],
  ['codex', path.join(PROFILES, 'codex.json'), false],
  ['cursor', path.join(PROFILES, 'cursor.json'), true],
  ['org-40', path.join(PROFILES, 'org-40.json'), true],
  ['empty', path.join(PROFILES, 'empty.json'), true],
];
for (const [name, profile, project] of MAIN) {
  test(`roundtrip: ${name}`, () => roundtrip(setup(name), profile, { project }));
}

test('roundtrip: agents-md-only never gets a CLAUDE.md, and Claude Code shares the AGENTS.md block', () => {
  const f = setup('agents-md-only');
  const profile = path.join(FIX, 'setups', 'agents-md-only', 'profile.json');
  const p = plan(f, profile);
  const block = p.plan.items.find((x) => x.path === 'AGENTS.md');
  assert.equal(block.action, 'append');
  assert.ok(!p.plan.items.some((x) => /CLAUDE|rules\/modelproof/.test(x.path)), p.out);
  const part = p.plan.package.parts.find((x) => x.target.path === 'AGENTS.md');
  assert.ok(part.readers.includes('claude-code'));
  ok(apply(f, p));
  for (const n of ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md']) assert.ok(!fs.existsSync(path.join(f.project, n)), n);
  ok(undo(f, p.plan.id));
  const g = setup('agents-md-only');
  roundtrip(g, profile);
  for (const n of ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md']) assert.ok(!fs.existsSync(path.join(g.project, n)), n);
});

test('roundtrip: symlinked .claude folders and a symlinked AGENTS.md stay links; writes land at the real path', () => {
  const f = setup('symlink');
  const before = snapshot(f, 'before');
  const proj = path.join(FIX, 'setups', 'symlink', 'profile.json');
  const user = path.join(FIX, 'setups', 'symlink', 'profile-user.json');
  const p = plan(f, proj);
  ok(p);
  const agents = p.plan.items.find((x) => x.path === 'AGENTS.md');
  assert.equal(agents.link, true);
  assert.equal(agents.real_path, fs.realpathSync(path.join(f.project, 'docs', 'AGENTS.md')));
  assert.match(p.out, /real path: .*docs\/AGENTS\.md/);
  ok(apply(f, p));
  ok(verify(f));
  ok(dupes(f));
  for (const l of ['project/.claude', 'project/AGENTS.md']) assert.ok(fs.lstatSync(path.join(f.dir, l)).isSymbolicLink(), `${l} is still a link`);
  assert.match(read(path.join(f.project, 'docs', 'AGENTS.md')), /modelproof:begin/);
  assert.ok(fs.existsSync(path.join(f.project, 'config', 'claude', 'agents', 'modelproof-scout.md')));
  let first = snapshot(f, 'first');
  ok(apply(f, plan(f, proj)));
  ok(compare(f, first));
  ok(undo(f, p.plan.id));
  ok(compare(f, before));
  // The same through a linked ~/.claude (a dotfiles folder).
  const pu = plan(f, user, { project: false });
  ok(pu);
  assert.match(pu.out, /real path: .*dotfiles\/claude\/rules\/modelproof\.md/);
  ok(apply(f, pu));
  ok(verify(f, false));
  ok(dupes(f));
  assert.ok(fs.lstatSync(path.join(f.home, '.claude')).isSymbolicLink());
  assert.ok(fs.existsSync(path.join(f.home, 'dotfiles', 'claude', 'rules', 'modelproof.md')));
  first = snapshot(f, 'first');
  ok(apply(f, plan(f, user, { project: false })));
  ok(compare(f, first));
  ok(undo(f, pu.plan.id));
  ok(compare(f, before));
  for (const l of ['project/.claude', 'project/AGENTS.md', 'home/.claude']) assert.ok(fs.lstatSync(path.join(f.dir, l)).isSymbolicLink());
});

test('optional parts are opt-in: no Explore unless the profile asks, and apply writes only planned parts', () => {
  const f = setup('cc-max5x');
  const before = snapshot(f, 'before');
  const explore = path.join(f.home, '.claude', 'agents', 'modelproof-explore.md');
  const base = path.join(PROFILES, 'cc-max5x.json');
  const p = plan(f, base, { project: false });
  ok(p);
  assert.ok(!p.plan.items.some((x) => x.part_id === 'claude-code:agent:explore'), p.out);
  assert.ok(!p.plan.package.parts.some((x) => x.id === 'claude-code:agent:explore'));
  assert.match(p.out, /Also available, not included: modelproof-explore\.md/);
  // A part slipped into the package with no numbered item is refused, even with a matching hash.
  const on = plan(f, writeProfile(f, base, { explore_override: true }), { project: false });
  ok(on);
  const item = on.plan.items.find((x) => x.part_id === 'claude-code:agent:explore');
  assert.ok(item && item.action === 'create', on.out);
  const tampered = JSON.parse(JSON.stringify(p.plan));
  tampered.package.parts.push(on.plan.package.parts[item.n - 1]);
  delete tampered.hash;
  tampered.hash = crypto.createHash('sha256').update(JSON.stringify(tampered)).digest('hex').slice(0, 16);
  const tFile = path.join(f.work, 'tampered.json');
  fs.writeFileSync(tFile, JSON.stringify(tampered));
  const t = node(INSTALL, ['apply', '--plan', tFile, '--expect', tampered.hash], f.env);
  assert.equal(t.code, 1, t.all);
  assert.match(t.all, /do not match/);
  ok(compare(f, before));
  // The default plan installs no Explore file.
  ok(apply(f, p));
  assert.ok(!fs.existsSync(explore));
  ok(undo(f, p.plan.id));
  ok(compare(f, before));
  // Opted in: the item is there; "no to N" leaves it out; a yes writes it.
  const on2 = plan(f, writeProfile(f, base, { explore_override: true }), { project: false });
  const n = on2.plan.items.find((x) => x.part_id === 'claude-code:agent:explore').n;
  ok(apply(f, on2, { skip: String(n) }));
  assert.ok(!fs.existsSync(explore));
  ok(undo(f, on2.plan.id));
  const on3 = plan(f, writeProfile(f, base, { explore_override: true }), { project: false });
  ok(apply(f, on3));
  assert.match(read(explore), /^name: Explore$/m);
  ok(undo(f, on3.plan.id));
  ok(compare(f, before));
});

/* ------------------------------------------------------------------ detect */

test('detect (cc-max5x): heads-up names the prose model rule by file:line; memory mentions are file:line only; no secrets', () => {
  const f = setup('cc-max5x');
  const r = inst(f, 'detect', '--home', f.home);
  ok(r);
  const s = JSON.parse(r.out);
  const h = s.heads_up.find((x) => x.file === '~/.claude/CLAUDE.md' && x.line === 39);
  assert.ok(h, r.out);
  assert.match(h.text, /Use opus for builds/);
  assert.deepEqual(s.mentions, [{ file: '~/.claude/projects/-home-alex-app/memory/prefs.md', line: 4 }]);
  assert.deepEqual(s.agents.map((a) => [a.name, a.model, a.modelproof]), [['code-reviewer', null, false], ['test-runner', null, false]]);
  assert.deepEqual(s.settings[0].keys, ['permissions', 'hooks', 'env', 'apiKeyHelper']);
  const style = s.files.find((x) => x.path === '~/.claude/notes/style.md');
  assert.deepEqual(style.readers, ['claude-code'], 'the @import is followed');
  assert.ok(!s.files.some((x) => /not-an-import/.test(x.path)), 'an @path inside a code fence is not an import');
  assert.doesNotMatch(r.out, /not-for-output/);
  // The plan prints the same heads-up, and the builder follows the user's own choice.
  const p = plan(f, path.join(PROFILES, 'cc-max5x.json'), { project: false });
  assert.match(p.out, /~\/\.claude\/CLAUDE\.md:39 +- Use opus for builds/);
  assert.doesNotMatch(p.out + JSON.stringify(p.plan), /not-for-output/);
  const builder = p.plan.package.parts.find((x) => x.id === 'claude-code:agent:builder');
  assert.match(builder.content, /^model: claude-opus-5-5$/m);
  assert.match(p.out, /builder +Claude Opus 5\.5 · your choice/);
});

test('plan preview: real conflicts first; rules-file lines shown; memory mentions on one line', () => {
  const f = setup('cc-max5x');
  const rules = path.join(f.home, '.claude', 'rules');
  fs.mkdirSync(rules, { recursive: true });
  fs.writeFileSync(path.join(rules, 'models.md'), '# Models\n- Keep token use low: use sonnet for reviews.\n- The opus proxy key is sk-live-abcdefgh12345678.\n');
  const s = JSON.parse(inst(f, 'detect', '--home', f.home).out);
  const line = (n) => s.heads_up.find((x) => x.file === '~/.claude/rules/models.md' && x.line === n);
  assert.equal(line(2).text, '- Keep token use low: use sonnet for reviews.', 'a rules-file line is shown like a CLAUDE.md line');
  assert.equal(line(3).text, '(line not shown)', 'a line holding a secret-looking value stays hidden');
  assert.deepEqual(s.agents.map((a) => a.description), ['Reviews a diff for bugs and unclear code. Use after a change is finished.', 'Runs the test suite and reports failures with the first useful line of each.']);
  const p = plan(f, path.join(PROFILES, 'cc-max5x.json'), { project: false });
  ok(p);
  const out = p.out;
  const reviewer = p.plan.items.find((x) => x.part_id === 'claude-code:agent:reviewer').n;
  const check = out.indexOf('Check these before you say Go');
  assert.ok(check > 0 && check < out.indexOf('Which model each helper runs'), out);
  assert.ok(out.includes(`  - ~/.claude/rules/models.md:2 says "- Keep token use low: use sonnet for reviews."; #${reviewer} modelproof-reviewer runs on the lead's model. Make them match, or skip #${reviewer}.`), out);
  assert.ok(out.includes(`  - Your helper code-reviewer (~/.claude/agents/code-reviewer.md) does the same job as #${reviewer} modelproof-reviewer. Keep both, or skip #${reviewer}.`), out);
  assert.ok(out.includes(`  - Your helper test-runner (~/.claude/agents/test-runner.md) does the same job as #${reviewer} modelproof-reviewer. Keep both, or skip #${reviewer}.`), out);
  // The heads-up list keeps the other lines, without repeating a checked one; memory is one line.
  const heads = out.slice(out.indexOf('Heads-up:'));
  assert.match(heads, /~\/\.claude\/CLAUDE\.md:39 +- Use opus for builds/);
  assert.doesNotMatch(heads, /models\.md:2/);
  assert.match(heads, /models\.md:3 +\(line not shown\)/);
  assert.match(heads, /^  Memory and output styles: 1 line names a model \(prefs\.md; lines not shown\)$/m);
  assert.doesNotMatch(out, /memory or output style; mentions a model/);
  assert.doesNotMatch(out + JSON.stringify(p.plan), /sk-live|not-for-output/);
});

test('readers: who loads the project AGENTS.md, case by case', () => {
  const cases = [
    ['no CLAUDE.md', {}, true],
    ['CLAUDE.md without an import', { 'CLAUDE.md': '# x\n' }, false],
    ['CLAUDE.md with @AGENTS.md', { 'CLAUDE.md': '# x\n@AGENTS.md\n' }, true],
    ['a two-hop import chain', { 'CLAUDE.md': 'see @docs/a.md\n', 'docs/a.md': '@../AGENTS.md\n' }, true],
    ['@AGENTS.md inside a code fence', { 'CLAUDE.md': '```\n@AGENTS.md\n```\n' }, false],
    ['@AGENTS.md inside inline code', { 'CLAUDE.md': 'write `@AGENTS.md` to import\n' }, false],
    ['CLAUDE.local.md only', { 'CLAUDE.local.md': '# mine\n' }, false],
    ['.claude/CLAUDE.md only', { '.claude/CLAUDE.md': '# mine\n' }, false],
    ['mode claude-md-and-agents-md', { 'CLAUDE.md': '# x\n', '~/.claude/settings.json': JSON.stringify({ pluginConfigs: { 'agents-md@builtin': { options: { instructionFiles: 'claude-md-and-agents-md' } } } }) }, true],
    ['mode claude-md', { '~/.claude/settings.json': JSON.stringify({ pluginConfigs: { 'agents-md@builtin': { options: { instructionFiles: 'claude-md' } } } }) }, false],
    ['an unknown mode', { '~/.claude/settings.json': JSON.stringify({ pluginConfigs: { 'agents-md@builtin': { options: { instructionFiles: 'something-new' } } } }) }, 'unsure'],
  ];
  for (const [label, files, want] of cases) {
    const f = setup('empty');
    fs.writeFileSync(path.join(f.project, 'AGENTS.md'), '# agents\n');
    for (const [rel, text] of Object.entries(files)) {
      const p = rel.startsWith('~/') ? path.join(f.home, rel.slice(2)) : path.join(f.project, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, text);
    }
    const ctx = makeContext({ home: f.home, project: f.project, env: {} });
    assert.equal(detect(ctx).claude_reads_project_agents_md, want, label);
    const r = readers(path.join(f.project, 'AGENTS.md'), ctx);
    assert.equal(r.tools.includes('claude-code'), want !== false, label);
    assert.equal(r.unsure, want === 'unsure', label);
  }
});

test('readers: AGENTS.md linked to CLAUDE.md is read by Claude Code', () => {
  const f = setup('empty');
  fs.writeFileSync(path.join(f.project, 'CLAUDE.md'), '# shared\n');
  fs.symlinkSync('CLAUDE.md', path.join(f.project, 'AGENTS.md'));
  const ctx = makeContext({ home: f.home, project: f.project, env: {} });
  assert.equal(detect(ctx).claude_reads_project_agents_md, true);
});

test('readers: unsure → Claude Code keeps its own rules file and the preview says lines may load twice', () => {
  const f = setup('empty');
  fs.writeFileSync(path.join(f.project, 'AGENTS.md'), '# agents\n');
  fs.mkdirSync(path.join(f.home, '.claude'));
  fs.writeFileSync(path.join(f.home, '.claude', 'settings.json'), JSON.stringify({ pluginConfigs: { 'agents-md@builtin': { options: { instructionFiles: 'something-new' } } } }));
  const prof = writeProfile(f, path.join(PROFILES, 'empty.json'), { tools: ['claude-code', 'codex'] });
  const p = plan(f, prof);
  ok(p);
  assert.ok(p.plan.items.some((x) => x.path === '.claude/rules/modelproof.md'));
  assert.match(p.out, /may load twice/);
});

test('readers: AGENTS.override.md → Codex reads it instead, and only the Codex text goes there', () => {
  const f = setup('empty');
  fs.writeFileSync(path.join(f.project, 'AGENTS.md'), '# shared\n');
  fs.writeFileSync(path.join(f.project, 'AGENTS.override.md'), '# override\n');
  const ctx = makeContext({ home: f.home, project: f.project, env: {} });
  assert.ok(!readers(path.join(f.project, 'AGENTS.md'), ctx).tools.includes('codex'));
  assert.deepEqual(readers(path.join(f.project, 'AGENTS.override.md'), ctx).tools, ['codex']);
  assert.equal(detect(ctx).agents_override.project, true);
  const prof = writeProfile(f, path.join(PROFILES, 'empty.json'), { tools: ['codex'] });
  const p = plan(f, prof);
  const text = p.plan.items.filter((x) => x.kind === 'block');
  assert.deepEqual(text.map((x) => x.path), ['AGENTS.override.md']);
  roundtrip(f, prof);
});

test('CODEX_HOME / CLAUDE_CONFIG_DIR: honoured inside the home folder, ignored (with a note) outside it', () => {
  const f = setup('empty');
  fs.mkdirSync(path.join(f.home, 'cfg', 'codex'), { recursive: true });
  let ctx = makeContext({ home: f.home, project: f.project, env: { CODEX_HOME: path.join(f.home, 'cfg', 'codex'), CLAUDE_CONFIG_DIR: '/etc/claude-elsewhere' } });
  const s = detect(ctx);
  assert.equal(s.dirs.codex, '~/cfg/codex');
  assert.equal(s.dirs.claude, '~/.claude');
  assert.ok(s.notes.some((n) => /CLAUDE_CONFIG_DIR points outside/.test(n)));
  ctx = makeContext({ home: f.home, env: { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' } });
  assert.equal(detect(ctx).env.subagent_model_force, true);
  // Plan through the CLI with CODEX_HOME set: the Codex files go under it.
  const prof = path.join(PROFILES, 'codex.json');
  const out = path.join(f.work, 'p.json');
  const r = node(INSTALL, ['plan', '--profile', prof, '--data', DATA, '--home', f.home, '--out', out], cleanEnv({ MODELPROOF_HOME: f.state, CODEX_HOME: path.join(f.home, 'cfg', 'codex') }));
  ok(r);
  const p = JSON.parse(read(out));
  assert.ok(p.items.every((x) => x.path.startsWith('~/cfg/codex/')), JSON.stringify(p.items.map((x) => x.path)));
});

/* ------------------------------------------------------------------ edge cases */

test('drift: a target changed after the preview → apply exits 3 and writes nothing', () => {
  const f = setup('codex');
  const p = plan(f, path.join(PROFILES, 'codex.json'), { project: false });
  fs.appendFileSync(path.join(f.home, '.codex', 'AGENTS.md'), '- one more rule\n');
  const snap = snapshot(f);
  const r = apply(f, p);
  assert.equal(r.code, 3, r.all);
  assert.match(r.all, /changed since the preview/);
  ok(compare(f, snap));
  assert.ok(!fs.existsSync(path.join(f.state, 'installs')), 'no install record written');
});

test('apply refuses a plan that is not the one previewed (wrong --expect, edited plan) with exit 3', () => {
  const f = setup('empty');
  const p = plan(f, path.join(PROFILES, 'empty.json'));
  const snap = snapshot(f);
  assert.equal(apply(f, p, { expect: '0000000000000000' }).code, 3);
  const edited = { ...p.plan, items: p.plan.items.slice(1) };
  fs.writeFileSync(p.file, JSON.stringify(edited));
  assert.equal(apply(f, p).code, 3);
  ok(compare(f, snap));
  const r = node(INSTALL, ['apply', '--plan', p.file], f.env);
  assert.equal(r.code, 1, 'apply without --expect is a usage error');
});

test('apply refuses a target outside the fixed list, even in a plan with a matching hash (exit 2)', () => {
  const f = setup('empty');
  const p = plan(f, path.join(PROFILES, 'empty.json'));
  const bad = JSON.parse(JSON.stringify(p.plan));
  bad.items[0].path = '../outside.md';
  bad.package.parts[0].target.path = '../outside.md';
  delete bad.hash;
  bad.hash = crypto.createHash('sha256').update(JSON.stringify(bad)).digest('hex').slice(0, 16);
  fs.writeFileSync(p.file, JSON.stringify(bad));
  const snap = snapshot(f);
  const r = apply(f, { file: p.file, plan: bad });
  assert.equal(r.code, 2, r.all);
  assert.match(r.all, /refused/);
  ok(compare(f, snap));
  assert.ok(!fs.existsSync(path.join(f.dir, 'outside.md')));
});

test('a target linked outside the home and project folders, or to nothing, is refused and never written', () => {
  for (const kind of ['outside', 'dangling']) {
    const f = setup('empty');
    const outside = path.join(tmp('outside'), 'AGENTS.md');
    fs.writeFileSync(outside, '# elsewhere\n');
    fs.symlinkSync(kind === 'outside' ? outside : path.join(f.project, 'nowhere.md'), path.join(f.project, 'AGENTS.md'));
    const prof = writeProfile(f, path.join(PROFILES, 'empty.json'), { tools: ['codex'] });
    const snap = snapshot(f);
    const p = plan(f, prof);
    assert.equal(p.code, 2, p.all);
    const item = p.plan.items.find((x) => x.path === 'AGENTS.md');
    assert.equal(item.action, 'conflict');
    assert.match(item.reason, kind === 'outside' ? /outside the home and project folders/ : /points nowhere/);
    ok(apply(f, p, { skip: String(item.n) }));
    assert.equal(read(outside), '# elsewhere\n');
    ok(undo(f, p.plan.id));
    ok(compare(f, snap));
  }
});

test('name collision: someone else\'s file or helper name is never overwritten (exit 2, --skip continues)', () => {
  const f = setup('empty');
  const own = '---\nname: my-scout\ndescription: mine\n---\nmine\n';
  fs.mkdirSync(path.join(f.project, '.claude', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(f.project, '.claude', 'agents', 'modelproof-scout.md'), own);
  fs.writeFileSync(path.join(f.project, '.claude', 'agents', 'helper.md'), '---\nname: modelproof-builder\ndescription: mine\n---\nmine\n');
  const snap = snapshot(f);
  const p = plan(f, path.join(PROFILES, 'empty.json'));
  assert.equal(p.code, 2, p.all);
  const conflicts = p.plan.items.filter((x) => x.action === 'conflict');
  assert.deepEqual(conflicts.map((x) => x.n), [1, 2]);
  assert.match(conflicts[0].reason, /did not write/);
  assert.match(conflicts[1].reason, /already used by \.claude\/agents\/helper\.md/);
  assert.match(p.out, /--skip 1,2/);
  const r = apply(f, p);
  assert.equal(r.code, 2);
  ok(compare(f, snap));
  ok(apply(f, p, { skip: '1,2' }));
  assert.equal(read(path.join(f.project, '.claude', 'agents', 'modelproof-scout.md')), own);
  assert.ok(fs.existsSync(path.join(f.project, '.claude', 'agents', 'modelproof-reviewer.md')));
  ok(undo(f, p.plan.id));
  ok(compare(f, snap));
});

test('unparseable settings.json → the settings item needs a decision (exit 2) and is never written', () => {
  const f = setup('empty');
  const bad = '{\n  "permissions": {},\n}\n';
  fs.mkdirSync(path.join(f.project, '.claude'));
  fs.writeFileSync(path.join(f.project, '.claude', 'settings.json'), bad);
  const prof = writeProfile(f, path.join(PROFILES, 'empty.json'), { effort_cap: 'high' });
  const snap = snapshot(f);
  const p = plan(f, prof);
  assert.equal(p.code, 2, p.all);
  const item = p.plan.items.find((x) => x.path === '.claude/settings.json');
  assert.equal(item.action, 'conflict');
  assert.match(item.reason, /cannot be read as JSON/);
  assert.equal(apply(f, p).code, 2);
  ok(compare(f, snap));
  ok(apply(f, p, { skip: String(item.n) }));
  assert.equal(read(path.join(f.project, '.claude', 'settings.json')), bad);
  ok(undo(f, p.plan.id));
  ok(compare(f, snap));
});

test('settings keys go in as text: indent kept, never copied to the state folder, user edits survive undo', () => {
  const f = setup('org-40');
  const settings = path.join(f.project, '.claude', 'settings.json');
  const original = read(settings);
  const prof = writeProfile(f, path.join(PROFILES, 'org-40.json'), { effort_cap: 'high' });
  const before = snapshot(f);
  const p = plan(f, prof);
  ok(p);
  assert.equal(p.plan.items.find((x) => x.path === '.claude/settings.json').action, 'add-keys');
  ok(apply(f, p));
  const after = read(settings);
  assert.equal(after, original.replace(/\n}\n$/, ',\n    "maxEffortLevel": "high"\n}\n'));
  assert.deepEqual(JSON.parse(after).permissions, JSON.parse(original).permissions);
  ok(verify(f));
  ok(dupes(f));
  const stateFiles = [];
  const walk = (d) => { for (const n of fs.readdirSync(d)) { const p2 = path.join(d, n); if (fs.statSync(p2).isDirectory()) walk(p2); else stateFiles.push(p2); } };
  walk(f.state);
  for (const s of stateFiles.filter((x) => !x.includes(`${path.sep}bin${path.sep}`))) assert.doesNotMatch(read(s), /make check/, `${s} must not hold a copy of settings.json`);
  // Reinstall: no second key.
  ok(apply(f, plan(f, prof)));
  assert.equal(read(settings), after);
  // The user adds a key of their own; undo takes out only ours.
  fs.writeFileSync(settings, read(settings).replace('{\n', '{\n    "model": "opus",\n'));
  const u = undo(f, p.plan.id);
  ok(u);
  assert.match(u.out, /except your later edits/);
  assert.equal(read(settings), original.replace('{\n', '{\n    "model": "opus",\n'));
  fs.writeFileSync(settings, original);
  ok(compare(f, before));
});

test('a key modelproof added and the user later changed is kept, and needs a decision on reinstall', () => {
  const f = setup('org-40');
  const settings = path.join(f.project, '.claude', 'settings.json');
  const prof = writeProfile(f, path.join(PROFILES, 'org-40.json'), { effort_cap: 'high' });
  const p = plan(f, prof);
  ok(apply(f, p));
  fs.writeFileSync(settings, read(settings).replace('"maxEffortLevel": "high"', '"maxEffortLevel": "low"'));
  const p2 = plan(f, prof);
  assert.equal(p2.code, 2);
  assert.match(p2.plan.items.find((x) => x.path === '.claude/settings.json').reason, /changed; your value stays/);
  ok(undo(f, p.plan.id));
  assert.match(read(settings), /"maxEffortLevel": "low"/);
});

test('edit outside the block → reinstall → undo leaves the original plus the edit', () => {
  const f = setup('codex');
  const file = path.join(f.home, '.codex', 'AGENTS.md');
  const original = read(file);
  const profile = path.join(PROFILES, 'codex.json');
  const p = plan(f, profile, { project: false });
  ok(apply(f, p));
  fs.writeFileSync(file, '# My top line\n' + read(file) + '- a rule after the block\n');
  const p2 = plan(f, profile, { project: false });
  ok(p2);
  assert.equal(p2.plan.items.find((x) => x.kind === 'block').action, 'unchanged');
  ok(apply(f, p2));
  ok(verify(f, false));
  const u = undo(f, p.plan.id);
  ok(u);
  assert.match(u.out, /except your later edits: ~\/\.codex\/AGENTS\.md/);
  assert.equal(read(file), '# My top line\n' + original + '- a rule after the block\n');
});

test('LC-08: undo that cannot fully take out its own untouched part says so and exits 3; it never blames the user', () => {
  const f = setup('codex');
  const file = path.join(f.home, '.codex', 'AGENTS.md');
  const p = plan(f, path.join(PROFILES, 'codex.json'), { project: false });
  ok(apply(f, p));
  // Nobody edits AGENTS.md. Damage the record of how the block went in, so the cut cannot be exact.
  const mPath = path.join(f.state, 'installs', p.plan.id, 'manifest.json');
  const m = JSON.parse(read(mPath));
  const key = Object.keys(m.targets).find((k) => m.targets[k].kind === 'block');
  assert.equal(key, '~/.codex/AGENTS.md');
  m.targets[key].block.separator = 'XX';
  fs.writeFileSync(mPath, JSON.stringify(m, null, 2) + '\n');
  const u = undo(f, p.plan.id);
  assert.equal(u.code, 3, u.all);
  assert.match(u.all, /could not remove modelproof's part from ~\/\.codex\/AGENTS\.md/);
  assert.doesNotMatch(u.all, /your later edits/);
  assert.doesNotMatch(read(file), /modelproof:begin/, 'the block itself still came out');
});

test('edit inside the block → reinstall keeps it (exit 2); undo cuts the block and keeps a copy of the edit', () => {
  const f = setup('codex');
  const file = path.join(f.home, '.codex', 'AGENTS.md');
  const before = snapshot(f);
  const profile = path.join(PROFILES, 'codex.json');
  const p = plan(f, profile, { project: false });
  ok(apply(f, p));
  fs.writeFileSync(file, read(file).replace('### How to hand off', '### How to hand off (my edit)'));
  assert.equal(verify(f, false).code, 3);
  const p2 = plan(f, profile, { project: false });
  assert.equal(p2.code, 2);
  assert.match(p2.plan.items.find((x) => x.kind === 'block').reason, /edited; your edits stay/);
  const u = undo(f, p.plan.id);
  ok(u);
  const kept = /kept at (\S+)/.exec(u.out);
  assert.ok(kept, u.out);
  assert.match(read(kept[1]), /How to hand off \(my edit\)/);
  ok(compare(f, before));
});

test('profile A → profile B → undo: the tree is back to before A (remove items are numbered)', () => {
  const f = setup('empty');
  const before = snapshot(f);
  const A = path.join(PROFILES, 'empty.json');
  const B = writeProfile(f, A, { tools: ['claude-code', 'codex'], roles: { builder: 'claude-opus-5-5' } });
  const pa = plan(f, A);
  ok(apply(f, pa));
  const pb = plan(f, B);
  ok(pb);
  const rm = pb.plan.items.find((x) => x.action === 'remove');
  assert.ok(rm, pb.out);
  assert.equal(rm.path, '.claude/rules/modelproof.md');
  assert.equal(rm.n, pb.plan.package.parts.length + 1);
  assert.ok(pb.plan.items.some((x) => x.path === 'AGENTS.md' && x.action === 'create'));
  assert.ok(pb.plan.items.some((x) => x.path === '.claude/agents/modelproof-builder.md' && x.action === 'update'));
  ok(apply(f, pb));
  assert.ok(!fs.existsSync(path.join(f.project, '.claude', 'rules')), 'the emptied rules folder it made is gone');
  ok(verify(f));
  ok(dupes(f));
  ok(undo(f, pa.plan.id));
  ok(compare(f, before));
});

test('a read-only target mid-apply rolls back every write (tree and install record unchanged)', { skip: process.getuid && process.getuid() === 0 ? 'root ignores file modes' : false }, () => {
  const f = setup('codex');
  const file = path.join(f.home, '.codex', 'AGENTS.md');
  const p = plan(f, path.join(PROFILES, 'codex.json'), { project: false });
  fs.chmodSync(file, 0o444);
  const snap = snapshot(f);
  const r = apply(f, p);
  assert.equal(r.code, 1, r.all);
  assert.match(r.all, /rolled back/);
  ok(compare(f, snap));
  assert.ok(!fs.existsSync(path.join(f.state, 'installs', p.plan.id, 'manifest.json')));
  fs.chmodSync(file, 0o644);
});

test('LC-07: an existing file is replaced whole (temp file + rename), keeps its mode, and leaves no temp file', () => {
  const f = setup('codex');
  const file = path.join(f.home, '.codex', 'AGENTS.md');
  fs.chmodSync(file, 0o640);
  const before = snapshot(f);
  const ino0 = fs.statSync(file).ino;
  const p = plan(f, path.join(PROFILES, 'codex.json'), { project: false });
  ok(apply(f, p));
  const st1 = fs.statSync(file);
  assert.notEqual(st1.ino, ino0, 'apply wrote a new file and renamed it over the old one (never truncated in place)');
  assert.equal(st1.mode & 0o777, 0o640);
  assert.match(read(file), /modelproof:begin/);
  const leftovers = (dir) => fs.readdirSync(dir).filter((n) => /\.tmp$|modelproof-\d/.test(n) && !/^modelproof-[a-z]+\.toml$/.test(n));
  assert.deepEqual(leftovers(path.dirname(file)), []);
  ok(undo(f, p.plan.id));
  const st2 = fs.statSync(file);
  assert.notEqual(st2.ino, st1.ino, 'undo replaces the file the same way');
  assert.equal(st2.mode & 0o777, 0o640);
  assert.deepEqual(leftovers(path.dirname(file)), []);
  ok(compare(f, before));
});

test('CRLF files keep CRLF, and a file with no final newline keeps none', () => {
  for (const shape of ['crlf', 'no-final-newline']) {
    const f = setup('codex');
    const file = path.join(f.home, '.codex', 'AGENTS.md');
    const text = read(file);
    fs.writeFileSync(file, shape === 'crlf' ? text.replace(/\n/g, '\r\n') : text.replace(/\n$/, ''));
    const before = snapshot(f);
    const p = plan(f, path.join(PROFILES, 'codex.json'), { project: false });
    ok(apply(f, p));
    const after = read(file);
    if (shape === 'crlf') assert.doesNotMatch(after, /[^\r]\n/, 'no bare LF');
    else assert.ok(after.endsWith('<!-- modelproof:end -->'));
    ok(verify(f, false));
    ok(undo(f, p.plan.id));
    ok(compare(f, before), shape);
  }
});

test('adopt: marked parts with no install record are recognised; undo and undo --from-markers restore', () => {
  for (const [name, profile, project] of [['empty', path.join(PROFILES, 'empty.json'), true], ['codex', path.join(PROFILES, 'codex.json'), false]]) {
    const f = setup(name);
    const before = snapshot(f);
    ok(apply(f, plan(f, profile, { project })));
    const mid = snapshot(f);
    // A teammate's checkout, or a lost state folder: a fresh MODELPROOF_HOME.
    const other = tmp('state2');
    const p = plan(f, profile, { project, state: other });
    ok(p);
    assert.ok(p.plan.items.every((x) => x.action === 'adopt'), JSON.stringify(p.plan.items.map((x) => x.action)));
    ok(apply(f, p, { state: other }));
    ok(compare(f, mid), 'adopting writes nothing');
    const u = undo(f, p.plan.id, other);
    ok(u);
    assert.match(u.out, /no earlier record/);
    ok(compare(f, before), `${name}: undo of adopted parts`);
    // Again, with no record at all.
    ok(apply(f, plan(f, profile, { project })));
    const third = tmp('state3');
    const r = node(INSTALL, ['undo', '--from-markers', '--home', f.home, ...(project ? ['--project', f.project] : [])], cleanEnv({ MODELPROOF_HOME: third }));
    ok(r);
    assert.match(r.out, /Took out \d+ marked part/);
    ok(compare(f, before), `${name}: undo --from-markers`);
  }
});

test('a second text copy for the same tool across user and project scope is refused (exit 2)', () => {
  const f = setup('cc-max5x');
  ok(apply(f, plan(f, path.join(PROFILES, 'cc-max5x.json'), { project: false })));
  const p = plan(f, path.join(PROFILES, 'empty.json'));
  assert.equal(p.code, 2, p.all);
  const item = p.plan.items.find((x) => x.path === '.claude/rules/modelproof.md');
  assert.equal(item.action, 'conflict');
  assert.match(item.reason, /already has modelproof text at user scope/);
  assert.ok(p.plan.items.filter((x) => x.action === 'conflict').length === 1, 'the helper files are fine');
});

test('damaged markers → plan exits 4 and writes no plan', () => {
  const f = setup('codex');
  const file = path.join(f.home, '.codex', 'AGENTS.md');
  fs.appendFileSync(file, '\n<!-- modelproof:begin v1 sha=0123456789abcdef -->\nx\n<!-- modelproof:begin v1 sha=0123456789abcdef -->\n');
  const p = plan(f, path.join(PROFILES, 'codex.json'), { project: false });
  assert.equal(p.code, 4, p.all);
  assert.equal(p.plan, null);
  assert.match(p.all, /second begin marker/);
});

test('LC-01: a file that ends inside an open code fence is never appended to (exit 2); once closed, the roundtrip is exact', () => {
  const f = setup('agents-md-only');
  const profile = path.join(FIX, 'setups', 'agents-md-only', 'profile.json');
  const file = path.join(f.project, 'AGENTS.md');
  fs.writeFileSync(file, '# Notes\n\nExample:\n\n```bash\npnpm test\n');
  const before = snapshot(f, 'before');
  const p = plan(f, profile);
  assert.equal(p.code, 2, p.all);
  const item = p.plan.items.find((x) => x.path === 'AGENTS.md');
  assert.equal(item.action, 'conflict', p.out);
  assert.match(item.reason, /ends inside an open code fence/);
  assert.match(item.reason, /close the fence or pick another file/);
  // Leaving it out writes nothing to that file; undo is exact.
  const conflicts = p.plan.items.filter((x) => x.action === 'conflict').map((x) => x.n).join(',');
  ok(apply(f, p, { skip: conflicts }), 'apply with the fenced file left out');
  assert.equal(read(file), '# Notes\n\nExample:\n\n```bash\npnpm test\n');
  ok(dupes(f));
  const u = undo(f, p.plan.id);
  ok(u);
  ok(compare(f, before));
  // The user closes the fence: the full roundtrip (append, reinstall unchanged, undo byte-identical).
  fs.appendFileSync(file, '```\n');
  roundtrip(f, profile);
});

test('LC-01: a fence closes only on the same character, at least as long, with nothing after it (CommonMark), so these stay open and are never appended to', () => {
  const cases = [
    ['a shorter run inside a longer fence', '# Notes\n\n````\ncode\n```\n', '````'],
    ['a shorter run inside a ````md fence', '# Notes\n\nShow the fence:\n\n````md\n```\n', '````'],
    ['a run with an info string is not a closer', '# Notes\n\n```\ncode\n```bash\n', '```'],
    ['a ~~~~ fence with a shorter ~~~ run', '# Notes\n\n~~~~\ncode\n~~~\n', '~~~~'],
    ['a ~~~ fence with a ``` line inside', '# Notes\n\n~~~\n```\n', '~~~'],
  ];
  for (const [label, text, fenceText] of cases) {
    const f = setup('agents-md-only');
    const profile = path.join(FIX, 'setups', 'agents-md-only', 'profile.json');
    const file = path.join(f.project, 'AGENTS.md');
    fs.writeFileSync(file, text);
    const p = plan(f, profile);
    assert.equal(p.code, 2, `${label}: ${p.all}`);
    const item = p.plan.items.find((x) => x.path === 'AGENTS.md');
    assert.equal(item.action, 'conflict', `${label}: ${p.out}`);
    assert.match(item.reason, /ends inside an open code fence/, label);
    assert.ok(item.reason.includes(`(${fenceText})`), `${label}: the reason names the fence it saw: ${item.reason}`);
  }
  // Closers that do count: a longer run, and a run with trailing spaces.
  for (const [label, text] of [
    ['a longer closing run', '# Notes\n\n```\ncode\n`````\n'],
    ['a closing run with trailing spaces', '# Notes\n\n````md\n```\n````  \n'],
  ]) {
    const f = setup('agents-md-only');
    const profile = path.join(FIX, 'setups', 'agents-md-only', 'profile.json');
    fs.writeFileSync(path.join(f.project, 'AGENTS.md'), text);
    const p = plan(f, profile);
    assert.equal(p.code, 0, `${label}: ${p.all}`);
    assert.equal(p.plan.items.find((x) => x.path === 'AGENTS.md').action, 'append', label);
    roundtrip(f, profile);
  }
});

test('LC-01: a marker quoted inside a code fence counts as a marker, so the installer stops (exit 4) instead of adding a second block', () => {
  const f = setup('agents-md-only');
  const profile = path.join(FIX, 'setups', 'agents-md-only', 'profile.json');
  const file = path.join(f.project, 'AGENTS.md');
  fs.writeFileSync(file, '# Notes\n\n```\n<!-- modelproof:begin v1 sha=0123456789abcdef -->\n```\n');
  const p = plan(f, profile);
  assert.equal(p.code, 4, p.all);
  assert.equal(p.plan, null);
  assert.match(p.all, /begin marker with no end marker/);
});

test('verify: exit 3 when an installed file changed, exit 4 when a second block appears', () => {
  const f = setup('org-40');
  const p = plan(f, path.join(PROFILES, 'org-40.json'));
  ok(apply(f, p));
  const scout = path.join(f.project, '.claude', 'agents', 'modelproof-scout.md');
  const keep = read(scout);
  fs.appendFileSync(scout, 'extra\n');
  assert.equal(verify(f).code, 3);
  fs.writeFileSync(scout, keep);
  ok(verify(f));
  fs.appendFileSync(path.join(f.project, 'AGENTS.md'), '\n<!-- modelproof:begin v1 sha=0123456789abcdef -->\nx\n<!-- modelproof:end -->\n');
  assert.equal(verify(f).code, 4);
  assert.equal(dupes(f).code, 1, 'setup-hash sees it too');
});

test('state folder: 700 folders, 600 files; a held lock stops a second run; the printed undo line works on its own', () => {
  const f = setup('empty');
  const before = snapshot(f);
  const p = plan(f, path.join(PROFILES, 'empty.json'));
  fs.mkdirSync(f.state, { recursive: true });
  fs.writeFileSync(path.join(f.state, 'lock'), '1');
  const locked = apply(f, p);
  assert.equal(locked.code, 1);
  assert.match(locked.all, /another modelproof run/);
  fs.unlinkSync(path.join(f.state, 'lock'));
  const r = apply(f, p);
  ok(r);
  const m = path.join(f.state, 'installs', p.plan.id, 'manifest.json');
  assert.equal(fs.statSync(m).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(f.state, 'installs', p.plan.id)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(f.state, 'bin')).mode & 0o777, 0o700);
  const line = /Undo: node (\S+) undo ([0-9a-f]{12})/.exec(r.out);
  assert.ok(line, r.out);
  assert.equal(line[2], p.plan.id);
  // Run the printed command with no MODELPROOF_HOME: it finds the state folder from its own location.
  const u = node(line[1], ['undo', line[2]], cleanEnv());
  ok(u);
  ok(compare(f, before));
  const st = inst(f, 'status');
  ok(st);
  assert.match(st.out, new RegExp(`${p.plan.id} +project 0 part`));
});

test('LC-05: the printed undo line runs as printed when the state folder path has a space', () => {
  const f = setup('empty');
  const before = snapshot(f);
  const state = path.join(tmp('state'), 'My Home', 'state dir');
  const p = plan(f, path.join(PROFILES, 'empty.json'), { state });
  ok(p);
  const r = apply(f, p, { state });
  ok(r);
  const line = /^Undo: (node .+)$/m.exec(r.out);
  assert.ok(line, r.out);
  const run = spawnSync('/bin/sh', ['-c', line[1]], { encoding: 'utf8', cwd: os.tmpdir(), env: { ...cleanEnv(), PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ''}` } });
  assert.equal(run.status, 0, line[1] + '\n' + run.stdout + run.stderr);
  assert.match(run.stdout, /byte-identical/);
  ok(compare(f, before));
});

test('LC-09: a lock left by a run that is no longer alive is taken over (and said); a live one still stops the run', () => {
  const f = setup('empty');
  const before = snapshot(f);
  const p = plan(f, path.join(PROFILES, 'empty.json'));
  fs.mkdirSync(f.state, { recursive: true });
  const lockFile = path.join(f.state, 'lock');
  // A live holder (this test process): exit 1, and the message names it.
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, started: '2026-09-27T00:00:00.000Z' }));
  const held = apply(f, p);
  assert.equal(held.code, 1, held.all);
  assert.match(held.all, new RegExp(`another modelproof run \\(pid ${process.pid}, started 2026-09-27T00:00:00.000Z\\) holds`));
  // A crashed run: its pid is gone.
  const dead = spawnSync(process.execPath, ['-e', '0']).pid;
  fs.writeFileSync(lockFile, JSON.stringify({ pid: dead, started: '2026-09-26T00:00:00.000Z' }));
  const r = apply(f, p);
  ok(r, 'a stale lock does not block the run');
  assert.match(r.all, new RegExp(`took over a lock left by an earlier run that is no longer running \\(pid ${dead}`));
  assert.ok(!fs.existsSync(lockFile), 'the lock is released afterwards');
  ok(undo(f, p.plan.id));
  ok(compare(f, before));
  // The lock the installer writes records its pid and start time.
  const src = read(INSTALL);
  assert.match(src, /JSON\.stringify\(\{ pid: process\.pid, started/);
});

test('preview paths: the notes name the real state folder, and the Apply line runs as printed', () => {
  const f = setup('empty');
  const before = snapshot(f);
  const profile = path.join(PROFILES, 'empty.json');
  // MODELPROOF_HOME outside the home folder: its full path, never ~/.modelproof/.
  const p = plan(f, profile);
  ok(p);
  assert.ok(p.out.includes(`; ${f.state}/ keeps the install history`), p.out);
  assert.doesNotMatch(p.out, /~\/\.modelproof\//);
  // Inside the home folder: shown with ~.
  const inHome = path.join(f.home, 'mp-state');
  const q = plan(f, profile, { state: inHome });
  ok(q);
  assert.match(q.out, /; ~\/mp-state\/ keeps the install history/);
  assert.match(q.out, /leaves ~\/mp-state in place/);
  // The Apply line runs as printed, from another folder, with a plan file whose path has a space.
  const dir = path.join(f.work, 'my plans');
  fs.mkdirSync(dir);
  const out = path.join(dir, 'plan.json');
  const r = node(INSTALL, ['plan', '--profile', profile, '--data', DATA, '--home', f.home, '--project', f.project, '--out', out], f.env);
  ok(r);
  const line = /^Apply: (node .+)$/m.exec(r.out);
  assert.ok(line, r.out);
  const hashNow = JSON.parse(read(out)).hash;
  assert.ok(line[1].includes(`--expect ${hashNow}`), line[1]);
  assert.ok(line[1].includes(`'${out}'`), line[1]);
  const run = spawnSync('/bin/sh', ['-c', line[1]], { encoding: 'utf8', cwd: os.tmpdir(), env: { ...f.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ''}` } });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /^Done\./);
  ok(undo(f, JSON.parse(read(out)).id));
  ok(compare(f, before));
});

test('ids: user scope and project scope get different install ids, stable across runs', () => {
  const f = setup('empty');
  const a = plan(f, path.join(PROFILES, 'empty.json'));
  const b = plan(f, path.join(PROFILES, 'empty.json'));
  const c = plan(f, path.join(PROFILES, 'cc-max5x.json'), { project: false });
  assert.equal(a.plan.id, b.plan.id);
  assert.equal(a.plan.hash, b.plan.hash, 'same inputs, same plan hash');
  assert.notEqual(a.plan.id, c.plan.id);
  assert.match(a.plan.id, /^[0-9a-f]{12}$/);
});

test('usage: unknown command and a project profile without --project exit 1', () => {
  const f = setup('empty');
  assert.equal(inst(f, 'frobnicate').code, 1);
  assert.equal(plan(f, path.join(PROFILES, 'empty.json'), { project: false }).code, 1);
});

test('LC-02: what Copy text prints, pasted by hand, is adopted by a later install, never added again', async () => {
  const { buildPackage, packageText } = await import('../assets/instructions.mjs');
  const FACTS = {
    models: JSON.parse(read(path.join(FIX, 'instructions-models.json'))),
    guidance: JSON.parse(read(path.join(FIX, 'guidance.json'))),
    plans: JSON.parse(read(path.join(FIX, 'instructions-plans.json'))),
  };
  const empty = JSON.parse(read(path.join(PROFILES, 'empty.json')));
  const cases = [
    ['codex', JSON.parse(read(path.join(PROFILES, 'codex.json'))), false],
    ['empty', { ...empty, set_default_model: true, roles: { lead: 'claude-sonnet-5' }, effort_cap: 'high' }, true],
  ];
  for (const [name, profile, project] of cases) {
    const f = setup(name);
    const text = packageText(buildPackage(profile, FACTS));
    // Paste each section where its heading says, the way a person would.
    const sections = text.split(/^=== (.+?) ===\n/m).slice(1);
    const kinds = [];
    for (let i = 0; i < sections.length; i += 2) {
      const head = sections[i];
      const body = sections[i + 1].replace(/\n+$/, '') + '\n';
      const m = /^(New file|Add at the end of|Add these keys to) (\S+)/.exec(head);
      assert.ok(m, head);
      const where = m[2].startsWith('~/') ? path.join(f.home, m[2].slice(2)) : path.join(f.project, m[2]);
      fs.mkdirSync(path.dirname(where), { recursive: true });
      const had = fs.existsSync(where) ? read(where) : null;
      if (m[1] === 'New file') fs.writeFileSync(where, body);
      else if (m[1] === 'Add at the end of') fs.writeFileSync(where, had ? had.replace(/\n*$/, '\n\n') + body : body);
      else fs.writeFileSync(where, JSON.stringify({ ...(had ? JSON.parse(had) : {}), ...JSON.parse(`{${body}}`) }, null, 2) + '\n');
      kinds.push(m[1]);
    }
    assert.ok(kinds.includes(name === 'codex' ? 'Add at the end of' : 'Add these keys to'), `${name}: ${kinds}`);
    const p = plan(f, writeProfile(f, path.join(PROFILES, 'empty.json'), profile), { project });
    ok(p, `${name} plan`);
    const actions = p.plan.items.map((x) => `${x.kind}:${x.action}`);
    for (const a of actions) assert.ok(!/:(append|create|add-keys|conflict)$/.test(a), `${name}: ${actions}`);
    if (name === 'codex') assert.ok(actions.includes('block:adopt'), `${name}: ${actions}`);
    ok(apply(f, p), `${name} apply`);
    ok(dupes(f), `${name}: no second copy of any helper heading or block`);
  }
});
