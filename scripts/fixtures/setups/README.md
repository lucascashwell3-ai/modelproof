# Installer fixture setups

Each folder is a pretend machine: `home/` stands for the home folder and `project/` for one
repository. `scripts/test-install.mjs` copies a setup into a fresh temp folder (links kept as
links), keeps the install record in a separate temp folder, and checks every run with
`scripts/setup-hash.mjs`. A missing `home/` or `project/` is created empty by the test. All paths
and values inside are made up (`/home/alex`, `fixture-...-not-for-output`).

| Setup | What it has | Profile used |
|---|---|---|
| `cc-max5x` | 150-line `~/.claude/CLAUDE.md` with an `@notes/style.md` import, a fenced `@path` that is not an import, and a prose line "Use opus for builds"; two helpers with no model; `settings.json` with permissions, hooks, env and apiKeyHelper (none of which may be printed); an auto-memory file and an output style | `profiles/cc-max5x.json` (user scope) |
| `codex` | `~/.codex/AGENTS.md` and `config.toml` with a model | `profiles/codex.json` (user scope) |
| `cursor` | project `AGENTS.md` and an existing `.cursor/rules/style.mdc` | `profiles/cursor.json` |
| `org-40` | shared repo: `CLAUDE.md` importing `@AGENTS.md`, a 60-line `AGENTS.md`, existing `.claude/agents` and `.codex/agents` helpers, `.claude/settings.json` with a 4-space indent | `profiles/org-40.json` |
| `empty` | nothing at all (no folder in git) | `profiles/empty.json` |
| `symlink` | `project/.claude` → `config/claude`, `project/AGENTS.md` → `docs/AGENTS.md`, `home/.claude` → `dotfiles/claude`; every link target is inside the setup | `symlink/profile.json`, `symlink/profile-user.json` |
| `agents-md-only` | a project with only `AGENTS.md`, used with Claude Code (must never get a `CLAUDE.md`) | `agents-md-only/profile.json` |
| `copilot` | project `AGENTS.md` and `.github/copilot-instructions.md` (both must stay as they are) | `profiles/copilot.json` |
| `antigravity` | `~/.gemini/AGENTS.md` with the user's own global rules (the block goes after them) | `profiles/antigravity.json` (user scope) |
| `cc-copilot` | project `CLAUDE.md`, `AGENTS.md`, `.claude/settings.json` and someone's own `.github/agents/docs-writer.agent.md`; GitHub Copilot also loads `.claude/agents`, so no helper may be added twice | `profiles/cc-copilot.json` |
| `power-user-max5x` | a heavy Claude Code user on Max 5x: `~/.claude/CLAUDE.md` with an `@~/work/notes/tone.md` import, helpers `code-simplifier` and `checker` (its description says it verifies, so it overlaps the reviewer) with no model line, an output style, a skill, and `settings.json` with permissions, env, hooks and plugins (none printed) | `profiles/power-user-max5x.json` (user scope) |

OpenRouter / API is copy only: `profiles/openrouter.json` runs on the `empty` setup and must write nothing.
