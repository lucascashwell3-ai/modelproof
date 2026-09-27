#!/usr/bin/env node
/* ============================================================
   Modelproof MCP server — sourced AI-model facts any MCP host
   (Claude Desktop, Cursor, …) can call.
   Read-only: fetches the SAME hosted data/models.json the site
   renders, so answers match the website and stay current.
   Facts only: prices, context, release notes and what each lab
   says about its own models (quote + link + date). It never
   ranks models or names one for a job — that stays the user's call.
   A missing figure is reported as null, never guessed.
   ============================================================ */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const DATA_URL = process.env.Modelproof_DATA_URL
  || 'https://lucascashwell3-ai.github.io/modelproof/data/models.json';

// ---- data (fetch the live file the site renders; cache ~1h) ----
let cache = { at: 0, data: null };
async function getData() {
  const now = Date.now();
  if (cache.data && now - cache.at < 3600_000) return cache.data;
  const res = await fetch(DATA_URL, { headers: { 'cache-control': 'no-cache' } });
  if (!res.ok) throw new Error(`Could not fetch model data (${res.status})`);
  cache = { at: now, data: await res.json() };
  return cache.data;
}

const num = (v) => v === null || v === undefined || Number.isNaN(v);

// What the labs and reporters say about a model, as quotes with their source — grouped so a
// quote cited for several kinds of work appears once. Empty when nothing is sourced.
function sourcedClaims(m) {
  const byQuote = new Map();
  for (const [task, entry] of Object.entries(m.task_fit_judged || {})) {
    for (const c of entry?.claims || []) {
      if (!c?.quote || !c?.source_url) continue;
      const key = c.quote + '\u0000' + c.source_url;
      if (!byQuote.has(key)) byQuote.set(key, { quote: c.quote, source_url: c.source_url, date: c.date || null, from: c.tier === 'lab' ? 'the lab' : 'a reporter or tester', kinds_of_work: [] });
      byQuote.get(key).kinds_of_work.push(task);
    }
  }
  return [...byQuote.values()];
}

const brief = (m) => ({
  name: m.name, vendor: m.vendor,
  status: m.status || null,
  released: m.released || null,
  coding_score: num(m.coding_score) ? null : m.coding_score,
  gpqa: num(m.benchmarks?.gpqa) ? null : m.benchmarks.gpqa,
  price_input_per_1m: num(m.price_input) ? null : m.price_input,
  price_output_per_1m: num(m.price_output) ? null : m.price_output,
  context_window: m.context_window ?? null,
  use_well: m.use_well || [],   // practical "get the most out of it" tips (sourced, plain English)
  sourced_claims: sourcedClaims(m),
});

// ---- tools ----
const TOOLS = [
  { name: 'compare_models', description: 'Compare specific models side by side: prices, context, scores, and what the labs and reporters say about each (quote + link + date). Sourced facts only.', inputSchema: { type: 'object', properties: { names: { type: 'array', items: { type: 'string' } } }, required: ['names'] } },
  { name: 'whats_new', description: 'The AI-model releases worth knowing about lately, newest first.', inputSchema: { type: 'object', properties: { limit: { type: 'number' } } } },
  { name: 'list_models', description: 'List all models with key sourced facts.', inputSchema: { type: 'object', properties: {} } },
];

async function handleTool(name, args = {}) {
  const data = await getData();
  const models = data.models || [];
  const asOf = data.as_of || 'unknown';
  const disclaimer = `Data as of ${asOf}. Figures are sourced; null = not publicly sourced (not guessed). Verify cost-critical prices against the vendor's own page. Independent tool, not affiliated with any vendor.`;

  if (name === 'compare_models') {
    const want = (args.names || []).map((s) => s.toLowerCase());
    const matched = models.filter((m) => want.some((w) => m.name.toLowerCase().includes(w)));
    return { asOf, models: matched.map(brief), disclaimer };
  }

  if (name === 'whats_new') {
    const rel = (data.releases || []).slice().sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, args.limit || 10);
    return { asOf, releases: rel.map((r) => ({ date: r.date, title: r.title, summary: r.summary, why: r.why || null, source: r.source || null })), disclaimer };
  }

  if (name === 'list_models') {
    // The full list stays light: quotes live in compare_models.
    const rows = models.map((m) => { const { sourced_claims, ...rest } = brief(m); return { ...rest, sourced_claims: sourced_claims.length }; });
    return { asOf, models: rows, note: 'sourced_claims is a count here; compare_models returns the quotes with links and dates.', disclaimer };
  }

  throw new Error(`Unknown tool: ${name}`);
}

// ---- MCP wiring ----
const server = new Server({ name: 'modelproof', version: '0.3.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  try {
    const out = await handleTool(req.params.name, req.params.arguments || {});
    return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
