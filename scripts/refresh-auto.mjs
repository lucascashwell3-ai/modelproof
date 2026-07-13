#!/usr/bin/env node
/* Auto-refresh, FLAG-FIRST. The machine only DETECTS and LINKS — it never writes a price or a
   benchmark into data/models.json (a human does, after verifying against the official page).
   It fetches OpenRouter's public models API as a price-DRIFT alarm, checks dated triggers and
   staleness, writes a CHANGES.md checklist for the reviewer, and bumps a machine `auto_checked`
   timestamp (separate from the human-owned `as_of`). Output is reviewed + merged via PR.
   Usage: node scripts/refresh-auto.mjs */
import { readFileSync, writeFileSync } from 'node:fs';

const OR_URL = 'https://openrouter.ai/api/v1/models';
const DRIFT = 0.2;                       // flag a price gap > 20%
const STALE_DAYS = 14;
const today = new Date().toISOString().slice(0, 10);
const dataUrl = new URL('../data/models.json', import.meta.url);
const data = JSON.parse(readFileSync(dataUrl));
const flags = [];

// --- price-drift alarm from OpenRouter (public, unauthenticated). Never overwrites; only flags. ---
let orNote = '';
try {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  const res = await fetch(OR_URL, { signal: ctrl.signal });
  clearTimeout(t);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const or = (await res.json()).data || [];
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const m of data.models) {
    if (m.price_output == null) continue;
    const hit = or.find((o) => norm(o.name || '').includes(norm(m.name)) || norm(m.name).includes(norm(o.name || '')));
    if (!hit || !hit.pricing) continue;
    const orOut = parseFloat(hit.pricing.completion) * 1e6;   // OpenRouter is per-token; we store per-1M
    if (!isFinite(orOut) || orOut <= 0) continue;
    const gap = Math.abs(orOut - m.price_output) / m.price_output;
    if (gap > DRIFT) flags.push(`PRICE — verify **${m.name}**: we list $${m.price_output}/1M out; OpenRouter shows ~$${orOut.toFixed(2)} (provider pass-through ≠ list price — confirm against the vendor's official pricing page before changing).`);
  }
} catch (e) {
  orNote = `OpenRouter unreachable this run (${e.message}) — no price-drift check. Stale-but-honest: nothing changed.`;
}

// --- dated triggers (hard-coded events we already know are coming) ---
const sonnet = data.models.find((m) => /sonnet 5/i.test(m.name));
if (sonnet && today >= '2026-09-01' && sonnet.price_output === 10)
  flags.push(`TRIGGER — Claude Sonnet 5 intro pricing ($2/$10) was due to rise to $3/$15 on 2026-09-01. Verify + update against the official page.`);

// --- staleness of the human-verified snapshot ---
const asOf = data.as_of;
if (asOf) {
  const days = Math.round((Date.parse(today) - Date.parse(asOf)) / 864e5);
  if (days > STALE_DAYS) flags.push(`STALE — data \`as_of\` is ${days} days old (${asOf}). Consider a full refresh pass (scripts/refresh.md) and bump \`as_of\`.`);
}

// --- write the reviewer report + the machine proof-of-life timestamp (NOT as_of) ---
const body = [
  `# Data refresh — ${today}`,
  ``,
  orNote ? `> ${orNote}\n` : '',
  flags.length ? `The automation flagged ${flags.length} item(s) for **human verification**. Nothing below was written to the data — verify each against a primary source, edit \`data/models.json\` by hand, bump \`as_of\`, then merge.\n` : `No changes flagged this run. (This PR only bumps the machine \`auto_checked\` date — proof the refresh ran.)\n`,
  ...flags.map((f, i) => `- [ ] ${f}`),
  ``,
  `---`,
  `_Machine \`auto_checked\`: ${today}. Human \`as_of\`: ${asOf || 'unknown'} — only a person bumps that, at merge._`,
].filter(Boolean).join('\n');
writeFileSync(new URL('../CHANGES.md', import.meta.url), body + '\n');
writeFileSync(new URL('../data/_auto_checked.json', import.meta.url), JSON.stringify({ auto_checked: today }, null, 2) + '\n');

console.log(`refresh-auto: ${flags.length} flag(s). ${orNote || 'OpenRouter checked.'}`);
flags.forEach((f) => console.log('  • ' + f));
