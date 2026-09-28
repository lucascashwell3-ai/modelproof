# The quick questions — at most five, under two minutes

Ask only what their setup didn't already answer. All in one message, numbered, each with its
answer choices so they can reply "1 Claude Code, 2 Max 5x often, 3 coding, 4 no, 5 everywhere".
A pasted profile (`"schema": "modelproof.profile/1"`, usually from the board) skips all of
them: save it as `$MP/profile.json` and go to the plan.

## The five

| # | Ask | Skip when | Goes into the profile as |
|---|---|---|---|
| 1 | "Which do you use: Claude Code, Codex, Cursor, or another tool that reads AGENTS.md?" | detect found them and they said yes to the readback | `tools`: `claude-code`, `codex`, `cursor`, `agents-md` |
| 2 | "Which plans do you pay for (for example Claude Max 5x, ChatGPT Plus, Cursor Pro), or do you use API keys? How often do you hit usage limits: often, sometimes, rarely?" | never skipped: plans don't show on disk | `plans`: `[{"vendor": "Anthropic", "plan": "Max 5x"}]`; API keys → `"api": true`; `limits`: `often` / `sometimes` / `rarely`; API only → `api-budget` |
| 3 | "What kind of work, mostly? coding, agents (long multi-step runs), bulk jobs, writing, research, extraction, chat, images, frontend, exec summaries" | — | `work`: `coding`, `agents`, `bulk`, `writing`, `research`, `extraction`, `chat`, `vision` (images), `frontend`, `exec-summaries` |
| 4 | "Any models you like, or never want used?" plus, for each existing model rule detect found, "Your <file> line <n> says <model> for <job> — keep that?" | — | `like`: models they name; `never`: models or labs; each confirmed rule → `roles` (below) |
| 5 | "Everywhere, or just this project?" | there is no project folder (then it is everywhere), or their instructions live in only one of the two | `scope`: `user` (everywhere) / `project` |

Write model names the way they said them (`opus`, `Claude Sonnet 5`, `gpt-6-sol`): the
installer maps names, tool aliases and ids, and anything it can't place shows up in the plan
as a `Left out of your answers:` note — tell them, don't guess a fix.

## Roles come only from them

`roles` = `lead`, `scout` (searching and reading), `builder` (writing code), `reviewer`
(checking a change). Set one only when they chose it: a confirmed existing rule ("keep opus
for builds?" → yes → `"builder": "opus"`) or a direct answer. Never fill a role yourself;
an empty role means the installer uses the tool's own documented default for that job, or
the lead's model.

## Only when they bring it up

- "Cap effort at medium" → `"effort_cap": "medium"` (`low`, `medium`, `high`, `xhigh`, `max`).
- "Also make X my default model" → `"set_default_model": true` and `"roles": {"lead": "X"}`.
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
  "like": ["claude-opus-5-5"],
  "never": [],
  "roles": { "builder": "opus" }
}
```

Before the plan, say the answers back in one line only if you had to guess one of them.
