#!/usr/bin/env node
/**
 * Cross-project design history log. Tracks what recent projects chose
 * (font, accent, aesthetic lane) so a new project can deliberately
 * differentiate from Lucas's OWN last few shipped sites — impeccable's
 * brand.md already fights internet-wide AI-slop convergence; this fights
 * convergence against his own back catalog, which brand.md has no way
 * to see.
 *
 * Usage:
 *   node design-history.mjs read [--limit N]
 *   node design-history.mjs append --project <name> --font <font> --accent <desc> --lane <lane>
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CANONICAL_PATH = path.join(os.homedir(), 'Projects', 'design-history.md');
const VENDORED_FALLBACK = path.join(process.cwd(), '.claude', 'design-history.md');
const HEADER = '# Design history\n\n| Date | Project | Font | Accent | Aesthetic lane |\n|---|---|---|---|---|\n';

function resolveReadPath() {
  if (fs.existsSync(CANONICAL_PATH)) return CANONICAL_PATH;
  if (fs.existsSync(VENDORED_FALLBACK)) return VENDORED_FALLBACK;
  return null;
}

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith('--')) {
      opts[rest[i].slice(2)] = rest[i + 1];
      i++;
    }
  }
  return { cmd, opts };
}

function readHistory(limit) {
  const filePath = resolveReadPath();
  if (!filePath) {
    console.log('No design history found (checked ~/Projects/design-history.md and a vendored .claude/design-history.md). Continue without it.');
    return;
  }
  const rows = fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('|') && !line.startsWith('| Date') && !line.startsWith('|---'));
  const recent = rows.slice(-limit);
  if (recent.length === 0) {
    console.log(`Design history file exists at ${filePath} but has no entries yet.`);
    return;
  }
  console.log(`Last ${recent.length} project(s) from ${filePath}:`);
  console.log(recent.join('\n'));
}

function appendHistory(opts) {
  const { project, font, accent, lane } = opts;
  if (!project || !font || !accent || !lane) {
    console.error('append requires --project --font --accent --lane');
    process.exit(1);
  }
  if (!fs.existsSync(CANONICAL_PATH)) {
    fs.mkdirSync(path.dirname(CANONICAL_PATH), { recursive: true });
    fs.writeFileSync(CANONICAL_PATH, HEADER);
  }
  const date = new Date().toISOString().slice(0, 10);
  const row = `| ${date} | ${project} | ${font} | ${accent} | ${lane} |\n`;
  fs.appendFileSync(CANONICAL_PATH, row);
  console.log(`Recorded: ${row.trim()}`);
}

const { cmd, opts } = parseArgs(process.argv.slice(2));
if (cmd === 'read') {
  readHistory(opts.limit ? Number(opts.limit) : 5);
} else if (cmd === 'append') {
  appendHistory(opts);
} else {
  console.error('Usage: design-history.mjs read [--limit N] | append --project <name> --font <font> --accent <desc> --lane <lane>');
  process.exit(1);
}
