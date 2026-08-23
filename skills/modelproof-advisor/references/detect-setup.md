# What do they already have? — read-only, names not values

Check presence only. Never read or echo a key's value. Never search on anything found.

**The tool you're running in is itself a signal.** In Claude Code, Anthropic access is
proven — don't report "nothing detected" to someone who is talking to Claude. Same logic for
Gemini CLI (Google) and Codex CLI (OpenAI).

## Providers (API keys / logins)

- Env: `env | grep -o -E '^(ANTHROPIC|OPENAI|GEMINI|GOOGLE_API|XAI|MISTRAL|DEEPSEEK|OPENROUTER|GROQ|TOGETHER|FIREWORKS)[A-Z_]*KEY' | sort -u`
- Project `.env*` files: `grep -o -E '^(ANTHROPIC|OPENAI|...)[A-Z_]*KEY' .env* 2>/dev/null` (name only)
- An OpenRouter key means almost every model is one string away — say so; it changes the answer.

## The tool they're in, and its model setting

| Tool | Where the model is set | How to set it (goes in the plan) |
|---|---|---|
| Claude Code | `~/.claude/settings.json` / `.claude/settings.json` → `"model"`; `/model` in session | edit the `model` key (project file for one project, home file for everything) |
| Cursor | Settings → Models (GUI; `~/.cursor/` holds no model choice you can safely edit) | tell them the menu path — don't edit files |
| Codex CLI | `~/.codex/config.toml` → `model` | edit the key |
| Gemini CLI | `~/.gemini/settings.json` | edit the key |
| Aider | `.aider.conf.yml` → `model` | edit the key |
| A script / batch job / API call (most bulk work) | the model id in their code | nothing to write — give the model id and the API to use (Batch API for overnight) |
| Anything else | ask: "what tool are you running this in?" | — |

**Write a setting, or just say it?** "Starting a project / this repo from now on" → the
project's settings file goes in the plan. A one-off task (a deck, a memo, one bulk run) →
no file: "pick it with `/model` this session" or the model id for the script, and no "Go?".
No project folder at all → only the home settings file is a candidate, and usually the
answer is the session menu.

**Plan limits.** You can't see which models a subscription tier unlocks. If the pick is a
top-tier model, add five words: "if your plan doesn't include it, use X" — the next one down.

Subscriptions (Claude Pro/Max, ChatGPT Plus, Gemini Advanced) don't show up on disk. If a key
isn't present and the task is about chat/desktop use, ask once: "Which do you pay for —
Claude, ChatGPT, Gemini, something else?"

## Budget, if unstated

Infer from their words: "overnight bulk", "tight", "cheap" → cheapest that clears the floor;
"client deck", "PE presentation", "important" → quality first; nothing said → value (best
score per dollar). State the inference in the readback so they can correct it.
