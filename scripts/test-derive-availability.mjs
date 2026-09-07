import test from 'node:test';
import assert from 'node:assert/strict';
import {
  vendorGroup, urlMatchesVendorGroup, findVendorSourceUrl, deriveDirectApi, deriveOpenWeights,
  deriveOpenRouterFlag, findOrMatch, bedrockKey, deriveAwsBedrock, deriveAvailabilityForModel,
  availabilityEquals, fetchBedrockModelKeys, OR_URL, AWS_BEDROCK_PRICE_URL,
} from './derive-availability.mjs';

// --- vendorGroup -------------------------------------------------------------------------------

test('vendorGroup: recognizes every direct_api vendor spelling in the live catalog', () => {
  assert.equal(vendorGroup('Anthropic'), 'anthropic');
  assert.equal(vendorGroup('anthropic'), 'anthropic');
  assert.equal(vendorGroup('OpenAI'), 'openai');
  assert.equal(vendorGroup('openai'), 'openai');
  assert.equal(vendorGroup('Google'), 'google');
  assert.equal(vendorGroup('google'), 'google');
  assert.equal(vendorGroup('xAI'), 'xai');
  assert.equal(vendorGroup('x-ai'), 'xai');
  assert.equal(vendorGroup('Mistral AI'), 'mistral');
  assert.equal(vendorGroup('DeepSeek'), 'deepseek');
  assert.equal(vendorGroup('deepseek'), 'deepseek');
  assert.equal(vendorGroup('~deepseek'), 'deepseek');
  assert.equal(vendorGroup('Moonshot AI'), 'moonshot');
  assert.equal(vendorGroup('Alibaba (Qwen)'), 'alibaba');
  assert.equal(vendorGroup('Qwen (Alibaba)'), 'alibaba');
  assert.equal(vendorGroup('qwen'), 'alibaba');
  assert.equal(vendorGroup('Z.ai (Zhipu)'), 'zai');
});

test('vendorGroup: a vendor outside the v1 direct_api list returns null (never guessed)', () => {
  assert.equal(vendorGroup('Meta'), null);
  assert.equal(vendorGroup('Tencent'), null);
  assert.equal(vendorGroup(''), null);
  assert.equal(vendorGroup(undefined), null);
});

// --- urlMatchesVendorGroup / findVendorSourceUrl / deriveDirectApi -----------------------------

test('urlMatchesVendorGroup: exact host and subdomain both match; unrelated host does not', () => {
  assert.equal(urlMatchesVendorGroup('https://anthropic.com/news/x', 'anthropic'), true);
  assert.equal(urlMatchesVendorGroup('https://platform.claude.com/docs/pricing', 'anthropic'), true);
  assert.equal(urlMatchesVendorGroup('https://www.anthropic.com/pricing', 'anthropic'), true);
  assert.equal(urlMatchesVendorGroup('https://openrouter.ai/anthropic/claude', 'anthropic'), false);
  assert.equal(urlMatchesVendorGroup(null, 'anthropic'), false);
  assert.equal(urlMatchesVendorGroup('not a url', 'anthropic'), false);
});

test('findVendorSourceUrl: prefers price_checked.url when it belongs to the vendor', () => {
  const model = {
    vendor: 'Anthropic',
    price_checked: { url: 'https://platform.claude.com/docs/en/about-claude/pricing' },
    sources: ['https://techcrunch.com/some-article'],
  };
  assert.equal(findVendorSourceUrl(model), 'https://platform.claude.com/docs/en/about-claude/pricing');
});

test('findVendorSourceUrl: falls back to the first matching sources[] entry', () => {
  const model = {
    vendor: 'OpenAI',
    sources: ['https://techcrunch.com/article', 'https://openai.com/index/gpt-6-astra/', 'https://developers.openai.com/pricing'],
  };
  assert.equal(findVendorSourceUrl(model), 'https://openai.com/index/gpt-6-astra/');
});

test('findVendorSourceUrl: null when the vendor is known but no stored URL belongs to it', () => {
  const model = { vendor: 'Anthropic', sources: ['https://techcrunch.com/article'] };
  assert.equal(findVendorSourceUrl(model), null);
});

test('findVendorSourceUrl: null for a vendor outside the v1 list regardless of sources', () => {
  const model = { vendor: 'Meta', sources: ['https://ai.meta.com/llama/'] };
  assert.equal(findVendorSourceUrl(model), null);
});

test('deriveDirectApi: true + source when a vendor URL is on file', () => {
  const model = { vendor: 'Anthropic', sources: ['https://www.anthropic.com/news/claude-opus-5'] };
  const r = deriveDirectApi(model);
  assert.equal(r.value, true);
  assert.equal(r.source, 'https://www.anthropic.com/news/claude-opus-5');
});

test('deriveDirectApi: null (never false) when nothing is sourced', () => {
  const model = { vendor: 'Anthropic', sources: [] };
  const r = deriveDirectApi(model);
  assert.equal(r.value, null);
  assert.equal(r.source, null);
});

// --- deriveOpenWeights ---------------------------------------------------------------------

test('deriveOpenWeights: true from an OpenRouter hugging_face_id', () => {
  const model = { verdict: '', strengths: [], weaknesses: [], best_for: [] };
  assert.equal(deriveOpenWeights(model, { hfId: 'Qwen/Qwen3.8-27B' }), true);
});

test('deriveOpenWeights: true from catalog prose saying "open weight(s)"', () => {
  const model = {
    verdict: 'The best-value open-weight coder.',
    strengths: [], weaknesses: [], best_for: [],
  };
  assert.equal(deriveOpenWeights(model, null), true);
  const model2 = { verdict: '', strengths: ['1M-token context; open weights, widely available'], weaknesses: [], best_for: [] };
  assert.equal(deriveOpenWeights(model2, null), true);
});

test('deriveOpenWeights: null (never false) when nothing indicates it', () => {
  const model = { verdict: 'A closed frontier model.', strengths: [], weaknesses: [], best_for: [] };
  assert.equal(deriveOpenWeights(model, null), null);
  assert.equal(deriveOpenWeights(model, { hfId: null }), null);
});

// --- deriveOpenRouterFlag / findOrMatch ------------------------------------------------------

test('deriveOpenRouterFlag: null when the feed could not be checked this run', () => {
  assert.equal(deriveOpenRouterFlag({ id: 'x' }, false), null);
  assert.equal(deriveOpenRouterFlag(null, false), null);
});

test('deriveOpenRouterFlag: true/false are both real, checked facts when the feed succeeded', () => {
  assert.equal(deriveOpenRouterFlag({ id: 'anthropic/claude-opus-5' }, true), true);
  assert.equal(deriveOpenRouterFlag(null, true), false);
});

test('findOrMatch: matches via the same id/name/alias rule Collect uses for price facts', () => {
  const model = { id: 'claude-opus-5', name: 'Claude Opus 5' };
  const orList = [{ id: 'anthropic/claude-opus-5', name: 'Anthropic: Claude Opus 5', hfId: null }];
  const match = findOrMatch(model, orList, {});
  assert.equal(match.id, 'anthropic/claude-opus-5');
  assert.equal(findOrMatch({ id: 'totally-unknown', name: 'Nothing' }, orList, {}), null);
});

// --- aws_bedrock ----------------------------------------------------------------------------

test('bedrockKey: collapses id and vendor-prefixed spellings to the same key', () => {
  assert.equal(bedrockKey('xai.grok-4.6'), bedrockKey('x-ai-grok-4-6'));
});

test('deriveAwsBedrock: true + matched when the AWS Price List API lists the model (by id or name)', () => {
  const keys = new Set([bedrockKey('xai.grok-4.6'), bedrockKey('DeepSeek V3.2')]);
  const byId = deriveAwsBedrock({ id: 'x-ai-grok-4-6', name: 'SpaceXAI: Grok 4.6' }, keys);
  assert.equal(byId.value, true);
  assert.equal(byId.matched, true);
  const byName = deriveAwsBedrock({ id: 'deepseek-v3-2', name: 'DeepSeek V3.2' }, keys);
  assert.equal(byName.value, true);
});

test('deriveAwsBedrock: null (never false) on a miss, and null when the feed could not be checked', () => {
  const keys = new Set([bedrockKey('DeepSeek V3.2')]);
  const miss = deriveAwsBedrock({ id: 'claude-opus-5', name: 'Claude Opus 5' }, keys);
  assert.equal(miss.value, null);
  assert.equal(miss.matched, false);
  const noFeed = deriveAwsBedrock({ id: 'claude-opus-5', name: 'Claude Opus 5' }, null);
  assert.equal(noFeed.value, null);
});

test('fetchBedrockModelKeys: returns null (not throws, not an empty Set treated as "checked clean") on a failed fetch', async () => {
  const failingFetch = async () => { throw new Error('network down'); };
  const result = await fetchBedrockModelKeys(AWS_BEDROCK_PRICE_URL, failingFetch);
  assert.equal(result, null);
});

test('fetchBedrockModelKeys: extracts attributes.model from every product, normalized', async () => {
  const fakeJson = {
    products: {
      SKU1: { attributes: { model: 'DeepSeek V3.2' } },
      SKU2: { attributes: { model: 'xai.grok-4.6' } },
      SKU3: { attributes: {} }, // no model attribute — must be skipped, not throw
    },
  };
  const fakeFetch = async () => ({ ok: true, json: async () => fakeJson });
  const keys = await fetchBedrockModelKeys(AWS_BEDROCK_PRICE_URL, fakeFetch);
  assert.equal(keys.has(bedrockKey('DeepSeek V3.2')), true);
  assert.equal(keys.has(bedrockKey('xai.grok-4.6')), true);
  assert.equal(keys.size, 2);
});

// --- deriveAvailabilityForModel (the merge) --------------------------------------------------

test('deriveAvailabilityForModel: full happy path — direct_api + openrouter + open_weights + aws_bedrock all sourced', () => {
  const model = {
    id: 'deepseek-v3-2', name: 'DeepSeek V3.2', vendor: 'DeepSeek',
    sources: ['https://api-docs.deepseek.com/pricing'],
    verdict: 'Open-weight, self-hostable.',
  };
  const orList = [{ id: 'deepseek/deepseek-v3.2', name: 'DeepSeek: V3.2', hfId: 'deepseek-ai/DeepSeek-V3.2' }];
  const bedrockKeys = new Set([bedrockKey('DeepSeek V3.2')]);
  const next = deriveAvailabilityForModel(model, { orList, aliases: {}, orFeedOk: true, bedrockKeys });
  assert.equal(next.direct_api, true);
  assert.equal(next.openrouter, true);
  assert.equal(next.open_weights, true);
  assert.equal(next.aws_bedrock, true);
  assert.equal(next.google_vertex, null);
  assert.equal(next.azure, null);
  assert.equal(next.eu_hosting, null);
  assert.ok(next.sources.includes(OR_URL));
  assert.ok(next.sources.includes('https://api-docs.deepseek.com/pricing'));
  assert.ok(next.sources.includes(AWS_BEDROCK_PRICE_URL));
});

test('deriveAvailabilityForModel: a fully unsourced/unmatched model gets nulls, never guessed falses (except openrouter)', () => {
  const model = { id: 'some-model', name: 'Some Model', vendor: 'Tencent', sources: [] };
  const next = deriveAvailabilityForModel(model, { orList: [], aliases: {}, orFeedOk: true, bedrockKeys: new Set() });
  assert.equal(next.direct_api, null);
  assert.equal(next.openrouter, false); // definite: feed checked, not found
  assert.equal(next.aws_bedrock, null);
  assert.equal(next.open_weights, null);
});

test('deriveAvailabilityForModel: never regresses a previously-true fact when this run cannot re-derive it', () => {
  const model = {
    id: 'some-model', name: 'Some Model', vendor: 'Tencent', sources: [],
    availability: { direct_api: true, openrouter: true, aws_bedrock: true, google_vertex: null, azure: null, open_weights: true, eu_hosting: null, sources: ['https://example.com/prior'] },
  };
  // This run's feeds fail entirely / find nothing new.
  const next = deriveAvailabilityForModel(model, { orList: [], aliases: {}, orFeedOk: false, bedrockKeys: null });
  assert.equal(next.direct_api, true);
  assert.equal(next.openrouter, true);
  assert.equal(next.aws_bedrock, true);
  assert.equal(next.open_weights, true);
  assert.ok(next.sources.includes('https://example.com/prior'));
});

test('deriveAvailabilityForModel: a failed OpenRouter fetch does not flip a real absence back to null either — it just holds', () => {
  const model = {
    id: 'some-model', name: 'Some Model', vendor: 'Tencent', sources: [],
    availability: { direct_api: null, openrouter: false, aws_bedrock: null, google_vertex: null, azure: null, open_weights: null, eu_hosting: null, sources: [] },
  };
  const next = deriveAvailabilityForModel(model, { orList: [], aliases: {}, orFeedOk: false, bedrockKeys: null });
  assert.equal(next.openrouter, false);
});

// --- availabilityEquals -----------------------------------------------------------------------

test('availabilityEquals: true for identical objects, order-independent on sources[]', () => {
  const a = { direct_api: true, openrouter: true, aws_bedrock: null, google_vertex: null, azure: null, open_weights: null, eu_hosting: null, sources: ['https://a', 'https://b'] };
  const b = { direct_api: true, openrouter: true, aws_bedrock: null, google_vertex: null, azure: null, open_weights: null, eu_hosting: null, sources: ['https://b', 'https://a'] };
  assert.equal(availabilityEquals(a, b), true);
});

test('availabilityEquals: false when any field or the source set differs', () => {
  const a = { direct_api: true, openrouter: true, aws_bedrock: null, google_vertex: null, azure: null, open_weights: null, eu_hosting: null, sources: ['https://a'] };
  const b = { ...a, openrouter: false };
  assert.equal(availabilityEquals(a, b), false);
  const c = { ...a, sources: ['https://a', 'https://c'] };
  assert.equal(availabilityEquals(a, c), false);
  assert.equal(availabilityEquals(null, a), false);
  assert.equal(availabilityEquals(null, null), true);
});
