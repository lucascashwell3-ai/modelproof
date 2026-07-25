#!/usr/bin/env node
/* ============================================================
   Modelproof MCP server — a neutral, cost-first model advisor
   any MCP host (Claude Desktop, Cursor, …) can call.
   Read-only: fetches the SAME hosted data/models.json the site
   renders, so recommendations match the website and stay current.
   Honesty rule enforced here: it returns only sourced values;
   a missing figure is reported as null/"unknown", never guessed.
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

// ---- scoring — a faithful port of the site's recommender (assets/app.js) ----
const GOAL_METRIC = { coding: 'coding_score', research: 'gpqa', writing: 'lmarena_elo', 'cheap-bulk': 'mmlu_pro' };
const GOAL_TAGS = { coding: ['coding', 'agentic'], research: ['reasoning', 'research'], writing: ['writing'], 'cheap-bulk': ['cheap-bulk'] };
const PROXY_GOALS = new Set(['writing']);
const PRIO = { cheapest: 6, value: 28, balanced: 48, best: 85 };
const num = (v) => v === null || v === undefined || Number.isNaN(v);
const capVal = (m, metric) => (metric === 'coding_score' ? m.coding_score : m.benchmarks?.[metric]);

function normalizer(values, { log = false } = {}) {
  const vals = values.filter((v) => !num(v)).map((v) => (log ? Math.log(v) : v));
  if (!vals.length) return () => 0.5;
  const min = Math.min(...vals), max = Math.max(...vals);
  if (max === min) return () => 0.5;
  return (v) => (num(v) ? 0.5 : ((log ? Math.log(v) : v) - min) / (max - min));
}
function scorer(models, goal) {
  const metric = GOAL_METRIC[goal];
  const primaryNorm = normalizer(models.map((m) => capVal(m, metric)));
  const sweNorm = normalizer(models.map((m) => m.coding_score));
  const gpqaNorm = normalizer(models.map((m) => m.benchmarks?.gpqa));
  const priceNorm = normalizer(models.map((m) => m.price_output), { log: true });
  const allowProxy = PROXY_GOALS.has(goal);
  return (m) => {
    const primary = capVal(m, metric);
    let cap, measured;
    if (!num(primary)) { cap = primaryNorm(primary); measured = true; }
    else if (allowProxy) {
      const parts = [];
      if (!num(m.coding_score)) parts.push(sweNorm(m.coding_score));
      if (!num(m.benchmarks?.gpqa)) parts.push(gpqaNorm(m.benchmarks.gpqa));
      if (parts.length) { cap = (parts.reduce((a, b) => a + b, 0) / parts.length) * 0.9; measured = true; }
      else { cap = 0.3; measured = false; }
    } else { cap = 0.3; measured = false; }
    return { cap, cheap: 1 - priceNorm(m.price_output), measured };
  };
}
function score(models, goal, priority) {
  const f = scorer(models, goal);
  const w = 0.22 + 0.68 * (priority / 100);
  const bulk = goal === 'cheap-bulk';
  const tags = GOAL_TAGS[goal] || [goal];
  return models.map((m) => {
    const hasTag = (m.best_for || []).some((t) => tags.includes(t));
    const { cap, cheap, measured } = f(m);
    let s = bulk ? 0.30 * cap + 0.70 * cheap : w * cap + (1 - w) * cheap;
    if (hasTag) s += 0.03;
    return { m, s, inRec: bulk ? true : measured };
  }).filter((x) => x.inRec).sort((a, b) => b.s - a.s);
}

// infer the task facet from free text when not given explicitly
function inferGoal(text = '') {
  const t = text.toLowerCase();
  if (/(cheap|bulk|classif|tag|extract|high.?volume|batch)/.test(t)) return 'cheap-bulk';
  if (/(research|reason|analy|strateg|plan|math|think)/.test(t)) return 'research';
  if (/(writ|draft|prose|email|copy|content|blog)/.test(t)) return 'writing';
  return 'coding';
}
const brief = (m) => ({
  name: m.name, vendor: m.vendor,
  coding_score: num(m.coding_score) ? null : m.coding_score,
  gpqa: num(m.benchmarks?.gpqa) ? null : m.benchmarks.gpqa,
  price_input_per_1m: num(m.price_input) ? null : m.price_input,
  price_output_per_1m: num(m.price_output) ? null : m.price_output,
  context_window: m.context_window ?? null,
  confidence: m.confidence ?? null,
  best_for: m.best_for || [],
  verdict: m.verdict || null,
  use_well: m.use_well || [],   // practical "get the most out of it" tips (sourced, plain English)
});

// ---- tools ----
const TOOLS = [
  {
    name: 'recommend_model',
    description: 'Recommend the AI model to use for a task and budget attitude, cost-first and neutral. Call when the user is choosing/comparing models or about to spend on an API.',
    inputSchema: {
      type: 'object',
      properties: {
        task_description: { type: 'string', description: 'What the user wants to do (free text).' },
        task: { type: 'string', enum: ['coding', 'research', 'writing', 'cheap-bulk'], description: 'Optional explicit task facet.' },
        cost_attitude: { type: 'string', enum: ['cheapest', 'value', 'balanced', 'best'], description: 'How much they weight price vs quality. Default balanced.' },
        labs: { type: 'array', items: { type: 'string' }, description: 'Optional: vendors/brands the user already pays for (e.g. ["Anthropic","Google"] or ["Claude","Gemini"]).' },
      },
    },
  },
  {
    name: 'my_kit',
    description: 'Make the most of what the user already has: given the labs/AIs they pay for, return their best model per task (coding, research, writing, cheap-bulk) with practical use_well tips, plus a neutral cost-first note when a model outside their labs is meaningfully better or cheaper. Call when the user asks "what should I use from what I have", "am I using X right", or "should I add/upgrade".',
    inputSchema: {
      type: 'object',
      properties: {
        labs: { type: 'array', items: { type: 'string' }, description: 'Vendors/brands the user pays for (e.g. ["Claude","Gemini"] or ["Anthropic","Google"]).' },
        cost_attitude: { type: 'string', enum: ['cheapest', 'value', 'balanced', 'best'], description: 'Default balanced.' },
      },
      required: ['labs'],
    },
  },
  { name: 'compare_models', description: 'Compare specific models side by side (sourced facts only).', inputSchema: { type: 'object', properties: { names: { type: 'array', items: { type: 'string' } } }, required: ['names'] } },
  { name: 'whats_new', description: 'The AI-model releases worth knowing about lately, newest first.', inputSchema: { type: 'object', properties: { limit: { type: 'number' } } } },
  { name: 'list_models', description: 'List all models with key sourced facts.', inputSchema: { type: 'object', properties: {} } },
];

async function handleTool(name, args = {}) {
  const data = await getData();
  const models = data.models || [];
  const asOf = data.as_of || 'unknown';
  const disclaimer = `Data as of ${asOf}. Figures are sourced; null = not publicly sourced (not guessed). Verify cost-critical prices against the vendor's own page. Independent tool, not affiliated with any vendor.`;

  if (name === 'recommend_model') {
    const goal = args.task || inferGoal(args.task_description || '');
    const priority = PRIO[args.cost_attitude] ?? PRIO.balanced;
    const labSet = (args.labs || []).map((s) => s.toLowerCase());
    const inLabs = (m) => !labSet.length || labSet.some((l) => m.vendor.toLowerCase().includes(l) || l.includes(m.vendor.toLowerCase()));
    const field = labSet.length ? models.filter(inLabs) : models;
    const ranked = score(field, goal, priority);
    if (!ranked.length) return { asOf, task: goal, note: 'No sourced model matches that task/labs.', disclaimer };
    const top = ranked[0].m;
    const runnersUp = ranked.slice(1, 3).map((r) => brief(r.m));
    let outsideLabsNote = null;
    if (labSet.length) {
      const globalTop = score(models, goal, priority)[0]?.m;
      if (globalTop && !inLabs(globalTop) && globalTop.id !== top.id) {
        const metric = GOAL_METRIC[goal];
        const cheaper = !num(globalTop.price_output) && !num(top.price_output) && globalTop.price_output <= top.price_output * 0.8;
        const better = !num(capVal(globalTop, metric)) && !num(capVal(top, metric)) && capVal(globalTop, metric) > capVal(top, metric);
        if (cheaper || better) outsideLabsNote = `Outside your labs, ${globalTop.name} may be worth a look — coding ${brief(globalTop).coding_score ?? '?'} at $${globalTop.price_output}/1M out vs your pick's $${top.price_output}. Stated as a fact; your call.`;
      }
    }
    return { asOf, task: goal, cost_attitude: args.cost_attitude || 'balanced', pick: brief(top), runners_up: runnersUp, outside_labs_note: outsideLabsNote, disclaimer };
  }

  if (name === 'my_kit') {
    const labSet = (args.labs || []).map((s) => s.toLowerCase());
    const inLabs = (m) => labSet.some((l) => m.vendor.toLowerCase().includes(l) || l.includes(m.vendor.toLowerCase())
      || m.name.toLowerCase().includes(l));
    const mine = models.filter(inLabs);
    if (!mine.length) return { asOf, note: 'No models matched those labs — check spelling, or call list_models to see vendors.', disclaimer };
    const priority = PRIO[args.cost_attitude] ?? PRIO.balanced;
    const kit = {};
    for (const goal of Object.keys(GOAL_METRIC)) {
      const ranked = score(mine, goal, priority);
      if (!ranked.length) { kit[goal] = null; continue; }
      const top = ranked[0].m;
      // the upgrade check: neutral, cost-first fact when the field beats their kit
      const globalTop = score(models, goal, priority)[0]?.m;
      let outside = null;
      if (globalTop && !inLabs(globalTop) && globalTop.id !== top.id) {
        const metric = GOAL_METRIC[goal];
        const cheaper = !num(globalTop.price_output) && !num(top.price_output) && globalTop.price_output <= top.price_output * 0.8;
        const better = !num(capVal(globalTop, metric)) && !num(capVal(top, metric)) && capVal(globalTop, metric) > capVal(top, metric);
        if (cheaper || better) outside = `Outside these labs: ${globalTop.name} at $${globalTop.price_output}/1M out vs $${top.price_output} — stated as a fact, the user's call.`;
      }
      kit[goal] = { pick: brief(top), outside_labs_note: outside };
    }
    return {
      asOf,
      labs: args.labs,
      kit,
      how_to_answer: 'Lead with the user\'s own kit and the use_well tips (how to use what they have). Mention outside_labs_note only as a neutral, cost-first fact — never as "switch to X". If every outside_labs_note is null, tell the user plainly that they are set with what they have.',
      disclaimer,
    };
  }

  if (name === 'compare_models') {
    const want = (args.names || []).map((s) => s.toLowerCase());
    const picked = models.filter((m) => want.some((w) => m.name.toLowerCase().includes(w)));
    return { asOf, models: picked.map(brief), disclaimer };
  }

  if (name === 'whats_new') {
    const rel = (data.releases || []).slice().sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, args.limit || 10);
    return { asOf, releases: rel.map((r) => ({ date: r.date, title: r.title, summary: r.summary, why: r.why || null, source: r.source || null })), disclaimer };
  }

  if (name === 'list_models') return { asOf, models: models.map(brief), disclaimer };

  throw new Error(`Unknown tool: ${name}`);
}

// ---- MCP wiring ----
const server = new Server({ name: 'modelproof', version: '0.2.0' }, { capabilities: { tools: {} } });
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
