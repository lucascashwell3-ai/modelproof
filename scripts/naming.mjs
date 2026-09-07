/* The one naming rule for data/models.json — ids, vendors and display names.
   Imported by the two admission paths (auto-refresh.mjs, apply-judgment.mjs) and enforced by the
   honesty gate (validate-data.mjs), so a record that breaks it cannot be published.

   THE RULE
   --------
   name    the model's own name, as the vendor writes it — no leading "Vendor: " label.
           OpenRouter's feed prefixes every display name with its vendor ("Google: Gemini 3.8
           Flash"); that label duplicates the vendor field and is stripped on the way in.
   id      derived from the name, never hand-chosen: lowercase, every run of non-alphanumerics
           becomes one "-", leading/trailing "-" trimmed, any parenthetical qualifier dropped.
             "Gemini 3.8 Flash"          -> gemini-3-8-flash
             "Gemini 3.1 Pro (Preview)"  -> gemini-3-1-pro
             "DeepSeek V4 Pro 0813"      -> deepseek-v4-pro-0813   (the name itself says DeepSeek)
             "Hy4 preview"               -> hy4-preview            (not tencent-hy4-preview)
           The vendor is never glued onto the front of an id. An id that came from a routing path
           ("google/gemini-3.8-flash" -> google-gemini-3-8-flash) is the bug this rule ends.
   vendor  exactly one display string per vendor, from VENDORS below. Feed vendor keys
           ("x-ai", "moonshotai", "qwen") resolve through VENDOR_ALIASES; casing and punctuation
           never matter on the way in, and only the canonical spelling may be stored.
           A vendor missing from VENDORS is added here, in a reviewed change — not typed free-form
           into a record.

   COMMUNITY LISTINGS
   ------------------
   OpenRouter ids that start with "~" ("~deepseek/deepseek-v4-flash-latest") are community
   re-hosts: someone other than the vendor serving a model or an alias of one. They are not
   vendor listings, so they are never auto-admitted and never queued for the Judge. The collect
   run drops them with a logged reason, and canonicalVendor("~deepseek") is null on purpose. */

const normalize = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Canonical vendor display names — the only values allowed in a model's `vendor` field. */
export const VENDORS = [
  'Anthropic', 'OpenAI', 'Google', 'xAI', 'Meta', 'Mistral AI', 'DeepSeek', 'Alibaba (Qwen)',
  'Moonshot AI', 'Z.ai (Zhipu)', 'Tencent', 'IBM', 'InclusionAI (Ant Group)', 'Kwaipilot',
  'Meituan', 'NVIDIA', 'Poolside', 'ByteDance', 'AionLabs', 'Sakana AI', 'Thinking Machines Lab',
  'Upstage', 'Amazon', 'Cohere',
];
const VENDOR_SET = new Set(VENDORS);

/** Feed spellings -> canonical, keyed by normalize(). Every canonical name maps to itself too. */
export const VENDOR_ALIASES = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google', googledeepmind: 'Google', gemini: 'Google', vertexai: 'Google',
  xai: 'xAI', spacexai: 'xAI',
  meta: 'Meta', metallama: 'Meta', metaai: 'Meta',
  mistral: 'Mistral AI', mistralai: 'Mistral AI',
  deepseek: 'DeepSeek', deepseekai: 'DeepSeek',
  alibaba: 'Alibaba (Qwen)', qwen: 'Alibaba (Qwen)', alibabaqwen: 'Alibaba (Qwen)',
  qwenalibaba: 'Alibaba (Qwen)', alibabacloud: 'Alibaba (Qwen)',
  moonshot: 'Moonshot AI', moonshotai: 'Moonshot AI',
  zai: 'Z.ai (Zhipu)', zhipu: 'Z.ai (Zhipu)', zhipuai: 'Z.ai (Zhipu)', zaizhipu: 'Z.ai (Zhipu)',
  tencent: 'Tencent', tencenthunyuan: 'Tencent', hunyuan: 'Tencent',
  ibm: 'IBM', ibmgranite: 'IBM',
  inclusionai: 'InclusionAI (Ant Group)', inclusionaiantgroup: 'InclusionAI (Ant Group)', antgroup: 'InclusionAI (Ant Group)',
  kwaipilot: 'Kwaipilot', kuaishou: 'Kwaipilot',
  meituan: 'Meituan',
  nvidia: 'NVIDIA',
  poolside: 'Poolside',
  bytedance: 'ByteDance', bytedanceseed: 'ByteDance',
  aionlabs: 'AionLabs', aion: 'AionLabs',
  sakana: 'Sakana AI', sakanaai: 'Sakana AI',
  thinkingmachines: 'Thinking Machines Lab', thinkingmachineslab: 'Thinking Machines Lab',
  upstage: 'Upstage',
  amazon: 'Amazon', aws: 'Amazon', bedrock: 'Amazon',
  cohere: 'Cohere',
};

/**
 * Vendors the collect run may admit on its own (>=2 sources + pricing). Everything else goes to
 * the Judge with a citation. This is the admission policy that predates the naming rule, now
 * expressed in canonical names; widening it is a policy change, not a naming one.
 */
export const AUTO_ADMIT_VENDORS = new Set([
  'Anthropic', 'OpenAI', 'Google', 'Meta', 'Mistral AI', 'xAI', 'DeepSeek', 'Alibaba (Qwen)',
  'Amazon', 'Cohere', 'Moonshot AI',
]);

/** A leading "Vendor: " label as OpenRouter writes it ("ByteDance Seed: Seed 2.1 Turbo"). */
const LEADING_LABEL = /^([A-Za-z][A-Za-z0-9.\- ]{0,29}):\s+/;

/** Is this OpenRouter id a community re-host ("~vendor/model")? */
export const isCommunityListing = (id) => /^~/.test(String(id || '').trim());

/** Canonical vendor display name for any spelling, or null when the vendor is not in VENDORS. */
export function canonicalVendor(raw) {
  const s = String(raw || '').trim();
  if (!s || s.startsWith('~')) return null;           // community listing — never the vendor
  if (VENDOR_SET.has(s)) return s;
  return VENDOR_ALIASES[normalize(s)] || null;
}

/** True when the string is exactly a canonical vendor name. */
export const isCanonicalVendor = (v) => VENDOR_SET.has(v);

/**
 * The model's own name: strips a leading "Label: " when the label names this vendor (by canonical
 * match, or by plain normalized equality for a vendor not yet in VENDORS). A label naming some
 * OTHER vendor is left alone — it is not ours to remove.
 */
export function bareModelName(name, vendor) {
  const s = String(name || '').trim();
  const m = LEADING_LABEL.exec(s);
  if (!m) return s;
  const label = m[1].trim();
  const same = (canonicalVendor(label) && canonicalVendor(label) === canonicalVendor(vendor)) ||
    (normalize(label) && normalize(label) === normalize(vendor));
  if (!same) return s;
  const rest = s.slice(m[0].length).trim();
  return rest || s;
}

/** Lowercase slug: runs of non-alphanumerics -> "-", trimmed. */
export const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** The id a model with this display name must carry. Any leading label and any "(…)" are dropped. */
export function modelId(name) {
  const bare = String(name || '').replace(LEADING_LABEL, '').replace(/\s*\([^)]*\)/g, ' ');
  return slug(bare);
}

export const ID_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Every way a model record breaks the rule, as plain strings (empty = clean). Used by the honesty
 * gate; kept here so the gate, the tests and the migration all judge by the same function.
 */
export function namingProblems(m) {
  const out = [];
  const id = String(m.id ?? '');
  if (!ID_SHAPE.test(id)) out.push(`id "${id}" is not a clean slug (lowercase a-z0-9, single "-" separators, no leading/trailing "-")`);
  const want = modelId(m.name);
  if (want && id !== want) out.push(`id "${id}" must be derived from the name — "${m.name}" -> "${want}"`);
  if (!isCanonicalVendor(m.vendor)) {
    const fix = canonicalVendor(m.vendor);
    out.push(fix
      ? `vendor "${m.vendor}" must be written "${fix}"`
      : `vendor "${m.vendor}" is not in scripts/naming.mjs VENDORS — add it there (reviewed), never free-form`);
  }
  const lbl = LEADING_LABEL.exec(String(m.name || ''));
  if (lbl && canonicalVendor(lbl[1]) && canonicalVendor(lbl[1]) === canonicalVendor(m.vendor)) {
    out.push(`name "${m.name}" repeats the vendor as a label — store "${bareModelName(m.name, m.vendor)}"`);
  }
  return out;
}
