# Usage guidance — raw research notes

Working notes for the per-model usage guidance section. Every claim here carries the page it
came from. Tier A = lab-published. Tier B = linkable reported experience. Nothing goes in the
dataset without a URL.

All Tier A pages below were fetched and read on **2026-08-04**.

---

## Anthropic

Anthropic publishes a **per-model prompting guide** — the deepest guidance of any lab. Pages:

- Prompting Claude Opus 5 — `https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5`
- What's new in Claude Opus 5 — `https://platform.claude.com/docs/en/about-claude/models/whats-new-opus-5`
- Prompting Claude Fable 5 — `https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5`
- Prompting Claude Sonnet 5 — `https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5`
- Prompting Claude Opus 4.8 — `https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-4-8`
- Models overview (selection guidance) — `https://platform.claude.com/docs/en/about-claude/models/overview`
- Migration guide — `https://platform.claude.com/docs/en/about-claude/models/migration-guide`

### Claude Opus 5 — `claude-opus-5`

Lucas's original example is confirmed, and it's stated twice on Anthropic's own pages.

1. **Delete your verification instructions.** "Claude Opus 5 verifies its own work without being
   told to. If your prompt contains explicit verification instructions ('include a final
   verification step for any non-trivial task,' 'use a subagent to verify'), remove them:
   instructions like these cause over-verification on Claude Opus 5, and removing them reduces
   wasted tokens with no loss in quality." Same for "double-check your answer" / "re-verify
   before responding" — they "compound with the model's own behavior and add cost without
   improving results." → prompting-claude-opus-5 (§ Task scope and over-verification,
   § Self-correction)
2. **Give it the whole task up front and let it run.** "performs best when given the complete
   task specification up front and left to run." → prompting-claude-opus-5 (§ Capability improvements)
3. **Effort is your main cost dial, and low/medium are unusually good.** "`low` and `medium`
   effort produce strong quality at a fraction of the tokens and latency of higher settings.
   Start with the default (`high`)… step up to `xhigh` for demanding coding and agentic work."
   → prompting-claude-opus-5
4. **Thinking is on by default now — recheck `max_tokens`.** Breaking change from Opus 4.8;
   `max_tokens` caps thinking + answer together, so old limits can truncate replies.
   → whats-new-opus-5 (§ Thinking on by default)
5. **Disabling thinking now errors above `high` effort.** `thinking: {"type":"disabled"}` with
   effort `xhigh` or `max` returns a 400. → whats-new-opus-5
6. **Responses run longer — ask for short if you want short.** Effort controls how much it
   *thinks*, not how much it *says*; lowering effort doesn't reliably shorten the visible answer.
   Prompt for brevity explicitly. → prompting-claude-opus-5 (§ Response length and verbosity)
7. **It expands scope and delegates readily.** Constrain scope explicitly for narrow tasks; cap
   subagent delegation on cost-sensitive work. → prompting-claude-opus-5
8. **Don't tell a code review to "only report high-severity issues"** — it now follows that
   literally and reports less. Ask for everything, filter in a second pass.
   → prompting-claude-opus-5 (§ Capability improvements)
9. **Prompt-cache minimum halved to 512 tokens** (from 1,024 on Opus 4.8) — short prompts that
   couldn't be cached before now can, with no code change. → whats-new-opus-5

### Claude Fable 5 — `claude-fable-5`

1. **Aim it at your hardest problem.** "The teams seeing the best outcomes apply Claude Fable 5
   to their hardest unsolved problems; testing it only on simpler workloads tends to undersell
   its capability range." → prompting-claude-fable-5
2. **Expect long turns; stop blocking on them.** Single requests can run many minutes at higher
   effort, autonomous runs for hours. "Adjust client timeouts, streaming, and user-facing
   progress indicators before migrating." → prompting-claude-fable-5 (§ Longer turns by default)
3. **Cut your old prompts down.** "Skills developed for prior models are often too prescriptive
   for Claude Fable 5 and can degrade output quality." → prompting-claude-fable-5
   (§ Recommended scaffolding changes)
4. **Give it a memory file.** Performs "particularly well when it can record lessons from
   previous runs and reference them" — a plain Markdown notes file is enough.
   → prompting-claude-fable-5 (§ Construct a memory system)
5. **Tell it *why*, not just *what*.** "tends to perform better when it understands the intent
   behind a request." → prompting-claude-fable-5
6. **Make it check claims against real tool output on long runs.** Anthropic's testing says this
   "nearly eliminated fabricated status reports." → prompting-claude-fable-5
7. **Don't ask it to show its reasoning.** Instructions to echo or explain internal reasoning can
   trigger a refusal category and cause fallbacks to Opus 4.8. → prompting-claude-fable-5
8. **`high` is the default; lower rungs still beat older models' best.** "Lower effort settings on
   Claude Fable 5 still perform well and often exceed `xhigh` performance on prior models."
   → prompting-claude-fable-5
9. **Caveat worth carrying:** runs safety classifiers over offensive-cyber and life-sciences
   work; benign work in those areas can trip them. Configure a fallback to Opus 4.8.
   → prompting-claude-fable-5 (note block)

### Claude Sonnet 5 — `claude-sonnet-5`

1. **Sampling parameters are gone.** Setting `temperature`, `top_p`, or `top_k` to anything
   non-default returns a 400. "This constraint is new for Sonnet-class models." Steer tone via
   the prompt instead. → prompting-claude-sonnet-5 (§ Tone and writing style)
2. **New tokenizer ≈ 30% more tokens for the same text** — `max_tokens` tuned on Sonnet 4.6 can
   truncate equivalent output. → prompting-claude-sonnet-5 (note block)
3. **Adaptive thinking is on by default** (it wasn't on Sonnet 4.6); manual extended thinking
   budgets now return a 400. → prompting-claude-sonnet-5
4. **Rough upgrade mapping:** Sonnet 5 at `medium` ≈ Sonnet 4.6 at `high`; Sonnet 5 at `high` ≈
   Sonnet 4.6 at `max`. Good excuse to drop a rung and save money.
   → prompting-claude-sonnet-5 (§ Calibrating effort and thinking depth)
5. **It takes instructions literally.** "It does not silently generalize an instruction from one
   item to another." If you want something applied everywhere, say "every section, not just the
   first one." → prompting-claude-sonnet-5 (§ More literal instruction following)
6. **Raise effort instead of prompting around shallow reasoning.**
   → prompting-claude-sonnet-5
7. **Frontend work settles into one default look.** Generic pushback ("make it minimal") just
   swaps one fixed palette for another; give a concrete spec, or ask for 4 directions to pick
   from first. → prompting-claude-sonnet-5 (§ Design and frontend defaults)
   — *note: this is the exact failure Lucas hit across five sites; his own house rule (prototypes
   first) is what Anthropic recommends.*

### Claude Opus 4.8 — `claude-opus-4-8`

1. **Start at `xhigh` for coding and agentic work**, minimum `high` for anything
   intelligence-sensitive. "Effort is likely to be more important for this model than for any
   prior Opus." → prompting-claude-opus-4-8
2. **Thinking is OFF unless you ask for it** — `thinking: {type: "adaptive"}`. (Opposite of
   Opus 5.) → prompting-claude-opus-4-8
3. **It prefers reasoning over reaching for tools.** Raise effort to get more tool use.
   → prompting-claude-opus-4-8 (§ Tool use triggering)
4. **It spawns few subagents by default** — ask explicitly if you want fan-out. (Opposite of
   Opus 5, which over-delegates.) → prompting-claude-opus-4-8
5. **Documented house style on frontend work:** cream `#F4F1EA` backgrounds, serif display type
   (Georgia, Fraunces, Playfair), italic accents, terracotta/amber. "This default is persistent."
   → prompting-claude-opus-4-8 (§ Design and frontend defaults)
6. **At `max`/`xhigh`, set a large output budget** — start at 64k tokens.
   → prompting-claude-opus-4-8
7. **Drop forced progress-update scaffolding** ("summarize every 3 tool calls") — it does this
   itself now. → prompting-claude-opus-4-8

### Claude Haiku 4.5 — `claude-haiku-4-5`

Thinner: no dedicated prompting guide. What is published (models overview):
1. **"The fastest model with near-frontier intelligence"** — $1/$5, 200k context, 64k max output.
2. **It is the odd one out on thinking:** supports classic extended thinking
   (`thinking.type: "enabled"`), and does *not* support adaptive thinking — the reverse of every
   other current Claude model. → models overview (latest models comparison table)
3. Knowledge cutoff is much older than the 5-series (training data Jul 2025, reliable Feb 2025).
   → models overview

### Cross-model (applies to several Claude entries)

- **Model choice, from Anthropic:** "start with **Claude Opus 5** for complex agentic coding and
  enterprise work. For workloads that need the highest available capability, use Claude Fable 5."
  → models overview (§ Choosing a model)
- **Batch API extended output:** Opus 5, Opus 4.8, Sonnet 5 and others support up to 300k output
  tokens with the `output-300k-2026-03-24` beta header. → models overview

---

## OpenAI

Pages: model guidance — `https://developers.openai.com/api/docs/guides/prompt-guidance` ·
reasoning guide — `https://developers.openai.com/api/docs/guides/reasoning` ·
GPT-5.2 prompting guide — `https://cookbook.openai.com/examples/gpt-5/gpt-5-2_prompting_guide`

### GPT-5.6 family (Sol / Terra / Luna)

1. **Which one:** Sol for frontier capability and complex production work (it's what the plain
   `gpt-5.6` alias resolves to); "use `gpt-5.6-terra` for strong performance at a lower price";
   "use `gpt-5.6-luna` for efficient, high-volume workloads." → prompt-guidance
2. **Delete your "be concise" instructions.** "GPT-5.6 tends to be more concise by default than
   GPT-5.5" — old brevity instructions may now be redundant. → prompt-guidance
   *(Same shape as the Opus 5 verification point: the model absorbed the instruction, so the
   instruction became waste.)*
3. **Shorter prompts scored better.** OpenAI's internal testing on leaner prompts: scores up
   "roughly 10–15% while reducing total tokens by 41–66%." Test removing repeated instructions.
   → prompt-guidance
4. **Don't reach for max effort by default.** "Preserve your current reasoning effort as the
   baseline, then compare one level lower." `medium` is the balanced default, `low` for
   latency-sensitive work; "reserve `max` for the hardest quality-first workloads."
   → prompt-guidance
5. **Reasoning now persists across turns by default** (`all_turns`, vs `current_turn` on earlier
   models). → prompt-guidance
6. **Use `text.verbosity`** (`low`/`medium`/`high`) for default detail, then say what each task
   needs — rather than one blanket brevity line. → prompt-guidance

---

## Google — Gemini 3 family

Page: Gemini 3 developer guide — `https://ai.google.dev/gemini-api/docs/gemini-3` ·
thinking — `https://ai.google.dev/gemini-api/docs/generate-content/thinking`

1. **Leave temperature at 1.0.** Direct warning: "Changing the temperature (setting it below 1.0)
   may lead to unexpected behavior, such as looping or degraded performance, particularly in
   complex mathematical or reasoning tasks." If you carried a low-temperature setting over from
   Gemini 2.5 for deterministic output, remove it. → gemini-3 guide
2. **Stop hand-writing chain-of-thought.** "If you were previously using complex prompt
   engineering (like chain of thought) to force Gemini 2.5 to reason, try Gemini 3 with
   `thinking_level: 'high'` and simplified prompts." → gemini-3 guide
3. **Be brief.** "Gemini 3 responds best to direct, clear instructions. It may over-analyze
   verbose or overly complex prompt engineering techniques used for older models."
   → gemini-3 guide
4. **Put the question last on big inputs.** With a whole book, codebase or long video in the
   prompt, "place your specific instructions or questions at the end of the prompt, after the
   data context." → gemini-3 guide
5. **`thinking_level`** replaces thinking budgets: `high` is the default (deepest, slowest first
   token); `low`/`minimal` for chat and high-volume work. `minimal` is the default on Flash-Lite.
   Don't set `thinking_level` and legacy `thinking_budget` together. → gemini-3 guide, thinking
6. **Thought signatures are enforced** from Gemini 3 on — pass them back or the model loses its
   reasoning thread across turns. → gemini-3 guide
7. **It's less verbose by default** than 2.5. → gemini-3 guide

---

## xAI — Grok 4.5

Pages: `https://docs.x.ai/developers/grok-4-5` · `https://docs.x.ai/developers/model-capabilities/text/reasoning`

1. **`reasoning_effort` defaults to `high`;** `low` and `medium` are the alternatives.
2. **Reasoning can't be turned off**, and `presencePenalty`, `frequencyPenalty` and `stop` are
   rejected on reasoning models — requests including them error.
3. **Set a `prompt_cache_key`.** xAI's own words: "we highly recommend setting a
   `prompt_cache_key`… without it you often pay full input price on a cache-cold server." A
   real money tip, not a style note.
4. **Raise your client timeout** — xAI's own examples use 3600s.
5. Reasoning summaries are exposed on Grok 4.5 and can be streamed alongside the answer.

---

## DeepSeek — V4-Pro / V4-Flash

Pages: `https://api-docs.deepseek.com/quick_start/parameter_settings/` ·
`https://api-docs.deepseek.com/guides/thinking_mode/` · `https://api-docs.deepseek.com/news/news260424/`

1. **Thinking mode silently ignores your sampling settings.** "Thinking mode does not support the
   `temperature`, `top_p`, `presence_penalty`, or `frequency_penalty` parameters, and while
   setting these parameters will not trigger an error, they will also have no effect." Silent
   no-op — worth knowing.
2. **Default temperature is 1.0**; change temperature or `top_p`, not both.

---

## Moonshot — Kimi K3 / K2.6

Pages: `https://huggingface.co/moonshotai/Kimi-K3` · `https://github.com/MoonshotAI/Kimi-K3`

1. **It will fill in gaps you left.** Model card: "due to training optimization for complex,
   long-horizon tasks, the model may proactively decide details on ambiguous instructions, so
   you should explicitly enforce bounds in the system prompt if strict constraint-following is
   required."
2. **Feed thinking tokens back.** "Agent wrappers must feed back all previous thinking tokens in
   multi-turn completions to avoid context degradation."
3. **Published settings:** all K3 results use reasoning effort `max` and temperature 1.0;
   `top_p` 0.95 for single-step tasks, 1.0 for agentic tasks. K2.5-era guidance: temperature 1.0
   for Thinking mode, 0.6 for Instant mode.

---

## Alibaba — Qwen3 family

Pages: Qwen3-Coder model cards on Hugging Face (`https://huggingface.co/Qwen/Qwen3-Coder-480B-A35B-Instruct`)

1. **Published sampling settings for Qwen3-Coder:** temperature 0.7, `top_p` 0.8, `top_k` 20,
   repetition penalty 1.05.
2. **Output length:** 32,768 tokens recommended for most queries; 38,912 for competition-grade
   math and programming problems.
3. Native context 262,144 tokens; drop it if you hit out-of-memory when self-hosting.
4. Caveat: these cards cover the open-weight Coder line, not the hosted `qwen3-max` endpoint —
   flag as adjacent, not exact, or leave blank.

---

## Mistral — Medium 3.1

Pages: `https://docs.mistral.ai/models/best-practices/prompt-engineering` ·
`https://docs.mistral.ai/models/best-practices`

1. **Temperature pairs with reasoning effort:** 0.7 at `reasoning_effort="high"`; 0.0–0.7 at
   `reasoning_effort="none"` depending on task.
2. Strong system-prompt adherence — put the standing rules in the system prompt.
3. Caveat: the specific temperature figures are published against Mistral Medium **3.5**. Do not
   attach them to the 3.1 row without checking 3.1's own card.

---

## Zhipu — GLM-5.2

Pages: `https://docs.z.ai/guides/capabilities/thinking-mode` ·
`https://huggingface.co/zai-org/GLM-5.2` · `https://z.ai/blog/glm-5`

1. **Thinking is on by default** on GLM-5.2/5.1/5 — a change from GLM-4.6's hybrid default.
2. **Turn-level thinking:** flip reasoning on or off per request inside one session. Off for
   "asking a fact" or "tweaking wording"; on for "complex planning," "multi-constraint
   reasoning," "code debugging."
3. **`reasoning_effort` takes only `max` and `high`** — and `max` is the default, applied to any
   unrecognised value. Turn it off entirely with `enable_thinking=false`.
4. **Keep prior turns' reasoning in context on coding work** — Zhipu says it preserves continuity,
   improves results, and raises cache hits, saving tokens.
5. Published eval settings: temperature 1.0, `top_p` 0.95.

---

## Meta — Llama 4 Maverick

Page: `https://github.com/meta-llama/llama-models/blob/main/models/llama4/MODEL_CARD.md`

1. **The system prompt is the main dial.** Meta: a system prompt "can be effective in reducing
   false refusals and templated or 'preachy' language patterns," and improves conversationality
   and formatting. Thinner than the others, but real and citable.
2. Improved steerability and instruction following vs Llama 3.

---

## Finding: Tier B is barely needed

I told Lucas that Qwen, Kimi, GLM and Mistral "publish close to nothing." **That was wrong.**
Every vendor in the catalog publishes at least one concrete, citable usage fact — often the
money kind (xAI's cache key, DeepSeek's silent parameter no-op, GLM's turn-level thinking).
Depth is uneven (Anthropic ≫ OpenAI ≈ Google > the rest), but the floor is not zero.

So tier B stays in the design as a labelled slot, but on today's catalog it has almost nothing
to do. Recommend shipping tier A first and only opening tier B where a real gap remains.

## A pattern worth pulling out on the page

Three labs independently say *delete the instructions you wrote for the last model*:

- Anthropic: remove verification instructions from Opus 5 prompts — they cause over-verification.
- OpenAI: GPT-5.6 is more concise by default; leaner prompts scored 10–15% better on 41–66%
  fewer tokens.
- Google: stop hand-writing chain-of-thought for Gemini 3; use `thinking_level` and simplify.

That's the section's headline, and it's Lucas's original insight generalized: **the most valuable
thing to know about a new model is which of your old habits it made useless.**

## Still to do

- [x] Tier A sweep — all 10 vendors, complete
- [ ] Schema + data written into `models.json`
- [ ] Validator rule: no guidance entry without a source URL
- [ ] Section design (later session, with Lucas at a screen)
