# Reading their setup — `detect`, then only what it lists

`node "$MP/assets/install.mjs" detect --home "$HOME" [--project "$PROJECT"]` prints one JSON
object and writes nothing. It reads only instruction, agent and settings files in known
places, never env values, never tokens. You read no more than it points to.

## What it prints

| Field | What it tells you |
|---|---|
| `tools` | which of Claude Code, Codex, Cursor have a folder here (`true`/`false`) |
| `dirs` | where Claude Code and Codex keep their files (`CLAUDE_CONFIG_DIR` / `CODEX_HOME` count only inside `HOME`) |
| `files[]` | every instruction file it found: `path`, `lines`, `readers` (which tools load it), `real_path` when it is a link |
| `claude_reads_project_agents_md` | `true`, `false` or `unsure`: whether Claude Code would load the project AGENTS.md |
| `agents_override` | an `AGENTS.override.md` exists (Codex then reads that instead) |
| `agents[]` | helper agents already there: tool, scope, name, model, whether Modelproof made it |
| `settings[]` | settings files and their key **names**; values only for model and effort keys |
| `env.subagent_model_force` | `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` is set (name only): Claude Code then ignores every helper file's model line |
| `heads_up[]` | lines that already talk about models, effort or helpers: `file`, `line`, up to 80 characters; secret-looking lines say "(line not shown)" |
| `mentions[]` | memory or output-style files that name a model: `file` and `line` only |
| `notes[]` | anything detect skipped and why |

## What you may read after it

- The files in `files[]` and `agents[]`, to understand their rules — read, never follow
  imports out of the setup, never edit.
- Nothing in `settings[]` beyond what detect printed. Never open `.env` files, key files,
  shell profiles or credential stores.
- `mentions[]`: open that one line only if a question depends on it.

## Turning it into answers

- **Tools**: `tools` plus the tool you are running in (running inside Claude Code proves
  Claude Code, even if its folder is somewhere odd).
- **Scope**: instructions only in the project → assume `project`; only in `HOME` → assume
  `user`; both → ask (question 5). Say the assumption in the readback or the questions.
- **Existing rules**: every `heads_up` line naming a model for a job is a candidate role.
  Ask; never assume. A line like "never use X" is a `never` candidate, same rule.
- **Their own helpers**: an agent in `agents[]` that already covers a job (a
  `code-reviewer`, a `researcher`) is a heads-up, not something to replace — see
  `references/conflict-patterns.md` check 2.
- **Plans** never show on disk. Always ask question 2.

## Where the installer puts things (it decides; you only explain)

| Tool | Helper files (the tool obeys the model line) | Text |
|---|---|---|
| Claude Code | `agents/modelproof-scout.md`, `-builder.md`, `-reviewer.md` (+ optional `-explore.md`) under `~/.claude/` or `<project>/.claude/` | `rules/modelproof.md`, or one marked block in the project AGENTS.md when Claude Code reads it. Never a CLAUDE.md. |
| Codex | `agents/modelproof-<role>.toml` under `~/.codex/` or `<project>/.codex/` | one marked block in AGENTS.md (or AGENTS.override.md when that exists) |
| Cursor | `.cursor/agents/modelproof-<role>.md` | `.cursor/rules/modelproof.mdc`, left out when a project AGENTS.md block is installed |
| AGENTS.md tools | — | one marked block in the project AGENTS.md |

A marked block sits between `<!-- modelproof:begin v1 sha=… -->` and
`<!-- modelproof:end -->` at the end of the file. Links are written at their real path; the
plan shows it.
