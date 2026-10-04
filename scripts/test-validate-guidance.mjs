// data/guidance.json gate: scripts/validate-data.mjs's validateGuidance() + claimProblems().
// No network. The live file is checked against the live catalog once (it must pass); every other
// case uses a small in-test fixture so a data change never breaks a rule test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  validateGuidance, claimProblems, GUIDANCE_TIERS, GUIDANCE_TOPICS, GUIDANCE_TOOLS, CLAIM_TIERS,
  TOOL_PLAN_TOOLS, TOOL_PLAN_CHOICE_ONLY,
} from './validate-data.mjs';

const MODELS = {
  models: [
    { id: 'claude-haiku-4-5', vendor: 'Anthropic' },
    { id: 'claude-sonnet-5', vendor: 'Anthropic' },
    { id: 'gpt-6-luna', vendor: 'OpenAI' },
  ],
};

const claim = (id, over = {}) => ({
  id,
  subject: { kind: 'tool', name: 'Claude Code' },
  topic: 'lead-helper',
  sentence: 'Claude Code cost docs say to set model: haiku for simple subagent tasks.',
  source_url: 'https://code.claude.com/docs/en/costs',
  tier: 'tool',
  date: '2026-09-27',
  quote: 'For simple subagent tasks, specify model: haiku in your subagent configuration',
  ...over,
});

function good() {
  return {
    _readme: 'Sourced facts from coding tools and model labs.',
    as_of: '2026-09-27',
    claims: [
      claim('cc-haiku'),
      claim('cc-alias-haiku', { topic: 'model-per-job' }),
      claim('openai-effort', { subject: { kind: 'lab', name: 'OpenAI' }, tier: 'lab', topic: 'effort', source_url: 'https://developers.openai.com/api/docs/guides/reasoning' }),
    ],
    role_defaults: [
      { tool: 'claude-code', role: 'scout', lab: 'Anthropic', model_ref: 'haiku', model_id: 'claude-haiku-4-5', basis: ['cc-haiku'] },
    ],
    model_refs: [
      { tool: 'claude-code', ref: 'haiku', model_id: 'claude-haiku-4-5', basis: ['cc-alias-haiku'] },
    ],
    effort_pages: [
      { lab: 'OpenAI', url: 'https://developers.openai.com/api/docs/models', basis: ['openai-effort'] },
    ],
  };
}
const errorsOf = (g, models = MODELS) => validateGuidance(g, models).errors;
const expectError = (g, re) => {
  const errs = errorsOf(g);
  assert.ok(errs.some((e) => re.test(e)), `expected an error matching ${re}, got:\n${errs.join('\n')}`);
};

test('the live data/guidance.json passes against the live catalog', () => {
  const g = JSON.parse(readFileSync(new URL('../data/guidance.json', import.meta.url)));
  const models = JSON.parse(readFileSync(new URL('../data/models.json', import.meta.url)));
  assert.deepEqual(validateGuidance(g, models).errors, []);
  assert.ok(g.claims.length >= 100, 'keeps the verified research set');
  // Lab balance: every lab with claims has at least 3, and no lab has more than 3x the smallest.
  const perLab = {};
  for (const c of g.claims) if (c.subject.kind === 'lab') perLab[c.subject.name] = (perLab[c.subject.name] || 0) + 1;
  const counts = Object.values(perLab);
  assert.ok(Object.keys(perLab).length >= 6, 'facts from at least 6 labs');
  assert.ok(Math.min(...counts) >= 3 && Math.max(...counts) <= 3 * Math.min(...counts), `labs stay balanced: ${JSON.stringify(perLab)}`);
});

// The live file is checked for rules only (a data-only change of a default must not fail a test);
// the values those rules produce today are pinned on the frozen copy, scripts/fixtures/guidance.json.
const LIVE = () => JSON.parse(readFileSync(new URL('../data/guidance.json', import.meta.url)));
const FROZEN = () => JSON.parse(readFileSync(new URL('./fixtures/guidance.json', import.meta.url)));

function planRules(g, models, where) {
  const byId = new Set((models.models || models).map((m) => m.id));
  assert.deepEqual(g.tool_plans.map((t) => t.tool), TOOL_PLAN_TOOLS, `${where}: one plan per tool`);
  for (const t of g.tool_plans) {
    if (t.helpers) assert.equal(t.helpers.model, 'inherit', `${where}: ${t.tool} helpers inherit by default`);
    const ids = [t.lead.model_id, t.bulk.model_id, t.helpers && t.helpers.push_down && t.helpers.push_down.model_id].filter(Boolean);
    for (const id of ids) assert.ok(byId.has(id), `${where}: ${t.tool} names ${id}, which is in the catalog`);
    if (TOOL_PLAN_CHOICE_ONLY.includes(t.tool)) assert.deepEqual(ids, [], `${where}: ${t.tool} names no model in its plan`);
  }
  assert.equal(g.tool_plans.find((t) => t.tool === 'openrouter').helpers, null, `${where}: a raw API call has no helpers`);
}

test('the live file: reviewer never has a default, and Codex/Cursor/AGENTS.md have none either', () => {
  const g = LIVE();
  assert.ok(!g.role_defaults.some((r) => r.role === 'reviewer'));
  assert.deepEqual([...new Set(g.role_defaults.map((r) => r.tool))], ['claude-code']);
});

test('the live file: one tool plan per tool; ids resolve; helpers inherit; choice-only tools name no model', () => {
  planRules(LIVE(), JSON.parse(readFileSync(new URL('../data/models.json', import.meta.url))), 'data/guidance.json');
});

test('the frozen copy: the defaults those rules gave on the day it was taken', () => {
  const g = FROZEN();
  planRules(g, JSON.parse(readFileSync(new URL('./fixtures/instructions-models.json', import.meta.url))), 'fixtures/guidance.json');
  assert.deepEqual(g.role_defaults.map((r) => `${r.role}:${r.model_ref}`).sort(), ['builder:sonnet', 'scout:haiku']);
  const cc = g.tool_plans.find((t) => t.tool === 'claude-code');
  assert.deepEqual([cc.lead.model_id, cc.lead.effort, cc.lead.raise_to, cc.helpers.push_down.model_id, cc.bulk.model_id],
    ['claude-opus-5-5', 'medium', 'high', 'claude-sonnet-5-5', 'claude-haiku-4-5']);
});

test('a well-formed file passes; models may be the file object or the array', () => {
  assert.deepEqual(errorsOf(good()), []);
  assert.deepEqual(errorsOf(good(), MODELS.models), []);
});

test('constants: guidance tiers are tool|lab; the models.json tier list is unchanged', () => {
  assert.deepEqual(GUIDANCE_TIERS, ['tool', 'lab']);
  assert.deepEqual(CLAIM_TIERS, ['lab', 'reported', 'measured', 'usage']);
  assert.deepEqual(GUIDANCE_TOPICS, ['instruction-files', 'enforced-model', 'effort', 'lead-helper', 'model-per-job', 'context']);
  assert.deepEqual(Object.keys(GUIDANCE_TOOLS), ['claude-code', 'codex', 'cursor', 'agents-md', 'copilot', 'antigravity', 'openrouter']);
  assert.deepEqual(TOOL_PLAN_TOOLS, ['claude-code', 'codex', 'cursor', 'copilot', 'antigravity', 'openrouter']);
  assert.deepEqual(TOOL_PLAN_CHOICE_ONLY, ['cursor', 'copilot', 'antigravity', 'openrouter']);
});

test('claimProblems: same rules for both files, tier list chosen by the caller', () => {
  const c = claim('x');
  assert.deepEqual(claimProblems(c, 'c', { tiers: GUIDANCE_TIERS }), []);
  assert.ok(claimProblems(c, 'c').some((e) => /tier "tool" must be one of lab, reported/.test(e)), 'default tiers are the models.json list');
  assert.ok(claimProblems({ ...c, tier: 'reported' }, 'c', { tiers: GUIDANCE_TIERS }).some((e) => /tier "reported" must be one of tool, lab/.test(e)));
  assert.ok(claimProblems({ ...c, quote: Array(26).fill('w').join(' ') }, 'c', { tiers: GUIDANCE_TIERS }).some((e) => /26 word/.test(e)));
  assert.ok(claimProblems({ ...c, source_url: 'ftp://x' }, 'c', { tiers: GUIDANCE_TIERS }).some((e) => /must be http/.test(e)));
  assert.ok(claimProblems({ ...c, date: '27 Sep' }, 'c', { tiers: GUIDANCE_TIERS }).some((e) => /YYYY-MM-DD/.test(e)));
  assert.ok(claimProblems({ ...c, sentence: 'It is the top model.' }, 'c', { tiers: GUIDANCE_TIERS }).some((e) => /banned relative phrase/.test(e)));
  assert.deepEqual(claimProblems(null, 'c'), ['c must be an object']);
});

test('shape: missing _readme, bad as_of, empty claims', () => {
  expectError({ ...good(), _readme: '' }, /_readme/);
  expectError({ ...good(), as_of: 'today' }, /as_of/);
  expectError({ ...good(), claims: [] }, /claims must be a non-empty array/);
  assert.match(errorsOf([])[0], /must be an object/);
});

test('claims: a duplicate id, a bad topic, an unknown tool or lab, a tier that does not match the subject', () => {
  const g = good(); g.claims.push(claim('cc-haiku')); expectError(g, /used twice/);
  const t = good(); t.claims[0].topic = 'ranking'; expectError(t, /topic "ranking"/);
  const u = good(); u.claims[0].subject.name = 'Some IDE'; expectError(u, /not a known tool/);
  const l = good(); l.claims[2].subject.name = 'Mistral'; expectError(l, /not a canonical vendor/);
  const m = good(); m.claims[2].tier = 'tool'; expectError(m, /must match subject\.kind/);
});

test('claims: a ranking word in our own sentence fails; the same word inside the verbatim quote does not', () => {
  for (const word of ['the best choice', 'better at code', 'our pick', 'we recommend it', 'suggested model', 'verdict', 'high confidence', 'start here']) {
    const g = good(); g.claims[0].sentence = `Claude Code docs: ${word}.`;
    expectError(g, /ranking word|banned relative phrase/);
  }
  const q = good(); q.claims[0].quote = 'Sonnet is recommended for most tasks'; assert.deepEqual(errorsOf(q), []);
});

test('role_defaults: basis ids must exist and include the tool or lab itself', () => {
  const g = good(); g.role_defaults[0].basis = ['nope']; expectError(g, /basis names "nope"/);
  const e = good(); e.role_defaults[0].basis = []; expectError(e, /basis must be a non-empty array/);
  const o = good(); o.role_defaults[0].basis = ['openai-effort']; expectError(o, /no claim from Claude Code or Anthropic itself/);
});

test('role_defaults: model_id must exist in models.json (or be null) and belong to that lab', () => {
  const g = good(); g.role_defaults[0].model_id = 'claude-haiku-9'; expectError(g, /not a model id in data\/models\.json/);
  const x = good(); x.role_defaults[0].model_id = 'gpt-6-luna'; x.model_refs = []; expectError(x, /OpenAI model — a default from Anthropic may only name Anthropic's own models/);
  const n = good(); n.role_defaults[0].model_id = null; n.role_defaults[0].model_ref = null; n.model_refs = []; assert.deepEqual(errorsOf(n), []);
});

test('role_defaults: no reviewer default, no unknown tool or role, no second default for one job', () => {
  const r = good(); r.role_defaults[0].role = 'reviewer'; expectError(r, /no default for the reviewer/);
  const t = good(); t.role_defaults[0].tool = 'windsurf'; expectError(t, /tool "windsurf"/);
  const j = good(); j.role_defaults[0].role = 'lead'; expectError(j, /role "lead"/);
  const d = good(); d.role_defaults.push({ ...d.role_defaults[0] }); expectError(d, /second default for claude-code\/scout/);
});

test('model_refs: model_id must exist or be null; a ref mapped twice fails; role defaults must agree with the map', () => {
  const g = good(); g.model_refs[0].model_id = 'claude-haiku-9'; expectError(g, /not a model id/);
  const n = good(); n.model_refs[0].model_id = null; n.role_defaults[0].model_id = null; assert.deepEqual(errorsOf(n), []);
  const d = good(); d.model_refs.push({ ...d.model_refs[0] }); expectError(d, /mapped twice/);
  const a = good(); a.model_refs[0].model_id = 'claude-sonnet-5'; expectError(a, /disagrees with model_refs claude-code\/haiku/);
  const b = good(); b.model_refs[0].basis = ['missing']; expectError(b, /basis names "missing"/);
});

/* ---- tool_plans */
function withPlan() {
  const g = good();
  g.claims.push(
    claim('cc-default', { topic: 'enforced-model', quote: 'The default model is claude-sonnet-5 unless you set another' }),
    claim('cc-levels', { topic: 'effort' }),
    claim('anthropic-low', { subject: { kind: 'lab', name: 'Anthropic' }, tier: 'lab', topic: 'effort' }),
    claim('cursor-inherit', { subject: { kind: 'tool', name: 'Cursor' }, source_url: 'https://cursor.com/docs/subagents' }),
  );
  g.tool_plans = [
    {
      tool: 'claude-code', as_of: '2026-09-27',
      instruction_files: [{ path: '~/.claude/CLAUDE.md', basis: ['cc-alias-haiku'] }],
      enforced: [{ what: 'model in a helper file', basis: ['cc-haiku'] }],
      effort_levels: { values: ['low', 'medium', 'high'], basis: ['cc-levels'] },
      lead: { model_id: 'claude-sonnet-5', effort: 'medium', raise_to: 'high', when: 'hard steps', basis: ['cc-default', 'anthropic-low'] },
      helpers: { model: 'inherit', basis: ['cc-haiku'], push_down: { model_id: 'claude-haiku-4-5', when: 'a routine thread', basis: ['cc-haiku'] } },
      bulk: { model_id: 'claude-haiku-4-5', effort: null, when: 'mechanical work', basis: ['cc-haiku'], explore: { basis: ['cc-haiku'] } },
    },
    {
      tool: 'cursor', as_of: '2026-09-27',
      instruction_files: [{ path: 'AGENTS.md', basis: ['cursor-inherit'] }],
      enforced: [{ what: 'model in a helper file', basis: ['cursor-inherit'] }],
      lead: { choice: 'your pick', effort: null, basis: ['cursor-inherit'] },
      helpers: { model: 'inherit', basis: ['cursor-inherit'] },
      bulk: { choice: 'your pick', effort: null, when: 'loops', basis: ['cursor-inherit'] },
    },
  ];
  return g;
}

test('tool_plans: a well-formed plan passes; tool_plans may be absent', () => {
  assert.deepEqual(errorsOf(withPlan()), []);
  assert.deepEqual(errorsOf(good()), []);
});

test('tool_plans: basis ids exist and belong to the tool or its lab', () => {
  const g = withPlan(); g.tool_plans[0].bulk.basis = ['nope']; expectError(g, /bulk\.basis names "nope"/);
  const o = withPlan(); o.tool_plans[0].lead.basis = ['openai-effort']; expectError(o, /lead\.basis "openai-effort" is a claim about OpenAI/);
  const c = withPlan(); c.tool_plans[1].bulk.basis = ['cc-haiku']; expectError(c, /bulk\.basis "cc-haiku" is a claim about Claude Code/);
  const e = withPlan(); e.tool_plans[0].helpers.basis = []; expectError(e, /helpers\.basis must name at least one claim id/);
});

test('tool_plans: model ids resolve, stay in a one-lab tool\'s lab, and a choice-only tool names none', () => {
  const g = withPlan(); g.tool_plans[0].bulk.model_id = 'claude-haiku-9'; expectError(g, /bulk\.model_id "claude-haiku-9" is not a model id/);
  const l = withPlan(); l.tool_plans[0].helpers.push_down.model_id = 'gpt-6-luna'; expectError(l, /OpenAI model — claude-code runs Anthropic models only/);
  const d = withPlan(); d.tool_plans[1].bulk = { model_id: 'gpt-6-luna', when: 'loops', basis: ['cursor-inherit'] }; expectError(d, /cursor's docs give no model string/);
  const b = withPlan(); b.tool_plans[1].lead.model_id = 'gpt-6-luna'; expectError(b, /lead needs exactly one of model_id or choice/);
  const x = withPlan(); x.tool_plans[1].lead.choice = 'auto'; expectError(x, /lead\.choice must be "your pick"/);
});

test('tool_plans: a bulk model goes into a helper file only by a model_refs string some basis quote gives', () => {
  // No model_refs row for the bulk model: the catalog id would be written with no source for it.
  const n = withPlan(); n.claims.push(claim('cc-sonnet-bulk', { quote: 'use claude-sonnet-5 for mechanical work' }));
  n.tool_plans[0].bulk = { ...n.tool_plans[0].bulk, model_id: 'claude-sonnet-5', basis: ['cc-sonnet-bulk'] };
  expectError(n, /bulk\.model_id "claude-sonnet-5" goes into claude-code's bulk helper file, so it needs a model_refs row/);
  // A row whose basis never quotes its string.
  const q = withPlan(); q.claims.find((c) => c.id === 'cc-alias-haiku').quote = 'Uses the fast and efficient model for simple tasks';
  expectError(q, /bulk\.model_id "claude-haiku-4-5": no model_refs row for it has a basis quote containing its string \(haiku\)/);
  // With a row whose claim quotes the string, it passes.
  const ok = withPlan(); ok.claims.push(claim('cc-sonnet-bulk', { quote: 'use claude-sonnet-5 for mechanical work' }), claim('cc-sonnet-string', { quote: 'set model: claude-sonnet-5 in the file' }));
  ok.model_refs.push({ tool: 'claude-code', ref: 'claude-sonnet-5', model_id: 'claude-sonnet-5', basis: ['cc-sonnet-string'] });
  ok.tool_plans[0].bulk = { ...ok.tool_plans[0].bulk, model_id: 'claude-sonnet-5', basis: ['cc-sonnet-bulk'] };
  assert.deepEqual(errorsOf(ok), []);
});

test('tool_plans: a slot that names a model rests on a quote that names it (no other model\'s quotes)', () => {
  const g = withPlan(); g.claims.push(claim('cc-sonnet-string', { quote: 'set model: claude-sonnet-5 in the file' }));
  g.model_refs.push({ tool: 'claude-code', ref: 'claude-sonnet-5', model_id: 'claude-sonnet-5', basis: ['cc-sonnet-string'] });
  g.tool_plans[0].bulk.model_id = 'claude-sonnet-5'; // basis still the Haiku quote
  expectError(g, /bulk\.basis: no quote names claude-sonnet-5/);
  const l = withPlan(); l.tool_plans[0].lead.basis = ['anthropic-low'];
  expectError(l, /lead\.basis: no quote names claude-sonnet-5/);
});

test('tool_plans: helpers inherit; effort values come from the tool\'s own level list; prose has no ranking words', () => {
  const h = withPlan(); h.tool_plans[0].helpers.model = 'claude-sonnet-5'; expectError(h, /helpers must be \{model: "inherit"/);
  const e = withPlan(); e.tool_plans[0].lead.effort = 'max'; expectError(e, /lead\.effort "max" is not one of claude-code's effort levels/);
  const n = withPlan(); n.tool_plans[1].bulk.effort = 'high'; expectError(n, /bulk\.effort "high" is not one of cursor's effort levels/);
  const w = withPlan(); w.tool_plans[0].bulk.when = 'the best bulk model'; expectError(w, /bulk\.when uses a ranking word/);
  const r = withPlan(); delete r.tool_plans[0].lead.when; expectError(r, /lead\.when must say when to raise effort/);
  const t = withPlan(); t.tool_plans.push({ ...t.tool_plans[1] }); expectError(t, /a second plan for cursor/);
  const u = withPlan(); u.tool_plans[1].tool = 'windsurf'; expectError(u, /tool "windsurf" must be one of/);
  const v = withPlan(); v.tool_plans[1].bulk.explore = { basis: ['cursor-inherit'] }; expectError(v, /bulk\.explore is a Claude Code helper only/);
});

test('effort_pages: lab canonical, url http(s), basis claims from that same lab', () => {
  const g = good(); g.effort_pages[0].url = 'docs.openai.com'; expectError(g, /url "docs\.openai\.com"/);
  const l = good(); l.effort_pages[0].lab = 'Mistral'; expectError(l, /lab "Mistral" is not a canonical vendor/);
  const b = good(); b.effort_pages[0].basis = ['cc-haiku']; expectError(b, /"cc-haiku" is not a claim from OpenAI/);
});
