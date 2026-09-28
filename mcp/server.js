#!/usr/bin/env node
/* ============================================================
   Modelproof MCP server — sourced AI-model facts any MCP host
   (Claude Desktop, Cursor, …) can call.
   Read-only: fetches the SAME hosted data/models.json the site
   renders, so answers match the website and stay current.
   Facts only: prices, context, release notes and what each lab
   says about its own models (quote + link + date). It never
   ranks models or names one for a job — that stays the user's call.
   A missing figure is reported as null. coding_score is SWE-bench
   Verified where published, otherwise an estimate, and says so.
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

import { brief, disclaimer as disclaimerFor } from './facts.js';

// ---- tools ----
const TOOLS = [
  { name: 'compare_models', description: 'Compare specific models side by side: prices, context, scores, and what the labs and reporters say about each (quote + link + date). Sourced facts only.', inputSchema: { type: 'object', properties: { names: { type: 'array', items: { type: 'string' } } }, required: ['names'] } },
  { name: 'whats_new', description: 'Recent AI-model releases, newest first, each with its source.', inputSchema: { type: 'object', properties: { limit: { type: 'number' } } } },
  { name: 'list_models', description: 'List all models with key sourced facts.', inputSchema: { type: 'object', properties: {} } },
];

async function handleTool(name, args = {}) {
  const data = await getData();
  const models = data.models || [];
  const asOf = data.as_of || 'unknown';
  const disclaimer = disclaimerFor(asOf);

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
