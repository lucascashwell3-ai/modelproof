#!/usr/bin/env node
// Independent roundtrip checker for a setup folder. It shares no code with the installer and never
// reads the installer's install record: it looks only at the files on disk.
//
//   node scripts/setup-hash.mjs snapshot <dir> --out before.json
//   node scripts/setup-hash.mjs compare  <dir> before.json [--ignore <relpath>]...
//   node scripts/setup-hash.mjs dupes    <dir> [<dir>...]
//
// snapshot: every file (path, sha256, mode), directory (path, mode) and symbolic link (path, link
//           text) under <dir>. Uses lstat; never follows a link.
// compare:  exit 0 iff the tree is identical to the snapshot (bytes, modes, dirs, links); else exit 1
//           and list each difference. Every --ignore is printed.
// dupes:    exit 0 iff no file holds more than one modelproof begin marker (code fences or not),
//           every file has as many end markers as begin markers, no file repeats the Modelproof
//           instructions heading (marked or not), no helper name repeats
//           within one agents folder or across the two folders GitHub Copilot loads together, no modelproof helper shares a name with someone else's helper
//           in the folders the same tool loads, no settings*.json repeats a top-level key, and no
//           TOML file repeats a table header; else exit 1 and list each.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const posix = (p) => p.split(path.sep).join('/');

export function snapshot(root) {
  const entries = [];
  const walk = (abs, rel) => {
    const names = fs.readdirSync(abs).sort();
    for (const name of names) {
      const a = path.join(abs, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = fs.lstatSync(a);
      const mode = (st.mode & 0o7777).toString(8);
      if (st.isSymbolicLink()) entries.push({ path: r, type: 'link', target: fs.readlinkSync(a) });
      else if (st.isDirectory()) { entries.push({ path: r, type: 'dir', mode }); walk(a, r); }
      else if (st.isFile()) entries.push({ path: r, type: 'file', mode, sha256: sha256(fs.readFileSync(a)) });
      else entries.push({ path: r, type: 'other', mode });
    }
  };
  walk(path.resolve(root), '');
  return { schema: 'modelproof.setup-hash/1', entries };
}

export function compare(root, before, ignores = []) {
  const skip = (p) => ignores.some((ig) => p === ig || p.startsWith(ig.replace(/\/+$/, '') + '/'));
  const now = new Map(snapshot(root).entries.filter((e) => !skip(e.path)).map((e) => [e.path, e]));
  const was = new Map(before.entries.filter((e) => !skip(e.path)).map((e) => [e.path, e]));
  const diffs = [];
  for (const [p, e] of was) {
    const n = now.get(p);
    if (!n) { diffs.push(`missing  ${p}`); continue; }
    if (n.type !== e.type) diffs.push(`type     ${p}: ${e.type} → ${n.type}`);
    else if (e.type === 'file' && n.sha256 !== e.sha256) diffs.push(`bytes    ${p}`);
    else if (e.type === 'link' && n.target !== e.target) diffs.push(`link     ${p}: ${e.target} → ${n.target}`);
    if (n.type === e.type && e.mode && n.mode !== e.mode) diffs.push(`mode     ${p}: ${e.mode} → ${n.mode}`);
  }
  for (const p of now.keys()) if (!was.has(p)) diffs.push(`added    ${p}`);
  return diffs.sort();
}

/* ------------------------------------------------------------------ dupes */

const SKIP_DIRS = new Set(['node_modules', '.git', '.modelproof']);
const BEGIN = /^<!-- modelproof:begin\b.*-->$/;
const END = /^<!-- modelproof:end\b.*-->$/;
// The instructions heading, old wording and new (the copy-only text says "lead and bulk").
const HEADING = /^#{1,6} Modelproof (helpers and hand-off|lead, helpers and bulk|lead and bulk)\b/;
const OWNED = /^(<!-- modelproof:owned v1\b.*-->|# modelproof:owned v1\b.*)$/;

function walkFiles(root, out, skipped) {
  const walk = (abs) => {
    let names;
    try { names = fs.readdirSync(abs).sort(); } catch { return; }
    for (const name of names) {
      const a = path.join(abs, name);
      const st = fs.lstatSync(a);
      if (st.isDirectory()) { if (SKIP_DIRS.has(name)) { skipped.add(name); continue; } walk(a); } else if (st.isFile()) out.push(a);
    }
  };
  walk(path.resolve(root));
}
// Begin markers, end markers and instruction headings as whole lines. Code fences do not hide
// them: this checker must not share a blind spot with the installer.
function markerCounts(text) {
  const n = { begin: 0, end: 0, heading: 0 };
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (BEGIN.test(line)) n.begin++;
    else if (END.test(line)) n.end++;
    else if (HEADING.test(line)) n.heading++;
  }
  return n;
}
function agentName(text, toml) {
  const lines = text.split(/\r?\n/);
  if (toml) {
    for (const l of lines) {
      if (/^\s*\[/.test(l)) break;
      const m = /^\s*name\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(l);
      if (m) return m[1];
    }
    return null;
  }
  if (lines[0] !== '---') return null;
  for (let i = 1; i < lines.length && lines[i] !== '---'; i++) {
    const m = /^name:\s*(.*)$/.exec(lines[i]);
    if (m) return m[1].replace(/^["']|["']$/g, '').trim();
  }
  return null;
}
// Top-level JSON keys from raw text, so a repeated key is visible (JSON.parse hides it).
function jsonTopKeys(text) {
  const keys = [];
  let depth = 0; let expectKey = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1; let s = '';
      while (j < text.length && text[j] !== '"') { if (text[j] === '\\') { s += text.slice(j, j + 2); j += 2; } else s += text[j++]; }
      if (depth === 1 && expectKey && /^\s*:/.test(text.slice(j + 1, j + 40))) keys.push(s);
      expectKey = false;
      i = j; continue;
    }
    if (c === '{' || c === '[') { depth++; expectKey = c === '{' && depth === 1; } else if (c === '}' || c === ']') depth--;
    else if (c === ',' && depth === 1) expectKey = true;
  }
  return keys;
}
const repeated = (list) => [...new Set(list.filter((x, i) => list.indexOf(x) !== i))];

export function dupes(roots) {
  const files = [];
  const skipped = new Set();
  for (const r of roots) walkFiles(r, files, skipped);
  const problems = [];
  const agentDirs = new Map(); // dir → [{file, name, owned}]
  const rel = (f) => {
    for (const r of roots) { const x = path.relative(path.resolve(r), f); if (!x.startsWith('..')) return posix(x); }
    return f;
  };
  for (const f of files) {
    const base = path.basename(f);
    const st = fs.statSync(f);
    if (st.size > 1024 * 1024) continue;
    const text = fs.readFileSync(f, 'utf8');
    const n = markerCounts(text);
    if (n.begin > 1) problems.push(`${rel(f)}: ${n.begin} modelproof begin markers`);
    if (n.begin !== n.end) problems.push(`${rel(f)}: ${n.begin} modelproof begin marker(s) but ${n.end} end marker(s)`);
    if (n.heading > 1) problems.push(`${rel(f)}: the Modelproof instructions heading appears ${n.heading} times`);
    if (/^settings.*\.json$/.test(base)) {
      const r = repeated(jsonTopKeys(text));
      if (r.length) problems.push(`${rel(f)}: repeated top-level key(s) ${r.join(', ')}`);
    }
    if (/\.toml$/.test(base)) {
      const heads = text.split(/\r?\n/).map((l) => /^\s*\[([^[\]]+)\]\s*(#.*)?$/.exec(l)).filter(Boolean).map((m) => m[1].trim());
      const r = repeated(heads);
      if (r.length) problems.push(`${rel(f)}: repeated table header(s) ${r.map((h) => `[${h}]`).join(', ')}`);
    }
    // Agent folders: .claude/agents (any depth below it), .codex/agents, .cursor/agents,
    // .github/agents and ~/.copilot/agents (GitHub Copilot, *.agent.md), .agents/agents and
    // ~/.gemini/config/agents (Antigravity).
    const m = /(^|\/)(\.claude|\.codex|\.cursor|\.github|\.copilot|\.agents|\.gemini\/config)\/agents(\/|$)/.exec(posix(f));
    if (m) {
      const family = m[2];
      const toml = family === '.codex';
      if ((toml && !/\.toml$/.test(base)) || (!toml && !/\.md$/.test(base))) continue;
      if ((family === '.github' || family === '.copilot') && !/\.agent\.md$/.test(base)) continue;
      if (family !== '.claude' && path.basename(path.dirname(f)) !== 'agents') continue;
      const dir = posix(f).slice(0, m.index + m[0].length).replace(/\/$/, '');
      const name = agentName(text, toml);
      if (!name) continue;
      const owned = text.split(/\r?\n/).some((l) => OWNED.test(l));
      if (!agentDirs.has(dir)) agentDirs.set(dir, []);
      agentDirs.get(dir).push({ file: f, name: name.toLowerCase(), shown: name, owned, family });
    }
  }
  // Same name twice within one folder (one tool, one precedence level).
  for (const list of agentDirs.values()) {
    for (const name of repeated(list.map((a) => a.name))) {
      problems.push(`helper name "${list.find((a) => a.name === name).shown}" appears more than once: ${list.filter((a) => a.name === name).map((a) => rel(a.file)).join(', ')}`);
    }
  }
  // A modelproof helper sharing its name with someone else's helper in the same tool's folders.
  const byFamily = new Map();
  for (const list of agentDirs.values()) for (const a of list) {
    if (!byFamily.has(a.family)) byFamily.set(a.family, []);
    byFamily.get(a.family).push(a);
  }
  for (const list of byFamily.values()) {
    for (const ours of list.filter((a) => a.owned)) {
      const clash = list.find((a) => !a.owned && a.name === ours.name && path.dirname(a.file) !== path.dirname(ours.file));
      if (clash) problems.push(`modelproof helper ${rel(ours.file)} shares the name "${ours.shown}" with ${rel(clash.file)}`);
    }
  }
  // GitHub Copilot loads .claude/agents next to its own folder (.github/agents in a workspace,
  // .copilot/agents in a home folder): one name twice across that pair is two helpers in Copilot.
  const parentOf = (dir) => dir.replace(/\/?(\.claude|\.github|\.copilot)\/agents$/, '');
  for (const [dir, list] of agentDirs) {
    const fam = list[0] && list[0].family;
    if (fam !== '.github' && fam !== '.copilot') continue;
    const claude = [...agentDirs.entries()].find(([d, l]) => l[0] && l[0].family === '.claude' && /\.claude\/agents$/.test(d) && parentOf(d) === parentOf(dir));
    if (!claude) continue;
    for (const a of list) {
      const twin = claude[1].find((b) => b.name === a.name);
      if (twin) problems.push(`helper name "${a.shown}" is loaded twice by GitHub Copilot: ${rel(a.file)} and ${rel(twin.file)}`);
    }
  }
  return { problems: [...new Set(problems)].sort(), skipped: [...skipped].sort() };
}

/* ------------------------------------------------------------------ CLI */

function main(argv) {
  const [cmd, ...rest] = argv;
  const flags = { ignore: [] };
  const pos = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--out') flags.out = rest[++i];
    else if (rest[i] === '--ignore') flags.ignore.push(rest[++i]);
    else pos.push(rest[i]);
  }
  if (cmd === 'snapshot' && pos[0]) {
    const snap = JSON.stringify(snapshot(pos[0]), null, 1) + '\n';
    if (flags.out) fs.writeFileSync(flags.out, snap); else process.stdout.write(snap);
    return 0;
  }
  if (cmd === 'compare' && pos[0] && pos[1]) {
    for (const ig of flags.ignore) console.log(`ignoring: ${ig}`);
    const diffs = compare(pos[0], JSON.parse(fs.readFileSync(pos[1], 'utf8')), flags.ignore);
    if (!diffs.length) { console.log('compare: identical'); return 0; }
    console.log(`compare: ${diffs.length} difference(s)`);
    for (const d of diffs) console.log('  ' + d);
    return 1;
  }
  if (cmd === 'dupes' && pos.length) {
    const r = dupes(pos);
    if (r.skipped.length) console.log(`not searched: ${r.skipped.join(', ')} folders`);
    if (!r.problems.length) { console.log('dupes: none'); return 0; }
    console.log(`dupes: ${r.problems.length}`);
    for (const p of r.problems) console.log('  ' + p);
    return 1;
  }
  console.error('usage: setup-hash.mjs snapshot <dir> --out f.json | compare <dir> f.json [--ignore rel]... | dupes <dir> [<dir>...]');
  return 2;
}

const isEntry = () => {
  try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
};
if (isEntry()) process.exitCode = main(process.argv.slice(2));
