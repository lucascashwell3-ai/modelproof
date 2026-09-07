#!/usr/bin/env node
/* One-off migration (2026-09): bring every existing record under the naming rule in
   scripts/naming.mjs. Kept for the record; safe to re-run (a clean catalog is a no-op).

   What it does, in order:
     1. models[]      vendor -> canonical spelling; name -> the model's own name (no "Vendor: "
                      label); id -> derived from the name. Records the old->new id map.
     2. junk          removes "-deepseek-deepseek-v4-flash-latest": a "~deepseek" community
                      re-host of DeepSeek's "latest" alias pointer, which resolves to the
                      V4 Flash 0731 snapshot already listed. Not a model, not a vendor listing.
                      Its release entry goes with it.
     3. references    effort_ladders[].series[].model_id, data/_auto_refresh_state.json keys,
                      scripts/model-aliases.json keys — renamed via the map. Each renamed or
                      relabelled model also gets aliases (old id, old name, its OpenRouter path)
                      so feed matching keeps finding it.
     4. releases[]    vendor -> canonical spelling where the value resolves.
     5. best_for_line regenerated for every model in a vendor group the migration touched — the
                      "Cheapest/Priciest <vendor> model" claim depends on who else is in the group.
     6. changelog     one "naming" entry per changed model, one "removed" entry for the junk record.

   Usage: node scripts/migrate-naming-2026-09.mjs [--dry-run] */
import { readFileSync, writeFileSync } from 'node:fs';
import { canonicalVendor, bareModelName, modelId } from './naming.mjs';
import { bestForLine } from './auto-refresh.mjs';

const ROOT = new URL('../', import.meta.url);
const dataUrl = new URL('data/models.json', ROOT);
const stateUrl = new URL('data/_auto_refresh_state.json', ROOT);
const aliasUrl = new URL('scripts/model-aliases.json', ROOT);
const changelogUrl = new URL('data/changelog.json', ROOT);
const dryRun = process.argv.includes('--dry-run');
const today = new Date().toISOString().slice(0, 10);

const JUNK_ID = '-deepseek-deepseek-v4-flash-latest';
const JUNK_WHY = 'community re-host (~deepseek) of the "latest" alias pointer — duplicates DeepSeek V4 Flash 0731; not a vendor listing';

const data = JSON.parse(readFileSync(dataUrl));
const state = JSON.parse(readFileSync(stateUrl));
const aliases = JSON.parse(readFileSync(aliasUrl));
const changelog = JSON.parse(readFileSync(changelogUrl));

const rename = new Map();           // old id -> new id
const touchedVendors = new Set();
const changed = [];                 // { oldId, id, oldVendor, vendor, oldName, name }
const changelogAdds = [];
const orPath = (m) => {
  const u = (m.sources || []).find((s) => /^https?:\/\/openrouter\.ai\//.test(s));
  return u ? u.replace(/^https?:\/\/openrouter\.ai\//, '').replace(/\/$/, '') : null;
};
const addAliases = (id, extra) => {
  const cur = new Set(aliases[id] || []);
  for (const a of extra) if (a && a !== id) cur.add(a);
  aliases[id] = [...cur];
};

// 1 + 2. models
const removed = [];
data.models = data.models.filter((m) => {
  if (m.id !== JUNK_ID) return true;
  removed.push(m);
  return false;
});
for (const m of data.models) {
  const vendor = canonicalVendor(m.vendor);
  if (!vendor) throw new Error(`${m.id}: vendor "${m.vendor}" is not in scripts/naming.mjs VENDORS — add it there first`);
  const name = bareModelName(m.name, vendor);
  const id = modelId(name);
  if (id === m.id && vendor === m.vendor && name === m.name) continue;
  changed.push({ oldId: m.id, id, oldVendor: m.vendor, vendor, oldName: m.name, name });
  touchedVendors.add(vendor); touchedVendors.add(m.vendor);
  const extra = [m.id, m.name, orPath(m)];
  if (id !== m.id) {
    rename.set(m.id, id);
    if (aliases[m.id]) { addAliases(id, aliases[m.id]); delete aliases[m.id]; }
  }
  addAliases(id, extra);
  m.id = id; m.vendor = vendor; m.name = name;
}
const dupes = data.models.map((m) => m.id).filter((x, i, a) => a.indexOf(x) !== i);
if (dupes.length) throw new Error(`rename produced duplicate ids: ${dupes.join(', ')}`);

// 3. references
let ladderRefs = 0;
for (const L of data.effort_ladders || []) for (const s of L.series || []) {
  if (rename.has(s.model_id)) { s.model_id = rename.get(s.model_id); ladderRefs++; }
}
let stateRefs = 0;
for (const [old, next] of rename) if (old in state) { state[next] = state[old]; delete state[old]; stateRefs++; }
if (JUNK_ID in state) { delete state[JUNK_ID]; stateRefs++; }
if (rename.has(state.guidanceCursor)) state.guidanceCursor = rename.get(state.guidanceCursor);

// 4. releases
let releaseVendors = 0, releasesRemoved = 0;
for (const m of removed) {
  const before = data.releases.length;
  data.releases = data.releases.filter((r) => !(String(r.vendor).startsWith('~') && new RegExp(m.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(r.title)));
  releasesRemoved += before - data.releases.length;
}
for (const r of data.releases || []) {
  const fix = canonicalVendor(r.vendor);
  if (r.vendor && fix && fix !== r.vendor) { r.vendor = fix; releaseVendors++; }
}

// 5. best_for_line for touched vendor groups
let lines = 0;
for (const m of data.models) {
  if (!touchedVendors.has(m.vendor) || !m.best_for_line) continue;
  const next = bestForLine(m, data.models);
  if (next !== m.best_for_line) { m.best_for_line = next; lines++; }
}

// 6. changelog
for (const c of changed) changelogAdds.push({
  date: today, model: c.name, field: 'naming',
  old: `${c.oldId} · ${c.oldVendor} · ${c.oldName}`, new: `${c.id} · ${c.vendor} · ${c.name}`,
  sources: [], note: 'scripts/naming.mjs — one naming rule for ids and vendors',
});
for (const m of removed) changelogAdds.push({ date: today, model: m.name, field: 'removed', old: m.id, new: null, sources: m.sources || [], note: JUNK_WHY });

// report
console.log(`models changed: ${changed.length} (ids renamed: ${rename.size}, vendors fixed: ${changed.filter((c) => c.oldVendor !== c.vendor).length}, names cleaned: ${changed.filter((c) => c.oldName !== c.name).length})`);
console.log(`removed: ${removed.map((m) => m.id).join(', ') || 'none'}${removed.length ? ' — ' + JUNK_WHY : ''}`);
console.log(`references: ladder series ${ladderRefs}, state keys ${stateRefs}, release vendors ${releaseVendors}, releases removed ${releasesRemoved}, best_for_line regenerated ${lines}`);
for (const c of changed) console.log(`  ${c.oldId.padEnd(38)} -> ${c.id.padEnd(30)} ${c.oldVendor.padEnd(24)} -> ${c.vendor}`);
if (dryRun) { console.log('dry run — nothing written'); process.exit(0); }
if (!changed.length && !removed.length && !releaseVendors) { console.log('already clean — nothing written'); process.exit(0); }

writeFileSync(dataUrl, JSON.stringify(data, null, 2) + '\n');
writeFileSync(stateUrl, JSON.stringify(state, null, 2) + '\n');
writeFileSync(changelogUrl, JSON.stringify([...changelog, ...changelogAdds], null, 2) + '\n');
// aliases: one line per model, as the file has always been written
const aliasLines = Object.entries(aliases).map(([k, v]) => `  ${JSON.stringify(k)}: ${Array.isArray(v) ? '[' + v.map((x) => JSON.stringify(x)).join(', ') + ']' : JSON.stringify(v)}`);
writeFileSync(aliasUrl, '{\n' + aliasLines.join(',\n') + '\n}\n');
console.log('written: data/models.json, data/_auto_refresh_state.json, data/changelog.json, scripts/model-aliases.json');
