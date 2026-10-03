#!/usr/bin/env node
// Modelproof installer. Places the parts of an instruction package into a real setup and takes
// them out again. Node 18+, no dependencies, no network. The package itself comes from
// ./instructions.mjs; this file never writes instruction text of its own.
//
//   node install.mjs detect --home H [--project P]
//   node install.mjs plan   --profile p.json --data D --home H [--project P] [--out plan.json]
//   node install.mjs apply  --plan plan.json --expect <planhash> [--skip 2,4]
//   node install.mjs verify --home H [--project P]
//   node install.mjs undo   <id> | undo --from-markers --home H [--project P]
//   node install.mjs status [--home H]
//
// Exit codes: 0 ok · 1 usage or internal · 2 conflict that needs a decision ·
//             3 changed since the preview · 4 damaged markers
//
// Rules this file keeps:
// - Add, never overwrite. New files where the tool supports them; otherwise one marked block at the
//   end of a file, or JSON keys that are absent, inserted as text (the file is never re-serialised).
// - Undo is surgery: cut our block with the exact separator bytes recorded when it went in, cut our
//   key text, move our files to the state folder's removed/ area. Nothing is ever deleted.
// - Reads only instruction, agent and settings files in known places. Never reads env values
//   (only the names CLAUDE_CODE_SUBAGENT_MODEL_FORCE, and the values of CLAUDE_CONFIG_DIR and
//   CODEX_HOME), never prints settings values other than model/effort keys, never copies a
//   settings file anywhere.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  buildPackage, renderPreview, GENERATOR_VERSION,
  BLOCK_BEGIN_RE as BEGIN_RE, BLOCK_END_RE as END_RE, blockBodyHash as bodyHash, blockText, blockBodyLines as contentLines, stampOwnedText,
} from './instructions.mjs';

export const INSTALLER_VERSION = '1.0.0';
export const EXIT = Object.freeze({ OK: 0, USAGE: 1, CONFLICT: 2, DRIFT: 3, CORRUPT: 4 });
const PLAN_SCHEMA = 'modelproof.plan/1';
const MANIFEST_SCHEMA = 'modelproof.manifest/1';
const SETUP_SCHEMA = 'modelproof.setup/1';
const MAX_READ = 1024 * 1024;
const SELF = fileURLToPath(import.meta.url);

class Fail extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/* ------------------------------------------------------------------ small helpers */

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const sha16 = (data) => sha256(data).slice(0, 16);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const uniq = (list) => list.filter((v, i) => list.indexOf(v) === i);
function countLines(text) {
  if (!text) return 0;
  const n = text.split('\n').length;
  return text.endsWith('\n') ? n - 1 : n;
}
function lstatOrNull(p) {
  try { return fs.lstatSync(p); } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null; throw e; }
}
function statOrNull(p) {
  try { return fs.statSync(p); } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null; throw e; }
}
function readBytes(p) {
  const st = statOrNull(p);
  if (!st) return null;
  if (!st.isFile()) throw new Fail(EXIT.CONFLICT, `${p} is not a regular file`);
  if (st.size > MAX_READ) throw new Fail(EXIT.CONFLICT, `${p} is larger than 1 MB; modelproof leaves it alone`);
  return fs.readFileSync(p);
}
function readText(p) {
  const b = readBytes(p);
  return b === null ? null : b.toString('utf8');
}
function isInside(child, parent) {
  if (!parent) return false;
  const rel = path.relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}
// Real path of a file that may not exist yet: resolve the longest existing ancestor, keep the rest.
function realTarget(abs) {
  const parts = [];
  let cur = path.resolve(abs);
  for (;;) {
    const st = lstatOrNull(cur);
    if (st) {
      let real;
      try { real = fs.realpathSync(cur); } catch (e) {
        if (e.code === 'ENOENT') throw new Fail(EXIT.CONFLICT, `${cur} is a link that points nowhere`);
        throw e;
      }
      return parts.length ? path.join(real, ...parts.reverse()) : real;
    }
    const parent = path.dirname(cur);
    if (parent === cur) return path.resolve(abs);
    parts.push(path.basename(cur));
    cur = parent;
  }
}
// For looking only (detect, readers): a dangling link resolves to itself instead of failing.
function realOr(abs) {
  try { return realTarget(abs); } catch { return path.resolve(abs); }
}
// True when any path segment from `base` down to `abs` is a symbolic link.
function hasLink(abs, base) {
  let cur = path.resolve(abs);
  const stop = path.resolve(base);
  while (isInside(cur, stop) && cur !== stop) {
    const st = lstatOrNull(cur);
    if (st && st.isSymbolicLink()) return true;
    cur = path.dirname(cur);
  }
  return false;
}
function detectEol(text) {
  const i = text.indexOf('\n');
  if (i < 0) return '\n';
  return i > 0 && text[i - 1] === '\r' ? '\r\n' : '\n';
}
// Lines with their offsets; `fence` marks lines inside ``` or ~~~ code fences (fence lines included).
// Fences follow CommonMark: an opener is 3+ backticks or tildes after at most 3 spaces (a backtick
// opener's info string holds no backtick); the closer is the same character, a run at least as
// long as the opener, and nothing after it but spaces or tabs. Anything else inside stays code.
// `openFence` is the opening run when the text ends inside a fence, else null.
function scanLines(text) {
  const out = [];
  let pos = 0;
  let fence = null;
  while (pos < text.length) {
    const nl = text.indexOf('\n', pos);
    const endWithEol = nl < 0 ? text.length : nl + 1;
    let body = text.slice(pos, nl < 0 ? text.length : nl);
    let eol = nl < 0 ? '' : '\n';
    if (body.endsWith('\r') && eol) { body = body.slice(0, -1); eol = '\r\n'; }
    let inFence = fence !== null;
    if (fence === null) {
      const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(body);
      if (m && !(m[1][0] === '`' && m[2].includes('`'))) { fence = m[1]; inFence = true; }
    } else {
      const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(body);
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
    }
    out.push({ text: body, eol, start: pos, end: endWithEol, fence: inFence });
    pos = endWithEol;
  }
  out.openFence = fence;
  return out;
}

/* ------------------------------------------------------------------ markers */

// Block marker lines and their hash come from assets/instructions.mjs (one definition).
const OWNED_HTML_RE = /^<!-- modelproof:owned v1(?: sha=([0-9a-f]{16}))? -->$/;
const OWNED_TOML_RE = /^# modelproof:owned v1(?: sha=([0-9a-f]{16}))?$/;
const PLAIN_OWNED_HTML = '<!-- modelproof:owned v1 -->';
const PLAIN_OWNED_TOML = '# modelproof:owned v1';

// Every modelproof block in a text file. Markers count as whole lines anywhere, code fences
// included: a marker quoted in someone's notes makes the file look damaged (exit 4) rather than
// hiding a real block from the installer.
export function findBlocks(text) {
  const lines = scanLines(text);
  const blocks = [];
  const corrupt = [];
  let open = null;
  lines.forEach((l, i) => {
    const b = BEGIN_RE.exec(l.text);
    if (b) {
      if (open) corrupt.push(`line ${i + 1}: a second begin marker before the end of the block at line ${open.begin + 1}`);
      else open = { begin: i, sha: b[1] || null };
      return;
    }
    if (END_RE.test(l.text)) {
      if (!open) { corrupt.push(`line ${i + 1}: an end marker with no begin marker`); return; }
      const body = lines.slice(open.begin + 1, i).map((x) => x.text);
      blocks.push({ begin: open.begin, end: i, sha: open.sha, body, start: lines[open.begin].start, stop: l.start + l.text.length });
      open = null;
    }
  });
  if (open) corrupt.push(`line ${open.begin + 1}: a begin marker with no end marker`);
  if (blocks.length > 1) corrupt.push(`${blocks.length} modelproof blocks in one file (lines ${blocks.map((b) => b.begin + 1).join(', ')})`);
  return { blocks, corrupt };
}
function blockIntact(block) { return !!block.sha && bodyHash(block.body) === block.sha; }
function appendBlock(text, bodyLines) {
  const eol = text === '' ? '\n' : detectEol(text);
  let separator; let trailer;
  if (text === '') { separator = ''; trailer = eol; } else if (text.endsWith('\n')) { separator = eol; trailer = eol; } else { separator = eol + eol; trailer = ''; }
  return { text: text + separator + blockText(bodyLines, eol) + trailer, separator, trailer, eol };
}
function replaceBlock(text, block, bodyLines) {
  const eol = detectEol(text);
  return text.slice(0, block.start) + blockText(bodyLines, eol) + text.slice(block.stop);
}
// Cut a block. With a recorded separator/trailer the cut is exact; otherwise only the block goes.
function cutBlock(text, block, separator, trailer) {
  const pre = text.slice(0, block.start);
  const post = text.slice(block.stop);
  if (separator !== null && pre.endsWith(separator) && post.startsWith(trailer)) {
    return { text: pre.slice(0, pre.length - separator.length) + post.slice(trailer.length), exact: true };
  }
  const eol = detectEol(text);
  return { text: pre + (post.startsWith(eol) && (pre === '' || pre.endsWith('\n')) ? post.slice(eol.length) : post), exact: false };
}
// No record of how the block went in (adopted, or --from-markers): the usual shape is one blank
// line before it and one line end after it.
function guessSeparators(text, block) {
  const eol = detectEol(text);
  const pre = text.slice(0, block.start);
  const post = text.slice(block.stop);
  if (pre === '') return { separator: '', trailer: post.startsWith(eol) ? eol : '' };
  if (post === '' && pre.endsWith(eol + eol)) return { separator: eol + eol, trailer: '' };
  return { separator: pre.endsWith(eol + eol) ? eol : '', trailer: post.startsWith(eol) ? eol : '' };
}

// Owned files carry a tag line; the installer stamps it with the hash of the generator's content
// so a later run (or a teammate with no install record) can tell an untouched copy from an edited one.
// The stamp itself lives in assets/instructions.mjs (the board's Copy text uses it too).
export function stampOwned(content) {
  const out = stampOwnedText(content);
  if (out === null) throw new Fail(EXIT.USAGE, 'package part has no owned tag; refusing to write it');
  return out;
}
export function ownedState(text) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].replace(/\r$/, '');
    const h = OWNED_HTML_RE.exec(raw);
    const t = h ? null : OWNED_TOML_RE.exec(raw);
    const m = h || t;
    if (!m) continue;
    if (!m[1]) return { tagged: true, sha: null, intact: false };
    const plain = lines.slice();
    plain[i] = (h ? PLAIN_OWNED_HTML : PLAIN_OWNED_TOML) + (lines[i].endsWith('\r') ? '\r' : '');
    return { tagged: true, sha: m[1], intact: sha16(plain.join('\n')) === m[1] };
  }
  return { tagged: false, sha: null, intact: false };
}

/* ------------------------------------------------------------------ JSON keys as text */

// Top-level keys of a JSON object, read from raw text (so duplicates are visible).
export function topLevelKeys(text) {
  const keys = [];
  let depth = 0; let i = 0; let expectKey = false;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1; let s = '';
      while (j < text.length && text[j] !== '"') { if (text[j] === '\\') { s += text[j] + text[j + 1]; j += 2; } else { s += text[j]; j++; } }
      if (depth === 1 && expectKey) {
        let k = j + 1;
        while (k < text.length && /\s/.test(text[k])) k++;
        if (text[k] === ':') { try { keys.push(JSON.parse('"' + s + '"')); } catch { keys.push(s); } }
      }
      expectKey = false;
      i = j + 1; continue;
    }
    if (c === '{' || c === '[') { depth++; expectKey = c === '{' && depth === 1; } else if (c === '}' || c === ']') depth--;
    else if (c === ',' && depth === 1) expectKey = true;
    i++;
  }
  return keys;
}
function jsonIndent(text) {
  const m = /\{\s*?\r?\n([ \t]+)"/.exec(text);
  return m ? m[1] : '  ';
}
// Insert absent top-level keys as text before the closing brace. Returns the new text and the
// exact segment inserted, so undo can cut the same bytes.
function jsonInsert(text, entries) {
  const close = text.lastIndexOf('}');
  const eol = detectEol(text);
  const indent = jsonIndent(text);
  let p = close - 1;
  while (p >= 0 && /\s/.test(text[p])) p--;
  const pairs = entries.map(([k, v]) => `${indent}${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  if (text[p] === '{') {
    // Empty object: the segment replaces the whitespace between the braces; undo puts it back.
    const segment = eol + pairs.join(',' + eol) + eol;
    return { text: text.slice(0, p + 1) + segment + text.slice(close), segment, dropped: text.slice(p + 1, close) };
  }
  const segment = pairs.map((x) => ',' + eol + x).join('');
  return { text: text.slice(0, p + 1) + segment + text.slice(p + 1), segment, dropped: '' };
}
function countOf(hay, needle) {
  if (!needle) return 0;
  let n = 0; let i = 0;
  while ((i = hay.indexOf(needle, i)) >= 0) { n++; i += needle.length; }
  return n;
}
function parseJsonObject(text) {
  try { const v = JSON.parse(text); return isObj(v) ? v : null; } catch { return null; }
}

/* ------------------------------------------------------------------ context */

function expandHome(p, home) { return p === '~' ? home : p.startsWith('~/') ? path.join(home, p.slice(2)) : p; }

export function makeContext({ home, project, env = process.env }) {
  if (!home) throw new Fail(EXIT.USAGE, '--home is required');
  const homeAbs = path.resolve(home);
  if (!statOrNull(homeAbs)) throw new Fail(EXIT.USAGE, `home folder not found: ${homeAbs}`);
  const realHome = fs.realpathSync(homeAbs);
  let projectAbs = null; let realProject = null;
  if (project) {
    projectAbs = path.resolve(project);
    if (!statOrNull(projectAbs)) throw new Fail(EXIT.USAGE, `project folder not found: ${projectAbs}`);
    realProject = fs.realpathSync(projectAbs);
  }
  const notes = [];
  // The only env values read: where Claude Code and Codex keep their config. Honoured only inside home.
  const envDir = (name, fallback) => {
    const v = env[name];
    if (!v) return fallback;
    const abs = path.resolve(expandHome(v, homeAbs));
    if (isInside(abs, homeAbs) || isInside(realOr(abs), realHome)) return abs;
    notes.push(`${name} points outside the home folder, so it is not used here.`);
    return fallback;
  };
  const claudeDir = envDir('CLAUDE_CONFIG_DIR', path.join(homeAbs, '.claude'));
  const codexDir = envDir('CODEX_HOME', path.join(homeAbs, '.codex'));
  return {
    home: homeAbs, realHome, project: projectAbs, realProject,
    claudeDir, codexDir, cursorDir: path.join(homeAbs, '.cursor'),
    force: Object.prototype.hasOwnProperty.call(env, 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE'),
    notes,
  };
}
const insideSetup = (real, ctx) => isInside(real, ctx.realHome) || (!!ctx.realProject && isInside(real, ctx.realProject));
// Detect reads through this only: nothing whose real path leaves the home or project folder, and
// an unreadable or dangling file is simply null.
function readSetupText(abs, ctx) {
  const real = realOr(abs);
  if (!insideSetup(real, ctx)) return null;
  try { return readText(real); } catch { return null; }
}
function display(abs, ctx) {
  if (ctx.project && isInside(abs, ctx.project)) return path.relative(ctx.project, abs) || '.';
  if (isInside(abs, ctx.home)) return '~/' + path.relative(ctx.home, abs);
  return abs;
}
function tildeDir(abs, ctx) { return '~/' + path.relative(ctx.home, abs); }
// A folder as the preview shows it: ~ for the home prefix, else the full path.
function tildeOr(abs, home) {
  if (home && isInside(abs, home)) { const rel = path.relative(home, abs); return rel ? '~/' + rel : '~'; }
  return abs;
}
// A path as a shell argument that runs as printed: ~/… inside the shell's own home when every
// character is plain, the bare path when plain, otherwise single-quoted.
function shellPath(abs) {
  const plain = (s) => /^[A-Za-z0-9_\/.~+:=@%,-]+$/.test(s);
  const home = os.homedir();
  if (home && isInside(abs, home) && abs !== home && plain(abs)) return '~/' + path.relative(home, abs);
  return plain(abs) ? abs : `'${abs.replace(/'/g, "'\\''")}'`;
}
// Package target path → absolute logical path.
function targetAbs(p, ctx) {
  if (p === '~' || p.startsWith('~/')) return path.join(ctx.home, p.slice(2));
  if (path.isAbsolute(p)) return p;
  if (!ctx.project) throw new Fail(EXIT.USAGE, `${p} is a project file; pass --project`);
  return path.join(ctx.project, p);
}

// The fixed list of places the installer may write. Checked on the logical path and the real path.
function allowedTarget(abs, ctx) {
  const rel = (base) => (base && isInside(abs, base) ? path.relative(base, abs).split(path.sep).join('/') : null);
  const tests = [];
  const cc = rel(ctx.claudeDir); const cx = rel(ctx.codexDir); const cu = rel(ctx.cursorDir);
  if (cc !== null) tests.push(/^agents\/modelproof-(scout|builder|reviewer|explore)\.md$/.test(cc) || /^rules\/modelproof\.md$/.test(cc) || cc === 'settings.json');
  if (cx !== null) tests.push(/^agents\/modelproof-(scout|builder|reviewer)\.toml$/.test(cx) || /^AGENTS(\.override)?\.md$/.test(cx));
  if (cu !== null) tests.push(/^agents\/modelproof-(scout|builder|reviewer)\.md$/.test(cu));
  const pr = rel(ctx.project);
  if (pr !== null) {
    tests.push(new RegExp('^(' + [
      '\\.claude/agents/modelproof-(scout|builder|reviewer|explore)\\.md', '\\.claude/rules/modelproof\\.md', '\\.claude/settings\\.json',
      '\\.codex/agents/modelproof-(scout|builder|reviewer)\\.toml', '\\.cursor/agents/modelproof-(scout|builder|reviewer)\\.md',
      '\\.cursor/rules/modelproof\\.mdc', 'AGENTS\\.md', 'AGENTS\\.override\\.md',
    ].join('|') + ')$').test(pr));
  }
  if (!tests.some(Boolean)) return 'not one of the places modelproof writes';
  const real = realTarget(abs);
  if (!isInside(real, ctx.realHome) && !(ctx.realProject && isInside(real, ctx.realProject))) return `it resolves to ${real}, outside the home and project folders`;
  if (/^(CLAUDE|CLAUDE\.local)\.md$/.test(path.basename(abs))) return 'modelproof never writes a CLAUDE.md';
  return null;
}

/* ------------------------------------------------------------------ detect */

function frontmatter(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== '---') return {};
  const out = {};
  for (let i = 1; i < lines.length && lines[i] !== '---'; i++) {
    const m = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i]);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
  return out;
}
function tomlTop(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break;
    const m = /^\s*([A-Za-z_][\w-]*)\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(line);
    if (m && !(m[1] in out)) out[m[1]] = m[2];
  }
  return out;
}
function listFiles(dir, re, recursive) {
  const out = [];
  const walk = (d) => {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(d, e.name);
      let isDir = e.isDirectory(); let isFile = e.isFile();
      if (e.isSymbolicLink()) { const st = statOrNull(p); isDir = !!st && st.isDirectory(); isFile = !!st && st.isFile(); }
      if (isDir && recursive) walk(p);
      else if (isFile && re.test(e.name)) out.push(p);
    }
  };
  walk(dir);
  return out;
}
function agentDirs(tool, ctx) {
  const dirs = [];
  if (tool === 'claude-code') { dirs.push(['user', path.join(ctx.claudeDir, 'agents')]); if (ctx.project) dirs.push(['project', path.join(ctx.project, '.claude', 'agents')]); }
  if (tool === 'codex') { dirs.push(['user', path.join(ctx.codexDir, 'agents')]); if (ctx.project) dirs.push(['project', path.join(ctx.project, '.codex', 'agents')]); }
  if (tool === 'cursor') { dirs.push(['user', path.join(ctx.cursorDir, 'agents')]); if (ctx.project) dirs.push(['project', path.join(ctx.project, '.cursor', 'agents')]); }
  return dirs;
}
function readAgents(tool, ctx) {
  const out = [];
  for (const [scope, dir] of agentDirs(tool, ctx)) {
    const toml = tool === 'codex';
    for (const f of listFiles(dir, toml ? /\.toml$/ : /\.md$/, tool !== 'codex')) {
      let text;
      text = readSetupText(f, ctx);
      if (text === null) continue;
      const meta = toml ? tomlTop(text) : frontmatter(text);
      const d = typeof meta.description === 'string' && !/^[>|][+-]?$/.test(meta.description) ? meta.description.trim().slice(0, 120) : '';
      out.push({ tool, scope, path: f, name: meta.name || null, model: meta.model || null, description: d && !looksSecret(d) ? d : null, modelproof: ownedState(text).tagged });
    }
  }
  return out;
}
// A line that looks like it holds a secret value. A word like "token" or "secret" on its own is
// not enough: instruction files talk about token use all the time, and those lines are shown.
function looksSecret(line) {
  if (/sk-[A-Za-z0-9_-]{8,}/.test(line)) return true;
  if (/\b(api[_-]?key|access[_-]?key|token|secret|passw(or)?d|pwd|bearer|auth)\b["']?\s*[:=]\s*["']?[^\s"']{8,}/i.test(line)) return true;
  if (/\bbearer\s+[A-Za-z0-9._~+/-]{16,}/i.test(line)) return true;
  return (line.match(/[A-Za-z0-9+=_-]{32,}/g) || []).some((run) => (run.match(/\d/g) || []).length >= 4);
}
const RULE_WORDS = /\b(opus|sonnet|haiku|fable|gpt-[\w.-]+|gemini|codex-[\w.-]+|model|models|effort|ultrathink|think hard|subagents?|delegat\w*|helpers?)\b/i;
const MODEL_WORDS = /\b(opus|sonnet|haiku|fable|gpt-[\w.-]+|gemini|claude-[\w.-]+|model)\b/i;

// Files Claude Code loads on its own for this home + project.
function ccLoadedFiles(ctx) {
  const files = [];
  const add = (scope, p) => { if (statOrNull(p)) files.push({ scope, abs: p }); };
  add('user', path.join(ctx.claudeDir, 'CLAUDE.md'));
  for (const f of listFiles(path.join(ctx.claudeDir, 'rules'), /\.md$/, true)) files.push({ scope: 'user', abs: f });
  if (ctx.project) {
    for (const n of ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md']) add('project', path.join(ctx.project, n));
    for (const f of listFiles(path.join(ctx.project, '.claude', 'rules'), /\.md$/, true)) files.push({ scope: 'project', abs: f });
  }
  return files;
}
function importTargets(text, fromFile, ctx) {
  const out = [];
  for (const l of scanLines(text)) {
    if (l.fence) continue;
    const line = l.text.replace(/`[^`]*`/g, ' ');
    const re = /(?:^|\s)@((?:~\/|\.{1,2}\/|\/)?[A-Za-z0-9._\/-]+)/g;
    let m;
    while ((m = re.exec(line))) {
      const raw = m[1].replace(/[.,;:!?)]+$/, '');
      if (!/[./]/.test(raw)) continue;
      const abs = raw.startsWith('~/') ? path.join(ctx.home, raw.slice(2)) : path.isAbsolute(raw) ? raw : path.join(path.dirname(fromFile), raw);
      out.push(abs);
    }
  }
  return out;
}
// Follow @imports from Claude Code's own files (up to four hops). Returns every imported file
// plus whether reading stopped short anywhere.
function importClosure(ctx) {
  const seen = new Map();
  let unsure = false;
  let frontier = ccLoadedFiles(ctx).map((f) => ({ abs: f.abs, depth: 0 }));
  const visited = new Set(frontier.map((f) => realOr(f.abs)));
  while (frontier.length) {
    const next = [];
    for (const f of frontier) {
      let text;
      if (!insideSetup(realOr(f.abs), ctx)) { unsure = true; continue; }
      text = readSetupText(f.abs, ctx);
      if (text === null) continue;
      for (const t of importTargets(text, f.abs, ctx)) {
        let real;
        try { real = realTarget(t); } catch { continue; }
        if (!seen.has(real)) seen.set(real, t);
        if (visited.has(real)) continue;
        visited.add(real);
        if (!statOrNull(real)) continue;
        if (f.depth + 1 >= 4) continue; // a fourth-hop file loads, but its own imports do not
        if (!isInside(real, ctx.realHome) && !(ctx.realProject && isInside(real, ctx.realProject))) { unsure = true; continue; }
        if (/\.md$/i.test(real)) next.push({ abs: t, depth: f.depth + 1 });
      }
    }
    frontier = next;
  }
  return { imported: seen, unsure };
}
function instructionMode(ctx) {
  // Claude Code's instruction-file mode lives in user settings only.
  const text = readSetupText(path.join(ctx.claudeDir, 'settings.json'), ctx);
  const obj = text ? parseJsonObject(text) : null;
  const v = obj && isObj(obj.pluginConfigs) && isObj(obj.pluginConfigs['agents-md@builtin'])
    && isObj(obj.pluginConfigs['agents-md@builtin'].options) ? obj.pluginConfigs['agents-md@builtin'].options.instructionFiles : null;
  return typeof v === 'string' ? v : null;
}

// Does Claude Code load the project AGENTS.md? true | false | 'unsure'
function claudeReadsProjectAgents(ctx, cache) {
  if (!ctx.project) return false;
  const agentsReal = realOr(path.join(ctx.project, 'AGENTS.md'));
  const loaded = ccLoadedFiles(ctx);
  if (loaded.some((f) => realOr(f.abs) === agentsReal)) return true;
  const imp = cache.imports || (cache.imports = importClosure(ctx));
  if (imp.imported.has(agentsReal)) return true;
  const mode = cache.mode !== undefined ? cache.mode : (cache.mode = instructionMode(ctx));
  if (mode === 'claude-md-and-agents-md') return true;
  if (mode && mode !== 'claude-md-or-agents-md') {
    if (mode === 'claude-md' || mode === 'managed-only') return imp.unsure ? 'unsure' : false;
    return 'unsure';
  }
  let has = ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md'].some((n) => statOrNull(path.join(ctx.project, n)));
  let dir = path.dirname(ctx.project);
  while (!has) {
    if (['CLAUDE.md', 'CLAUDE.local.md'].some((n) => statOrNull(path.join(dir, n)))) has = true;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  if (!has) return true;
  return imp.unsure ? 'unsure' : false;
}

// Who loads this file? One function, used by detect for every file it lists and by plan.
export function readers(target, ctx, cache = {}) {
  const abs = path.resolve(target);
  const real = realOr(abs);
  const tools = new Set();
  let unsure = false;
  const same = (p) => realOr(p) === real;
  if (ctx.project) {
    if (same(path.join(ctx.project, 'AGENTS.md'))) {
      if (!statOrNull(path.join(ctx.project, 'AGENTS.override.md'))) tools.add('codex');
      tools.add('cursor'); tools.add('agents-md');
      const cc = claudeReadsProjectAgents(ctx, cache);
      if (cc === true) tools.add('claude-code');
      if (cc === 'unsure') { tools.add('claude-code'); unsure = true; }
    }
    if (same(path.join(ctx.project, 'AGENTS.override.md'))) tools.add('codex');
    if (/\.mdc$/.test(abs) && isInside(abs, path.join(ctx.project, '.cursor', 'rules'))) tools.add('cursor');
  }
  if (same(path.join(ctx.codexDir, 'AGENTS.override.md'))) tools.add('codex');
  if (same(path.join(ctx.codexDir, 'AGENTS.md')) && !statOrNull(path.join(ctx.codexDir, 'AGENTS.override.md'))) tools.add('codex');
  const ccFiles = ccLoadedFiles(ctx).map((f) => realOr(f.abs));
  if (ccFiles.includes(real)) tools.add('claude-code');
  if (isInside(abs, path.join(ctx.claudeDir, 'rules')) && /\.md$/.test(abs)) tools.add('claude-code');
  if (ctx.project && isInside(abs, path.join(ctx.project, '.claude', 'rules')) && /\.md$/.test(abs)) tools.add('claude-code');
  const imp = cache.imports || (cache.imports = importClosure(ctx));
  if (imp.imported.has(real)) tools.add('claude-code');
  return { tools: ['claude-code', 'codex', 'cursor', 'agents-md'].filter((t) => tools.has(t)), unsure };
}

function scanRules(abs, ctx, out, words) {
  let text;
  text = readSetupText(abs, ctx);
  if (text === null) return;
  const { blocks } = findBlocks(text);
  const lines = text.split(/\r?\n/);
  const inBlock = (i) => blocks.some((b) => i >= b.begin && i <= b.end);
  const owned = ownedState(text).tagged;
  if (owned) return;
  lines.forEach((l, i) => {
    if (inBlock(i) || !words.test(l)) return;
    out.push({ file: display(abs, ctx), line: i + 1, text: looksSecret(l) ? '(line not shown)' : l.trim().slice(0, 80) });
  });
}

export function detect(ctx) {
  const cache = {};
  const has = (p) => !!statOrNull(p);
  const tools = {
    'claude-code': has(ctx.claudeDir) || has(path.join(ctx.home, '.claude.json')) || (!!ctx.project && has(path.join(ctx.project, '.claude'))),
    codex: has(ctx.codexDir) || (!!ctx.project && has(path.join(ctx.project, '.codex'))),
    cursor: has(ctx.cursorDir) || (!!ctx.project && has(path.join(ctx.project, '.cursor'))),
  };
  // Instruction files and who reads each.
  const fileList = [];
  const addFile = (scope, abs) => {
    if (!has(abs) || fileList.some((f) => f.abs === abs)) return;
    fileList.push({ scope, abs });
  };
  addFile('user', path.join(ctx.claudeDir, 'CLAUDE.md'));
  for (const f of listFiles(path.join(ctx.claudeDir, 'rules'), /\.md$/, true)) addFile('user', f);
  addFile('user', path.join(ctx.codexDir, 'AGENTS.md'));
  addFile('user', path.join(ctx.codexDir, 'AGENTS.override.md'));
  if (ctx.project) {
    for (const n of ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', 'AGENTS.override.md']) addFile('project', path.join(ctx.project, n));
    for (const f of listFiles(path.join(ctx.project, '.claude', 'rules'), /\.md$/, true)) addFile('project', f);
    for (const f of listFiles(path.join(ctx.project, '.cursor', 'rules'), /\.mdc$/, false)) addFile('project', f);
  }
  const imp = cache.imports || (cache.imports = importClosure(ctx));
  for (const [real, logical] of imp.imported) if (has(real) && (isInside(real, ctx.realHome) || (ctx.realProject && isInside(real, ctx.realProject)))) addFile(ctx.project && isInside(logical, ctx.project) ? 'project' : 'user', logical);
  const files = [];
  const heads = [];
  for (const f of fileList) {
    let text = null;
    text = readSetupText(f.abs, ctx); // null: unreadable or outside the setup, listed with no line count
    const r = readers(f.abs, ctx, cache);
    files.push({ scope: f.scope, path: display(f.abs, ctx), lines: text === null ? null : countLines(text), readers: r.tools, ...(hasLink(f.abs, f.scope === 'project' ? ctx.project : ctx.home) ? { real_path: realOr(f.abs) } : {}) });
    scanRules(f.abs, ctx, heads, RULE_WORDS);
  }
  // Model mentions in auto-memory and output styles: file:line only.
  const mentions = [];
  const projectsDir = path.join(ctx.claudeDir, 'projects');
  let memDirs = [];
  try { memDirs = fs.readdirSync(projectsDir).sort().map((d) => path.join(projectsDir, d, 'memory')); } catch { /* none */ }
  const styleDirs = [path.join(ctx.claudeDir, 'output-styles')];
  if (ctx.project) styleDirs.push(path.join(ctx.project, '.claude', 'output-styles'));
  for (const d of [...memDirs, ...styleDirs]) {
    for (const f of listFiles(d, /\.md$/, false)) {
      const found = [];
      scanRules(f, ctx, found, MODEL_WORDS);
      for (const x of found) mentions.push({ file: x.file, line: x.line });
    }
  }
  // Helper agents: name, model and the one-line description (so a helper doing the same job as
  // one of the package's can be named in the plan).
  const agents = [];
  for (const tool of ['claude-code', 'codex', 'cursor']) {
    for (const a of readAgents(tool, ctx)) agents.push({ tool, scope: a.scope, path: display(a.path, ctx), name: a.name, model: a.model, description: a.description, modelproof: a.modelproof });
  }
  // Settings: key names, plus model/effort values. Never env values, hooks or apiKeyHelper.
  const settings = [];
  let forceInSettings = false;
  const settingsFiles = [['user', path.join(ctx.claudeDir, 'settings.json')]];
  if (ctx.project) settingsFiles.push(['project', path.join(ctx.project, '.claude', 'settings.json')], ['project', path.join(ctx.project, '.claude', 'settings.local.json')]);
  for (const [scope, abs] of settingsFiles) {
    let text = null;
    try { if (!insideSetup(realOr(abs), ctx)) throw new Error("outside"); text = readText(abs); } catch { settings.push({ scope, path: display(abs, ctx), keys: [], unreadable: true }); continue; }
    if (text === null) continue;
    const obj = parseJsonObject(text);
    if (!obj) { settings.push({ scope, path: display(abs, ctx), keys: topLevelKeys(text), parse_error: true }); continue; }
    const rec = { scope, path: display(abs, ctx), keys: Object.keys(obj) };
    for (const k of ['model', 'effortLevel', 'maxEffortLevel']) if (typeof obj[k] === 'string') rec[k] = obj[k].slice(0, 60);
    if (isObj(obj.env) && Object.prototype.hasOwnProperty.call(obj.env, 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE')) forceInSettings = true;
    settings.push(rec);
  }
  const reads = claudeReadsProjectAgents(ctx, cache);
  const mode = cache.mode !== undefined ? cache.mode : (cache.mode = instructionMode(ctx));
  const notes = [...ctx.notes];
  if (reads === 'unsure') notes.push('Could not tell for sure whether Claude Code reads the project AGENTS.md.');
  return {
    schema: SETUP_SCHEMA,
    home: ctx.realHome,
    project: ctx.realProject,
    tools,
    dirs: { claude: tildeDir(ctx.claudeDir, ctx), codex: tildeDir(ctx.codexDir, ctx) },
    instruction_mode: mode || 'claude-md-or-agents-md',
    claude_reads_project_agents_md: reads,
    agents_override: {
      user: has(path.join(ctx.codexDir, 'AGENTS.override.md')),
      project: !!ctx.project && has(path.join(ctx.project, 'AGENTS.override.md')),
    },
    files, agents, settings,
    env: { subagent_model_force: ctx.force || forceInSettings },
    heads_up: heads.slice(0, 30),
    mentions: mentions.slice(0, 30),
    notes,
  };
}

/* ------------------------------------------------------------------ state */

export function stateDir(opts = {}) {
  if (process.env.MODELPROOF_HOME) return path.resolve(process.env.MODELPROOF_HOME);
  if (opts.home) return path.join(path.resolve(opts.home), '.modelproof');
  const here = path.dirname(SELF);
  if (path.basename(here) === 'bin' && statOrNull(path.join(here, '..', 'installs'))) return path.resolve(here, '..');
  return path.join(os.homedir(), '.modelproof');
}
export function installId(ctx, scope) {
  return sha256(scope === 'user' ? ctx.realHome + 'user' : ctx.realProject + 'project').slice(0, 12);
}
function ensurePrivateDir(dir) {
  const missing = [];
  let cur = dir;
  while (!statOrNull(cur)) { missing.unshift(cur); cur = path.dirname(cur); }
  for (const d of missing) { fs.mkdirSync(d, { mode: 0o700 }); fs.chmodSync(d, 0o700); }
  return missing;
}
function writePrivate(file, data) {
  ensurePrivateDir(path.dirname(file));
  fs.writeFileSync(file, data, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}
function manifestPath(state, id) { return path.join(state, 'installs', id, 'manifest.json'); }
function loadManifest(state, id) {
  const p = manifestPath(state, id);
  const b = (() => { try { return fs.readFileSync(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } })();
  if (b === null) return { bytes: null, m: null };
  let m;
  try { m = JSON.parse(b.toString('utf8')); } catch { throw new Fail(EXIT.CORRUPT, `install record ${p} is not valid JSON`); }
  return { bytes: b, m };
}
// The lock records who holds it (pid + start time). A lock whose pid is no longer running was left
// by a run that stopped midway: it is taken over, and the run says so.
function readLock(p) {
  let text;
  try { text = fs.readFileSync(p, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  let pid = null; let started = null;
  try { const j = JSON.parse(text); pid = j.pid; started = j.started || null; } catch { pid = Number(text.trim()); }
  return { text, pid: Number.isInteger(pid) && pid > 0 ? pid : null, started };
}
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
}
function lock(state) {
  ensurePrivateDir(state);
  const p = path.join(state, 'lock');
  const held = (h) => new Fail(EXIT.USAGE, `another modelproof run${h && h.pid ? ` (pid ${h.pid}${h.started ? `, started ${h.started}` : ''})` : ''} holds ${p}. If none is running, remove that file and try again.`);
  const create = () => fs.openSync(p, 'wx', 0o600);
  let fd;
  try { fd = create(); } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const h = readLock(p);
    // Unknown holder (unreadable, or pid still running): leave it alone.
    if (h && (!h.pid || pidAlive(h.pid))) throw held(h);
    if (h) {
      // Move the stale lock aside, then check it is still the one judged stale before dropping it.
      const aside = `${p}.stale-${process.pid}`;
      try { fs.renameSync(p, aside); } catch (err) { if (err.code !== 'ENOENT') throw err; }
      let moved = null;
      try { moved = fs.readFileSync(aside, 'utf8'); } catch { /* another run moved it first */ }
      if (moved !== null && moved !== h.text) { try { fs.renameSync(aside, p); } catch { /* keep going */ } throw held(readLock(p)); }
      try { fs.unlinkSync(aside); } catch { /* gone */ }
      process.stderr.write(`Note: took over a lock left by an earlier run that is no longer running (pid ${h.pid}${h.started ? `, started ${h.started}` : ''}).\n`);
    }
    try { fd = create(); } catch (err) { if (err.code === 'EEXIST') throw held(readLock(p)); throw err; }
  }
  const started = new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString();
  fs.writeSync(fd, JSON.stringify({ pid: process.pid, started }));
  fs.closeSync(fd);
  return () => { try { fs.unlinkSync(p); } catch { /* already gone */ } };
}
function flatName(logical) { return logical.replace(/^~\//, 'home/').replace(/[/\\]/g, '__'); }

/* ------------------------------------------------------------------ plan: per-part decisions */

function partName(content, toml) {
  const meta = toml ? tomlTop(content) : frontmatter(content);
  return meta.name || null;
}

// Decide what one part does against the current bytes. Pure: plan and apply both call it.
function decide(part, cur, entry, extra) {
  const kind = part.kind;
  const res = { action: null, reason: null, next: null, record: null };
  if (kind === 'owned-file') {
    const bytes = stampOwned(part.content);
    if (cur === null) {
      if (extra.nameClash) return { ...res, action: 'conflict', reason: extra.nameClash };
      return { ...res, action: 'create', next: bytes, record: { owned: { sha16: sha16(part.content) } } };
    }
    const text = cur.toString('utf8');
    const mine = entry && entry.active && entry.after_sha256 === sha256(cur);
    const st = ownedState(text);
    const intact = mine || st.intact || (st.tagged && !st.sha && text === String(part.content));
    if (!st.tagged && !mine) return { ...res, action: 'conflict', reason: 'a file with this name that modelproof did not write; it stays as is' };
    if (!intact) return { ...res, action: 'conflict', reason: 'this modelproof file was edited after it was installed; your version stays' };
    if (text === bytes) return { ...res, action: mine ? 'unchanged' : 'adopt', record: { owned: { sha16: sha16(part.content) } } };
    return { ...res, action: 'update', adopt: !mine, next: bytes, record: { owned: { sha16: sha16(part.content) } } };
  }
  if (kind === 'block') {
    const body = contentLines(part.content);
    if (body.some((l) => BEGIN_RE.test(l) || END_RE.test(l) || /modelproof:(begin|end)/.test(l))) throw new Fail(EXIT.USAGE, `package part ${part.id} carries marker text; refusing it`);
    if (cur === null) {
      const a = appendBlock('', body);
      return { ...res, action: 'create', next: a.text, record: { block: { sha16: bodyHash(body), separator: a.separator, trailer: a.trailer, eol: a.eol, created_file: true } } };
    }
    const text = cur.toString('utf8');
    if (text.includes('\u0000')) return { ...res, action: 'conflict', reason: 'not a text file' };
    const { blocks, corrupt } = findBlocks(text);
    if (corrupt.length) throw new Fail(EXIT.CORRUPT, `${part.target.path}: damaged modelproof markers — ${corrupt.join('; ')}. Nothing was changed; fix or remove the markers by hand.`);
    if (!blocks.length) {
      // Appended after an unclosed fence, the block would sit inside it: the tool reading the file
      // would see code, not rules.
      const open = scanLines(text).openFence;
      if (open) return { ...res, action: 'conflict', reason: `this file ends inside an open code fence (${open}), so a block added at the end would read as code; close the fence or pick another file` };
      const a = appendBlock(text, body);
      return { ...res, action: 'append', next: a.text, record: { block: { sha16: bodyHash(body), separator: a.separator, trailer: a.trailer, eol: a.eol, created_file: false } } };
    }
    const b = blocks[0];
    const same = b.body.join('\n') === body.join('\n');
    const known = entry && entry.active && entry.block;
    if (!blockIntact(b) && !(same && !b.sha)) return { ...res, action: 'conflict', reason: 'the modelproof block here was edited; your edits stay' };
    const rec = known ? { ...entry.block, sha16: bodyHash(body) } : { ...guessSeparators(text, b), eol: detectEol(text), sha16: bodyHash(body), created_file: false, guessed: true };
    if (same && b.sha) return { ...res, action: known ? 'unchanged' : 'adopt', record: { block: rec } };
    return { ...res, action: 'update', adopt: !known, next: replaceBlock(text, b, body), record: { block: rec } };
  }
  if (kind === 'json-keys') {
    const want = Object.entries(part.keys || {});
    const ours = (entry && entry.active && entry.keys) ? entry.keys : null;
    if (cur === null) {
      const ins = jsonInsert('{}\n', want);
      return { ...res, action: 'create', next: ins.text, record: { keys: { created_file: true, segments: [{ keys: want.map(([k]) => k), values: Object.fromEntries(want), text: ins.segment }] } } };
    }
    const text = cur.toString('utf8');
    const obj = parseJsonObject(text);
    if (!obj) return { ...res, action: 'conflict', reason: 'this settings file cannot be read as JSON (a comment or trailing comma?); nothing is written to it' };
    let work = text;
    const segments = [];
    const kept = [];
    let changed = false;
    // Our earlier keys: keep, change or cut, by exact text.
    for (const seg of (ours ? ours.segments : [])) {
      const stillOurs = seg.keys.every((k) => Object.prototype.hasOwnProperty.call(obj, k) && JSON.stringify(obj[k]) === JSON.stringify(seg.values[k])) && countOf(work, seg.text) === 1;
      if (!stillOurs) return { ...res, action: 'conflict', reason: `a key modelproof added (${seg.keys.join(', ')}) was changed; your value stays` };
      const wanted = seg.keys.filter((k) => Object.prototype.hasOwnProperty.call(part.keys || {}, k));
      const sameVals = wanted.length === seg.keys.length && seg.keys.every((k) => JSON.stringify(part.keys[k]) === JSON.stringify(seg.values[k]));
      if (sameVals) { segments.push(seg); continue; }
      work = work.replace(seg.text, seg.dropped || '');
      changed = true;
    }
    const have = new Set(segments.flatMap((s) => s.keys));
    const add = [];
    for (const [k, v] of want) {
      if (have.has(k)) continue;
      const present = Object.prototype.hasOwnProperty.call(parseJsonObject(work) || {}, k);
      if (present) { kept.push(k); continue; }
      add.push([k, v]);
    }
    if (add.length) {
      const ins = jsonInsert(work, add);
      work = ins.text;
      segments.push({ keys: add.map(([k]) => k), values: Object.fromEntries(add), text: ins.segment, ...(ins.dropped ? { dropped: ins.dropped } : {}) });
      changed = true;
    }
    if (!parseJsonObject(work)) throw new Fail(EXIT.USAGE, `internal: settings text would not parse after the change to ${part.target.path}`);
    const record = { keys: { created_file: ours ? !!ours.created_file : false, segments } };
    const note = kept.length ? `already set and kept: ${kept.join(', ')}` : null;
    if (!changed) return { ...res, action: segments.length ? 'unchanged' : 'skip', reason: note || (segments.length ? null : 'nothing to add'), record: segments.length ? record : null };
    return { ...res, action: ours ? 'update' : 'add-keys', reason: note, next: work, record };
  }
  throw new Fail(EXIT.USAGE, `unknown part kind ${kind}`);
}

// What taking out one recorded target does (remove item on reinstall, and undo).
function decideRemove(entry, cur) {
  if (cur === null) return { action: 'unchanged', reason: 'already gone', ops: [] };
  const text = cur.toString('utf8');
  if (entry.kind === 'owned-file') {
    const intact = entry.after_sha256 === sha256(cur) || ownedState(text).intact;
    return { action: 'remove', edited: !intact, ops: [{ type: 'move' }] };
  }
  if (entry.kind === 'block') {
    const { blocks, corrupt } = findBlocks(text);
    if (corrupt.length) throw new Fail(EXIT.CORRUPT, `${entry.path}: damaged modelproof markers — ${corrupt.join('; ')}`);
    if (!blocks.length) return { action: 'unchanged', reason: 'block already gone', ops: [] };
    const b = blocks[0];
    const rec = entry.block || {};
    const guess = rec.guessed || rec.separator === undefined ? guessSeparators(text, b) : { separator: rec.separator, trailer: rec.trailer };
    const cut = cutBlock(text, b, guess.separator, guess.trailer);
    const ops = [];
    const edited = !blockIntact(b);
    if (edited) ops.push({ type: 'copy', text: text.slice(b.start, b.stop) + detectEol(text) });
    const emptyCreated = cut.text === '' && (rec.created_file || rec.guessed);
    ops.push(emptyCreated ? { type: 'move' } : { type: 'write', text: cut.text });
    return { action: 'remove', edited, exact: cut.exact && !rec.guessed, ops };
  }
  if (entry.kind === 'json-keys') {
    let work = text;
    let exact = true;
    for (const seg of (entry.keys ? entry.keys.segments : []).slice().reverse()) {
      const obj = parseJsonObject(work);
      const valuesSame = obj && seg.keys.every((k) => JSON.stringify(obj[k]) === JSON.stringify(seg.values[k]));
      if (valuesSame && countOf(work, seg.text) === 1) work = work.replace(seg.text, seg.dropped || '');
      else exact = false;
    }
    if (work === text) return { action: 'unchanged', reason: 'keys already gone or changed', exact, ops: [] };
    const emptyCreated = entry.keys && entry.keys.created_file && work.replace(/\s/g, '') === '{}';
    return { action: 'remove', exact, ops: [emptyCreated ? { type: 'move' } : { type: 'write', text: work }] };
  }
  return { action: 'unchanged', ops: [] };
}

function nameClash(part, abs, ctx) {
  const m = /^(claude-code|codex|cursor):agent:/.exec(part.id);
  if (!m) return null;
  const tool = m[1];
  const name = partName(part.content, tool === 'codex');
  if (!name) return null;
  const real = realTarget(abs);
  for (const a of readAgents(tool, ctx)) {
    if (realOr(a.path) === real || a.modelproof) continue;
    if (a.name && a.name.toLowerCase() === name.toLowerCase()) return `the helper name "${name}" is already used by ${display(a.path, ctx)}; that file stays and this one is left out`;
  }
  return null;
}

// Text for one tool already installed at the other scope → a second copy would load twice.
function otherScopeCopy(part, ctx, scope) {
  if (part.enforced !== false) return null;
  const readersList = part.readers || [part.tool];
  const found = [];
  const ownedAt = (p) => { const t = readSetupText(p, ctx); return t !== null && ownedState(t).tagged; };
  const blockAt = (p) => { const t = readSetupText(p, ctx); return t !== null && findBlocks(t).blocks.length > 0; };
  for (const tool of readersList) {
    if (scope === 'project') {
      if (tool === 'claude-code' && ownedAt(path.join(ctx.claudeDir, 'rules', 'modelproof.md'))) found.push(['Claude Code', display(path.join(ctx.claudeDir, 'rules', 'modelproof.md'), ctx)]);
      if (tool === 'codex') for (const n of ['AGENTS.md', 'AGENTS.override.md']) if (blockAt(path.join(ctx.codexDir, n))) found.push(['Codex', display(path.join(ctx.codexDir, n), ctx)]);
    } else if (ctx.project) {
      if (tool === 'claude-code' && ownedAt(path.join(ctx.project, '.claude', 'rules', 'modelproof.md'))) found.push(['Claude Code', display(path.join(ctx.project, '.claude', 'rules', 'modelproof.md'), ctx)]);
      if (tool === 'claude-code' && blockAt(path.join(ctx.project, 'AGENTS.md')) && readers(path.join(ctx.project, 'AGENTS.md'), ctx).tools.includes('claude-code')) found.push(['Claude Code', 'AGENTS.md']);
      if (tool === 'codex') for (const n of ['AGENTS.md', 'AGENTS.override.md']) if (blockAt(path.join(ctx.project, n))) found.push(['Codex', n]);
    }
  }
  if (!found.length) return null;
  const [tool, where] = found[0];
  return `${tool} already has modelproof text at ${scope === 'project' ? 'user' : 'project'} scope (${where}); a second copy would load twice. Undo that install first, or leave this part out`;
}

function packageFacts(dataDir) {
  const load = (n, optional) => {
    const p = path.join(dataDir, n);
    if (!statOrNull(p)) { if (optional) return undefined; throw new Fail(EXIT.USAGE, `--data folder has no ${n}: ${dataDir}`); }
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { throw new Fail(EXIT.USAGE, `${p} is not valid JSON`); }
  };
  const facts = { models: load('models.json'), guidance: load('guidance.json') };
  const plans = load('plans.json', true);
  if (plans) facts.plans = plans;
  return facts;
}

function planHash(plan) {
  const { hash, ...rest } = plan;
  void hash;
  return sha16(JSON.stringify(rest));
}

export function makePlan({ profile, facts, ctx, state }) {
  const scope = profile && profile.scope === 'project' ? 'project' : 'user';
  if (scope === 'project' && !ctx.project) throw new Fail(EXIT.USAGE, 'this profile is for one project; pass --project');
  const setup = detect(ctx);
  const id = installId(ctx, scope);
  const { bytes: mBytes, m: manifest } = loadManifest(state, id);
  const targets = (manifest && manifest.targets) || {};
  // Keys this install added are ours, not the user's: hide them from the generator so a reinstall
  // keeps (or changes) them instead of treating them as "already set".
  for (const s of setup.settings) {
    const e = targets[s.path];
    if (!e || !e.active || !e.keys) continue;
    const mine = new Set(e.keys.segments.flatMap((x) => x.keys));
    s.keys = s.keys.filter((k) => !mine.has(k));
  }
  const pkg = buildPackage(profile, facts, { ...setup, state_dir: tildeOr(path.resolve(state), ctx.home) });
  const items = [];
  const seen = new Set();
  pkg.parts.forEach((part, i) => {
    const abs = targetAbs(part.target.path, ctx);
    const logical = part.target.path;
    seen.add(logical);
    const item = { n: i + 1, part_id: part.id, kind: part.kind, path: logical, real_path: null, link: false, action: null, reason: null, sha_before: null, lines_before: 0, lines_after: 0 };
    let bad;
    try { bad = allowedTarget(abs, ctx); } catch (e) { if (!(e instanceof Fail)) throw e; bad = e.message; }
    if (bad) { items.push({ ...item, action: 'conflict', reason: `refused: ${bad}` }); return; }
    const real = realTarget(abs);
    item.real_path = real;
    item.link = hasLink(abs, scope === 'project' ? ctx.project : ctx.home);
    let cur;
    try { cur = readBytes(real); } catch (e) { if (e instanceof Fail && e.code === EXIT.CONFLICT) { items.push({ ...item, action: 'conflict', reason: e.message }); return; } throw e; }
    item.sha_before = cur === null ? null : sha256(cur);
    item.lines_before = cur === null ? 0 : countLines(cur.toString('utf8'));
    const entry = targets[logical];
    const clash = cur === null ? nameClash(part, abs, ctx) : null;
    const d = decide(part, cur, entry, { nameClash: clash });
    const second = otherScopeCopy(part, ctx, scope);
    if (second && d.action !== 'conflict') { items.push({ ...item, action: 'conflict', reason: second }); return; }
    item.action = d.action;
    item.reason = d.reason || null;
    item.lines_after = d.next !== null && d.next !== undefined ? countLines(d.next) : item.lines_before;
    if (d.adopt) item.adopt = true;
    items.push(item);
  });
  // Parts an earlier install placed that this package no longer has: their own numbered items.
  let n = pkg.parts.length;
  for (const [logical, entry] of Object.entries(targets)) {
    if (!entry.active || seen.has(logical)) continue;
    const abs = targetAbs(logical, ctx);
    const real = realTarget(abs);
    let cur;
    try { cur = readBytes(real); } catch { cur = null; }
    const r = decideRemove(entry, cur);
    const item = { n: ++n, part_id: entry.part_id, kind: entry.kind, path: logical, real_path: real, link: hasLink(abs, scope === 'project' ? ctx.project : ctx.home), action: r.action === 'remove' ? (r.edited ? 'conflict' : 'remove') : 'remove', reason: r.edited ? 'this part is no longer in the package, but it was edited after install; your version stays' : (r.reason ? `no longer in this package (${r.reason})` : 'no longer in this package'), sha_before: cur === null ? null : sha256(cur), lines_before: cur === null ? 0 : countLines(cur.toString('utf8')), lines_after: 0 };
    items.push(item);
  }
  const plan = {
    schema: PLAN_SCHEMA,
    installer_version: INSTALLER_VERSION,
    generator_version: GENERATOR_VERSION,
    id, scope,
    home: ctx.home, project: ctx.project,
    real_home: ctx.realHome, real_project: ctx.realProject,
    dirs: { claude: ctx.claudeDir, codex: ctx.codexDir },
    state_dir: state,
    manifest_sha: mBytes ? sha256(mBytes) : null,
    package: pkg,
    items,
    heads_up: setup.heads_up,
    mentions: setup.mentions,
    notes: setup.notes,
  };
  plan.hash = planHash(plan);
  return plan;
}

export function renderPlan(plan, planFile) {
  const out = [renderPreview(plan.package).trimEnd(), ''];
  out.push(`Plan ${plan.hash} · install id ${plan.id} · ${plan.scope} scope`);
  const w = Math.max(...plan.items.map((x) => x.action.length), 6);
  for (const it of plan.items) {
    const counts = it.action === 'remove' ? 'taken out' : `${it.lines_before} → ${it.lines_after} lines`;
    let line = `  ${String(it.n).padStart(2)}. ${it.action.padEnd(w)}  ${it.path}`;
    if (it.link && it.real_path) line += ` (real path: ${it.real_path})`;
    line += ` · ${counts}`;
    out.push(line);
    if (it.reason) out.push(`      ${it.reason}`);
  }
  const conflicts = plan.items.filter((x) => x.action === 'conflict').map((x) => x.n);
  // Lines already listed under "Check these before you say Go" are not repeated here.
  const checked = new Set((Array.isArray(plan.package.checks) ? plan.package.checks : []).filter((c) => c.kind === 'rule').map((c) => `${c.file}:${c.line}`));
  const heads = plan.heads_up.filter((h) => !checked.has(`${h.file}:${h.line}`));
  if (heads.length || plan.mentions.length) {
    out.push('', 'Heads-up: lines in your setup that already talk about models, effort or helpers (kept as they are)');
    for (const h of heads) out.push(`  ${h.file}:${h.line}  ${h.text}`);
    if (plan.mentions.length) {
      const names = uniq(plan.mentions.map((m) => path.basename(m.file)));
      const shown = names.length > 6 ? `${names.slice(0, 6).join(', ')} and ${names.length - 6} more` : names.join(', ');
      out.push(`  Memory and output styles: ${plan.mentions.length} ${plan.mentions.length === 1 ? 'line names' : 'lines name'} a model (${shown}; lines not shown)`);
    }
  }
  for (const n of plan.notes) out.push(`Note: ${n}`);
  out.push('', `Undo takes out everything above and leaves ${tildeOr(plan.state_dir, plan.home)} in place (install history).`);
  if (conflicts.length) out.push(`Needs a decision: ${conflicts.join(', ')}. Apply refuses until each is left out with --skip ${conflicts.join(',')}.`);
  // The exact command, runnable as printed from any folder: this installer's own path and the plan file's.
  out.push(planFile ? `Apply: node ${shellPath(SELF)} apply --plan ${shellPath(path.resolve(planFile))} --expect ${plan.hash}${conflicts.length ? ` --skip ${conflicts.join(',')}` : ''}` : 'Write the plan with --out <file> to apply it.');
  return out.join('\n') + '\n';
}

/* ------------------------------------------------------------------ executing writes, with rollback */

function mkdirsFor(file) {
  const created = [];
  let cur = path.dirname(file);
  const missing = [];
  while (!statOrNull(cur)) { missing.unshift(cur); cur = path.dirname(cur); }
  for (const d of missing) { fs.mkdirSync(d); created.push(d); }
  return created;
}
function moveFile(src, dest) {
  ensurePrivateDir(path.dirname(dest));
  let target = dest; let k = 1;
  while (lstatOrNull(target)) target = `${dest}.${k++}`;
  try { fs.renameSync(src, target); } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    fs.copyFileSync(src, target);
    fs.unlinkSync(src);
  }
  return target;
}
// Replace an existing file whole, at its real path: write a temp file in the same folder, copy the
// mode, flush it to disk, then rename it over the target. A kill or power loss mid-write leaves
// either the old bytes or the new ones, never a cut-off file. A read-only file stays refused.
function writeReplace(real, data) {
  const st = fs.statSync(real);
  fs.accessSync(real, fs.constants.W_OK);
  const dir = path.dirname(real);
  const tmp = path.join(dir, `.${path.basename(real)}.modelproof-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`);
  const fd = fs.openSync(tmp, 'wx', st.mode & 0o7777);
  try {
    fs.writeFileSync(fd, data);
    fs.fchmodSync(fd, st.mode & 0o7777);
    try { fs.fchownSync(fd, st.uid, st.gid); } catch { /* not ours to set; keep the default owner */ }
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(tmp, real);
  } catch (e) {
    try { fs.closeSync(fd); } catch { /* already closed */ }
    try { fs.unlinkSync(tmp); } catch { /* gone */ }
    throw e;
  }
  try { const dfd = fs.openSync(dir, 'r'); try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); } } catch { /* best effort */ }
}
// Runs ops in order; on any error undoes the ones done, newest first, then rethrows.
function runOps(ops) {
  const done = [];
  try {
    for (const op of ops) {
      if (op.type === 'write') {
        const existed = !!lstatOrNull(op.real);
        const original = existed ? fs.readFileSync(op.real) : null;
        const dirs = existed ? [] : mkdirsFor(op.real);
        done.push({ op, existed, original, dirs });
        if (existed) writeReplace(op.real, op.data);
        else fs.writeFileSync(op.real, op.data, { flag: 'wx' });
      } else if (op.type === 'move') {
        const to = moveFile(op.real, op.dest);
        done.push({ op, to });
        op.movedTo = to;
      } else if (op.type === 'copy') {
        ensurePrivateDir(path.dirname(op.dest));
        let target = op.dest; let k = 1;
        while (lstatOrNull(target)) target = `${op.dest}.${k++}`;
        fs.writeFileSync(target, op.data, { mode: 0o600, flag: 'wx' });
        done.push({ op, copied: target });
        op.copiedTo = target;
      } else if (op.type === 'rmdir') {
        try { fs.rmdirSync(op.dir); done.push({ op, removedDir: op.dir }); } catch { /* not empty or gone: leave it */ }
      }
    }
  } catch (err) {
    for (const d of done.reverse()) {
      try {
        if (d.op.type === 'write') {
          if (d.existed) writeReplace(d.op.real, d.original);
          else { try { fs.unlinkSync(d.op.real); } catch { /* not written */ } for (const dir of d.dirs.slice().reverse()) { try { fs.rmdirSync(dir); } catch { /* keep */ } } }
        } else if (d.op.type === 'move') fs.renameSync(d.to, d.op.real);
        else if (d.op.type === 'copy') fs.unlinkSync(d.copied);
        else if (d.op.type === 'rmdir') fs.mkdirSync(d.removedDir);
      } catch { /* keep undoing the rest; the error below is still reported */ }
    }
    throw err;
  }
  return done;
}

/* ------------------------------------------------------------------ apply */

function ctxFromPlan(plan) {
  const ctx = makeContext({ home: plan.home, project: plan.project, env: {} });
  ctx.claudeDir = plan.dirs.claude;
  ctx.codexDir = plan.dirs.codex;
  return ctx;
}
function copyBin(state) {
  const here = path.dirname(SELF);
  const bin = path.join(state, 'bin');
  ensurePrivateDir(bin);
  for (const f of ['install.mjs', 'instructions.mjs']) {
    const src = path.join(here, f);
    const dest = path.join(bin, f);
    if (path.resolve(src) === path.resolve(dest)) continue;
    writePrivate(dest, fs.readFileSync(src));
  }
  return path.join(bin, 'install.mjs');
}

export function applyPlan(plan, { expect, skip = [] }) {
  if (!plan || plan.schema !== PLAN_SCHEMA) throw new Fail(EXIT.USAGE, 'not a modelproof plan file');
  if (!expect) throw new Fail(EXIT.USAGE, 'apply needs --expect <plan hash> (the hash printed with the preview)');
  const actual = planHash(plan);
  if (actual !== plan.hash || expect !== plan.hash) throw new Fail(EXIT.DRIFT, `this plan is not the one previewed (hash ${actual}, expected ${expect}). Run plan again and review it.`);
  const ctx = ctxFromPlan(plan);
  if (ctx.realHome !== plan.real_home || (plan.project && ctx.realProject !== plan.real_project)) throw new Fail(EXIT.DRIFT, 'the home or project folder now resolves somewhere else. Run plan again.');
  // Every package part is a numbered item and every non-remove item is a package part: apply
  // writes only what the preview listed, never a part that sits in the package without an item.
  const parts = plan.package && Array.isArray(plan.package.parts) ? plan.package.parts : [];
  parts.forEach((p, i) => {
    const it = plan.items.find((x) => x.n === i + 1);
    if (!it || it.part_id !== p.id) throw new Fail(EXIT.USAGE, `plan items and package parts do not match at item ${i + 1}. Run plan again.`);
  });
  for (const it of plan.items) if (!['remove', 'conflict'].includes(it.action) && it.n > parts.length) throw new Fail(EXIT.USAGE, `plan item ${it.n} has no package part. Run plan again.`);
  const state = plan.state_dir;
  const skipSet = new Set(skip);
  const open = plan.items.filter((x) => x.action === 'conflict' && !skipSet.has(x.n));
  if (open.length) throw new Fail(EXIT.CONFLICT, `items need a decision: ${open.map((x) => `${x.n} (${x.path}: ${x.reason})`).join('; ')}. Leave them out with --skip ${open.map((x) => x.n).join(',')}.`);
  const release = lock(state);
  try {
    const { bytes: mBytes, m: old } = loadManifest(state, plan.id);
    if ((mBytes ? sha256(mBytes) : null) !== plan.manifest_sha) throw new Fail(EXIT.DRIFT, 'the install record changed since the preview. Run plan again.');
    const manifest = old ? JSON.parse(JSON.stringify(old)) : {
      schema: MANIFEST_SCHEMA, id: plan.id, scope: plan.scope, home: plan.home, project: plan.project,
      real_home: plan.real_home, real_project: plan.real_project, dirs: plan.dirs,
      first_installed: new Date().toISOString(), targets: {}, history: [],
    };
    manifest.targets = manifest.targets || {};
    manifest.history = manifest.history || [];
    const round = manifest.history.length + 1;
    const removedDir = path.join(state, 'installs', plan.id, 'removed', String(round));
    const partsById = new Map(plan.package.parts.map((p, i) => [i + 1, p]));
    const ops = [];
    const touched = [];
    const summary = [];
    for (const it of plan.items) {
      if (skipSet.has(it.n) || it.action === 'conflict') { summary.push(`  ${String(it.n).padStart(2)}. left out  ${it.path}`); continue; }
      const abs = targetAbs(it.path, ctx);
      const bad = allowedTarget(abs, ctx);
      if (bad) throw new Fail(EXIT.CONFLICT, `refused ${it.path}: ${bad}`);
      const real = realTarget(abs);
      if (real !== it.real_path) throw new Fail(EXIT.DRIFT, `${it.path} now resolves to ${real}, not ${it.real_path}. Run plan again.`);
      const cur = readBytes(real);
      if ((cur === null ? null : sha256(cur)) !== it.sha_before) throw new Fail(EXIT.DRIFT, `${it.path} changed since the preview. Nothing was written. Run plan again.`);
      const entry = manifest.targets[it.path];
      if (it.action === 'remove') {
        const r = decideRemove(entry, cur);
        for (const o of r.ops) {
          if (o.type === 'move') ops.push({ type: 'move', real, dest: path.join(removedDir, flatName(it.path)) });
          if (o.type === 'copy') ops.push({ type: 'copy', dest: path.join(removedDir, flatName(it.path) + '.edited-block'), data: o.text });
          if (o.type === 'write') ops.push({ type: 'write', real, data: o.text });
        }
        for (const dir of (entry.created_dirs || []).slice().sort((a, b) => b.length - a.length)) ops.push({ type: 'rmdir', dir });
        touched.push({ it, entry, remove: true });
        summary.push(`  ${String(it.n).padStart(2)}. removed   ${it.path}`);
        continue;
      }
      const part = partsById.get(it.n);
      if (!part || part.id !== it.part_id) throw new Fail(EXIT.USAGE, `plan item ${it.n} does not match its package part`);
      const d = decide(part, cur, entry, { nameClash: null });
      if (d.action !== it.action) throw new Fail(EXIT.DRIFT, `${it.path}: expected "${it.action}", now "${d.action}". Run plan again.`);
      if (d.next !== null && d.next !== undefined) ops.push({ type: 'write', real, data: d.next, item: it });
      if (d.action !== 'skip') touched.push({ it, entry, d, cur });
      summary.push(`  ${String(it.n).padStart(2)}. ${d.action.padEnd(9)} ${it.path}`);
    }
    // New manifest (union by target). Before-state is recorded the first time a path is touched.
    const next = JSON.parse(JSON.stringify(manifest));
    next.last_installed = new Date().toISOString();
    next.installer_version = INSTALLER_VERSION;
    next.generator_version = plan.generator_version;
    next.pending = true;
    for (const t of touched) {
      const key = t.it.path;
      if (t.remove) { if (next.targets[key]) next.targets[key].active = false; continue; }
      const prev = next.targets[key];
      const firstTouch = !prev;
      const base = prev || {
        path: key, kind: t.it.kind, part_id: t.it.part_id,
        before: t.d.adopt || t.d.action === 'adopt' ? { existed: t.cur !== null, sha256: null, unknown: true } : { existed: t.cur !== null, sha256: t.cur === null ? null : sha256(t.cur) },
        created_dirs: [],
      };
      if (!firstTouch && !prev.active && prev.kind !== t.it.kind) base.kind = t.it.kind;
      next.targets[key] = { ...base, kind: t.it.kind, part_id: t.it.part_id, real: t.it.real_path, active: true, ...t.d.record };
    }
    next.history.push({ round, at: next.last_installed, action: 'apply', plan: plan.hash, items: plan.items.map((x) => ({ n: x.n, path: x.path, action: skipSet.has(x.n) ? 'left out' : x.action })) });
    const mPath = manifestPath(state, plan.id);
    const madeStateDirs = ensurePrivateDir(path.dirname(mPath));
    writePrivate(mPath, JSON.stringify(next, null, 2) + '\n');
    let done;
    try {
      done = runOps(ops);
    } catch (err) {
      if (mBytes) writePrivate(mPath, mBytes);
      else {
        try { fs.unlinkSync(mPath); } catch { /* gone */ }
        for (const d of madeStateDirs.slice().reverse()) { try { fs.rmdirSync(d); } catch { /* keep */ } }
      }
      throw new Fail(EXIT.USAGE, `could not write (${err.code || err.message}); every change from this run was rolled back`);
    }
    // After-state hashes and created folders, then the final record.
    for (const d of done) {
      if (d.op.type !== 'write' || !d.op.item) continue;
      const tgt = next.targets[d.op.item.path];
      if (!d.existed && d.dirs.length) tgt.created_dirs = uniq([...(tgt.created_dirs || []), ...d.dirs]);
      if (!d.existed && !tgt.before.existed) tgt.before.created = true;
    }
    for (const t of touched) {
      const tgt = next.targets[t.it.path];
      const cur = readBytes(realTarget(targetAbs(t.it.path, ctx)));
      tgt.after_sha256 = cur === null ? null : sha256(cur);
    }
    delete next.pending;
    writePrivate(mPath, JSON.stringify(next, null, 2) + '\n');
    const bin = copyBin(state);
    return { id: plan.id, summary, undo: `node ${shellPath(bin)} undo ${plan.id}` };
  } finally {
    release();
  }
}

/* ------------------------------------------------------------------ verify */

export function verify(ctx, state) {
  const problems = [];
  let corrupt = false;
  let checked = 0;
  for (const scope of ['user', 'project']) {
    if (scope === 'project' && !ctx.project) continue;
    const id = installId(ctx, scope);
    const { m } = loadManifest(state, id);
    if (!m) continue;
    if (m.pending) problems.push(`${id}: an earlier apply stopped midway`);
    const vctx = { ...ctx, claudeDir: m.dirs ? m.dirs.claude : ctx.claudeDir, codexDir: m.dirs ? m.dirs.codex : ctx.codexDir };
    for (const [logical, e] of Object.entries(m.targets || {})) {
      if (!e.active) continue;
      checked++;
      const real = realTarget(targetAbs(logical, vctx));
      const cur = readBytes(real);
      if (cur === null) { problems.push(`${logical}: missing`); continue; }
      const text = cur.toString('utf8');
      if (e.kind === 'owned-file') {
        if (sha256(cur) !== e.after_sha256) problems.push(`${logical}: changed since install`);
      } else if (e.kind === 'block') {
        const { blocks, corrupt: bad } = findBlocks(text);
        if (bad.length) { corrupt = true; problems.push(`${logical}: ${bad.join('; ')}`); continue; }
        if (blocks.length !== 1) { problems.push(`${logical}: expected one modelproof block, found ${blocks.length}`); continue; }
        if (!blockIntact(blocks[0]) || blocks[0].sha !== e.block.sha16) problems.push(`${logical}: block changed since install`);
      } else if (e.kind === 'json-keys') {
        const keys = topLevelKeys(text);
        const obj = parseJsonObject(text);
        for (const seg of e.keys.segments) for (const k of seg.keys) {
          const n = keys.filter((x) => x === k).length;
          if (n !== 1) problems.push(`${logical}: key ${k} appears ${n} times`);
          else if (!obj || JSON.stringify(obj[k]) !== JSON.stringify(seg.values[k])) problems.push(`${logical}: key ${k} changed since install`);
        }
      }
    }
  }
  return { code: corrupt ? EXIT.CORRUPT : problems.length ? EXIT.DRIFT : EXIT.OK, problems, checked };
}

/* ------------------------------------------------------------------ undo */

function sweepEmptyDirs(dirs, ops) {
  for (const d of dirs.slice().sort((a, b) => b.length - a.length)) ops.push({ type: 'rmdir', dir: d });
}
// Folders modelproof may have made, for parts with no record of it (adopted or --from-markers).
function guessDirs(real, base) {
  const out = [];
  let cur = path.dirname(real);
  while (isInside(cur, base) && cur !== base && /^(\.claude|\.codex|\.cursor|agents|rules)$/.test(path.basename(cur))) { out.push(cur); cur = path.dirname(cur); }
  return out;
}

export function undoInstall(state, id) {
  const release = lock(state);
  try {
    const { m } = loadManifest(state, id);
    if (!m) throw new Fail(EXIT.USAGE, `no install record ${id} in ${state}`);
    const ctx = makeContext({ home: m.home, project: m.project, env: {} });
    ctx.claudeDir = m.dirs.claude; ctx.codexDir = m.dirs.codex;
    const round = (m.history || []).length + 1;
    const removedDir = path.join(state, 'installs', id, 'removed', String(round));
    const ops = [];
    const report = [];
    const kept = [];
    const all = Object.entries(m.targets || {});
    const entries = all.filter(([, e]) => e.active);
    const dirs = all.flatMap(([, e]) => e.created_dirs || []);
    // Paths where modelproof's own part did not come out cleanly although nobody touched the file
    // since the last apply: a leftover there is modelproof's failure, not the user's edit.
    const leftover = new Set();
    for (const [logical, e] of entries) {
      const real = realTarget(targetAbs(logical, ctx));
      const cur = readBytes(real);
      const r = decideRemove(e, cur);
      const clean = r.edited || (r.action === 'remove' && r.exact !== false);
      const sameAsApplied = e.after_sha256 !== undefined && (cur === null ? e.after_sha256 === null : sha256(cur) === e.after_sha256);
      if (!clean && sameAsApplied) leftover.add(logical);
      for (const o of r.ops) {
        if (o.type === 'move') ops.push({ type: 'move', real, dest: path.join(removedDir, flatName(logical)), edited: !!r.edited });
        if (o.type === 'copy') ops.push({ type: 'copy', dest: path.join(removedDir, flatName(logical) + '.edited-block'), data: o.text, note: logical });
        if (o.type === 'write') ops.push({ type: 'write', real, data: o.text });
      }
      if (r.edited) kept.push(logical);
      if (e.before && e.before.unknown) dirs.push(...guessDirs(real, m.scope === 'project' ? ctx.realProject : ctx.realHome));
    }
    sweepEmptyDirs(uniq(dirs), ops);
    const done = runOps(ops);
    // Compare every path this install ever touched against its before-state, by hash only. A path
    // that differs is the user's later edit, unless nobody touched it since the install: then
    // modelproof failed to take its own part out, and that is an error, not the user's doing.
    const differs = [];
    const failed = [];
    for (const [logical, e] of all) {
      const real = realTarget(targetAbs(logical, ctx));
      const cur = readBytes(real);
      const b = e.before || {};
      if (b.unknown) { differs.push(`${logical} (no earlier record)`); continue; }
      const same = b.existed ? cur !== null && sha256(cur) === b.sha256 : cur === null;
      if (!same) (leftover.has(logical) ? failed : differs).push(logical);
    }
    for (const d of done) {
      if (d.op.type === 'move' && d.op.edited) report.push(`your edited ${display(d.op.real, ctx)} is kept at ${d.to}`);
      else if (d.op.type === 'move') report.push(`moved ${display(d.op.real, ctx)} to ${d.to}`);
      if (d.op.type === 'copy') report.push(`your edited block from ${d.op.note} is kept at ${d.copied}`);
    }
    const next = JSON.parse(JSON.stringify(m));
    next.history = next.history || [];
    next.history.push({ round, at: new Date().toISOString(), action: 'undo', result: failed.length ? 'could not remove every modelproof part' : differs.length ? 'restored except your later edits' : 'byte-identical', differs, ...(failed.length ? { failed } : {}) });
    next.targets = {};
    writePrivate(manifestPath(state, id), JSON.stringify(next, null, 2) + '\n');
    return { differs, failed, report, kept };
  } finally {
    release();
  }
}

// No install record: take out every marked modelproof part in the known places.
export function undoFromMarkers(ctx, state) {
  const release = lock(state);
  try {
    const cands = [];
    const push = (scope, abs, kind) => { if (statOrNull(abs)) cands.push({ scope, abs, kind }); };
    for (const r of ['scout', 'builder', 'reviewer', 'explore']) push('user', path.join(ctx.claudeDir, 'agents', `modelproof-${r}.md`), 'owned-file');
    push('user', path.join(ctx.claudeDir, 'rules', 'modelproof.md'), 'owned-file');
    for (const r of ['scout', 'builder', 'reviewer']) { push('user', path.join(ctx.codexDir, 'agents', `modelproof-${r}.toml`), 'owned-file'); push('user', path.join(ctx.cursorDir, 'agents', `modelproof-${r}.md`), 'owned-file'); }
    for (const n of ['AGENTS.md', 'AGENTS.override.md']) push('user', path.join(ctx.codexDir, n), 'block');
    if (ctx.project) {
      const P = (...x) => path.join(ctx.project, ...x);
      for (const r of ['scout', 'builder', 'reviewer', 'explore']) push('project', P('.claude', 'agents', `modelproof-${r}.md`), 'owned-file');
      for (const r of ['scout', 'builder', 'reviewer']) { push('project', P('.codex', 'agents', `modelproof-${r}.toml`), 'owned-file'); push('project', P('.cursor', 'agents', `modelproof-${r}.md`), 'owned-file'); }
      push('project', P('.claude', 'rules', 'modelproof.md'), 'owned-file');
      push('project', P('.cursor', 'rules', 'modelproof.mdc'), 'owned-file');
      for (const n of ['AGENTS.md', 'AGENTS.override.md']) push('project', P(n), 'block');
    }
    const scope = ctx.project ? 'project' : 'user';
    const id = installId(ctx, scope);
    const removedDir = path.join(state, 'installs', id, 'removed', 'from-markers');
    const ops = [];
    const dirs = [];
    const found = [];
    for (const c of cands) {
      const real = realTarget(c.abs);
      const cur = readBytes(real);
      if (cur === null) continue;
      const text = cur.toString('utf8');
      if (c.kind === 'owned-file') {
        if (!ownedState(text).tagged) continue;
        ops.push({ type: 'move', real, dest: path.join(removedDir, flatName(display(c.abs, ctx))) });
        found.push(display(c.abs, ctx));
        dirs.push(...guessDirs(real, c.scope === 'project' ? ctx.realProject : ctx.realHome));
      } else {
        const r = decideRemove({ kind: 'block', path: display(c.abs, ctx), block: { guessed: true } }, cur);
        if (r.action !== 'remove') continue;
        for (const o of r.ops) {
          if (o.type === 'copy') ops.push({ type: 'copy', dest: path.join(removedDir, flatName(display(c.abs, ctx)) + '.edited-block'), data: o.text });
          if (o.type === 'write') ops.push({ type: 'write', real, data: o.text });
          if (o.type === 'move') ops.push({ type: 'move', real, dest: path.join(removedDir, flatName(display(c.abs, ctx))) });
        }
        found.push(display(c.abs, ctx));
      }
    }
    sweepEmptyDirs(uniq(dirs), ops);
    runOps(ops);
    return { found };
  } finally {
    release();
  }
}

export function status(state) {
  const dir = path.join(state, 'installs');
  let ids = [];
  try { ids = fs.readdirSync(dir).sort(); } catch { /* none */ }
  const out = [];
  for (const id of ids) {
    const { m } = loadManifest(state, id);
    if (!m) continue;
    const active = Object.values(m.targets || {}).filter((e) => e.active);
    out.push({ id, scope: m.scope, root: m.scope === 'project' ? m.project : m.home, parts: active.length, last_installed: m.last_installed || null, pending: !!m.pending });
  }
  return out;
}

/* ------------------------------------------------------------------ CLI */

function parseArgs(argv) {
  const out = { _: [], skip: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    if (key === 'from-markers' || key === 'json') { out[key] = true; continue; }
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Fail(EXIT.USAGE, `${a} needs a value`);
    i++;
    if (key === 'skip') out.skip.push(...v.split(',').map((x) => x.trim()).filter(Boolean).map(Number));
    else out[key] = v;
  }
  if (out.skip.some((n) => !Number.isInteger(n) || n < 1)) throw new Fail(EXIT.USAGE, '--skip takes item numbers, e.g. --skip 2,4');
  return out;
}
const USAGE = `usage:
  node install.mjs detect --home H [--project P]
  node install.mjs plan   --profile p.json --data D --home H [--project P] [--out plan.json]
  node install.mjs apply  --plan plan.json --expect <planhash> [--skip 2,4]
  node install.mjs verify --home H [--project P]
  node install.mjs undo   <id> | undo --from-markers --home H [--project P]
  node install.mjs status [--home H]`;

export function main(argv, io = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) }) {
  try {
    const args = parseArgs(argv);
    const cmd = args._[0];
    if (cmd === 'detect') {
      const ctx = makeContext({ home: args.home, project: args.project });
      io.out(JSON.stringify(detect(ctx), null, 2) + '\n');
      return EXIT.OK;
    }
    if (cmd === 'plan') {
      if (!args.profile) throw new Fail(EXIT.USAGE, '--profile is required');
      const ctx = makeContext({ home: args.home, project: args.project });
      const state = stateDir({ home: args.home });
      const dataDir = args.data || (statOrNull(path.join(state, 'data')) ? path.join(state, 'data') : null);
      if (!dataDir) throw new Fail(EXIT.USAGE, '--data is required (a folder with models.json and guidance.json)');
      let profile;
      try { profile = JSON.parse(fs.readFileSync(args.profile, 'utf8')); } catch { throw new Fail(EXIT.USAGE, `cannot read profile ${args.profile}`); }
      const plan = makePlan({ profile, facts: packageFacts(dataDir), ctx, state });
      if (args.out) fs.writeFileSync(args.out, JSON.stringify(plan, null, 2) + '\n');
      io.out(renderPlan(plan, args.out || null));
      return plan.items.some((x) => x.action === 'conflict') ? EXIT.CONFLICT : EXIT.OK;
    }
    if (cmd === 'apply') {
      if (!args.plan) throw new Fail(EXIT.USAGE, '--plan is required');
      let plan;
      try { plan = JSON.parse(fs.readFileSync(args.plan, 'utf8')); } catch { throw new Fail(EXIT.USAGE, `cannot read plan ${args.plan}`); }
      const r = applyPlan(plan, { expect: args.expect, skip: args.skip });
      io.out(['Done.', ...r.summary, 'Start a new session so each tool loads the new files.', `Undo: ${r.undo}`].join('\n') + '\n');
      return EXIT.OK;
    }
    if (cmd === 'verify') {
      const ctx = makeContext({ home: args.home, project: args.project });
      const r = verify(ctx, stateDir({ home: args.home }));
      io.out(r.code === EXIT.OK ? `verify: ok (${r.checked} parts checked)\n` : `verify: ${r.problems.length} problem(s)\n${r.problems.map((p) => '  ' + p).join('\n')}\n`);
      return r.code;
    }
    if (cmd === 'undo') {
      const state = stateDir({ home: args.home });
      if (args['from-markers']) {
        const ctx = makeContext({ home: args.home, project: args.project });
        const r = undoFromMarkers(ctx, state);
        io.out(r.found.length ? `Took out ${r.found.length} marked part(s) with no install record:\n${r.found.map((x) => '  ' + x).join('\n')}\nSettings keys cannot be found without a record; check settings.json by hand.\n` : 'No marked modelproof parts found.\n');
        return EXIT.OK;
      }
      const id = args._[1];
      if (!id || !/^[0-9a-f]{12}$/.test(id)) throw new Fail(EXIT.USAGE, 'undo needs an install id (see status), or --from-markers');
      const r = undoInstall(state, id);
      const lines = [...r.report];
      if (r.differs.length) lines.push(`Restored except your later edits: ${r.differs.join(', ')}`);
      else if (!r.failed.length) lines.push('Restored: every file is byte-identical to before the install.');
      if (r.failed.length) {
        io.out(lines.join('\n') + (lines.length ? '\n' : ''));
        io.err(`Undo could not remove modelproof's part from ${r.failed.join(', ')}. Nobody edited ${r.failed.length > 1 ? 'these files' : 'that file'} after the install; take out what is left by hand.\n`);
        return EXIT.DRIFT;
      }
      io.out(lines.join('\n') + '\n');
      return EXIT.OK;
    }
    if (cmd === 'status') {
      const rows = status(stateDir({ home: args.home }));
      io.out(rows.length ? rows.map((r) => `${r.id}  ${r.scope.padEnd(7)} ${r.parts} part(s)  ${r.root}${r.pending ? '  (an apply stopped midway)' : ''}`).join('\n') + '\n' : 'Nothing installed.\n');
      return EXIT.OK;
    }
    io.err(USAGE + '\n');
    return EXIT.USAGE;
  } catch (e) {
    if (e instanceof Fail) { io.err(e.message + '\n'); return e.code; }
    io.err(`internal error: ${e && e.stack ? e.stack : e}\n`);
    return EXIT.USAGE;
  }
}

function isEntry() {
  if (!process.argv[1]) return false;
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(SELF); } catch { return false; }
}
if (isEntry()) process.exitCode = main(process.argv.slice(2));
