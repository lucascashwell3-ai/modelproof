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

## Still to do

- [ ] OpenAI (5 models: GPT-5.5, GPT-5.6 Sol/Terra/Luna, o4-mini)
- [ ] Google (4: Gemini 3.1 Pro, 3.5 Flash, 3.6 Flash, 2.5 Flash-Lite)
- [ ] xAI (Grok 4.5), DeepSeek (V4-Pro, V4-Flash), Meta (Llama 4 Maverick)
- [ ] Alibaba (Qwen3-Max, Qwen3-Coder-Plus, Qwen-Turbo), Moonshot (Kimi K3, K2.6),
      Mistral (Medium 3.1), Zhipu (GLM-5.2)
- [ ] Tier B sweep for whichever of the above publish nothing usable
