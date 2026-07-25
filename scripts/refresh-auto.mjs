#!/usr/bin/env node
/* Auto-refresh, FLAG-FIRST. The machine only DETECTS and LINKS — it never writes a price or a
   benchmark into data/models.json (a human does, after verifying against a primary source).

   Three passes, per scripts/data-sources.md:
     1. Launch detector   — new model IDs on OpenRouter that we don't list yet (day-0 signal).
     2. Price-drift alarm — OpenRouter pass-through prices vs our list prices.
     3. Backfill watcher  — blank benchmark cells that a Tier-A source has since published,
                            and drift between the shipped ladder and upstream.

   Writes a reviewer report to docs/auto-refresh-report.md and a machine `auto_checked` timestamp
   (deliberately separate from the human-owned `as_of`, so the site never overclaims freshness).
   Output is reviewed + merged via PR.

   Usage:  node scripts/refresh-auto.mjs
   Behind a proxy:  NODE_USE_ENV_PROXY=1 node scripts/refresh-auto.mjs
*/
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const OR_URL = 'https://openrouter.ai/api/v1/models';
const DRIFT = 0.2;                       // flag a price gap > 20%
const STALE_DAYS = 14;
const today = new Date().toISOString().slice(0, 10);
const dataUrl = new URL('../data/models.json', import.meta.url);
const data = JSON.parse(readFileSync(dataUrl));
const flags = [];
const notes = [];

// --- OpenRouter: one fetch, two jobs (launch detection + price drift) --------------------------
let or = null;
try {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  const res = await fetch(OR_URL, { signal: ctrl.signal });
  clearTimeout(t);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  or = (await res.json()).data || [];
} catch (e) {
  notes.push(`OpenRouter unreachable this run (${e.message}) — no launch check and no price-drift check. Stale but honest: nothing changed.`);
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

if (or) {
  // 1. LAUNCH DETECTOR. New IDs show up here at or near launch, which is the earliest cheap signal
  //    that a model exists. We only shortlist the vendors the site actually ranks — OpenRouter
  //    carries hundreds of community fine-tunes that are not in scope.
  const VENDORS = /^(anthropic|openai|google|x-ai|deepseek|qwen|moonshot|meta-llama|mistralai|z-ai)\//;
  const known = data.models.map((m) => norm(m.name));
  const seen = new Set();
  const fresh = [];
  for (const o of or) {
    if (!VENDORS.test(o.id || '')) continue;
    if (/free|preview-\d|:online|extended/.test(o.id)) continue;      // variants, not new models
    const n = norm(o.name);
    if (!n || seen.has(n)) continue;
    if (known.some((k) => k === n || k.includes(n) || n.includes(k))) continue;
    // Only surface genuinely recent arrivals — OpenRouter lists plenty of old models we chose not
    // to rank, and re-flagging those every week would train the reviewer to ignore the report.
    const created = o.created ? new Date(o.created * 1000).toISOString().slice(0, 10) : null;
    if (created && (Date.parse(today) - Date.parse(created)) / 864e5 > 45) continue;
    seen.add(n);
    fresh.push({ id: o.id, name: o.name, created, ctx: o.context_length ?? null });
  }
  for (const f of fresh) {
    // Proposal, not insertion. OpenRouter's name/date fields are provider pass-through and are
    // frequently wrong or placeholder at launch; writing them straight into models.json would put
    // unverified strings on the page, which is the one thing this project doesn't do. The stub
    // below is paste-ready once a human has checked the vendor's own page.
    flags.push(`NEW MODEL — \`${f.id}\`${f.created ? ` (first seen ${f.created})` : ''} is on OpenRouter and not in our data. Verify on the vendor's own page, then paste a stub with **every benchmark null** and \`confidence: "low"\` so the site shows it as *present, figures pending* rather than absent or guessed.`);
  }

  // 2. PRICE DRIFT. Never overwrites; only flags.
  for (const m of data.models) {
    if (m.price_output == null) continue;
    const hit = or.find((o) => norm(o.name).includes(norm(m.name)) || norm(m.name).includes(norm(o.name)));
    if (!hit || !hit.pricing) continue;
    const orOut = parseFloat(hit.pricing.completion) * 1e6;   // OpenRouter is per-token; we store per-1M
    if (!isFinite(orOut) || orOut <= 0) continue;
    const gap = Math.abs(orOut - m.price_output) / m.price_output;
    if (gap > DRIFT) flags.push(`PRICE — verify **${m.name}**: we list $${m.price_output}/1M out; OpenRouter shows ~$${orOut.toFixed(2)} (provider pass-through ≠ list price — confirm against the vendor's official pricing page before changing).`);
  }
}

// --- 3. BACKFILL WATCHER — delegate to the Tier-A collector and read its JSON -------------------
// Kept as a subprocess rather than an import so the collector stays independently runnable and
// this script keeps working (degraded, and saying so) when the source is unreachable.
try {
  const out = execFileSync('node', [new URL('./collect-epoch.mjs', import.meta.url).pathname, '--json'],
    { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'ignore'] });
  const epoch = JSON.parse(out);
  for (const b of epoch.backfill || [])
    flags.push(`BACKFILL — **${b.model}** \`${b.field}\` is blank in our data; Epoch AI (CC-BY, independently run) now publishes **${b.value}%**${b.stderr != null ? ` ±${b.stderr}` : ''}. Source: ${b.source}. Verify, then fill the cell **with the source URL in \`sources[]\`**.`);
  for (const d of epoch.drift || [])
    flags.push(`LADDER — ${d} (source: ${epoch.attribution})`);
  if (!(epoch.backfill || []).length && !(epoch.drift || []).length)
    notes.push('Epoch AI checked: no new blanks filled upstream and the shipped ladder matches.');
} catch (e) {
  notes.push(`Epoch AI collector did not complete (${e.message.split('\n')[0]}) — no backfill check this run.`);
}

// --- dated triggers (hard-coded events we already know are coming) -----------------------------
const sonnet = data.models.find((m) => /sonnet 5/i.test(m.name));
if (sonnet && today >= '2026-09-01' && sonnet.price_output === 10)
  flags.push(`TRIGGER — Claude Sonnet 5 intro pricing ($2/$10) was due to rise to $3/$15 on 2026-09-01. Verify + update against the official page.`);

// --- staleness of the human-verified snapshot --------------------------------------------------
const asOf = data.as_of;
if (asOf) {
  const days = Math.round((Date.parse(today) - Date.parse(asOf)) / 864e5);
  if (days > STALE_DAYS) flags.push(`STALE — data \`as_of\` is ${days} days old (${asOf}). Consider a full refresh pass (scripts/refresh.md) and bump \`as_of\`.`);
}

// --- write the reviewer report + the machine proof-of-life timestamp (NOT as_of) ----------------
// Deliberately NOT CHANGES.md: that file is the human decision log and this script would overwrite
// it wholesale every run, destroying the project's history one week at a time.
const body = [
  `# Data refresh — ${today}`,
  ``,
  ...notes.map((n) => `> ${n}\n`),
  flags.length
    ? `The automation flagged ${flags.length} item(s) for **human verification**. Nothing below was written to the data — verify each against a primary source, edit \`data/models.json\` by hand, bump \`as_of\`, then merge.\n`
    : `No changes flagged this run. (This PR only bumps the machine \`auto_checked\` date — proof the refresh ran.)\n`,
  ...flags.map((f) => `- [ ] ${f}`),
  ``,
  `---`,
  `_Machine \`auto_checked\`: ${today}. Human \`as_of\`: ${asOf || 'unknown'} — only a person bumps that, at merge._`,
  `_The machine may propose a model's existence, release entries and official list prices. It may never write a benchmark, a ladder point, a coding score or a confidence upgrade — see \`scripts/data-sources.md\`._`,
].filter(Boolean).join('\n');

mkdirSync(new URL('../docs/', import.meta.url), { recursive: true });
writeFileSync(new URL('../docs/auto-refresh-report.md', import.meta.url), body + '\n');
writeFileSync(new URL('../data/_auto_checked.json', import.meta.url), JSON.stringify({ auto_checked: today }, null, 2) + '\n');

console.log(`refresh-auto: ${flags.length} flag(s).`);
notes.forEach((n) => console.log('  … ' + n));
flags.forEach((f) => console.log('  • ' + f.replace(/\*\*/g, '')));
