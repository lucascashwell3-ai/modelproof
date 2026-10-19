// Three taps -> a real Modelproof package, from the shipped generator (instructions.mjs). Data in,
// data out; no UI. The Build page uses it, so whatever the board shows is exactly what the
// installer would write.
import { buildPackage, renderPreview, packageText, GENERATOR_VERSION } from './instructions.mjs';

export { GENERATOR_VERSION };

// Tap 1 (tool) and tap 2 (plan). Plan names are the rows in data/plans.json for that vendor.
export const TOOLS = [
  { id: 'claude-code', label: 'Claude Code', maker: 'Anthropic', vendor: 'Anthropic', plans: ['Pro', 'Max 5x', 'Max 20x', 'Team (Premium seat)'] },
  { id: 'codex', label: 'Codex', maker: 'OpenAI', vendor: 'OpenAI', plans: ['Plus', 'Pro 100', 'Pro 200', 'Business'] },
  { id: 'cursor', label: 'Cursor', maker: 'Anysphere', vendor: 'Cursor', plans: ['Pro', 'Pro+', 'Ultra', 'Teams (Standard)'] },
  { id: 'copilot', label: 'GitHub Copilot', maker: 'GitHub', vendor: 'GitHub Copilot', plans: ['Pro', 'Pro+', 'Max', 'Business'] },
  { id: 'antigravity', label: 'Antigravity', maker: 'Google', vendor: 'Google', plans: ['Google AI Pro', 'Google AI Ultra (5x)', 'Google AI Ultra (20x)'] },
  // Any agent that can run several models (OpenRouter, Ollama on your computer, or both). Tap 2 becomes where they run.
  // The generator has no tool of its own for this; it reads as OpenRouter (copy-only text).
  { id: 'any', label: 'Any model', maker: null, vendor: null, gen: 'openrouter', plans: ['openrouter', 'ollama', 'both'] },
];

// Tap 3 (how you work). Maps to the generator's own inputs; it never picks a model.
export const WORK = [
  { id: 'short', label: 'Quick tasks and questions', hint: 'One model does the job; helpers only for long reading and bulk edits.', big_job: false, limits: 'rarely', work: ['coding', 'chat'] },
  { id: 'long', label: 'One long job at a time', hint: 'Your main model plans and reviews; helpers do the pieces; a checker re-checks each one.', big_job: true, limits: 'sometimes', work: ['coding', 'agents'] },
  { id: 'parallel', label: 'Several jobs at once', hint: 'Same split, plus lines on what to do near a full usage limit.', big_job: true, limits: 'often', work: ['coding', 'agents'] },
];

// The jobs in the picture, in the order the generator names them.
export const ROLE_INFO = {
  lead: { name: 'Lead', job: 'Your main model. Plans the work and talks to you.' },
  scout: { name: 'Scout', job: 'Reads and searches, sums up for the lead. Never edits.' },
  builder: { name: 'Builder', job: 'Makes one planned change and runs its check.' },
  reviewer: { name: 'Reviewer', job: 'Reviews the change cold, from the diff.' },
  checker: { name: 'Checker', job: 'Re-checks finished work with real evidence. Never edits.' },
  bulk: { name: 'Bulk', job: 'Mechanical work a script or test can check.' },
};
export const ROLE_ORDER = ['lead', 'scout', 'builder', 'reviewer', 'checker', 'bulk'];

// The data files and the install prompt, found from this module's own URL, so any page can load them.
const DATA_URL = new URL('../data/', import.meta.url);
const PROMPT_URL = new URL('install-prompt.txt', import.meta.url);
export async function loadFacts({ changelog: withLog = true } = {}) {
  const get = async (url, kind) => { const r = await fetch(url); if (!r.ok) throw new Error(`${String(url).split('/').pop()}: HTTP ${r.status}`); return kind === 'text' ? r.text() : r.json(); };
  const [models, guidance, plans, changelog, installPrompt] = await Promise.all([
    get(new URL('models.json', DATA_URL)), get(new URL('guidance.json', DATA_URL)), get(new URL('plans.json', DATA_URL)),
    withLog ? get(new URL('changelog.json', DATA_URL)) : null, get(PROMPT_URL, 'text'),
  ]);
  return { models, guidance, plans, changelog, installPrompt };
}

export function profileFromTaps({ tool, plan, work }, extra = {}) {
  const t = TOOLS.find((x) => x.id === tool) || TOOLS[0];
  const w = WORK.find((x) => x.id === work) || WORK[0];
  return {
    schema: 'modelproof.profile/1', who: 'person', tools: [t.gen || t.id], scope: 'user',
    plans: t.vendor ? [{ vendor: t.vendor, plan: plan || t.plans[0] }] : [],
    limits: w.limits, work: w.work, like: [], never: [],
    roles: extra.roles || {}, big_job: extra.big_job ?? w.big_job,
    ...(extra.example ? { example: extra.example } : {}),
  };
}

// Where a model choice came from, in plain words (the picture labels every box with this).
export function sourceLabel(x, toolLabel, key) {
  if (!x) return '';
  if (key === 'lead' && x.from === 'inherit') return `You pick it in ${toolLabel}`;
  if (x.from === 'you') return x.example ? 'From the example setup' : 'Your choice';
  if (x.from === 'tool') return `${toolLabel}'s own docs`;
  if (x.from === 'lab') return "The model maker's own docs";
  if (x.from === 'inherit') return "Runs on the lead's model";
  return '';
}

export function setupFromTaps(taps, facts, extra = {}) {
  const profile = profileFromTaps(taps, extra);
  const pkg = buildPackage(profile, { models: facts.models, guidance: facts.guidance, plans: facts.plans });
  const tool = profile.tools[0];
  const toolLabel = (TOOLS.find((x) => x.id === tool) || {}).label || tool;
  const r = pkg.roles[tool] || {};
  const roles = ROLE_ORDER.filter((k) => r[k]).map((k) => {
    const x = r[k];
    const m = x.model_id ? facts.models.models.find((mm) => mm.id === x.model_id) : null;
    return {
      key: k, ...ROLE_INFO[k], from: x.from, model_id: x.model_id || null,
      model_name: x.model_name || null,
      model_ref: x.model_ref || null,
      source: sourceLabel(x, toolLabel, k),
      quote: (x.basis && x.basis[0]) ? { text: x.basis[0].quote, url: x.basis[0].source_url, date: x.basis[0].date } : null,
      price: m && m.price_input != null ? { input: m.price_input, output: m.price_output } : null,
      effort: x.effort_info ? { level: x.effort_info.effort, raise_to: x.effort_info.raise_to, when: x.effort_info.when } : null,
    };
  });
  const files = pkg.parts.map((p) => ({ id: p.id, path: p.target && p.target.path, kind: p.kind, lines: (p.content || '').split('\n').length, content: p.content, why: p.why }));
  return {
    profile, pkg, tool, toolLabel, roles,
    big_job: !!pkg.big_job,
    near_limit: r.near_limit ? { text: r.near_limit.when, model_name: r.near_limit.model_name || null } : null,
    files, preview: renderPreview(pkg), text: packageText(pkg), asOf: facts.guidance.as_of,
  };
}

// Models someone could put in a box on the board: live models the tool runs.
export function modelsForTool(facts, tool) {
  const lab = { 'claude-code': 'anthropic', codex: 'openai', antigravity: 'google' }[tool];
  const dead = ['deprecated', 'retired', 'shutdown', 'removed'];
  return facts.models.models
    .filter((m) => !dead.includes(String(m.status || '').toLowerCase()))
    .filter((m) => !lab || String(m.vendor || '').toLowerCase().includes(lab === 'openai' ? 'openai' : lab))
    .map((m) => ({ id: m.id, name: m.name, vendor: m.vendor, price_input: m.price_input, price_output: m.price_output, released: m.released }));
}
