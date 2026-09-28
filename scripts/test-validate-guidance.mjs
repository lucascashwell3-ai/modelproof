// data/guidance.json gate: scripts/validate-data.mjs's validateGuidance() + claimProblems().
// No network. The live file is checked against the live catalog once (it must pass); every other
// case uses a small in-test fixture so a data change never breaks a rule test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  validateGuidance, claimProblems, GUIDANCE_TIERS, GUIDANCE_TOPICS, GUIDANCE_TOOLS, CLAIM_TIERS,
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

test('the live file: reviewer never has a default, and Codex/Cursor/AGENTS.md have none either', () => {
  const g = JSON.parse(readFileSync(new URL('../data/guidance.json', import.meta.url)));
  assert.ok(!g.role_defaults.some((r) => r.role === 'reviewer'));
  assert.deepEqual([...new Set(g.role_defaults.map((r) => r.tool))], ['claude-code']);
  assert.deepEqual(g.role_defaults.map((r) => `${r.role}:${r.model_ref}`).sort(), ['builder:sonnet', 'scout:haiku']);
});

test('a well-formed file passes; models may be the file object or the array', () => {
  assert.deepEqual(errorsOf(good()), []);
  assert.deepEqual(errorsOf(good(), MODELS.models), []);
});

test('constants: guidance tiers are tool|lab; the models.json tier list is unchanged', () => {
  assert.deepEqual(GUIDANCE_TIERS, ['tool', 'lab']);
  assert.deepEqual(CLAIM_TIERS, ['lab', 'reported', 'measured', 'usage']);
  assert.deepEqual(GUIDANCE_TOPICS, ['instruction-files', 'enforced-model', 'effort', 'lead-helper', 'model-per-job', 'context']);
  assert.deepEqual(Object.keys(GUIDANCE_TOOLS), ['claude-code', 'codex', 'cursor', 'agents-md']);
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

test('effort_pages: lab canonical, url http(s), basis claims from that same lab', () => {
  const g = good(); g.effort_pages[0].url = 'docs.openai.com'; expectError(g, /url "docs\.openai\.com"/);
  const l = good(); l.effort_pages[0].lab = 'Mistral'; expectError(l, /lab "Mistral" is not a canonical vendor/);
  const b = good(); b.effort_pages[0].basis = ['cc-haiku']; expectError(b, /"cc-haiku" is not a claim from OpenAI/);
});
