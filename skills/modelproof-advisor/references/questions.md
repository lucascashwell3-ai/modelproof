# The quick questions — at most five, under two minutes

Ask only what their setup didn't already answer. All in one message, numbered, each with its
answer choices so they can reply "1 Claude Code, 2 Max 5x often, 3 coding, 4 no, 5 everywhere".
A pasted profile (`"schema": "modelproof.profile/1"`, usually from the board) skips all of
them: save it as `$MP/profile.json` and go to the plan.

## The five

| # | Ask | Skip when | Goes into the profile as |
|---|---|---|---|
| 1 | "Which tools do you use: Claude Code, Codex, Cursor, GitHub Copilot, Antigravity (Gemini), or OpenRouter / a raw API? Another tool that reads AGENTS.md counts too." | detect found them and they said yes to the readback | `tools`: `claude-code`, `codex`, `cursor`, `copilot`, `antigravity`, `openrouter`, `agents-md` |
| 2 | "Which plan is each tool on (for example Claude Code on Max 5x, Copilot Pro, Cursor Pro), or do you use API keys? How often do you hit usage limits: often, sometimes, rarely?" | never skipped: plans don't show on disk | `plans`: `[{"vendor": "Anthropic", "plan": "Max 5x"}]`; API keys → `"api": true`; `limits`: `often` / `sometimes` / `rarely`; API only → `api-budget` |
| 3 | "What kind of work, mostly? coding, agents (long multi-step runs), bulk jobs, writing, research, extraction, chat, images, frontend, exec summaries" | — | `work`: `coding`, `agents`, `bulk`, `writing`, `research`, `extraction`, `chat`, `vision` (images), `frontend`, `exec-summaries` |
| 4 | "Any models you like, or never want used?" plus, for each existing model rule detect found, "Your <file> line <n> says <model> for <job> — keep that?" | — | `like`: models they name; `never`: models or labs; each confirmed rule → `roles` (below) |
| 5 | "Everywhere, or just this project?" | there is no project folder (then it is everywhere), or their instructions live in only one of the two | `scope`: `user` (everywhere) / `project` |

Write model names the way they said them (`opus`, `Claude Sonnet 5`, `gpt-6-sol`): the
installer maps names, tool aliases and ids, and anything it can't place shows up in the plan
as a `Left out of your answers:` note — tell them, don't guess a fix.

## Roles come only from them

`roles` = `lead` (the main model), the helpers `scout` (searching and reading), `builder`
(writing code), `reviewer` (checking a change), and `bulk` (mechanical work a script or test
can check). Set one only when they chose it: a confirmed existing rule ("keep opus for
builds?" → yes → `"builder": "opus"`) or a direct answer. Never fill a role yourself. An
empty role means: the lead is the tool's documented default model (or the one they choose in
the tool), each helper runs on the lead's model, and bulk runs on the model the tool's own
docs name for mechanical work, where they name one. Someone who hits limits often or
sometimes also gets one sourced line on handing a well-scoped thread to a lighter model near a
full limit: a habit, never a setting.

## Only when they bring it up

- "Cap effort at medium" → `"effort_cap": "medium"` (a level the tool's own docs list: Claude
  Code takes `low` to `max`; Codex also lists `ultra`). The plan's lead line shows the tool's
  default effort and when its docs raise it, as information.
- "Also make X my default model" → `"set_default_model": true` and `"roles": {"lead": "X"}`.
- Claude Code, and they hit limits **often** (question 2): one follow-up, "Also put Claude
  Code's built-in Explore helper on the bulk model (haiku)? It adds one more helper file." Yes →
  `"explore_override": true`. Never ask it otherwise, never set it without their yes: without
  it the plan leaves that file out and lists it under "Also available, not included".
- A whole team or company → `"who": "org"` with `org.divisions`; the board at `BASE` +
  `board.html` builds that profile faster than questions. Offer it once.

## The file

```json
{
  "schema": "modelproof.profile/1",
  "who": "person",
  "tools": ["claude-code"],
  "scope": "user",
  "plans": [{ "vendor": "Anthropic", "plan": "Max 5x" }],
  "limits": "often",
  "work": ["coding", "agents"],
  "like": [],
  "never": [],
  "roles": {}
}
```

Before the plan, say the answers back in one line only if you had to guess one of them.
